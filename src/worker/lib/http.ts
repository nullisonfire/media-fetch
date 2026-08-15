import type { Context } from 'hono';
import type { ApiErrorCode } from '@shared/contracts';

/**
 * Every non-2xx response in the app goes through here, so the client only ever
 * has to understand one error envelope.
 */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number = 400,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static invalidRequest(message = 'The request payload was not valid.') {
    return new AppError('invalid_request', message, 400);
  }
  static unsupported(message = 'That link is not from a supported platform.') {
    return new AppError('unsupported_url', message, 422);
  }
  static ambiguous(message = 'Could not identify the platform for that link.') {
    return new AppError('ambiguous_url', message, 422);
  }
  static notFound(message = 'That media could not be found or is private.') {
    return new AppError('not_found', message, 404);
  }
  static rateLimited(retryAfter: number) {
    return new AppError('rate_limited', 'Too many requests. Slow down a moment.', 429, retryAfter);
  }
  static resolverDown(message = 'The extraction service is unavailable.') {
    return new AppError('resolver_unavailable', message, 503);
  }
  static upstream(message = 'The platform refused the request.') {
    return new AppError('upstream_error', message, 502);
  }
  static internal(message = 'Something went wrong on our end.') {
    return new AppError('internal_error', message, 500);
  }
}

export function errorBody(code: ApiErrorCode, message: string, retryAfter?: number) {
  return { error: { code, message, ...(retryAfter ? { retryAfter } : {}) } };
}

/**
 * JSON responses are constructed directly rather than through `c.json()`.
 *
 * Hono types its status argument as a union of literal status codes, so passing a
 * plain `number` fails to compile and forces casts at every call site. Returning
 * a Response is equally valid to Hono, keeps the status type honest, and lets us
 * default `cache-control: no-store` — which matters because resolve payloads
 * contain signed, expiring URLs that must never be cached by an intermediary.
 */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/**
 * Best-effort client identity for rate limiting.
 * CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by the
 * client, unlike X-Forwarded-For — so it is the only header trusted here.
 */
export function clientKey(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}
