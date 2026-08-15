import { Hono } from 'hono';
import type { Env } from '../config/env';
import { AppError } from '../lib/http';

export const vendorRoute = new Hono<{ Bindings: Env }>();

/**
 * Serves the ffmpeg.wasm core from R2, same-origin.
 *
 * WHY THIS ROUTE EXISTS — two hard constraints collide:
 *
 *  1. `ffmpeg-core.wasm` is ~31 MiB. Cloudflare Workers Assets rejects any single
 *     file over 25 MiB, so the core CANNOT ship as a static asset.
 *  2. The app sets `COEP: require-corp` (required for SharedArrayBuffer, required
 *     for the multithreaded muxer). Under that policy a cross-origin fetch is
 *     blocked unless the origin sends CORP headers — so a public R2 URL or a CDN
 *     will not work either.
 *
 * Serving R2 bytes *through* the Worker satisfies both: no asset size limit, and
 * the browser sees a same-origin response. The file is immutable and edge-cached,
 * so this costs one R2 read per cold cache, not per user.
 *
 * Upload with: npm run upload:ffmpeg
 */

/**
 * Strict allowlist. The alternative — interpolating a path segment into an R2
 * key — is a path-traversal invitation, and there are exactly three files.
 */
const CORE_FILES: Record<string, string> = {
  'ffmpeg-core.js': 'text/javascript; charset=utf-8',
  'ffmpeg-core.wasm': 'application/wasm',
  'ffmpeg-core.worker.js': 'text/javascript; charset=utf-8',
};

vendorRoute.get('/ffmpeg/:file', async (c) => {
  const file = c.req.param('file');
  const contentType = CORE_FILES[file];
  if (!contentType) throw AppError.notFound('Unknown vendor asset.');

  if (!c.env.FFMPEG_BUCKET) {
    throw AppError.internal(
      'The ffmpeg core bucket is not configured. See README -> "Hosting the ffmpeg core".',
    );
  }

  const key = `ffmpeg/${file}`;
  // Range support matters here: the wasm is 31 MiB and browsers routinely issue
  // ranged requests for large binaries, especially on flaky connections.
  const range = c.req.header('range');
  const object = await c.env.FFMPEG_BUCKET.get(key, {
    ...(range ? { range: c.req.raw.headers } : {}),
  });

  if (!object) throw AppError.notFound('The ffmpeg core has not been uploaded yet.');

  const headers = new Headers();
  headers.set('content-type', contentType);
  headers.set('etag', object.httpEtag);
  // Version-pinned by the vendor script, so it can be cached indefinitely.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('accept-ranges', 'bytes');
  headers.set('x-content-type-options', 'nosniff');
  // The two headers that make cross-origin isolation work for this subresource.
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('cross-origin-embedder-policy', 'require-corp');

  // R2 sets `range` on the object when a ranged read was served.
  const hasRange = 'range' in object && object.range !== undefined;
  if (hasRange && object.size !== undefined) {
    const r = object.range as { offset?: number; length?: number };
    const offset = r.offset ?? 0;
    const length = r.length ?? object.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('content-length', String(object.size));
  return new Response(object.body, { status: 200, headers });
});
