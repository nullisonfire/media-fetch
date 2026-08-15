/**
 * ============================================================
 *  PLATFORM TEMPLATE — copy this file to add a new platform
 * ============================================================
 *
 * Checklist (all four steps, in order):
 *
 *  1. Copy to `src/worker/platforms/<id>.ts` and rename the export.
 *  2. Add `'<id>'` to PLATFORM_IDS and a descriptor to PLATFORMS in
 *     `src/shared/platforms.ts` (name, accent, glyph, hint).
 *  3. Import + append it to PROVIDERS in `src/worker/platforms/registry.ts`.
 *  4. Confirm your resolver backend actually supports the platform, and map the
 *     id in `src/worker/resolver/backend.ts` if its name differs there.
 *
 * That's it. Detection, the dropdown, the proxy allowlist, and the mux flow all
 * pick the new platform up with no further changes.
 *
 * ---- Design rules for providers ----
 *  - match() must be PURE and must never throw. No network, no I/O.
 *  - Confidence is a real signal, not decoration. Return <0.75 when you are
 *    genuinely unsure so the UI asks the user instead of guessing wrong.
 *  - cdnHosts is a security boundary. List only hosts that actually serve media
 *    for this platform. Never add a wildcard.
 *  - enrich() is optional, must never throw, and should only ever call public,
 *    keyless, documented endpoints. If a platform has no such endpoint, omit it
 *    and let the resolver supply metadata.
 */
import { defineProvider, hostMatches, stripTracking } from './types';

// Example: TikTok-style id shape. Replace with the real pattern.
const MEDIA_ID = /^\d{6,25}$/;

export const templatePlatform = defineProvider({
  // @ts-expect-error — remove once '<id>' is added to PLATFORM_IDS in shared/platforms.ts
  id: 'template',

  hosts: ['example.com', 'exmpl.short'],

  cdnHosts: ['cdn.example.com', 'video.example.net'],

  match(url) {
    if (!hostMatches(url.hostname, this.hosts)) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    const stripped = stripTracking(url);

    // Canonical shape: /video/<id>
    const idx = segments.indexOf('video');
    if (idx !== -1) {
      const raw = segments[idx + 1] ?? '';
      if (MEDIA_ID.test(raw)) {
        return {
          confidence: 1,
          mediaId: raw,
          canonicalUrl: `https://example.com/video/${raw}`,
        };
      }
      // Right host and route, unrecognised id -> let the resolver try, but flag
      // the uncertainty to the UI.
      return { confidence: 0.6, mediaId: raw, canonicalUrl: stripped.toString() };
    }

    // Host is ours but this is not a media page (profile, search, home).
    return { confidence: 0.4, mediaId: '', canonicalUrl: stripped.toString() };
  },

  async enrich(match, ctx) {
    if (!match.mediaId) return {};

    const cacheKey = `template:${match.mediaId}`;
    const cached = await ctx.cacheGet(cacheKey);
    if (cached) return JSON.parse(cached);

    const res = await ctx.fetch(`https://example.com/api/oembed?id=${match.mediaId}`, {
      headers: { accept: 'application/json', 'user-agent': ctx.userAgent },
    });
    if (!res.ok) return {};

    const body = (await res.json()) as { title?: string; author?: string };
    const meta = { title: body.title, author: body.author };
    await ctx.cachePut(cacheKey, JSON.stringify(meta), 21_600);
    return meta;
  },
});
