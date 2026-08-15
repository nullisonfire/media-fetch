import type { MiddlewareHandler } from 'hono';
import { errorBody, jsonResponse } from '../lib/http';
import type { Env } from '../config/env';

/**
 * Security headers for API responses.
 *
 * Static assets get their headers from public/_headers (Workers Assets serves
 * them without touching this middleware), so the two must be kept in agreement —
 * notably COOP/COEP, without which SharedArrayBuffer and therefore the
 * multithreaded muxer will not start.
 */
export const securityHeaders: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();

  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  // Proxied media is consumed by same-origin fetch() from the muxer, so
  // same-origin CORP is both sufficient and the tightest option.
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
};

/**
 * Same-origin enforcement instead of permissive CORS.
 *
 * This API exists only for this app's own frontend. Emitting
 * `Access-Control-Allow-Origin: *` would turn a rate-limited, signed proxy into
 * a public service that anyone can embed. Requests with no Origin header
 * (curl, server-side) are allowed through so the API stays scriptable by its
 * owner; browsers always send Origin on cross-origin calls, which is the case
 * we actually need to block.
 */
export const sameOriginOnly: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const origin = c.req.header('origin');
  if (origin) {
    const expected = new URL(c.req.url).origin;
    if (origin !== expected) {
      return jsonResponse(
        errorBody('invalid_request', 'Cross-origin requests are not permitted.'),
        403,
      );
    }
    c.header('Access-Control-Allow-Origin', expected);
    c.header('Vary', 'Origin');
  }
  return next();
};
