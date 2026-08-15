import type { PlatformId } from '@shared/platforms';
// Type-only import; erased at compile time, so the mutual reference with
// resolver/types.ts costs nothing at runtime.
import type { ResolverResult } from '../resolver/types';

/** Result of a provider claiming a URL. */
export interface ProviderMatch {
  /**
   * 0..1 confidence.
   *   1.00 — host + path + id all matched a known shape (e.g. /watch?v=<11 chars>)
   *   0.85 — host + recognisable path, id extracted heuristically
   *   0.50 — host matched but the path is not a known media shape
   * Anything below CONFIDENCE_THRESHOLD makes the UI ask the user to confirm
   * via the dropdown instead of guessing.
   */
  confidence: number;
  /** Platform-native identifier. */
  mediaId: string;
  /** Normalised URL with tracking params stripped — this is the cache key. */
  canonicalUrl: string;
  /**
   * Provider-specific extras forwarded to the resolver (e.g. bilibili page no.).
   *
   * The value type includes `undefined` deliberately. Providers return different
   * `extra` shapes from different branches of match(); TypeScript unions those
   * object literals and normalises the absent keys to `kind?: undefined`, which a
   * strict `Record<string, string>` rejects. Allowing undefined models what
   * actually happens instead of forcing every provider to cast.
   */
  extra?: Record<string, string | undefined>;
}

/** Metadata a provider can supply from a public/documented endpoint. */
export interface ProviderMetadata {
  title?: string;
  author?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

export interface EnrichContext {
  fetch: typeof fetch;
  /** Short-lived KV-backed memo, keyed by canonicalUrl. */
  cacheGet: (key: string) => Promise<string | null>;
  cachePut: (key: string, value: string, ttlSeconds: number) => Promise<void>;
  userAgent: string;
}

/**
 * Context for NATIVE extraction — the same helpers as enrich(), plus the
 * optional platform credentials that unlock higher qualities.
 *
 * Every credential here is optional by design: each native extractor must work
 * anonymously, and use a cookie only to raise quality ceilings. Nothing in this
 * project requires an account to function.
 */
export interface ExtractContext extends EnrichContext {
  credentials: {
    /** Bilibili SESSDATA. Without it the DASH ladder caps at 480p. */
    bilibiliCookie?: string;
    /** Instagram session cookie. Unlocks play_count and gated posts. */
    instagramCookie?: string;
  };
}

/**
 * A platform plugin.
 *
 * Providers are intentionally thin. They answer three questions —
 * "is this URL mine?", "what is its canonical id?", and "what public metadata
 * can I cheaply attach?" — and nothing else. Actual stream enumeration is the
 * resolver backend's job (src/worker/resolver), which keeps every provider
 * small, pure, and trivially unit-testable.
 */
export interface PlatformProvider {
  readonly id: PlatformId;

  /**
   * Hostnames owned by this platform, matched as exact or subdomain suffix.
   * Used both for detection short-listing and for building the proxy allowlist.
   */
  readonly hosts: readonly string[];

  /**
   * Upstream media/CDN host suffixes the stream proxy is permitted to fetch for
   * this platform. This is a security control, not a convenience list: the proxy
   * refuses any host absent from the union of every provider's cdnHosts, which
   * is what stops the endpoint being a general-purpose open relay.
   */
  readonly cdnHosts: readonly string[];

  /** Return null to decline the URL. Must not throw. */
  match(url: URL): ProviderMatch | null;

  /** Optional cheap metadata lookup (oEmbed / public API). Must never throw. */
  enrich?(match: ProviderMatch, ctx: EnrichContext): Promise<ProviderMetadata>;

  /**
   * NATIVE, IN-WORKER extraction.
   *
   * When a provider implements this, the Worker resolves the media entirely by
   * itself and the external resolver backend is never contacted — no second
   * service, no always-on machine, everything inside Cloudflare.
   *
   * Implement it only where the platform can genuinely be read with plain
   * fetch(): a JSON/HTTP endpoint, no JavaScript evaluation (Workers cannot
   * eval), no native binaries. Where that is not possible, omit it and the
   * request falls through to the resolver backend.
   *
   * Unlike match() and enrich(), this one MAY throw — an AppError with a
   * specific code produces a far better message than a generic failure.
   */
  extract?(match: ProviderMatch, ctx: ExtractContext): Promise<ResolverResult>;
}

/**
 * Helper that gives every provider identical shape and lets TS infer literals.
 * Also the single place to add cross-cutting provider behaviour later
 * (Future Extension: per-provider circuit breakers, metrics, feature flags).
 */
export function defineProvider(provider: PlatformProvider): PlatformProvider {
  return provider;
}

/** Exact host or any subdomain of it. Never substring-matches. */
export function hostMatches(hostname: string, suffixes: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return suffixes.some((raw) => {
    const s = raw.toLowerCase();
    return host === s || host.endsWith(`.${s}`);
  });
}

/** Tracking params stripped during canonicalisation, so caching is effective. */
const TRACKING_PARAMS = new Set([
  'si',
  'feature',
  'pp',
  'ab_channel',
  'spm_id_from',
  'vd_source',
  'from_source',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'igshid',
  'igsh',
  'img_index',
  'fbclid',
  'gclid',
  'mibextid',
  'rdid',
  '_rdr',
  'ref_src',
  'ref_url',
]);

export function stripTracking(url: URL, keep: readonly string[] = []): URL {
  const out = new URL(url.toString());
  const keepSet = new Set(keep);
  for (const key of [...out.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) && !keepSet.has(key)) out.searchParams.delete(key);
  }
  out.hash = '';
  return out;
}
