import type { Detection } from '@shared/contracts';
import type { PlatformId } from '@shared/platforms';
import { bilibili } from './bilibili';
import { dailymotion } from './dailymotion';
import { facebook } from './facebook';
import { instagram } from './instagram';
import { youtube } from './youtube';
import { hostMatches, type PlatformProvider } from './types';

/**
 * THE registry. Adding a platform is one import + one array entry; detection,
 * the UI dropdown, and the proxy allowlist all derive from here.
 */
export const PROVIDERS: readonly PlatformProvider[] = [
  youtube,
  bilibili,
  facebook,
  instagram,
  dailymotion,
];

const BY_ID = new Map<PlatformId, PlatformProvider>(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: PlatformId): PlatformProvider | undefined {
  return BY_ID.get(id);
}

/**
 * Union of every provider's CDN hosts — the proxy's allowlist.
 * Computed once at module scope (Workers keep this warm across requests).
 */
export const ALLOWED_CDN_HOSTS: readonly string[] = [
  ...new Set(PROVIDERS.flatMap((p) => p.cdnHosts.map((h) => h.toLowerCase()))),
];

export function isAllowedCdnHost(hostname: string): boolean {
  return hostMatches(hostname, ALLOWED_CDN_HOSTS);
}

/**
 * Pulls the first URL out of pasted text. Users paste "Check this out
 * https://youtu.be/… via @someone" far more often than a bare URL, and failing
 * on that is a needless dead end.
 */
export function extractUrl(input: string): string | null {
  const trimmed = input.trim();
  const match = /(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s<>"')\]]*)?/i.exec(trimmed);
  if (!match) return null;
  const raw = match[0];
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export function parseUrl(input: string): URL | null {
  const candidate = extractUrl(input);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    // Only ever accept http(s). Blocks data:, file:, blob:, javascript:.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Smart platform detection.
 *
 * Every provider gets a look and the highest-confidence claim wins. Providers
 * that partially matched are returned as `candidates` so the UI can offer them
 * as one-tap alternatives instead of making the user scan the full dropdown.
 */
export function detect(input: string): Detection {
  const url = parseUrl(input);
  if (!url) return { platform: null, confidence: 0, candidates: [] };

  const claims = PROVIDERS.flatMap((provider) => {
    let match;
    try {
      match = provider.match(url);
    } catch {
      // A broken provider must never take down detection for the others.
      return [];
    }
    return match ? [{ provider, match }] : [];
  }).sort((a, b) => b.match.confidence - a.match.confidence);

  const best = claims[0];
  if (!best) return { platform: null, confidence: 0, candidates: [] };

  return {
    platform: best.provider.id,
    confidence: best.match.confidence,
    canonicalUrl: best.match.canonicalUrl,
    mediaId: best.match.mediaId || undefined,
    candidates: claims.slice(1).map((c) => c.provider.id),
  };
}

/**
 * Resolves the provider to use, honouring an explicit user override from the
 * dropdown. Returns the provider plus its match so callers get the canonical id
 * without matching twice.
 */
export function resolveProvider(
  input: string,
  override?: PlatformId,
): { provider: PlatformProvider; match: NonNullable<ReturnType<PlatformProvider['match']>> } | null {
  const url = parseUrl(input);
  if (!url) return null;

  if (override) {
    const provider = getProvider(override);
    if (!provider) return null;
    // Trust the override even when the provider declines the URL shape: the
    // user may know about a link format we have not taught the matcher yet.
    const match = provider.match(url) ?? {
      confidence: 0.5,
      mediaId: '',
      canonicalUrl: url.toString(),
      extra: { forced: 'true' },
    };
    return { provider, match };
  }

  const detection = detect(input);
  if (!detection.platform) return null;
  const provider = getProvider(detection.platform);
  if (!provider) return null;
  const match = provider.match(url);
  return match ? { provider, match } : null;
}
