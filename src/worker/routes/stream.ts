import { Hono } from 'hono';
import { loadConfig, UPSTREAM_USER_AGENT, type Env } from '../config/env';
import { AppError } from '../lib/http';
import { verifyStreamToken } from '../lib/signing';
import { rewritePlaylist } from '../lib/hls';
import { safeFetch } from '../lib/ssrf';

export const streamRoute = new Hono<{ Bindings: Env }>();

/**
 * Headers forwarded from the client to the upstream CDN.
 * Range is the important one: without it, seeking, resumable downloads and the
 * muxer's chunked reads all break, and every retry restarts from byte 0.
 */
const FORWARD_TO_UPSTREAM = ['range', 'if-range', 'accept-encoding'] as const;

/**
 * Headers copied from the upstream response back to the client.
 * Everything else is dropped — notably set-cookie, which would otherwise let an
 * upstream CDN plant cookies on OUR origin, and any upstream CORS/caching header
 * that would contradict the policy we set ourselves.
 */
const FORWARD_TO_CLIENT = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
] as const;

const CONTENT_TYPE_BY_CONTAINER: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  flv: 'video/x-flv',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

/**
 * GET/HEAD /api/stream?t=<signed token>[&dl=1]
 *
 * Pipes an upstream media stream through the Worker. Reasons this proxy exists
 * rather than handing the browser the upstream URL directly:
 *
 *  1. CORS — CDN media responses carry no permissive ACAO header, so the muxer
 *     could never fetch() them cross-origin.
 *  2. COEP — under `require-corp`, cross-origin subresources without CORP are
 *     blocked outright.
 *  3. Leakage — upstream URLs embed IP-bound, expiring session tokens. Keeping
 *     them server-side means they never land in browser history or the DOM.
 *
 * The response body is streamed, never buffered: a Worker has a small memory
 * budget and these files run to gigabytes.
 */
streamRoute.on(['GET', 'HEAD'], '/', async (c) => {
  const config = loadConfig(c.env);

  const token = c.req.query('t');
  if (!token) throw AppError.invalidRequest('Missing stream token.');

  const verified = await verifyStreamToken(token, config.signingKey);
  if (!verified.ok) {
    throw new AppError(
      verified.reason,
      verified.reason === 'token_expired'
        ? 'This download link has expired. Resolve the link again.'
        : 'This download link is not valid.',
      verified.reason === 'token_expired' ? 410 : 403,
    );
  }

  const { k: kind, r: referer, f: filename, ua } = verified.payload;

  /**
   * A child of a directly-fetched playlist may be requested with `?u=<child>`
   * alongside the parent's token. Minting a token per segment in the browser is
   * impossible (it has no signing key), so the parent token authorises its
   * children — but ONLY on the same host, so a valid token for one CDN can never
   * be used to fetch from another.
   */
  const requestedChild = c.req.query('u');
  let upstreamUrl = verified.payload.u;
  if (requestedChild) {
    let childHost: string;
    let parentHost: string;
    try {
      childHost = new URL(requestedChild).hostname;
      parentHost = new URL(verified.payload.u).hostname;
    } catch {
      throw AppError.invalidRequest('Malformed child URL.');
    }
    // Exact host match: a suffix check would let evil-cdndirector.example through.
    if (childHost !== parentHost) {
      throw AppError.invalidRequest('That child URL does not belong to the signed playlist.');
    }
    upstreamUrl = requestedChild;
  }

  const upstreamHeaders = new Headers({
    // A UA from the signed payload wins: Google's video CDN rejects requests
    // whose UA does not match the InnerTube client that minted the URL.
    'user-agent': ua || UPSTREAM_USER_AGENT,
    accept: '*/*',
  });
  // Referer is taken from the SIGNED payload, never from the request, so a
  // client cannot use this endpoint to forge referers to arbitrary hosts.
  if (referer) upstreamHeaders.set('referer', referer);

  for (const name of FORWARD_TO_UPSTREAM) {
    const value = c.req.header(name);
    if (value) upstreamHeaders.set(name, value);
  }

  /**
   * Dailymotion's WAF refuses datacenter IPs non-deterministically — measured at
   * 4/6 then 0/8 from one host within an hour. A single attempt therefore fails
   * downloads that a retry would have completed, so playlist fetches (small, and
   * the gateway to everything else) get a few quick attempts before giving up.
   * Media bytes are not retried here: they are large, and the client's own
   * fallback handles them.
   */
  const attempts = kind === 'hls' ? 4 : 1;
  let upstream!: Response;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    upstream = await safeFetch(upstreamUrl, {
      method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
    });
    if (upstream.ok || upstream.status === 206 || attempt === attempts) break;
    await upstream.body?.cancel();
    // Short, escalating pause: the WAF decision varies per request, not per second.
    await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
  }

  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel();
    if (upstream.status === 403 || upstream.status === 401) {
      /**
       * A 403 has two very different causes and they must not share a message.
       *
       * On a playlist it is almost always the CDN's WAF refusing this server's
       * IP — reporting "your link expired" there sends the user to re-resolve,
       * which cannot possibly help. On media bytes it usually IS an expired
       * upstream signature, where re-resolving is exactly the fix.
       */
      if (kind === 'hls') {
        throw new AppError(
          'upstream_blocked',
          "The platform's CDN refused this server. Its firewall blocks datacenter IPs " +
            'intermittently, so retrying often works; a resolver on a residential ' +
            'connection fixes it permanently.',
          503,
        );
      }
      throw new AppError(
        'token_expired',
        'The platform link has expired. Resolve it again to refresh.',
        410,
      );
    }
    if (upstream.status === 404) throw AppError.notFound('The media is no longer available.');
    throw AppError.upstream(`The platform returned ${upstream.status}.`);
  }

  /**
   * An HLS playlist is text full of CDN URLs, not media. Rewrite every URI to a
   * signed same-origin proxy URL before the browser sees it: the segment hosts
   * send no CORS headers, so JS could not fetch them directly, and the raw URLs
   * would leak upstream signatures into the page.
   */
  if (kind === 'hls') {
    const body = await upstream.text();
    const rewritten = await rewritePlaylist(body, {
      playlistUrl: upstreamUrl,
      origin: new URL(c.req.url).origin,
      signingKey: config.signingKey,
      // Children inherit the parent's expiry, so nothing outlives its token.
      expiresAt: verified.payload.e,
      base: {
        p: verified.payload.p,
        ...(referer ? { r: referer } : {}),
        ...(ua ? { ua } : {}),
      },
    });

    return new Response(rewritten, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      },
    });
  }

  const headers = new Headers();
  for (const name of FORWARD_TO_CLIENT) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  if (kind === 'thumb') {
    headers.set('content-type', upstream.headers.get('content-type') ?? 'image/jpeg');
    // Thumbnails are immutable for the life of the signed token.
    headers.set('cache-control', 'private, max-age=3600');
  } else {
    // Trust our own container mapping over the CDN's frequently-wrong guess
    // (googlevideo serves DASH fragments as application/octet-stream).
    const container = filename?.split('.').pop()?.toLowerCase();
    const mapped = container ? CONTENT_TYPE_BY_CONTAINER[container] : undefined;
    if (mapped) headers.set('content-type', mapped);
    headers.set('cache-control', 'private, no-store');
  }

  // Advertise range support even when the upstream forgot to.
  if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes');

  /**
   * `dl=1` triggers a browser download; without it the response is inline so the
   * muxer can fetch() it and <video> can preview it. Filename comes from the
   * signed token, so it cannot be used for header injection.
   */
  if (c.req.query('dl') === '1' && filename) {
    const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
    headers.set(
      'content-disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
  }

  headers.set('x-content-type-options', 'nosniff');
  headers.set('cross-origin-resource-policy', 'same-origin');

  return new Response(c.req.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
});
