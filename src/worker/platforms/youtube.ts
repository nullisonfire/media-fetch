import { AppError } from '../lib/http';
import type { RawStream, ResolverResult } from '../resolver/types';
import { defineProvider, hostMatches, stripTracking, type ProviderMatch } from './types';

/* ------------------------------------------------------------------ *
 * NATIVE IN-WORKER EXTRACTION — InnerTube, ANDROID_VR client
 * ------------------------------------------------------------------ *
 *
 * This is the whole reason YouTube can be served without any external service.
 *
 * WHY ANDROID_VR SPECIFICALLY
 * --------------------------
 * YouTube's other InnerTube clients return stream URLs whose `n` /signature
 * parameters are scrambled, and descrambling them means EXECUTING JavaScript
 * pulled from the player bundle. Cloudflare Workers cannot do that: `eval` and
 * `new Function` are unavailable by design. That single fact rules out the web
 * clients entirely.
 *
 * The ANDROID_VR (Oculus) client returns plain `url` fields with no cipher and
 * no Proof-of-Origin token. Verified live from a datacenter IP before this was
 * written: playabilityStatus OK, 27 formats, 27 with a direct URL, 0 requiring
 * a cipher, heights up to 2160p, and a ranged GET on the 2160p URL returned
 * HTTP 206 with real bytes.
 *
 * KNOWN FRAGILITY — read before relying on this
 * ---------------------------------------------
 * This is an undocumented client surface. YouTube has periodically degraded it
 * (in early 2026 it briefly returned only 360p to some callers), and it can be
 * changed or gated at any time without notice. Mitigations built in here:
 *   - playabilityStatus is mapped to precise, honest error codes.
 *   - If the response contains no directly usable URL we throw rather than
 *     returning a broken half-result.
 *   - A resolver backend, when configured, still acts as the fallback path.
 */

/** Oculus Quest client. clientName 28 is ANDROID_VR in InnerTube's enum. */
const ANDROID_VR = {
  clientName: 'ANDROID_VR',
  clientVersion: '1.62.27',
  clientNameId: '28',
  userAgent:
    'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; GB) gzip',
} as const;

interface InnerTubeFormat {
  itag?: number;
  url?: string;
  signatureCipher?: string;
  cipher?: string;
  mimeType?: string;
  bitrate?: number;
  averageBitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  contentLength?: string;
  audioChannels?: number;
  audioSampleRate?: string;
  quality?: string;
  qualityLabel?: string;
}

interface InnerTubePlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: {
    formats?: InnerTubeFormat[];
    adaptiveFormats?: InnerTubeFormat[];
    hlsManifestUrl?: string;
  };
  videoDetails?: {
    title?: string;
    author?: string;
    lengthSeconds?: string;
    isLive?: boolean;
    isLiveContent?: boolean;
    thumbnail?: { thumbnails?: Array<{ url?: string; width?: number }> };
  };
}

/** `video/mp4; codecs="avc1.640028"` -> { container: 'mp4', codec: 'avc1' } */
function parseMimeType(mimeType: string | undefined): {
  kind: 'video' | 'audio';
  container: string;
  codec: string;
} {
  const raw = mimeType ?? '';
  const kind = raw.startsWith('audio') ? 'audio' : 'video';
  const container = /\/(\w+)/.exec(raw)?.[1] ?? 'mp4';
  const codecList = /codecs="([^"]+)"/.exec(raw)?.[1] ?? '';
  // Adaptive formats carry exactly one codec; progressive ones carry two.
  const first = codecList.split(',')[0]?.trim() ?? '';
  const family = first.split('.')[0] ?? 'unknown';
  const normalised =
    family === 'avc1' || family === 'h264'
      ? 'avc1'
      : family === 'mp4a'
        ? 'mp4a'
        : family === 'vp9' || family === 'vp09'
          ? 'vp9'
          : family === 'av01'
            ? 'av01'
            : family || 'unknown';
  // An audio-only MP4 is conventionally .m4a; keeping it as .mp4 makes the proxy
  // label it video/mp4 and browsers then treat an audio download as a video.
  const normalisedContainer =
    container === 'mpeg' ? 'mp3' : kind === 'audio' && container === 'mp4' ? 'm4a' : container;
  return { kind, container: normalisedContainer, codec: normalised };
}

/** Maps playabilityStatus onto our stable client-facing error codes. */
function assertPlayable(status: string | undefined, reason: string | undefined): void {
  switch (status) {
    case 'OK':
      return;
    case 'LOGIN_REQUIRED':
      /**
       * YouTube overloads LOGIN_REQUIRED. The `reason` text is the only way to
       * tell a genuinely private video from the datacenter-IP bot check, and
       * conflating them produces a badly misleading error — the user goes
       * hunting for a permissions problem that does not exist.
       */
      if (/not a bot|confirm you|unusual traffic/i.test(reason ?? '')) {
        throw new AppError(
          'upstream_blocked',
          'YouTube served its "confirm you are not a bot" check. That is what YouTube does ' +
            'to datacenter IPs, which is what Cloudflare egresses from. Point RESOLVER_BASE_URL ' +
            'at a resolver on a residential connection to handle YouTube.',
          503,
        );
      }
      throw new AppError(
        'requires_auth',
        reason?.includes('age')
          ? 'That video is age-restricted, so it cannot be fetched anonymously.'
          : 'That video is private or requires signing in.',
        422,
      );
    case 'AGE_VERIFICATION_REQUIRED':
      throw new AppError('requires_auth', 'That video requires age verification.', 422);
    case 'UNPLAYABLE':
      throw new AppError('not_found', reason || 'That video cannot be played.', 404);
    case 'ERROR':
      throw AppError.notFound(reason || 'That video does not exist or was removed.');
    case 'LIVE_STREAM_OFFLINE':
      throw new AppError('live_stream_unsupported', 'That live stream is offline.', 422);
    default:
      throw AppError.upstream(
        reason ? `YouTube refused: ${reason}` : 'YouTube would not release this video.',
      );
  }
}

/** YouTube ids are always exactly 11 chars of base64url. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PATH_ID_ROUTES = ['shorts', 'live', 'embed', 'v'] as const;

function ok(mediaId: string, canonical: string, confidence = 1): ProviderMatch {
  return { confidence, mediaId, canonicalUrl: canonical };
}

export const youtube = defineProvider({
  id: 'youtube',

  hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'yt.be'],

  cdnHosts: [
    'googlevideo.com', // the actual media CDN for every itag
    'ytimg.com', // thumbnails
    'youtube.com',
    'ggpht.com', // channel avatars
  ],

  match(url) {
    if (!hostMatches(url.hostname, this.hosts)) return null;

    const canonicalFor = (id: string) => `https://www.youtube.com/watch?v=${id}`;
    const segments = url.pathname.split('/').filter(Boolean);

    // youtu.be/<id>
    if (hostMatches(url.hostname, ['youtu.be', 'yt.be'])) {
      const id = segments[0];
      if (id && VIDEO_ID.test(id)) return ok(id, canonicalFor(id));
      return { confidence: 0.5, mediaId: id ?? '', canonicalUrl: stripTracking(url).toString() };
    }

    // /watch?v=<id>
    const queryId = url.searchParams.get('v');
    if (queryId && VIDEO_ID.test(queryId)) return ok(queryId, canonicalFor(queryId));

    // /shorts/<id>, /live/<id>, /embed/<id>, /v/<id>
    const [head, tail] = segments;
    if (head && tail && (PATH_ID_ROUTES as readonly string[]).includes(head)) {
      if (VIDEO_ID.test(tail)) return ok(tail, canonicalFor(tail));
      return { confidence: 0.6, mediaId: tail, canonicalUrl: stripTracking(url).toString() };
    }

    // Playlist-only or channel URL: ours, but not a single downloadable item.
    // Reported low so the UI can explain rather than fail opaquely.
    return { confidence: 0.35, mediaId: '', canonicalUrl: stripTracking(url).toString() };
  },

  /**
   * Resolves every stream entirely inside the Worker. No resolver service, no
   * always-on machine, no egress beyond one JSON POST.
   */
  async extract(match, ctx): Promise<ResolverResult> {
    if (!match.mediaId) {
      throw AppError.unsupported(
        'That looks like a channel or playlist page rather than a single video.',
      );
    }

    const payload = {
      context: {
        client: {
          clientName: ANDROID_VR.clientName,
          clientVersion: ANDROID_VR.clientVersion,
          deviceMake: 'Oculus',
          deviceModel: 'Quest 3',
          osName: 'Android',
          osVersion: '12',
          androidSdkVersion: 32,
          hl: 'en',
          gl: 'US',
          userAgent: ANDROID_VR.userAgent,
        },
      },
      videoId: match.mediaId,
      // Both flags are required or age-gated-but-public videos return UNPLAYABLE.
      contentCheckOk: true,
      racyCheckOk: true,
    };

    let response: Response;
    try {
      response = await ctx.fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': ANDROID_VR.userAgent,
          'x-youtube-client-name': ANDROID_VR.clientNameId,
          'x-youtube-client-version': ANDROID_VR.clientVersion,
          'accept-language': 'en-US,en;q=0.9',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw AppError.upstream('YouTube did not respond in time.');
    }

    if (!response.ok) {
      throw AppError.upstream(`YouTube's player API returned ${response.status}.`);
    }

    const body = (await response.json()) as InnerTubePlayerResponse;
    assertPlayable(body.playabilityStatus?.status, body.playabilityStatus?.reason);

    const details = body.videoDetails;
    const isLive = Boolean(details?.isLive);

    const candidates = [
      ...(body.streamingData?.formats ?? []),
      ...(body.streamingData?.adaptiveFormats ?? []),
    ];

    const streams: RawStream[] = [];
    let cipheredCount = 0;

    for (const format of candidates) {
      if (!format.url) {
        // A ciphered URL would need JS to unscramble, which a Worker cannot do.
        if (format.signatureCipher || format.cipher) cipheredCount += 1;
        continue;
      }
      const { kind, container, codec } = parseMimeType(format.mimeType);
      const isProgressive = (format.mimeType ?? '').includes(',');

      const stream: RawStream = {
        url: format.url,
        kind: kind === 'audio' ? 'audio' : isProgressive ? 'muxed' : 'video',
        container,
        codec,
        // GVS checks the UA against the client that minted the URL, so the proxy
        // must replay this exact string.
        headers: { 'User-Agent': ANDROID_VR.userAgent },
      };

      if (kind === 'video') {
        if (format.width) stream.width = format.width;
        if (format.height) stream.height = format.height;
        if (format.fps) stream.fps = format.fps;
      } else {
        if (format.audioChannels) stream.audioChannels = format.audioChannels;
        const sampleRate = Number(format.audioSampleRate);
        if (Number.isFinite(sampleRate) && sampleRate > 0) stream.audioSampleRate = sampleRate;
      }

      const bitrate = format.averageBitrate ?? format.bitrate;
      if (bitrate) stream.bitrateKbps = Math.round(bitrate / 1000);

      const size = Number(format.contentLength);
      if (Number.isFinite(size) && size > 0) stream.sizeBytes = size;

      streams.push(stream);
    }

    if (streams.length === 0) {
      throw AppError.upstream(
        cipheredCount > 0
          ? 'YouTube returned only scrambled stream URLs, which cannot be unscrambled at the edge.'
          : 'YouTube returned no downloadable streams for that video.',
      );
    }

    const thumbnails = details?.thumbnail?.thumbnails ?? [];
    const widest = thumbnails.reduce<{ url?: string; width?: number } | undefined>(
      (best, current) => ((current.width ?? 0) > (best?.width ?? 0) ? current : best),
      undefined,
    );

    const lengthSeconds = Number(details?.lengthSeconds);

    return {
      title: details?.title?.trim() || 'Untitled',
      ...(details?.author ? { author: details.author } : {}),
      ...(Number.isFinite(lengthSeconds) && lengthSeconds > 0
        ? { durationSeconds: lengthSeconds }
        : {}),
      ...(widest?.url ? { thumbnailUrl: widest.url } : {}),
      isLive,
      streams,
    };
  },

  /**
   * oEmbed is public, keyless, and cheap — enough for title/author/thumbnail so
   * the UI can render a preview card immediately, in parallel with the slower
   * stream resolution.
   */
  async enrich(match, ctx) {
    if (!match.mediaId) return {};
    const cacheKey = `yt:oembed:${match.mediaId}`;
    const cached = await ctx.cacheGet(cacheKey);
    if (cached) return JSON.parse(cached);

    const endpoint = new URL('https://www.youtube.com/oembed');
    endpoint.searchParams.set('url', match.canonicalUrl);
    endpoint.searchParams.set('format', 'json');

    const res = await ctx.fetch(endpoint.toString(), {
      headers: { accept: 'application/json', 'user-agent': ctx.userAgent },
    });
    if (!res.ok) return {};

    const body = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    const meta = {
      title: body.title,
      author: body.author_name,
      // maxresdefault is not guaranteed to exist; hqdefault always is.
      thumbnailUrl: body.thumbnail_url ?? `https://i.ytimg.com/vi/${match.mediaId}/hqdefault.jpg`,
    };
    await ctx.cachePut(cacheKey, JSON.stringify(meta), 21_600);
    return meta;
  },
});
