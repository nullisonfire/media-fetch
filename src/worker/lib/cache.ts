import type { EnrichContext, ExtractContext } from '../platforms/types';
import { UPSTREAM_USER_AGENT, type Env } from '../config/env';

/**
 * Thin KV wrapper. Every helper swallows KV failures: a cache outage must
 * degrade to a slower request, never a failed one.
 */
export function createCache(env: Env) {
  return {
    /** Always a miss when KV is not bound. */
    async get(key: string): Promise<string | null> {
      if (!env.CACHE) return null;
      try {
        return await env.CACHE.get(key, 'text');
      } catch {
        return null;
      }
    },

    async put(key: string, value: string, ttlSeconds: number): Promise<void> {
      if (!env.CACHE) return;
      try {
        // KV enforces a 60s floor on expirationTtl.
        await env.CACHE.put(key, value, { expirationTtl: Math.max(60, ttlSeconds) });
      } catch {
        /* non-fatal */
      }
    },

    async getJson<T>(key: string): Promise<T | null> {
      const raw = await this.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
  };
}

export type Cache = ReturnType<typeof createCache>;

/** Builds the context handed to provider.enrich(). */
export function createEnrichContext(env: Env): EnrichContext {
  const cache = createCache(env);
  return {
    fetch: fetch.bind(globalThis),
    cacheGet: (key) => cache.get(key),
    cachePut: (key, value, ttl) => cache.put(key, value, ttl),
    userAgent: UPSTREAM_USER_AGENT,
  };
}

/**
 * Builds the context handed to provider.extract().
 *
 * Credentials are read straight from the environment here so no provider needs
 * to know how secrets are stored, and so a missing credential is simply
 * `undefined` rather than a crash — every extractor must work anonymously.
 */
export function createExtractContext(env: Env): ExtractContext {
  return {
    ...createEnrichContext(env),
    credentials: {
      ...(env.BILIBILI_COOKIE ? { bilibiliCookie: env.BILIBILI_COOKIE } : {}),
      ...(env.INSTAGRAM_COOKIE ? { instagramCookie: env.INSTAGRAM_COOKIE } : {}),
    },
  };
}
