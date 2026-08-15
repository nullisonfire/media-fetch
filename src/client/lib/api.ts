import {
  apiErrorSchema,
  detectResponseSchema,
  resolveResponseSchema,
  type ApiErrorCode,
  type Detection,
  type ResolvedMedia,
} from '@shared/contracts';
import type { PlatformId } from '@shared/platforms';

/**
 * Typed API client.
 *
 * Responses are validated against the same Zod schemas the Worker uses, so a
 * contract drift surfaces as a clear error here instead of an
 * `undefined is not an object` five call frames deeper in the UI.
 */

export class ApiRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(
  path: string,
  body: unknown,
  parse: (data: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError('internal_error', 'Network request failed. Check your connection.');
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiRequestError(
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.retryAfter,
      );
    }
    throw new ApiRequestError('internal_error', `Request failed (HTTP ${response.status}).`);
  }

  try {
    return parse(payload);
  } catch {
    throw new ApiRequestError('internal_error', 'The server sent an unexpected response.');
  }
}

export function detectPlatform(url: string, signal?: AbortSignal): Promise<Detection> {
  return request(
    '/api/detect',
    { url },
    (data) => detectResponseSchema.parse(data).detection,
    signal,
  );
}

export function resolveMedia(
  url: string,
  platform?: PlatformId,
  signal?: AbortSignal,
): Promise<ResolvedMedia> {
  return request(
    '/api/resolve',
    { url, ...(platform ? { platform } : {}) },
    (data) => resolveResponseSchema.parse(data).media,
    signal,
  );
}

/** Friendly copy per error code. Keeps user-facing wording out of the UI logic. */
export const ERROR_COPY: Record<ApiErrorCode, string> = {
  invalid_request: 'That does not look like a valid link.',
  unsupported_url: 'That platform is not supported yet.',
  ambiguous_url: 'Pick the platform manually — we could not tell from the link.',
  not_found: 'That media is private, deleted, or does not exist.',
  geo_restricted: 'That media is blocked in this region.',
  requires_auth: 'That media requires signing in, so it cannot be fetched.',
  ip_locked_url:
    'That download is locked to the extraction server. Set RESOLVER_TOKEN on both ' +
    'the Worker and the resolver to enable the direct-from-resolver route.',
  live_stream_unsupported: 'Live streams cannot be saved as a file.',
  rate_limited: 'Too many requests. Give it a moment.',
  upstream_blocked:
    'The platform blocked this request from our servers. YouTube throttles datacenter IPs, so it needs a residential resolver.',
  resolver_unavailable: 'The extraction service is down. Try again shortly.',
  upstream_error: 'The platform refused the request.',
  token_invalid: 'That download link is not valid any more.',
  token_expired: 'The download link expired. Resolve the link again.',
  configuration_error:
    'This deployment is misconfigured. Check /api/health \u2014 it names the exact problem.',
  internal_error: 'Something went wrong. Try again.',
};
