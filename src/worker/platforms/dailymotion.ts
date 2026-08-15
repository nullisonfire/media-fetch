import { AppError } from '../lib/http';
import { parseMasterPlaylist } from '../lib/hls';
import type { RawStream, ResolverResult } from '../resolver/types';
import { defineProvider, hostMatches, stripTracking } from './types';

/* ------------------------------------------------------------------ *
 * NATIVE IN-WORKER EXTRACTION — geo.dailymotion.com
 * ------------------------------------------------------------------ *
 *
 * `geo.dailymotion.com/video/<id>.json?legacy=true` is the player's own
 * metadata endpoint: title, duration, owner, thumbnails, and the master HLS
 * playlist, with no key and no cookies.
 *
 * Dailymotion is HLS-only — there is no progressive file at any quality. Each
 * HLS variant is self-contained (audio and video already interleaved), so no
 * muxing is required; the browser fetches the segments and concatenates them,
 * then ffmpeg.wasm remuxes the result into a single MP4.
 *
 * KNOWN RISK, measured: the metadata endpoint answers 200 from a datacenter IP,
 * but `cdndirector.dailymotion.com` — which serves the manifest — returned 403
 * from every datacenter host tested, with an empty body and `server: cloudflare`
 * (a WAF block). Verified NOT to be a header problem: a byte-exact copy of a
 * real Chrome request, with and without a bootstrapped cookie jar, is still
 * refused, while the same headers get 200 on other Dailymotion hosts.
 *
 * Whether Cloudflare's own edge is treated differently is untested here and is
 * exactly what scripts/edge-probe.js measures. If the manifest is refused, this
 * extractor reports that plainly rather than failing obscurely.
 */

interface DailymotionMetadata {
  title?: string;
  duration?: number;
  error?: { code?: number; title?: string };
  owner?: { screenname?: string; username?: string };
  thumbnails?: Record<string, string>;
  stream_formats?: Record<string, string>;
  qualities?: { auto?: Array<{ type?: string; url?: string }> };
  mode?: string;
  private?: boolean;
  is_password_protected?: boolean;
}

/** Browser-shaped headers. The CDN inspects these even though they do not suffice alone. */
const DM_HEADERS: Record<string, string> = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Not=A?Brand";v="99", "Chromium";v="151"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-site',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/151.0.0.0 Safari/537.36',
};

/** Dailymotion ids start with x, then base36. Suffixes after `_` are slugs. */
const VIDEO_ID = /^(x[a-z0-9]{5,9})/i;

export const dailymotion = defineProvider({
  id: 'dailymotion',

  hosts: ['dailymotion.com', 'dai.ly', 'dmcdn.net'],

  cdnHosts: [
    'dmcdn.net', // segment storage
    'dailymotion.com', // covers cdndirector. and geo. subdomains
    'dmxleo.dailymotion.com',
  ],

  match(url) {
    if (!hostMatches(url.hostname, this.hosts)) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    const stripped = stripTracking(url);
    const canonicalFor = (id: string) => `https://www.dailymotion.com/video/${id}`;

    // dai.ly/<id>
    if (hostMatches(url.hostname, ['dai.ly'])) {
      const m = VIDEO_ID.exec(segments[0] ?? '');
      if (m?.[1]) return { confidence: 1, mediaId: m[1].toLowerCase(), canonicalUrl: canonicalFor(m[1].toLowerCase()) };
      return { confidence: 0.5, mediaId: '', canonicalUrl: stripped.toString() };
    }

    // /video/<id>[_slug]  and  /embed/video/<id>
    const videoIdx = segments.lastIndexOf('video');
    if (videoIdx !== -1) {
      const raw = segments[videoIdx + 1] ?? '';
      const m = VIDEO_ID.exec(raw);
      if (m?.[1]) {
        const id = m[1].toLowerCase();
        return { confidence: 1, mediaId: id, canonicalUrl: canonicalFor(id) };
      }
      return { confidence: 0.6, mediaId: raw, canonicalUrl: stripped.toString() };
    }

    return { confidence: 0.4, mediaId: '', canonicalUrl: stripped.toString() };
  },

  async extract(match, ctx): Promise<ResolverResult> {
    if (!match.mediaId) {
      throw AppError.unsupported('That Dailymotion link does not point at a single video.');
    }

    /* ---- 1. player metadata (keyless, works from anywhere) ---- */
    const metaRes = await ctx.fetch(
      `https://geo.dailymotion.com/video/${encodeURIComponent(match.mediaId)}.json?legacy=true`,
      { headers: DM_HEADERS, signal: AbortSignal.timeout(12_000) },
    );
    if (!metaRes.ok) {
      throw AppError.upstream(`Dailymotion metadata returned ${metaRes.status}.`);
    }

    const meta = (await metaRes.json()) as DailymotionMetadata;
    if (meta.error) {
      throw AppError.notFound(meta.error.title || 'That Dailymotion video is unavailable.');
    }
    if (meta.is_password_protected) {
      throw new AppError('requires_auth', 'That video is password protected.', 422);
    }

    const master = meta.qualities?.auto?.[0]?.url;
    if (!master) {
      throw AppError.upstream('Dailymotion returned no playable manifest for that video.');
    }

    /* ---- 2. the master playlist, to enumerate qualities ---- */
    const masterRes = await ctx.fetch(master, {
      headers: DM_HEADERS,
      signal: AbortSignal.timeout(12_000),
    });

    if (!masterRes.ok) {
      // The single most likely failure, and the one worth naming precisely.
      throw new AppError(
        'upstream_blocked',
        `Dailymotion's CDN refused this server (HTTP ${masterRes.status}). Its WAF blocks ` +
          'datacenter IPs, and no combination of headers or cookies changes that. ' +
          'Dailymotion needs a resolver on a residential connection.',
        503,
      );
    }

    const body = await masterRes.text();
    const variants = parseMasterPlaylist(body, master);
    if (variants.length === 0) {
      throw AppError.upstream('Dailymotion returned a manifest with no variants.');
    }

    /**
     * Each variant is a complete programme, not a video-only track: Dailymotion
     * interleaves audio into every rendition. That is why these are emitted as
     * `hls` rather than `video` — the browser assembles segments, and there is
     * nothing to mux against.
     */
    const streams: RawStream[] = variants.map((variant) => ({
      url: variant.url,
      kind: 'hls' as const,
      container: 'mp4',
      codec: variant.codecs?.split(',')[0]?.trim().split('.')[0] ?? 'avc1',
      ...(variant.width ? { width: variant.width } : {}),
      ...(variant.height ? { height: variant.height } : {}),
      ...(variant.bandwidth ? { bitrateKbps: Math.round(variant.bandwidth / 1000) } : {}),
      headers: { Referer: 'https://www.dailymotion.com/' },
    }));

    const thumbnails = meta.thumbnails ?? {};
    const widest = Object.keys(thumbnails)
      .map(Number)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a)[0];

    return {
      title: meta.title?.trim() || `Dailymotion ${match.mediaId}`,
      ...(meta.owner?.screenname ? { author: meta.owner.screenname } : {}),
      ...(meta.duration ? { durationSeconds: meta.duration } : {}),
      ...(widest && thumbnails[String(widest)]
        ? { thumbnailUrl: thumbnails[String(widest)]! }
        : {}),
      isLive: meta.mode === 'live',
      streams,
    };
  },

  /**
   * Dailymotion's Graph API is public and keyless for read-only video fields —
   * the cleanest metadata source of any platform here.
   */
  async enrich(match, ctx) {
    if (!match.mediaId) return {};
    const cacheKey = `dm:video:${match.mediaId}`;
    const cached = await ctx.cacheGet(cacheKey);
    if (cached) return JSON.parse(cached);

    const api = new URL(`https://api.dailymotion.com/video/${encodeURIComponent(match.mediaId)}`);
    api.searchParams.set('fields', 'title,duration,thumbnail_720_url,owner.screenname');

    const res = await ctx.fetch(api.toString(), {
      headers: { accept: 'application/json', 'user-agent': ctx.userAgent },
    });
    if (!res.ok) return {};

    const body = (await res.json()) as {
      title?: string;
      duration?: number;
      thumbnail_720_url?: string;
      'owner.screenname'?: string;
    };
    const meta = {
      title: body.title,
      author: body['owner.screenname'],
      durationSeconds: body.duration,
      thumbnailUrl: body.thumbnail_720_url,
    };
    await ctx.cachePut(cacheKey, JSON.stringify(meta), 21_600);
    return meta;
  },
});
