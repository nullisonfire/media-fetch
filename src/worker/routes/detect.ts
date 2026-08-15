import { Hono } from 'hono';
import { detectRequestSchema } from '@shared/contracts';
import { detect } from '../platforms/registry';
import { jsonResponse } from '../lib/http';
import type { Env } from '../config/env';

export const detectRoute = new Hono<{ Bindings: Env }>();

/**
 * POST /api/detect  { url }
 *
 * Pure, synchronous, no network, no rate limit — it runs on every keystroke in
 * the paste box. Kept as a server route (rather than duplicated in the client) so
 * detection rules live in exactly one place, and so a new platform is recognised
 * without shipping a new client bundle.
 */
detectRoute.post('/', async (c) => {
  const { url } = detectRequestSchema.parse(await c.req.json());
  return jsonResponse({ ok: true, detection: detect(url) });
});

/** GET variant, for debugging and prefilled ?url= deep links. */
detectRoute.get('/', (c) => {
  const { url } = detectRequestSchema.parse({ url: c.req.query('url') ?? '' });
  return jsonResponse({ ok: true, detection: detect(url) });
});
