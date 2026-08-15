import { AppError } from '../lib/http';
import type { RawStream, ResolverResult } from '../resolver/types';
import { defineProvider, hostMatches, stripTracking } from './types';

/* ------------------------------------------------------------------ *
 * NATIVE IN-WORKER EXTRACTION — the public playurl API
 * ------------------------------------------------------------------ *
 *
 * Bilibili is the friendliest of the platforms here: everything needed is plain
 * JSON over HTTPS, so the Worker resolves it with no external service.
 *
 * Verified live from a datacenter IP before this was written:
 *   view API   -> code 0, cid + title + duration
 *   playurl    -> code 0, DASH with 6 video reps and 3 audio reps
 *   CDN        -> HTTP 206 with real bytes, and Referer was NOT required
 *
 * `fnval` is a bitmask of requested capabilities. 4048 = DASH + HDR + 4K +
 * Dolby + AV1, i.e. "give me everything you have"; the response is filtered to
 * whatever the account tier actually permits.
 *
 * QUALITY CEILING: anonymously, Bilibili caps the ladder at 480p. That is an
 * account restriction, not a bug — set the BILIBILI_COOKIE secret (a SESSDATA
 * value) to raise it to 1080p, or higher with a premium account.
 */
const FNVAL_EVERYTHING = 4048;

/** Quality ids Bilibili documents; used only to label what came back. */
const QUALITY_HEIGHT: Record<number, number> = {
  6: 240, 16: 360, 32: 480, 64: 720, 74: 720, 80: 1080,
  112: 1080, 116: 1080, 120: 2160, 125: 2160, 126: 2160, 127: 4320,
};

interface BiliDashRep {
  id?: number;
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
  bandwidth?: number;
  mimeType?: string;
  mime_type?: string;
  codecs?: string;
  width?: number;
  height?: number;
  frameRate?: string;
  frame_rate?: string;
}

interface BiliPlayurlData {
  quality?: number;
  timelength?: number;
  dash?: {
    duration?: number;
    video?: BiliDashRep[];
    audio?: BiliDashRep[];
    dolby?: { audio?: BiliDashRep[] };
    flac?: { audio?: BiliDashRep };
  };
  durl?: Array<{ url?: string; size?: number; length?: number; backup_url?: string[] }>;
  support_formats?: Array<{ quality?: number; new_description?: string; codecs?: string[] }>;
}

/** Normalises Bilibili's DASH codec strings to our short families. */
function shortCodec(codecs: string | undefined): string {
  const c = (codecs ?? '').toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('h264')) return 'avc1';
  if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'hevc';
  if (c.startsWith('av01')) return 'av01';
  if (c.startsWith('mp4a')) return 'mp4a';
  if (c.startsWith('fLaC') || c.startsWith('flac')) return 'flac';
  if (c.startsWith('ec-3')) return 'ac3';
  return c.split('.')[0] || 'unknown';
}

/** "30000/1001" -> 29.97 */
function parseFrameRate(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  if (raw.includes('/')) {
    const [num, den] = raw.split('/').map(Number);
    if (num && den) return Math.round((num / den) * 100) / 100;
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function repToStream(rep: BiliDashRep, kind: 'video' | 'audio'): RawStream | null {
  const url = rep.baseUrl ?? rep.base_url;
  if (!url) return null;

  const mime = rep.mimeType ?? rep.mime_type ?? '';
  const stream: RawStream = {
    url,
    kind,
    // Bilibili serves .m4s fragments that are plain fMP4 under the hood, so mp4
    // is the correct container hint for ffmpeg's demuxer.
    container: kind === 'audio' ? 'm4a' : 'mp4',
    codec: shortCodec(rep.codecs) || (mime.startsWith('audio') ? 'mp4a' : 'avc1'),
    // Sent even though the CDN did not require it in testing: some edges do.
    headers: { Referer: 'https://www.bilibili.com/' },
  };

  if (kind === 'video') {
    if (rep.width) stream.width = rep.width;
    if (rep.height) stream.height = rep.height;
    else if (rep.id && QUALITY_HEIGHT[rep.id]) stream.height = QUALITY_HEIGHT[rep.id];
    const fps = parseFrameRate(rep.frameRate ?? rep.frame_rate);
    if (fps) stream.fps = fps;
  }

  if (rep.bandwidth) stream.bitrateKbps = Math.round(rep.bandwidth / 1000);
  return stream;
}

const BV_ID = /^BV[A-Za-z0-9]{10}$/;
const AV_ID = /^av(\d+)$/i;
const EPISODE = /^(ep|ss)\d+$/i;

export const bilibili = defineProvider({
  id: 'bilibili',

  hosts: ['bilibili.com', 'b23.tv', 'bilibili.tv', 'bilibili.co'],

  cdnHosts: [
    'bilivideo.com', // primary DASH host
    'bilivideo.cn',
    'akamaized.net', // bilibili leases Akamai edges
    'hdslb.com', // images + some media mirrors
    'bilibili.com',
    'bilivideo.io',
  ],

  match(url) {
    if (!hostMatches(url.hostname, this.hosts)) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    const stripped = stripTracking(url, ['p']);

    // b23.tv/<code> — a shortlink. We can identify the platform with high
    // confidence but the real id only appears after a redirect, which the
    // resolver follows. Reported at 0.9: good enough to skip the dropdown.
    if (hostMatches(url.hostname, ['b23.tv'])) {
      const code = segments[0] ?? '';
      return {
        confidence: code ? 0.9 : 0.4,
        mediaId: code,
        canonicalUrl: `https://b23.tv/${code}`,
        extra: { shortlink: 'true' },
      };
    }

    // /video/BV… or /video/av…
    const videoIdx = segments.indexOf('video');
    if (videoIdx !== -1) {
      const raw = segments[videoIdx + 1] ?? '';
      // Multi-part videos: ?p=2 selects the page, default 1.
      const page = url.searchParams.get('p') ?? '1';
      const extra = { page };

      if (BV_ID.test(raw)) {
        return {
          confidence: 1,
          mediaId: raw,
          canonicalUrl: `https://www.bilibili.com/video/${raw}/${page === '1' ? '' : `?p=${page}`}`,
          extra,
        };
      }
      const av = AV_ID.exec(raw);
      if (av) {
        return {
          confidence: 1,
          mediaId: raw.toLowerCase(),
          canonicalUrl: `https://www.bilibili.com/video/${raw.toLowerCase()}/`,
          extra,
        };
      }
      if (raw) return { confidence: 0.6, mediaId: raw, canonicalUrl: stripped.toString(), extra };
    }

    // /bangumi/play/ep123456 | ss12345 (anime + licensed series)
    if (segments[0] === 'bangumi' && segments[1] === 'play') {
      const raw = segments[2] ?? '';
      if (EPISODE.test(raw)) {
        return {
          confidence: 1,
          mediaId: raw.toLowerCase(),
          canonicalUrl: `https://www.bilibili.com/bangumi/play/${raw.toLowerCase()}`,
          extra: { kind: 'bangumi' },
        };
      }
    }

    return { confidence: 0.4, mediaId: '', canonicalUrl: stripped.toString() };
  },

  /**
   * Resolves the full DASH ladder inside the Worker — no resolver service.
   */
  async extract(match, ctx): Promise<ResolverResult> {
    // Shortlinks and bangumi use different endpoints; hand those to the resolver
    // rather than pretending to support them.
    if (match.extra?.['shortlink'] === 'true') {
      throw AppError.unsupported(
        'Expand that b23.tv link to a full bilibili.com/video/BV… URL first.',
      );
    }
    if (match.extra?.['kind'] === 'bangumi') {
      throw AppError.unsupported(
        'Bangumi episodes use a separate licensed API that this app does not read.',
      );
    }
    if (!BV_ID.test(match.mediaId)) {
      throw AppError.unsupported('That is not a recognisable Bilibili video id.');
    }

    const cookie = ctx.credentials.bilibiliCookie;
    const headers: Record<string, string> = {
      'user-agent': ctx.userAgent,
      accept: 'application/json, text/plain, */*',
      // Bilibili's API layer rejects calls without a plausible origin pair.
      referer: 'https://www.bilibili.com/',
      origin: 'https://www.bilibili.com',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(cookie ? { cookie } : {}),
    };

    /* ---- 1. view API: cid is required by playurl ---- */
    const viewRes = await ctx.fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(match.mediaId)}`,
      { headers, signal: AbortSignal.timeout(12_000) },
    );
    if (!viewRes.ok) throw AppError.upstream(`Bilibili's view API returned ${viewRes.status}.`);

    const view = (await viewRes.json()) as {
      code?: number;
      message?: string;
      data?: {
        cid?: number;
        title?: string;
        duration?: number;
        pic?: string;
        owner?: { name?: string };
        pages?: Array<{ cid?: number; page?: number; part?: string }>;
      };
    };
    if (view.code !== 0 || !view.data) {
      // -404 is Bilibili's "nothing here"; -403 is region/permission.
      if (view.code === -404) throw AppError.notFound('That Bilibili video does not exist.');
      if (view.code === -403) {
        throw new AppError('geo_restricted', 'That video is restricted in this region.', 451);
      }
      throw AppError.upstream(view.message || 'Bilibili refused the metadata request.');
    }

    // Multi-part videos: ?p=N selects the page, and each page has its own cid.
    const pageNumber = Number(match.extra?.['page'] ?? '1');
    const pages = view.data.pages ?? [];
    const selected = pages.find((p) => p.page === pageNumber) ?? pages[0];
    const cid = selected?.cid ?? view.data.cid;
    if (!cid) throw AppError.upstream('Bilibili did not return a stream id (cid).');

    /* ---- 2. playurl: the actual streams ---- */
    const playurl = new URL('https://api.bilibili.com/x/player/playurl');
    playurl.searchParams.set('bvid', match.mediaId);
    playurl.searchParams.set('cid', String(cid));
    playurl.searchParams.set('fnval', String(FNVAL_EVERYTHING));
    playurl.searchParams.set('fourk', '1');

    const playRes = await ctx.fetch(playurl.toString(), {
      headers,
      signal: AbortSignal.timeout(12_000),
    });
    if (!playRes.ok) throw AppError.upstream(`Bilibili's playurl API returned ${playRes.status}.`);

    const play = (await playRes.json()) as { code?: number; message?: string; data?: BiliPlayurlData };
    if (play.code !== 0 || !play.data) {
      if (play.code === -404) throw AppError.notFound('Those streams are no longer available.');
      throw AppError.upstream(play.message || 'Bilibili refused to release the streams.');
    }

    const streams: RawStream[] = [];
    const dash = play.data.dash;

    if (dash) {
      for (const rep of dash.video ?? []) {
        const stream = repToStream(rep, 'video');
        if (stream) streams.push(stream);
      }
      for (const rep of dash.audio ?? []) {
        const stream = repToStream(rep, 'audio');
        if (stream) streams.push(stream);
      }
      // Dolby and FLAC live in their own sub-objects rather than the audio array.
      for (const rep of dash.dolby?.audio ?? []) {
        const stream = repToStream(rep, 'audio');
        if (stream) streams.push(stream);
      }
      if (dash.flac?.audio) {
        const stream = repToStream(dash.flac.audio, 'audio');
        if (stream) streams.push(stream);
      }
    } else if (play.data.durl?.length) {
      // Legacy progressive path (FLV/MP4), already muxed.
      for (const item of play.data.durl) {
        if (!item.url) continue;
        streams.push({
          url: item.url,
          kind: 'muxed',
          container: 'mp4',
          codec: 'avc1',
          ...(item.size ? { sizeBytes: item.size } : {}),
          ...(play.data.quality && QUALITY_HEIGHT[play.data.quality]
            ? { height: QUALITY_HEIGHT[play.data.quality] }
            : {}),
          headers: { Referer: 'https://www.bilibili.com/' },
        });
      }
    }

    if (streams.length === 0) {
      throw AppError.upstream('Bilibili returned no usable streams for that video.');
    }

    const durationSeconds =
      dash?.duration ??
      (play.data.timelength ? Math.round(play.data.timelength / 1000) : undefined) ??
      view.data.duration;

    return {
      title: view.data.title?.trim() || 'Untitled',
      ...(view.data.owner?.name ? { author: view.data.owner.name } : {}),
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(view.data.pic ? { thumbnailUrl: view.data.pic } : {}),
      isLive: false,
      streams,
    };
  },

  /**
   * Bilibili's public web API returns metadata without auth for public videos.
   * Cookie-gated content (paid bangumi, member-only) is intentionally NOT
   * handled here — that is an authenticated-content path we do not touch.
   */
  async enrich(match, ctx) {
    if (!BV_ID.test(match.mediaId)) return {};
    const cacheKey = `bili:view:${match.mediaId}`;
    const cached = await ctx.cacheGet(cacheKey);
    if (cached) return JSON.parse(cached);

    const api = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(match.mediaId)}`;
    const res = await ctx.fetch(api, {
      headers: {
        accept: 'application/json',
        'user-agent': ctx.userAgent,
        // Bilibili rejects API calls without a plausible referer.
        referer: 'https://www.bilibili.com/',
      },
    });
    if (!res.ok) return {};

    const body = (await res.json()) as {
      code?: number;
      data?: { title?: string; duration?: number; pic?: string; owner?: { name?: string } };
    };
    if (body.code !== 0 || !body.data) return {};

    const meta = {
      title: body.data.title,
      author: body.data.owner?.name,
      durationSeconds: body.data.duration,
      thumbnailUrl: body.data.pic,
    };
    await ctx.cachePut(cacheKey, JSON.stringify(meta), 21_600);
    return meta;
  },
});
