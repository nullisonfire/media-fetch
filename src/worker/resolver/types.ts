import type { TrackKind } from '@shared/contracts';
import type { PlatformId } from '@shared/platforms';
import type { ProviderMatch } from '../platforms/types';

/** A single downloadable track as reported by the extraction backend. */
export interface RawStream {
  /** Direct upstream media URL. Never leaves the Worker unsigned. */
  url: string;
  kind: TrackKind;
  container: string;
  codec: string;

  width?: number;
  height?: number;
  fps?: number;
  hdr?: boolean;

  audioChannels?: number;
  audioSampleRate?: number;

  bitrateKbps?: number;
  sizeBytes?: number;

  /**
   * Headers the upstream CDN requires (typically Referer). Captured in the
   * signed token so the proxy can replay them; never exposed to the browser.
   */
  headers?: Record<string, string>;

  /**
   * Set when the browser should fetch this URL DIRECTLY rather than through the
   * proxy — see StreamVariant.directUrl. Used where the visitor's residential IP
   * succeeds and a datacenter IP does not.
   */
  directUrl?: string;
}

export interface ResolverResult {
  title: string;
  author?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  isLive: boolean;
  streams: RawStream[];
}

export interface ResolverInput {
  platform: PlatformId;
  match: ProviderMatch;
  /** The URL to hand the backend — canonical form when we have one. */
  url: string;
}

/**
 * Pluggable extraction backend.
 *
 * Deliberately an interface with an out-of-process implementation rather than
 * scraping logic inside the Worker, for three reasons:
 *
 *  1. Correctness — platform extraction breaks constantly; a dedicated service
 *     (yt-dlp) is maintained by people tracking those changes full-time.
 *  2. Runtime fit — Workers have no long-lived CPU budget and no native code.
 *  3. Separation of concerns — this app owns UX, transport and muxing; the
 *     backend owns extraction. Either can be replaced without touching the other.
 *
 * Point RESOLVER_BASE_URL at infrastructure YOU control. See README.
 */
export interface ResolverBackend {
  readonly name: string;
  resolve(input: ResolverInput): Promise<ResolverResult>;
}
