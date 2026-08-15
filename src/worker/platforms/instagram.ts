import { AppError } from '../lib/http';
import {
  cookieHeader,
  decodeEfg,
  harvestCookies,
  META_DOCUMENT_HEADERS,
  META_UA,
  parseDashManifest,
  shortCodec,
} from '../lib/meta-web';
import type { RawStream, ResolverResult } from '../resolver/types';
import { defineProvider, hostMatches, stripTracking, type ExtractContext } from './types';

/* ------------------------------------------------------------------ *
 * NATIVE IN-WORKER EXTRACTION — logged-out Polaris GraphQL
 * ------------------------------------------------------------------ *
 *
 * THE load-bearing detail: `Sec-Fetch-Site: same-origin`.
 *
 * Without it Instagram answers 200 plus a ~600 kB HTML shell instead of JSON, no
 * matter how many other headers are sent. Browsers FORBID page JavaScript from
 * setting any Sec-Fetch-* header — the fetch spec makes them forbidden header
 * names — but workerd's Headers guard does not inspect header names, so a Worker
 * can send it and a browser never can.
 *
 * That asymmetry is the entire reason this extraction must live server-side, and
 * it is why the Worker can do something the client cannot.
 *
 * Other verified findings:
 *  - The logged-out post query is POST https://www.instagram.com/api/graphql
 *    with doc_id 27130156389949648
 *    (friendly name PolarisLoggedOutDesktopWWWPostRootContentQuery).
 *  - `variables` takes {"media_id": <numeric pk>} — NOT the shortcode.
 *  - A fresh `lsd` token AND the guest cookie jar from a homepage GET are BOTH
 *    required. A dummy lsd fails; omitting cookies fails.
 *  - shortcode <-> pk is pure base64 with the alphabet A-Za-z0-9-_, so the
 *    conversion costs zero network round-trips.
 */

const IG_APP_ID = '936619743392459';
const IG_FRIENDLY_NAME = 'PolarisLoggedOutDesktopWWWPostRootContentQuery';

/**
 * Ordered doc_id candidates. These rotate with Instagram's frontend deploys —
 * index 0 is the verified-working one, the rest are historical fallbacks. When
 * all fail we report a schema change rather than a generic error, so the cause
 * is unambiguous.
 *
 * Future Extension: a Cron trigger could scrape the current doc_id from
 * instagram.com's JS bundles into KV, making this self-healing.
 */
const IG_DOC_IDS = ['27130156389949648', '8845758582119845', '10015901848480474'] as const;

/** Guest session reuse window. Caching here is load-bearing, not an optimisation:
 *  Meta rate-limits anonymous access per source IP. */
const SESSION_TTL_SECONDS = 600;

const MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, CAROUSEL: 8 } as const;

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Instagram shortcodes are the media's 64-bit primary key written in base64.
 * BigInt keeps precision that Number would silently destroy past 2^53.
 */
export function shortcodeToPk(shortcode: string): string {
  let value = 0n;
  for (const char of shortcode) {
    const digit = B64_ALPHABET.indexOf(char);
    if (digit === -1) throw AppError.invalidRequest(`Invalid character "${char}" in shortcode.`);
    value = value * 64n + BigInt(digit);
  }
  return value.toString();
}

interface IgVideoVersion {
  url?: string;
  width?: number;
  height?: number;
  type?: number;
}

interface IgNode {
  media_type?: number;
  has_audio?: boolean;
  video_versions?: IgVideoVersion[];
  video_dash_manifest?: string;
  original_width?: number;
  original_height?: number;
  image_versions2?: { candidates?: Array<{ url?: string; width?: number }> };
  carousel_media?: IgNode[];
  code?: string;
  pk?: string | number;
  caption?: { text?: string };
  user?: { username?: string; full_name?: string };
  clips_metadata?: {
    music_info?: { music_asset_info?: { title?: string; display_artist?: string } };
    original_sound_info?: { original_audio_title?: string; ig_artist?: { username?: string } };
  };
}

/* ------------------------------------------------------------------ *
 * Guest session (cookies + lsd)
 * ------------------------------------------------------------------ */

interface GuestSession {
  cookie: string;
  lsd: string;
  csrf: string;
}

/** Per-isolate memo, so a burst costs one bootstrap rather than one each. */
let sessionMemo: { value: GuestSession | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};

async function getGuestSession(ctx: ExtractContext, force = false): Promise<GuestSession> {
  const now = Date.now();
  if (!force && sessionMemo.value && sessionMemo.expiresAt > now) return sessionMemo.value;

  const response = await ctx.fetch('https://www.instagram.com/', {
    headers: META_DOCUMENT_HEADERS,
    signal: AbortSignal.timeout(12_000),
  });

  const jar = harvestCookies(response);
  const html = await response.text();

  // The token appears in a few shapes depending on which bundle rendered.
  const lsd =
    /\["LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ??
    /"lsd":"([^"]+)"/.exec(html)?.[1] ??
    /<script[^>]+id="__eqmc"[^>]*>([^<]+)<\/script>/
      .exec(html)?.[1]
      ?.match(/"l":"([^"]+)"/)?.[1] ??
    null;

  const csrf = jar.get('csrftoken') ?? /"csrf_token":"([^"]+)"/.exec(html)?.[1] ?? '';
  if (csrf && !jar.has('csrftoken')) jar.set('csrftoken', csrf);

  if (!lsd || jar.size === 0) {
    throw AppError.upstream(
      'Instagram did not hand out a guest session. The edge IP is most likely rate-limited — try again shortly.',
    );
  }

  const session: GuestSession = { cookie: cookieHeader(jar), lsd, csrf };
  sessionMemo = { value: session, expiresAt: now + SESSION_TTL_SECONDS * 1000 };
  return session;
}

/* ------------------------------------------------------------------ *
 * Strategies
 * ------------------------------------------------------------------ */

/**
 * Authenticated private API. Only runs when an Instagram cookie is configured.
 * Returns null (rather than throwing) on any failure so the guest path still
 * gets its turn — a dead session must not fail the whole request.
 */
async function viaAuthenticated(pk: string, ctx: ExtractContext): Promise<IgNode | null> {
  const cookie = ctx.credentials.instagramCookie;
  if (!cookie) return null;

  const csrf = /csrftoken=([^;]+)/.exec(cookie)?.[1] ?? 'missing';
  const response = await ctx.fetch(`https://www.instagram.com/api/v1/media/${pk}/info/`, {
    headers: {
      'user-agent': META_UA,
      'x-ig-app-id': IG_APP_ID,
      'x-csrftoken': csrf,
      'x-ig-www-claim': '0',
      'x-requested-with': 'XMLHttpRequest',
      accept: '*/*',
      cookie,
      referer: 'https://www.instagram.com/',
      origin: 'https://www.instagram.com',
      'sec-fetch-site': 'same-origin',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(12_000),
  });

  // A 302 means the session cookie is dead.
  if (response.status !== 200) return null;
  try {
    const data = (await response.json()) as { items?: IgNode[] };
    return data.items?.[0] ?? null;
  } catch {
    return null;
  }
}

/** The logged-out GraphQL query. This is the workhorse. */
async function viaGraphql(pk: string, ctx: ExtractContext): Promise<IgNode> {
  let session = await getGuestSession(ctx);
  let sawHtmlShell = false;

  for (const docId of IG_DOC_IDS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body = new URLSearchParams({
        av: '0',
        __d: 'www',
        __user: '0',
        __a: '1',
        __comet_req: '7',
        lsd: session.lsd,
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: IG_FRIENDLY_NAME,
        server_timestamps: 'true',
        doc_id: docId,
        variables: JSON.stringify({ media_id: pk }),
      });

      const response = await ctx.fetch('https://www.instagram.com/api/graphql', {
        method: 'POST',
        headers: {
          'user-agent': META_UA,
          'content-type': 'application/x-www-form-urlencoded',
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.9',
          'x-ig-app-id': IG_APP_ID,
          'x-ig-www-claim': '0',
          'x-csrftoken': session.csrf,
          'x-fb-lsd': session.lsd,
          'x-fb-friendly-name': IG_FRIENDLY_NAME,
          'x-requested-with': 'XMLHttpRequest',
          origin: 'https://www.instagram.com',
          referer: 'https://www.instagram.com/',
          cookie: session.cookie,
          /* ---- load-bearing. A browser cannot send these. Do not remove. ---- */
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });

      const text = await response.text();

      // An HTML body means the request was rejected at the edge, usually because
      // the guest session went stale. Re-bootstrap once, then move on.
      if (!text.startsWith('{')) {
        sawHtmlShell = true;
        if (attempt === 0) {
          session = await getGuestSession(ctx, true);
          continue;
        }
        break;
      }

      let payload: {
        data?: { xig_polaris_media?: { if_not_gated_logged_out?: IgNode } | null };
        errors?: unknown;
      };
      try {
        payload = JSON.parse(text);
      } catch {
        break;
      }

      const root = payload.data?.xig_polaris_media;
      const product = root?.if_not_gated_logged_out;
      if (product) return product;

      // Distinguish "gated/removed" from "wrong doc_id" so the error is honest.
      if (root === null && !payload.errors) {
        throw AppError.notFound(
          'That post is unavailable — it may be deleted, private or region-blocked.',
        );
      }
      if (root && !product) {
        throw new AppError(
          'requires_auth',
          'That post is age- or login-gated, so it cannot be read anonymously.',
          422,
        );
      }
      break; // errors present: try the next doc_id
    }
  }

  if (sawHtmlShell) {
    throw AppError.upstream(
      'Instagram refused the API call and served an HTML shell instead. The edge IP is likely rate-limited.',
    );
  }
  throw AppError.upstream(
    'Instagram returned no media for any known doc_id — the doc_id has probably rotated and needs updating.',
  );
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

function nodeToStreams(node: IgNode): RawStream[] {
  const streams: RawStream[] = [];

  /**
   * Instagram's own flag is the ground truth for silence: a reel posted with no
   * sound has has_audio=false, no audio Representation, and silent renditions
   * throughout. Muxing there is impossible and pointless.
   */
  const mediaHasAudio = node.has_audio !== false;

  /**
   * `video_versions` are the pre-muxed progressive files (h264 + aac, confirmed
   * by ffprobe). Instagram returns three entries (type 101/102/103) that are
   * byte-identical duplicates of one file — legacy quality slots, not real
   * alternatives — so they are collapsed by path.
   */
  const seenPaths = new Set<string>();
  for (const version of [...(node.video_versions ?? [])].sort(
    (a, b) => (a.type ?? 0) - (b.type ?? 0),
  )) {
    if (!version.url) continue;
    let path = version.url;
    try {
      path = new URL(version.url).pathname;
    } catch {
      /* keep the raw string */
    }
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);

    const efg = decodeEfg(version.url);
    streams.push({
      url: version.url,
      kind: mediaHasAudio ? 'muxed' : 'video',
      container: 'mp4',
      codec: 'avc1',
      ...(version.width ? { width: version.width } : {}),
      ...(version.height ? { height: version.height } : {}),
      ...(efg?.bitrate ? { bitrateKbps: Math.round(efg.bitrate / 1000) } : {}),
      headers: { Referer: 'https://www.instagram.com/' },
    });
  }

  // The adaptive ladder: higher resolution, but silent video + separate audio.
  const dash = parseDashManifest(node.video_dash_manifest);
  for (const rendition of dash.video) {
    streams.push({
      url: rendition.url,
      kind: rendition.hasAudio ? 'muxed' : 'video',
      container: rendition.mimeType.includes('webm') ? 'webm' : 'mp4',
      codec: shortCodec(rendition.codec, 'avc1'),
      ...(rendition.width ? { width: rendition.width } : {}),
      ...(rendition.height ? { height: rendition.height } : {}),
      ...(rendition.bitrateKbps ? { bitrateKbps: rendition.bitrateKbps } : {}),
      headers: { Referer: 'https://www.instagram.com/' },
    });
  }
  for (const rendition of dash.audio) {
    streams.push({
      url: rendition.url,
      kind: 'audio',
      container: 'm4a',
      codec: shortCodec(rendition.codec, 'mp4a'),
      ...(rendition.bitrateKbps ? { bitrateKbps: rendition.bitrateKbps } : {}),
      headers: { Referer: 'https://www.instagram.com/' },
    });
  }

  return streams;
}

const bestImage = (node: IgNode): string | undefined => {
  const candidates = [...(node.image_versions2?.candidates ?? [])].sort(
    (a, b) => (b.width ?? 0) - (a.width ?? 0),
  );
  return candidates[0]?.url;
};

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

/** Instagram shortcodes are base64url, historically 11 chars, now up to ~15. */
const SHORTCODE = /^[A-Za-z0-9_-]{5,20}$/;
const MEDIA_ROUTES = new Set(['p', 'reel', 'reels', 'tv']);

export const instagram = defineProvider({
  id: 'instagram',

  hosts: ['instagram.com', 'instagr.am', 'ig.me'],

  cdnHosts: [
    'cdninstagram.com', // scontent-*.cdninstagram.com
    'fbcdn.net', // Instagram media increasingly comes from Meta's shared CDN
    'instagram.com',
  ],

  match(url) {
    if (!hostMatches(url.hostname, this.hosts)) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    const stripped = stripTracking(url);

    // Both /p/<code> and /<username>/p/<code> are valid; scan for the route word
    // rather than assuming a fixed position.
    const routeIdx = segments.findIndex((s) => MEDIA_ROUTES.has(s));
    if (routeIdx !== -1) {
      const route = segments[routeIdx]!;
      const code = segments[routeIdx + 1] ?? '';
      if (code && SHORTCODE.test(code)) {
        // Normalise /reels/ -> /reel/ so the cache key is stable.
        const normalised = route === 'reels' ? 'reel' : route;
        return {
          confidence: 1,
          mediaId: code,
          canonicalUrl: `https://www.instagram.com/${normalised}/${code}/`,
          extra: { kind: normalised },
        };
      }
      return { confidence: 0.6, mediaId: code, canonicalUrl: stripped.toString() };
    }

    // /stories/<user>/<id> — ephemeral and usually account-restricted.
    if (segments[0] === 'stories') {
      return {
        confidence: 0.5,
        mediaId: segments[2] ?? '',
        canonicalUrl: stripped.toString(),
        extra: { kind: 'story' },
      };
    }

    return { confidence: 0.4, mediaId: '', canonicalUrl: stripped.toString() };
  },

  async extract(match, ctx): Promise<ResolverResult> {
    if (!match.mediaId || !SHORTCODE.test(match.mediaId)) {
      throw AppError.unsupported('That Instagram link does not point at a single post or reel.');
    }
    if (match.extra?.['kind'] === 'story') {
      throw new AppError(
        'requires_auth',
        'Instagram stories are only visible to signed-in accounts.',
        422,
      );
    }

    const pk = shortcodeToPk(match.mediaId);
    const node = (await viaAuthenticated(pk, ctx)) ?? (await viaGraphql(pk, ctx));

    // A carousel's first video is the one worth resolving; images have no streams.
    const isCarousel =
      node.media_type === MEDIA_TYPE.CAROUSEL || Array.isArray(node.carousel_media);
    const slides = isCarousel ? (node.carousel_media ?? []) : [node];
    const videoNode =
      slides.find((s) => s.media_type === MEDIA_TYPE.VIDEO || (s.video_versions?.length ?? 0) > 0) ??
      null;

    if (!videoNode) {
      throw AppError.unsupported(
        'That post contains only images, which this downloader does not handle.',
      );
    }

    const streams = nodeToStreams(videoNode);
    if (streams.length === 0) {
      throw AppError.upstream('Instagram returned no downloadable renditions for that post.');
    }

    const dash = parseDashManifest(videoNode.video_dash_manifest);
    const caption = node.caption?.text?.trim();
    const music = node.clips_metadata?.music_info?.music_asset_info;
    const original = node.clips_metadata?.original_sound_info;

    return {
      // Instagram posts have no title, so the caption's first line is the most
      // useful filename source; falling back to the audio title, then the code.
      title:
        caption?.split('\n')[0]?.slice(0, 120) ||
        music?.title ||
        original?.original_audio_title ||
        `Instagram ${match.mediaId}`,
      ...(node.user?.username ? { author: node.user.username } : {}),
      ...(dash.durationSeconds ? { durationSeconds: dash.durationSeconds } : {}),
      ...(bestImage(videoNode) ? { thumbnailUrl: bestImage(videoNode)! } : {}),
      isLive: false,
      streams,
    };
  },
});
