import type { ErrorHandler, NotFoundHandler } from 'hono';
import { ZodError } from 'zod';
import { AppError, errorBody, jsonResponse } from '../lib/http';
import { UpstreamRejected } from '../lib/ssrf';
import { ConfigError, type Env } from '../config/env';

/**
 * Single funnel for every thrown error.
 *
 * Rule: internal detail (stack traces, upstream URLs, resolver responses) is
 * logged but NEVER returned. Clients get a stable code plus copy safe to render.
 */
export const onError: ErrorHandler<{ Bindings: Env }> = (err, c) => {
  if (err instanceof AppError) {
    return jsonResponse(
      errorBody(err.code, err.message, err.retryAfter),
      err.status,
      err.retryAfter ? { 'retry-after': String(err.retryAfter) } : {},
    );
  }

  /**
   * Misconfiguration is an OPERATOR error, not a mystery. Report exactly which
   * binding is wrong and how to fix it — this is the difference between a
   * two-minute fix and an afternoon. Secret values are never echoed.
   */
  if (err instanceof ConfigError) {
    console.error(
      JSON.stringify({ level: 'error', event: 'config_invalid', problems: err.problems }),
    );
    return jsonResponse(
      {
        error: {
          code: 'configuration_error',
          message: `This deployment is not configured correctly. ${err.problems.join(' ')}`,
        },
      },
      503,
    );
  }

  if (err instanceof ZodError) {
    const detail = err.issues[0];
    const where = detail?.path.join('.') || 'request';
    return jsonResponse(
      errorBody('invalid_request', `Invalid ${where}: ${detail?.message ?? 'malformed input'}`),
      400,
    );
  }

  if (err instanceof UpstreamRejected) {
    // `reason` is a fixed enum string, safe to log; the URL is deliberately not.
    console.warn(JSON.stringify({ level: 'warn', event: 'upstream_rejected', reason: err.reason }));
    return jsonResponse(
      errorBody('upstream_error', 'That media host is not permitted or unreachable.'),
      502,
    );
  }

  console.error(
    JSON.stringify({
      level: 'error',
      event: 'unhandled_error',
      name: err.name,
      message: err.message,
      path: new URL(c.req.url).pathname,
    }),
  );

  return jsonResponse(errorBody('internal_error', 'Something went wrong on our end.'), 500);
};

export const onNotFound: NotFoundHandler<{ Bindings: Env }> = () =>
  jsonResponse(errorBody('not_found', 'No such endpoint.'), 404);
