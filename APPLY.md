# MediaFetch — resolver passthrough patch

Fixes YouTube `token_expired` and Dailymotion `upstream_blocked`, which were the
same bug wearing two masks.

## Why

A googlevideo URL carries `ip=<the extracting host's IP>` inside its signed
`sparams`. Measured directly: request it from any other address and you get a 302
whose redirect carries `ipbypass=yes&mip=<caller>`, then a 403. The Cloudflare
Worker can never fetch a resolver-extracted URL, and neither can the browser.

Dailymotion's CDN is the same wall from the other side — it refuses datacenter
IPs *and* sends no `Access-Control-Allow-Origin`, closing the browser route too.

So the bytes must leave from the machine that did the extraction. The resolver
gains a `/fetch` streaming endpoint and the **browser streams from it directly**;
the Worker never touches media, so Cloudflare's CPU limits and egress stay out of
the picture. ffmpeg.wasm still muxes locally.

## Files

Unzip over your project root, preserving paths.

| File | Change |
|---|---|
| `resolver-cpanel/app.py` | **New `/fetch` endpoint.** HMAC-verified, host-allowlisted, Range-forwarding, CORS + CORP. Also adds 206/403/410/416 to the status table — 206 was missing, which mangles every ranged download |
| `src/worker/resolver/passthrough.ts` | **New.** Mints signed resolver-fetch URLs |
| `src/worker/resolver/types.ts` | `RawStream.viaResolver` marks IP-pinned URLs |
| `src/worker/resolver/ytdlp.ts` | Marks everything it returns as `viaResolver` |
| `src/worker/resolver/assemble.ts` | Emits `directUrl` pointing at the resolver |
| `src/worker/routes/resolve.ts` | Passes the passthrough config through |
| `src/worker/routes/stream.ts` | New `ip_locked_url` error — a 403 on a pinned URL no longer claims the link expired |
| `src/worker/index.ts` | `/api/health` echoes `resolverBaseUrl` + `resolverTokenSet` |
| `src/shared/contracts.ts`, `src/client/lib/api.ts` | The new error code and its copy |
| `src/client/main.ts` | Prefers `directUrl` for both single-file and mux downloads |
| `resolver-cpanel/README.md` | Setup for the above |
| `wrangler.toml` | Single `[vars]` table, **pre-filled with your live resolver URL** — safe to overwrite |

## Deploy

**1. Resolver** — upload `resolver-cpanel/app.py`, then cPanel → Setup Python App →
Environment variables:

| Variable | Value |
|---|---|
| `RESOLVER_TOKEN` | `openssl rand -hex 32` (you may already have one) |
| `ALLOWED_ORIGIN` | `https://media-fetch.zonal8731.workers.dev` |

Then **Restart**. `ALLOWED_ORIGIN` defaults to `*`, which works but lets any
website stream through your hosting account.

**2. Worker**

```bash
npx wrangler secret put RESOLVER_TOKEN   # the SAME value
git add -A && git commit -m "resolver byte passthrough" && git push
```

`RESOLVER_TOKEN` now does two jobs — it authenticates `/extract` and is the HMAC
key for `/fetch`. If the two sides disagree: 401 on extract, 403 on every
download. If it is missing on the Worker, no passthrough URLs are minted and
downloads fail with `ip_locked_url`, which says so.

## Verify

```bash
curl https://media-fetch.zonal8731.workers.dev/api/health
curl https://sectester.xyz/media-fetch_resolver/health
```

Worker: `"resolverBaseUrl"` shows your URL, `"resolverTokenSet": true`,
`"resolverFallback": true`.
Resolver: `"fetchPassthrough": "enabled"`, `"allowedOriginWarning": null`.

## Bandwidth

This moves real traffic through your cPanel account — a 1080p video is a few
hundred MB per download. `MAX_FETCH_MB` caps one response at 2 GB; nothing tracks
a monthly total. Shared hosts meter this and some suspend accounts that sustain
it. Bilibili, Facebook and Instagram extract natively in the Worker and never
touch the resolver, so only YouTube and Dailymotion carry the cost.

## Security notes

`/fetch` is closed three independent ways, verified by test:

- HMAC signature (forged and tampered tokens rejected), expiry inside the signed
  payload so it cannot be edited
- CDN host allowlist enforced on the resolver — `169.254.169.254` and
  `evil-googlevideo.com` both refused, so even a leaked key cannot turn it into a
  general-purpose proxy
- Duplicate `?t=` parameters rejected rather than resolved by precedence

The download filename comes from the signed payload, never the query string.
