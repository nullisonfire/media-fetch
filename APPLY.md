# MediaFetch — resolver passthrough patch (rev 2)

Fixes YouTube `token_expired`, Dailymotion `upstream_blocked`, and the CSP
refusal that followed the first revision.

## Why

A googlevideo URL carries `ip=<the extracting host's IP>` inside its signed
`sparams`. Measured directly: request it from any other address and you get a 302
whose redirect carries `ipbypass=yes&mip=<caller>`, then 403. Cloudflare can never
fetch a resolver-extracted URL, and neither can the browser.

Dailymotion is the same wall from the other side — its CDN refuses datacenter IPs
*and* sends no `Access-Control-Allow-Origin`.

So the bytes must leave from the machine that extracted them. The resolver gains
a `/fetch` streaming endpoint and the browser streams from it directly; the
Worker never touches media. ffmpeg.wasm still muxes locally.

**rev 2** adds the piece rev 1 missed: the page shipped `connect-src 'self' blob:`,
so the browser blocked that cross-origin fetch. CSP lives in a static `_headers`
file that Workers Assets serves without invoking the Worker, so it cannot read
the resolver URL from the environment — and a `<meta>` CSP cannot help either,
because multiple policies intersect and can only restrict further. The build now
reads `RESOLVER_BASE_URL` out of the committed `wrangler.toml` and adds exactly
that origin to `connect-src` and `media-src`.

## Files

Unzip over your project root, preserving paths.

| File | Change |
|---|---|
| `resolver-cpanel/app.py` | **New `/fetch`** — HMAC-verified, host-allowlisted, Range-forwarding, CORS + CORP. Also adds 206/403/410/416 to the status table; 206 was missing, which mangles every ranged download |
| `scripts/build-headers.mjs` | **New.** Adds the resolver origin to the CSP at build time |
| `package.json` | `build` now runs that script after `vite build` |
| `src/worker/resolver/passthrough.ts` | **New.** Mints signed resolver-fetch URLs |
| `src/worker/resolver/types.ts` | `RawStream.viaResolver` marks IP-pinned URLs |
| `src/worker/resolver/ytdlp.ts` | Marks everything it returns |
| `src/worker/resolver/assemble.ts` | Emits `directUrl` pointing at the resolver |
| `src/worker/routes/resolve.ts` | Passes the passthrough config through |
| `src/worker/routes/stream.ts` | `ip_locked_url` — a 403 on a pinned URL no longer claims the link expired |
| `src/worker/index.ts` | `/api/health` echoes `resolverBaseUrl` + `resolverTokenSet` |
| `src/client/lib/muxer.ts` | A blocked cross-origin fetch now names CORS/CSP instead of blaming the track pair |
| `src/client/main.ts` | Prefers `directUrl` for single-file and mux downloads |
| `src/shared/contracts.ts`, `src/client/lib/api.ts` | New error code and copy |
| `wrangler.toml` | Single `[vars]` table, **pre-filled with your live resolver URL** — safe to overwrite |

## Deploy

**1. Resolver** — upload `resolver-cpanel/app.py`, then Setup Python App →
Environment variables:

| Variable | Value |
|---|---|
| `RESOLVER_TOKEN` | `openssl rand -hex 32` (you may already have one) |
| `ALLOWED_ORIGIN` | `https://media-fetch.zonal8731.workers.dev` |

Then **Restart**.

**2. Worker**

```bash
npx wrangler secret put RESOLVER_TOKEN   # the SAME value
git add -A && git commit -m "resolver byte passthrough + CSP" && git push
```

`RESOLVER_TOKEN` does two jobs now — it authenticates `/extract` and is the HMAC
key for `/fetch`. Disagree and you get 401 on extract, 403 on every download.

## Verify

```bash
curl https://media-fetch.zonal8731.workers.dev/api/health
curl https://sectester.xyz/media-fetch_resolver/health
```

Worker: `"resolverBaseUrl"` set, `"resolverTokenSet": true`, `"resolverFallback": true`.
Resolver: `"fetchPassthrough": "enabled"`, `"allowedOriginWarning": null`.

Then in the browser devtools Network tab, the CSP header on the document should
read `connect-src 'self' blob: https://sectester.xyz`. If it does not, the build
did not see `RESOLVER_BASE_URL` — check that `[vars]` is uncommented.

## Bandwidth

This moves real traffic through your cPanel account — a 1080p video is a few
hundred MB per download. `MAX_FETCH_MB` caps one response at 2 GB; nothing tracks
a monthly total. Shared hosts meter this and some suspend accounts that sustain
it. Bilibili, Facebook and Instagram extract natively and never touch the
resolver, so only YouTube and Dailymotion carry the cost.

## Security

`/fetch` is closed three independent ways, verified by test: HMAC signature
(forged and tampered rejected) with expiry inside the signed payload; a CDN host
allowlist enforced on the resolver (`169.254.169.254` and `evil-googlevideo.com`
both refused); and duplicate `?t=` parameters rejected rather than resolved by
precedence. The download filename comes from the signed payload, never the query
string.

The CSP addition is one named origin, not a `https:` wildcard.
