import { Hono } from 'hono';
import { CONFIDENCE_THRESHOLD, resolveRequestSchema } from '@shared/contracts';
import { loadConfig, type Env } from '../config/env';
import { AppError, jsonResponse } from '../lib/http';
import { createCache, createEnrichContext, createExtractContext } from '../lib/cache';
import { resolveProvider } from '../platforms/registry';
import { createResolver } from '../resolver';
import { assembleResolvedMedia } from '../resolver/assemble';
import type { ResolverResult } from '../resolver/types';
import type { ProviderMetadata } from '../platforms/types';

export const resolveRoute = new Hono<{ Bindings: Env }>();

/**
 * How long raw extraction results are cached.
 *
 * Deliberately short. Upstream media URLs are themselves signed and
 * expiring (commonly ~6h, sometimes far less), so a long cache would serve links
 * that 403 on use. 10 minutes absorbs retries and "resolve then think about it"
 * behaviour without risking staleness.
 *
 * Note we cache the RAW resolver result, never the assembled response: proxy
 * tokens are minted fresh per request so a cache hit still yields a full-TTL
 * download window.
 */
const RESOLVE_CACHE_TTL_SECONDS = 600;

/** POST /api/resolve  { url, platform? } */
resolveRoute.post('/', async (c) => {
  const config = loadConfig(c.env);
  const body = resolveRequestSchema.parse(await c.req.json());

  const resolved = resolveProvider(body.url, body.platform);
  if (!resolved) {
    throw AppError.unsupported(
      'That link is not from a platform we support. Pick a platform manually if you think it should work.',
    );
  }
  const { provider, match } = resolved;

  /**
   * When detection is uncertain and the user has NOT overridden, refuse rather
   * than guess. A wrong guess produces a confusing failure several seconds later;
   * asking produces a correct result immediately.
   */
  if (!body.platform && match.confidence < CONFIDENCE_THRESHOLD) {
    throw AppError.ambiguous(
      'That link could not be matched to a platform with confidence. Choose one from the dropdown.',
    );
  }

  if (!match.mediaId && !match.extra?.['forced'] && !match.extra?.['shortlink']) {
    throw AppError.unsupported(
      'That looks like a profile, playlist or search page rather than a single video.',
    );
  }

  const cache = createCache(c.env);
  const cacheKey = `resolve:v1:${provider.id}:${match.canonicalUrl}`;

  let result = await cache.getJson<ResolverResult>(cacheKey);
  let metadata: ProviderMetadata = {};

  if (result) {
    // Metadata is cached independently inside enrich(), so this stays cheap.
    metadata = provider.enrich
      ? await provider.enrich(match, createEnrichContext(c.env)).catch(() => ({}))
      : {};
  } else {
    /**
     * NATIVE FIRST.
     *
     * When the provider can extract inside the Worker, use it and never contact
     * an external service — that is what lets this run entirely on Cloudflare
     * with no always-on machine anywhere.
     *
     * The resolver backend, if configured, is only a fallback: for platforms with
     * no native path (Dailymotion, whose CDN refuses datacenter IPs outright), or
     * when a native extractor breaks because a platform changed its private API.
     */
    const resolver = createResolver(config);

    const extractNatively = provider.extract
      ? provider.extract(match, createExtractContext(c.env))
      : null;

    // Extraction and metadata enrichment are independent — run them together so
    // the user waits for the slower of the two, not the sum.
    const enrichPromise = provider.enrich
      ? provider.enrich(match, createEnrichContext(c.env)).catch(() => ({}))
      : Promise.resolve({});

    let extraction: ResolverResult;
    if (extractNatively) {
      try {
        extraction = await extractNatively;
      } catch (nativeError) {
        if (!resolver) throw nativeError;
        // Native path failed and a fallback exists — try it, but if the fallback
        // also fails, surface the ORIGINAL error: it is the more specific one.
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'native_extract_failed',
            platform: provider.id,
            message: nativeError instanceof Error ? nativeError.message : 'unknown',
          }),
        );
        try {
          extraction = await resolver.resolve({
            platform: provider.id,
            match,
            url: match.canonicalUrl,
          });
        } catch {
          throw nativeError;
        }
      }
    } else if (resolver) {
      extraction = await resolver.resolve({
        platform: provider.id,
        match,
        url: match.canonicalUrl,
      });
    } else {
      throw AppError.resolverDown(
        `${provider.id} needs an external extraction service, which is not configured. ` +
          'Set RESOLVER_BASE_URL, or use a platform that resolves natively.',
      );
    }

    result = extraction;
    metadata = await enrichPromise;

    if (!result.isLive) {
      c.executionCtx.waitUntil(
        cache.put(cacheKey, JSON.stringify(result), RESOLVE_CACHE_TTL_SECONDS),
      );
    }
  }

  if (result.isLive) {
    throw new AppError(
      'live_stream_unsupported',
      'That is a live stream. It has no fixed end, so it cannot be downloaded as a file.',
      422,
    );
  }

  const media = await assembleResolvedMedia({
    platform: provider.id,
    canonicalUrl: match.canonicalUrl,
    mediaId: match.mediaId,
    result,
    metadata,
    signingKey: config.signingKey,
    ttlSeconds: config.proxyTokenTtlSeconds,
    origin: new URL(c.req.url).origin,
  });

  return jsonResponse({ ok: true, media });
});
