import { AppError } from '../lib/http';
import { joinResolverUrl, type RawStream, type ResolverBackend, type ResolverResult } from './types';

/**
 * Adapter for a self-hosted yt-dlp HTTP service.
 *
 * Expected contract (a reference implementation ships in `resolver-server/`):
 *   POST {base}/extract
 *   Authorization: Bearer <RESOLVER_TOKEN>
 *   { "url": "https://..." }
 *   -> 200 with yt-dlp's `--dump-single-json` object
 *
 * This is the recommended backend: it is the only one that enumerates every
 * format, which is what makes both the quality picker and the mux flow possible.
 */

/** Subset of yt-dlp's format object that we actually consume. */
interface YtDlpFormat {
  format_id?: string;
  url?: string;
  ext?: string;
  protocol?: string;
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  tbr?: number; // total bitrate, kbps
  abr?: number; // audio bitrate, kbps
  vbr?: number;
  filesize?: number;
  filesize_approx?: number;
  audio_channels?: number;
  asr?: number;
  dynamic_range?: string;
  http_headers?: Record<string, string>;
}

interface YtDlpPayload {
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  is_live?: boolean;
  formats?: YtDlpFormat[];
  url?: string;
  ext?: string;
  http_headers?: Record<string, string>;
}

/**
 * Only plain-HTTP progressive URLs are usable here. Segmented protocols
 * (`m3u8_native`, `http_dash_segments`) require client-side manifest parsing and
 * segment stitching, which is out of scope — including them would surface
 * options that fail at download time.
 */
const USABLE_PROTOCOLS = new Set(['https', 'http']);

const isNone = (codec: string | undefined): boolean =>
  !codec || codec === 'none' || codec === 'null';

/** Normalises yt-dlp's verbose codec strings to short families. */
function shortCodec(codec: string | undefined): string {
  if (!codec) return 'unknown';
  const c = codec.toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('h264')) return 'avc1';
  if (c.startsWith('hev1') || c.startsWith('hvc1') || c.startsWith('h265')) return 'hevc';
  if (c.startsWith('av01')) return 'av01';
  if (c.startsWith('vp9') || c === 'vp09') return 'vp9';
  if (c.startsWith('vp8')) return 'vp8';
  if (c.startsWith('mp4a')) return 'mp4a';
  if (c.startsWith('opus')) return 'opus';
  if (c.startsWith('vorbis')) return 'vorbis';
  if (c.startsWith('ec-3') || c.startsWith('ac-3')) return 'ac3';
  return c.split('.')[0] ?? c;
}

function toRawStream(format: YtDlpFormat): RawStream | null {
  if (!format.url) return null;
  if (format.protocol && !USABLE_PROTOCOLS.has(format.protocol)) return null;

  const hasVideo = !isNone(format.vcodec);
  const hasAudio = !isNone(format.acodec);
  if (!hasVideo && !hasAudio) return null;

  const kind = hasVideo && hasAudio ? 'muxed' : hasVideo ? 'video' : 'audio';
  const codec = shortCodec(hasVideo ? format.vcodec : format.acodec);

  const stream: RawStream = {
    url: format.url,
    kind,
    container: format.ext ?? (kind === 'audio' ? 'm4a' : 'mp4'),
    codec,
  };

  if (hasVideo) {
    if (format.width) stream.width = format.width;
    if (format.height) stream.height = format.height;
    if (format.fps) stream.fps = Math.round(format.fps);
    if (format.dynamic_range && format.dynamic_range !== 'SDR') stream.hdr = true;
  }
  if (hasAudio) {
    if (format.audio_channels) stream.audioChannels = format.audio_channels;
    if (format.asr) stream.audioSampleRate = format.asr;
  }

  const bitrate = format.tbr ?? format.vbr ?? format.abr;
  if (bitrate) stream.bitrateKbps = Math.round(bitrate);

  const size = format.filesize ?? format.filesize_approx;
  if (size) stream.sizeBytes = size;

  // Preserve Referer/Origin/User-Agent: some CDNs (notably Google's) validate
  // the UA against the client that minted the URL. The rest of yt-dlp's header
  // bundle is dropped as unnecessary.
  const headers = format.http_headers ?? {};
  const forwarded: Record<string, string> = {};
  for (const name of ['Referer', 'Origin', 'User-Agent']) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (value) forwarded[name] = value;
  }
  if (Object.keys(forwarded).length > 0) stream.headers = forwarded;

  return stream;
}

export function createYtDlpResolver(options: {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}): ResolverBackend {
  const { baseUrl, token, timeoutMs = 20_000 } = options;

  return {
    name: 'ytdlp',

    async resolve({ url }): Promise<ResolverResult> {
      const endpoint = joinResolverUrl(baseUrl, 'extract');

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Timeout or network failure — the resolver is down, not the user's fault.
        throw AppError.resolverDown(
          'The extraction service did not respond in time. Try again shortly.',
        );
      }

      if (response.status === 404) throw AppError.notFound();
      if (response.status === 401 || response.status === 403) {
        console.error(JSON.stringify({ level: 'error', event: 'resolver_auth_failed' }));
        throw AppError.resolverDown('The extraction service rejected our credentials.');
      }
      if (!response.ok) {
        console.warn(
          JSON.stringify({ level: 'warn', event: 'resolver_error', status: response.status }),
        );
        throw AppError.upstream('The platform would not release this media.');
      }

      const payload = (await response.json()) as YtDlpPayload;

      const candidates = payload.formats?.length
        ? payload.formats
        : // Single-format responses (some platforms) put the URL at the top level.
          payload.url
          ? [{ url: payload.url, ext: payload.ext, vcodec: 'unknown', acodec: 'unknown', http_headers: payload.http_headers }]
          : [];

      const streams = candidates
        .map(toRawStream)
        .filter((s): s is RawStream => s !== null)
        // De-duplicate identical URLs (yt-dlp sometimes lists a format twice).
        .filter((s, i, all) => all.findIndex((o) => o.url === s.url) === i)
        /**
         * Every URL here was signed by the CDN against the RESOLVER's IP, not
         * ours. Marking them lets assemble() route the byte fetch back through
         * the resolver — the only host whose address the signature accepts.
         */
        .map((s) => ({ ...s, viaResolver: true }));

      if (streams.length === 0) {
        throw AppError.upstream('No downloadable streams were found for that link.');
      }

      return {
        title: payload.title?.trim() || 'Untitled',
        author: payload.uploader ?? payload.channel,
        durationSeconds: payload.duration,
        thumbnailUrl: payload.thumbnail,
        isLive: Boolean(payload.is_live),
        streams,
      };
    },
  };
}
