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

  /**
   * True when this URL was minted by the external resolver rather than by the
   * Worker.
   *
   * This matters because of how CDNs bind their signatures. A googlevideo URL
   * carries `ip=<the extractor's IP>` inside its signed `sparams`, so it returns
   * 403 to every other address on earth — including this Worker and including
   * the visitor's browser. Measured directly: the request 302s and comes back
   * with `ipbypass=yes&mip=<caller>`, then 403.
   *
   * Resolver-derived bytes are therefore fetchable ONLY from the resolver's own
   * IP. This flag tells assemble() to point the browser at the resolver's
   * passthrough endpoint rather than at the Worker proxy, which cannot work.
   */
  viaResolver?: boolean;
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


/**
 * Joins a path onto a resolver base URL, PRESERVING any path the base carries.
 *
 * `new URL('/extract', 'https://host/app')` yields `https://host/extract` — the
 * leading slash makes it root-absolute and silently discards `/app`. That breaks
 * every resolver mounted on a subpath (cPanel's "Setup Python App" mounts at a
 * path by default), and it fails as a confusing 404 from the wrong URL.
 */
export function joinResolverUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');
  return suffix ? `${base}/${suffix}` : base;
}
