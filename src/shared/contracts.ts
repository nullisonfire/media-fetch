/**
 * The API contract, defined once with Zod and shared by the Worker (runtime
 * validation of untrusted input) and the client (compile-time types + response
 * parsing). If this file and the UI ever disagree, the build fails — which is
 * the entire point of keeping it here rather than duplicating interfaces.
 */
import { z } from 'zod';
import { PLATFORM_IDS } from './platforms';

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

export const platformIdSchema = z.enum(PLATFORM_IDS);

/**
 * `muxed` = progressive file that already contains both tracks.
 * `video` / `audio` = adaptive, single-track — these need the in-browser muxer
 *   to be recombined at full quality.
 * `hls`   = an HLS variant playlist. Already contains both tracks, but arrives as
 *   hundreds of segments that the browser must fetch and concatenate before
 *   remuxing into a single file. Dailymotion serves only this shape.
 */
export const trackKindSchema = z.enum(['muxed', 'video', 'audio', 'hls']);
export type TrackKind = z.infer<typeof trackKindSchema>;

export const streamVariantSchema = z.object({
  /** Stable within a single resolve response; used as the <option> value. */
  id: z.string().min(1),
  kind: trackKindSchema,
  /** Container as reported by the resolver: mp4 | webm | m4a | mp3 | flv. */
  container: z.string().min(1),
  /** Codec short name: avc1 | vp9 | av01 | mp4a | opus. */
  codec: z.string().min(1),

  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  hdr: z.boolean().optional(),

  audioChannels: z.number().int().positive().optional(),
  audioSampleRate: z.number().int().positive().optional(),

  bitrateKbps: z.number().positive().optional(),
  /** Absent when the upstream does not advertise Content-Length. */
  sizeBytes: z.number().int().nonnegative().optional(),

  /** Pre-rendered human label, e.g. "1080p60 · AVC · 4.2 MB/s". */
  label: z.string().min(1),

  /**
   * Same-origin, HMAC-signed proxy URL. The raw upstream URL is never sent to
   * the browser: it usually carries IP/session-bound tokens and would leak
   * upstream credentials into client-side history.
   */
  proxyUrl: z.string().min(1),
});
export type StreamVariant = z.infer<typeof streamVariantSchema>;

export const resolvedMediaSchema = z.object({
  platform: platformIdSchema,
  /** The URL the user pasted, normalised. */
  canonicalUrl: z.string().url(),
  /** Platform-native id (video id, BV id, shortcode). */
  mediaId: z.string().min(1),

  title: z.string(),
  author: z.string().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  thumbnailUrl: z.string().optional(),
  isLive: z.boolean().default(false),

  variants: z.array(streamVariantSchema),

  /**
   * Resolver's opinion, so the UI can preselect without re-implementing quality
   * ranking. `video`+`audio` are populated when the best result needs a mux.
   */
  recommended: z.object({
    muxed: z.string().optional(),
    video: z.string().optional(),
    audio: z.string().optional(),
  }),

  /** True when the highest available quality is only reachable via a mux. */
  bestRequiresMux: z.boolean(),

  /** Epoch ms. Signed proxy URLs stop working after this. */
  expiresAt: z.number().int().positive(),
});
export type ResolvedMedia = z.infer<typeof resolvedMediaSchema>;

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

/** 2 KB ceiling: no legitimate media URL is longer, and it caps abuse cheaply. */
const urlInput = z.string().trim().min(4).max(2048);

export const detectRequestSchema = z.object({ url: urlInput });
export type DetectRequest = z.infer<typeof detectRequestSchema>;

export const resolveRequestSchema = z.object({
  url: urlInput,
  /**
   * Set when the user overrides detection with the dropdown. When omitted the
   * server runs smart detection.
   */
  platform: platformIdSchema.optional(),
});
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

export const detectionSchema = z.object({
  /** null when no provider claimed the URL — the UI then forces the dropdown. */
  platform: platformIdSchema.nullable(),
  /** 0..1. Below CONFIDENCE_THRESHOLD the UI asks for confirmation. */
  confidence: z.number().min(0).max(1),
  canonicalUrl: z.string().optional(),
  mediaId: z.string().optional(),
  /** Other providers that partially matched, offered as quick alternatives. */
  candidates: z.array(platformIdSchema).default([]),
});
export type Detection = z.infer<typeof detectionSchema>;

/** Below this, the UI surfaces the manual dropdown instead of auto-resolving. */
export const CONFIDENCE_THRESHOLD = 0.75;

export const apiErrorSchema = z.object({
  error: z.object({
    /** Machine-readable; the UI maps these to friendly copy. */
    code: z.enum([
      'invalid_request',
      'unsupported_url',
      'ambiguous_url',
      'not_found',
      'geo_restricted',
      'requires_auth',
      'live_stream_unsupported',
      'rate_limited',
      'upstream_blocked',
      'resolver_unavailable',
      'upstream_error',
      'token_invalid',
      'token_expired',
      'configuration_error',
      'internal_error',
    ]),
    message: z.string(),
    /** Seconds, only on rate_limited. */
    retryAfter: z.number().int().positive().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorCode = ApiError['error']['code'];

export const detectResponseSchema = z.object({ ok: z.literal(true), detection: detectionSchema });
export const resolveResponseSchema = z.object({ ok: z.literal(true), media: resolvedMediaSchema });

/* ------------------------------------------------------------------ *
 * Muxing (client-side only, but typed here so the UI and worker agree on
 * which output containers are legal)
 * ------------------------------------------------------------------ */

export const OUTPUT_CONTAINERS = ['mp4', 'mkv', 'webm'] as const;
export type OutputContainer = (typeof OUTPUT_CONTAINERS)[number];

/**
 * Codec/container compatibility. Getting this wrong is the #1 source of
 * "muxed file won't play": e.g. VP9+Opus cannot be stream-copied into MP4 by
 * every player's expectations, and AVC cannot go into WebM at all.
 */
export const CONTAINER_SUPPORT: Record<OutputContainer, { video: string[]; audio: string[] }> = {
  mp4: { video: ['avc1', 'h264', 'av01', 'hevc', 'hvc1'], audio: ['mp4a', 'aac', 'opus'] },
  webm: { video: ['vp9', 'vp8', 'av01'], audio: ['opus', 'vorbis'] },
  mkv: { video: ['*'], audio: ['*'] }, // Matroska takes essentially anything.
};

/** Picks a container that can stream-copy both tracks (no re-encode). */
export function pickOutputContainer(videoCodec: string, audioCodec: string): OutputContainer {
  const v = videoCodec.toLowerCase();
  const a = audioCodec.toLowerCase();
  const fits = (c: OutputContainer) => {
    const s = CONTAINER_SUPPORT[c];
    const has = (list: string[], codec: string) =>
      list.includes('*') || list.some((x) => codec.startsWith(x));
    return has(s.video, v) && has(s.audio, a);
  };
  if (fits('mp4')) return 'mp4';
  if (fits('webm')) return 'webm';
  return 'mkv';
}
