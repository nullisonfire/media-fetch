import { AppError } from '../lib/http';
import {
  extractJsonNumber,
  extractJsonString,
  extractMetaTag,
  META_DOCUMENT_HEADERS,
  parseDashManifest,
  shortCodec,
} from '../lib/meta-web';
import type { RawStream, ResolverResult } from '../resolver/types';
import { defineProvider, hostMatches, stripTracking, type ExtractContext } from './types';

/* ------------------------------------------------------------------ *
 * NATIVE IN-WORKER EXTRACTION — the embeddable player plugin
 * ------------------------------------------------------------------ *
 *
 * The key finding: `/reel/<id>` and `/videos/<id>` return HTTP 400 to a plain
 * datacenter GET, but `/plugins/video.php?href=...` cheerfully returns a
 * VideoConfig blob containing `hd_src` and `sd_src`, and needs no cookies at all.
 *
 * The `/watch/?v=<id>` page then supplies the og:* metadata the plugin lacks —
 * note that its og:title carries "<N> views · <M> reactions" as a prefix rather
 * than in a structured field.
 *
 * The two are independent, so they run in parallel and are merged.
 *
 * `hd_src` / `sd_src` are pre-muxed (ffprobe-confirmed: both carry an AAC
 * track), so they lead the format list. Any adaptive renditions found in an
 * inline DASH manifest follow, correctly flagged as silent.
 */

const NUMERIC_ID = /^\d{6,}$/;

interface PluginResult {
  hd: string | null;
  sd: string | null;
  dashManifest: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
}

interface PageResult {
  hd: string | null;
  sd: string | null;
  title: string | null;
  ownerName: string | null;
  caption: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
}

/** Strategy A — the embeddable player. The reliable route to the media. */
async function viaPlugin(videoId: string, ctx: ExtractContext): Promise<PluginResult | null> {
  const href = encodeURIComponent(`https://www.facebook.com/watch/?v=${videoId}`);
  const response = await ctx.fetch(
    `https://www.facebook.com/plugins/video.php?href=${href}&show_text=false&autoplay=false`,
    { headers: META_DOCUMENT_HEADERS, signal: AbortSignal.timeout(12_000) },
  );
  if (!response.ok) return null;

  const html = await response.text();
  const hd =
    extractJsonString(html, 'hd_src') ?? extractJsonString(html, 'hd_src_no_ratelimit');
  const sd =
    extractJsonString(html, 'sd_src') ?? extractJsonString(html, 'sd_src_no_ratelimit');
  if (!hd && !sd) return null;

  return {
    hd,
    sd,
    dashManifest: extractJsonString(html, 'dash_manifest'),
    durationSeconds: extractJsonNumber(html, 'video_duration'),
    width: extractJsonNumber(html, 'original_width') ?? extractJsonNumber(html, 'width'),
    height: extractJsonNumber(html, 'original_height') ?? extractJsonNumber(html, 'height'),
    thumbnailUrl:
      extractJsonString(html, 'preferred_thumbnail_image_uri') ??
      extractJsonString(html, 'thumbnail_src'),
  };
}

/** Strategy B — the watch page, for og:* metadata and sometimes progressive URLs. */
async function viaWatchPage(videoId: string, ctx: ExtractContext): Promise<PageResult | null> {
  const response = await ctx.fetch(`https://www.facebook.com/watch/?v=${videoId}`, {
    headers: META_DOCUMENT_HEADERS,
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return null;

  const html = await response.text();
  const ogTitle = extractMetaTag(html, 'og:title') ?? '';

  // og:title reads like "32K views · 484 reactions | How much should I tip? | ATTN:"
  const segments = ogTitle.split('|').map((s) => s.trim()).filter(Boolean);
  if (/views|reactions/i.test(segments[0] ?? '')) segments.shift();

  const progressive = [...html.matchAll(/"progressive_url":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => {
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return null;
      }
    })
    .filter((v): v is string => Boolean(v));

  const durationMs = extractJsonNumber(html, 'playable_duration_in_ms');

  return {
    hd:
      extractJsonString(html, 'browser_native_hd_url') ??
      extractJsonString(html, 'playable_url_quality_hd') ??
      progressive[0] ??
      null,
    sd:
      extractJsonString(html, 'browser_native_sd_url') ??
      extractJsonString(html, 'playable_url') ??
      progressive[1] ??
      null,
    title: segments[0] ?? null,
    ownerName: segments.length > 1 ? (segments[segments.length - 1] ?? null) : null,
    caption: extractMetaTag(html, 'og:description') ?? '',
    thumbnailUrl: extractMetaTag(html, 'og:image'),
    durationSeconds:
      durationMs != null ? durationMs / 1000 : extractJsonNumber(html, 'length_in_second'),
  };
}

export const facebook = defineProvider({
  id: 'facebook',

  hosts: ['facebook.com', 'fb.watch', 'fb.com', 'facebook.net'],

  cdnHosts: [
    'fbcdn.net', // video.*.fbcdn.net / scontent.*.fbcdn.net
    'facebook.com',
    'fbsbx.com',
  ],

  match(url) {
    if (!hostMatches(url.hostname, this.hosts)) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    const stripped = stripTracking(url, ['v']);

    // fb.watch/<code>/ — shortlink, resolved upstream via redirect.
    if (hostMatches(url.hostname, ['fb.watch'])) {
      const code = segments[0] ?? '';
      return {
        confidence: code ? 0.9 : 0.4,
        mediaId: code,
        canonicalUrl: `https://fb.watch/${code}/`,
        extra: { shortlink: 'true' },
      };
    }

    // /watch?v=<id>  and  /video.php?v=<id>
    const queryId = url.searchParams.get('v');
    if (queryId && NUMERIC_ID.test(queryId)) {
      return {
        confidence: 1,
        mediaId: queryId,
        canonicalUrl: `https://www.facebook.com/watch/?v=${queryId}`,
      };
    }

    // /<page-or-user>/videos/<slug?>/<id>/
    const videosIdx = segments.indexOf('videos');
    if (videosIdx !== -1) {
      const id = segments.slice(videosIdx + 1).findLast((s) => NUMERIC_ID.test(s));
      if (id) {
        return {
          confidence: 1,
          mediaId: id,
          canonicalUrl: `https://www.facebook.com/watch/?v=${id}`,
        };
      }
      return { confidence: 0.6, mediaId: '', canonicalUrl: stripped.toString() };
    }

    // /reel/<id>  and  /share/v/<code>
    if (segments[0] === 'reel' && segments[1]) {
      const id = segments[1];
      return {
        confidence: NUMERIC_ID.test(id) ? 1 : 0.8,
        mediaId: id,
        canonicalUrl: `https://www.facebook.com/reel/${id}`,
        extra: { kind: 'reel' },
      };
    }
    if (segments[0] === 'share' && (segments[1] === 'v' || segments[1] === 'r') && segments[2]) {
      return {
        confidence: 0.9,
        mediaId: segments[2],
        canonicalUrl: `https://www.facebook.com/share/${segments[1]}/${segments[2]}/`,
        extra: { shortlink: 'true' },
      };
    }

    return { confidence: 0.4, mediaId: '', canonicalUrl: stripped.toString() };
  },

  async extract(match, ctx): Promise<ResolverResult> {
    if (match.extra?.['shortlink'] === 'true' || !NUMERIC_ID.test(match.mediaId)) {
      // Resolving a shortlink means following a redirect chain that Facebook
      // gates differently per IP; be explicit rather than silently failing.
      throw AppError.unsupported(
        'Open that share link in a browser and paste the full /watch/?v=… or /reel/… URL.',
      );
    }

    // Independent strategies — run together so the user waits for the slower one,
    // not the sum.
    const [plugin, page] = await Promise.all([
      viaPlugin(match.mediaId, ctx).catch(() => null),
      viaWatchPage(match.mediaId, ctx).catch(() => null),
    ]);

    if (!plugin && !page) {
      throw AppError.upstream(
        'Facebook returned nothing usable for that video. It may be private or removed.',
      );
    }

    const hd = plugin?.hd ?? page?.hd ?? null;
    const sd = plugin?.sd ?? page?.sd ?? null;
    if (!hd && !sd) {
      throw new AppError(
        'requires_auth',
        'That video exists but its media is not readable anonymously — it is likely non-public.',
        422,
      );
    }

    const headers = { Referer: 'https://www.facebook.com/' };
    const streams: RawStream[] = [];

    // Progressive first: both are pre-muxed and directly playable.
    if (hd) {
      streams.push({
        url: hd,
        kind: 'muxed',
        container: 'mp4',
        codec: 'avc1',
        ...(plugin?.height ? { height: plugin.height } : {}),
        ...(plugin?.width ? { width: plugin.width } : {}),
        headers,
      });
    }
    if (sd && sd !== hd) {
      streams.push({ url: sd, kind: 'muxed', container: 'mp4', codec: 'avc1', headers });
    }

    // Adaptive renditions, when an inline manifest was present.
    const dash = parseDashManifest(plugin?.dashManifest);
    for (const rendition of dash.video) {
      streams.push({
        url: rendition.url,
        kind: rendition.hasAudio ? 'muxed' : 'video',
        container: rendition.mimeType.includes('webm') ? 'webm' : 'mp4',
        codec: shortCodec(rendition.codec, 'avc1'),
        ...(rendition.width ? { width: rendition.width } : {}),
        ...(rendition.height ? { height: rendition.height } : {}),
        ...(rendition.bitrateKbps ? { bitrateKbps: rendition.bitrateKbps } : {}),
        headers,
      });
    }
    for (const rendition of dash.audio) {
      streams.push({
        url: rendition.url,
        kind: 'audio',
        container: 'm4a',
        codec: shortCodec(rendition.codec, 'mp4a'),
        ...(rendition.bitrateKbps ? { bitrateKbps: rendition.bitrateKbps } : {}),
        headers,
      });
    }

    const durationSeconds =
      plugin?.durationSeconds ?? page?.durationSeconds ?? dash.durationSeconds ?? undefined;

    return {
      title: page?.title?.trim() || page?.caption?.split('\n')[0]?.slice(0, 120) || `Facebook ${match.mediaId}`,
      ...(page?.ownerName ? { author: page.ownerName } : {}),
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(page?.thumbnailUrl ?? plugin?.thumbnailUrl
        ? { thumbnailUrl: (page?.thumbnailUrl ?? plugin?.thumbnailUrl)! }
        : {}),
      isLive: false,
      streams,
    };
  },
});
