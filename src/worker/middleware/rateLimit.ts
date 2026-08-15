import type { MiddlewareHandler } from 'hono';
import { AppError, clientKey } from '../lib/http';
import { createCache } from '../lib/cache';
import type { Env } from '../config/env';

/**
 * Fixed-window per-IP limiter backed by KV.
 *
 * Tradeoff, stated plainly: KV is eventually consistent, so a client hitting
 * several colos at once can exceed the nominal limit for a few seconds. That is
 * acceptable for abuse-dampening on a resolve endpoint, and KV keeps this
 * dependency-free.
 *
 * Future Optimization: swap for Cloudflare's native rate-limiting binding (or a
 * Durable Object) when strict, globally-consistent counting is required. Only
 * this file changes.
 */
export function rateLimit(options: {
  limitPerMinute: (env: Env) => number;
  bucket: string;
}): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const limit = options.limitPerMinute(c.env);
    if (limit <= 0) return next();

    // Counting needs somewhere to count. Without KV the limiter is a no-op —
    // deliberately fail-open, because an unavailable cache must not deny service.
    if (!c.env.CACHE) return next();

    const cache = createCache(c.env);
    const window = Math.floor(Date.now() / 60_000);
    const key = `rl:${options.bucket}:${window}:${clientKey(c)}`;

    const current = Number((await cache.get(key)) ?? '0');
    if (Number.isFinite(current) && current >= limit) {
      const retryAfter = 60 - Math.floor((Date.now() % 60_000) / 1000);
      throw AppError.rateLimited(Math.max(1, retryAfter));
    }

    // Write-behind: never make the user wait on the counter update.
    c.executionCtx.waitUntil(cache.put(key, String(current + 1), 120));

    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - current - 1)));
    return next();
  };
}
