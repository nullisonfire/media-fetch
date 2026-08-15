# MediaFetch

Multi-platform media downloader on Cloudflare Workers, with **audio/video muxing that runs in the browser**.

Paste a link → the platform is detected automatically (with a manual dropdown when detection is unsure) → pick a quality → if the best quality is split into separate audio and video streams, one button downloads both and combines them locally.

Supported today: **YouTube · Bilibili · Facebook · Instagram · Dailymotion**.
Adding another platform is one file plus one registry line.

---

## Why it is built this way

The two constraints that shaped every decision:

**1. Cloudflare Workers cannot mux.** No native binaries, and a bounded CPU budget per request. ffmpeg is a native binary that must touch every byte of a potentially multi-gigabyte file. So muxing happens **client-side in ffmpeg.wasm**, and it turns out to be the better design anyway:

| | Server-side mux | Client-side mux (this project) |
|---|---|---|
| Workers compatible | ✗ impossible | ✓ |
| Bandwidth cost | every byte twice | zero |
| Scaling | your CPU | the user's CPU |
| Privacy | media on your disks | media never leaves the device |
| Speed | queue + transfer | starts instantly |

Because we only ever **stream copy** (`-c copy`) — rewriting container headers, never re-encoding — a 1080p remux takes seconds and loses no quality.

**2. Most platforms can be read by the Worker itself; two cannot.** Each provider may implement `extract()` and resolve media natively inside the Worker — no second service, nothing to keep running. Where that is impossible, a pluggable `ResolverBackend` (yt-dlp or Cobalt) is the fallback.

| Platform | Native in Worker | Notes |
|---|---|---|
| **Bilibili** | ✅ yes | `playurl` API, DASH audio+video. Anonymous ceiling is 480p; set `BILIBILI_COOKIE` for 1080p+ |
| **Instagram** | ✅ yes | Logged-out Polaris GraphQL. Needs `Sec-Fetch-Site: same-origin`, which **only a Worker can send** |
| **Facebook** | ✅ yes | `/plugins/video.php` returns `hd_src`/`sd_src` with no cookies |
| **YouTube** | ⚠️ needs residential egress | InnerTube ANDROID_VR needs no JS and no PO token, but datacenter IPs get "confirm you're not a bot" |
| **Dailymotion** | ⚠️ unreliable | Metadata always works; the HLS manifest is behind a WAF that refuses datacenter IPs intermittently (~3/5 with retries) |

**Measured, not assumed.** Bilibili returns 6 video + 3 audio DASH reps and serves HTTP 206 bytes. Dailymotion resolves 3/3 test videos up to 1080p. YouTube's InnerTube ANDROID_VR client returns 27 formats, all with direct URLs and **zero** requiring JS signature descrambling — but only 1 of 9 test videos passed the bot check.

### Dailymotion: let the browser do it

`cdndirector.dailymotion.com` is behind a Cloudflare WAF that refuses datacenter
IPs. Measured, in order:

| Client | Result |
|---|---|
| curl / Node, byte-exact Chrome headers | 403, every time |
| same, with a bootstrapped guest cookie jar | 403 |
| **workerd** (same host, same IP) | 200 — then 4/6 — then **0/8** |

So it is not headers and not cookies: a different TLS fingerprint gets further,
and even that decays as an IP accumulates requests. Any server-side fetch of the
manifest is a coin flip.

**Could the browser fetch it instead?** That was the obvious escape — the visitor's
residential IP is not what the CDN blocks. It does not work, and the response
headers say exactly why:

```
access-control-allow-headers: X-Request-Origin     present
timing-allow-origin: *                             present
access-control-allow-origin:                       ABSENT
```

Without `Access-Control-Allow-Origin` the browser will never let JavaScript read
that response. Opening the same URL in a browser tab DOES work, because a
top-level navigation is not CORS-checked — which makes it look like the browser
can fetch it when `fetch()` cannot.

The code still exposes `directUrl` and tries it first: it costs one failed request,
and it starts working for free the day Dailymotion adds a CORS header. But the
working path today is the proxy, and that path is a coin flip.

**Practical position:** Dailymotion succeeds roughly 3 times in 5 with retries.
If that is not good enough, point `RESOLVER_BASE_URL` at a resolver on a
residential connection — the same fix YouTube needs. Bilibili, Facebook and
Instagram are unaffected and need nothing.

---

## Architecture

```
Browser                      Cloudflare Worker                Your resolver
───────                      ─────────────────                ─────────────
paste URL ──POST /api/detect──▶ platform registry
                                (pure, no network)
                             ◀── { platform, confidence }

  ── POST /api/resolve ──────▶ provider.match()
                               provider.enrich() ─┐ (public API, parallel)
                               resolver.resolve() ─┴──▶ POST /extract  (yt-dlp)
                               ◀── format list
                               rank · label · HMAC-sign each URL
                             ◀── ResolvedMedia { variants[] }

  ── GET /api/stream?t=… ────▶ verify HMAC · check expiry
                               SSRF guard · CDN allowlist
                               Range pass-through ──────▶ platform CDN
                             ◀── streamed bytes (never buffered)

ffmpeg.wasm: video + audio ──▶ single file ──▶ File System Access API ──▶ disk

HLS path (Dailymotion), where each variant already carries audio:
  GET /api/stream?t=… (kind=hls) ──▶ fetch playlist, REWRITE every segment URI
                                     into a signed same-origin proxy URL
  browser ── fetch ~N segments in parallel ──▶ join ──▶ ffmpeg -c copy ──▶ MP4
```

### Layout

```
src/
├── shared/            imported by BOTH sides — one source of truth
│   ├── contracts.ts     Zod schemas: runtime validation + compile-time types
│   └── platforms.ts     platform ids, names, brand colours, icons
├── worker/
│   ├── index.ts         Hono app, route table, middleware order
│   ├── config/env.ts    validated bindings (fails loudly if misconfigured)
│   ├── platforms/       ONE FILE PER PLATFORM + registry.ts + _template.ts
│   ├── resolver/        backend interface, yt-dlp + Cobalt adapters, assemble.ts
│   ├── routes/          detect · resolve · stream (proxy) · vendor (R2 core)
│   ├── middleware/      security headers · same-origin · rate limit · errors
│   └── lib/             HMAC signing · SSRF guards · KV cache · HTTP helpers
└── client/
    ├── main.ts          state, rendering, event wiring
    ├── styles.css       token-driven design system
    └── lib/
        ├── muxer.ts     ffmpeg.wasm — THE feature
        ├── capabilities.ts  probes, split out so the muxer stays lazily loaded
        ├── download.ts  streaming save to disk, with fallbacks
        ├── api.ts       typed client, responses validated against contracts
        └── format.ts    display formatters
resolver-server/       reference yt-dlp service (FastAPI + Dockerfile) — VPS / Pi
resolver-cpanel/       same contract as plain WSGI — cPanel "Setup Python App"
```

---

## Quickstart

### 1. Install

```bash
npm install          # postinstall vendors ffmpeg.wasm into vendor/ffmpeg/
```

See **[Hosting the ffmpeg core](#hosting-the-ffmpeg-core)** — it does not ship as a static asset, and the reason is a hard platform limit.

### 2. Run the resolver

```bash
cd resolver-server
pip install -r requirements.txt
export RESOLVER_TOKEN="$(openssl rand -hex 32)"
uvicorn app:app --port 8080
```

Or with Docker: `docker build -t mediafetch-resolver . && docker run -p 8080:8080 -e RESOLVER_TOKEN=… mediafetch-resolver`

### 3. Configure the Worker

```bash
cp .dev.vars.example .dev.vars
# set SIGNING_KEY (openssl rand -base64 48) and RESOLVER_TOKEN to match step 2
```

Create the KV namespace and paste the ids into `wrangler.toml`:

```bash
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create CACHE --preview
```

Create the R2 bucket and upload the ffmpeg core (once per ffmpeg version):

```bash
npx wrangler r2 bucket create mediafetch-vendor
npm run upload:ffmpeg
```

### 4. Develop

```bash
npm run dev      # open http://localhost:5173
```

Runs Vite on **:5173** (the app, with HMR) and `wrangler dev` on **:8787** (the API); Vite proxies `/api/*` across. Always use :5173.

It builds once first, because `wrangler dev` hard-fails if `assets.directory` (`dist/client`) does not exist yet — which is always the case on a fresh clone.

Local dev needs **no Cloudflare account and no KV/R2 resources**: Wrangler simulates KV locally, and the ffmpeg core is served from `vendor/` by a Vite plugin. Steps 3's KV/R2 commands are only required for deploying.

### 5. Deploy

The only hard requirement is the `SIGNING_KEY` secret. Everything else is optional.

#### Minimal deploy (nothing to provision)

`wrangler.toml` ships in exactly this state — no placeholders to fix:

```bash
npx wrangler secret put SIGNING_KEY     # paste: openssl rand -base64 48
npm run deploy
```

One binding (`ASSETS`), zero vars, zero resources. Bilibili, Facebook and
Instagram work immediately.

Everything else is commented out in `wrangler.toml`; uncomment what you want:

| Uncomment | Gains | Cost of leaving it off |
|---|---|---|
| `[[r2_buckets]]` | in-browser muxing | single-file + audio-only still work; combining does not |
| `[[kv_namespaces]]` | caching + rate limiting | every resolve re-extracts; limiter fails open |
| `RESOLVER_BASE_URL` | YouTube + Dailymotion | those two return a clear "needs a residential resolver" error |

Tuning vars (`PROXY_TOKEN_TTL_SECONDS`, `RATE_LIMIT_RESOLVE_PER_MINUTE`,
`ENVIRONMENT`) all have defaults in `src/worker/config/env.ts`, so they only
belong in `wrangler.toml` if you are changing them.

#### Full deploy

```bash
npx wrangler kv namespace create CACHE            # paste id + preview_id
npx wrangler kv namespace create CACHE --preview
npx wrangler r2 bucket create mediafetch-vendor
npm run upload:ffmpeg                             # enables the muxer
npx wrangler secret put SIGNING_KEY
npm run deploy
```

#### Deploying from Workers Builds (git-connected CI)

Four things trip up a CI deploy, all visible in the build log:

| Log line | Fix |
|---|---|
| `KV namespace 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID' is not valid [code: 10042]` | Paste a real id, or delete the `[[kv_namespaces]]` block. A placeholder id fails the deploy, it is not ignored. |
| `Failed to match Worker name ... config "mediafetch", CI expected "media-fetch"` | `name` in `wrangler.toml` must equal the CI Worker name. |
| `Multiple environments are defined ... no target environment was specified` | Either define no extra environments, or set the deploy command to `npx wrangler deploy --env=""`. |
| Frontend loads but every `/api/*` route returns 503 `configuration_error` | The `SIGNING_KEY` secret is not set. Secrets are NOT read from `wrangler.toml`. Add it under **Settings -> Variables and Secrets -> Add -> Secret**, then redeploy. `GET /api/health` names the problem verbatim. |

CI cannot run the interactive `wrangler secret put`, so set secrets once in the
dashboard (or from your own machine); they persist across deploys.

Verify a deploy with one request:

```bash
curl https://<your-worker>.workers.dev/api/health
```

Healthy:

```json
{ "ok": true, "platforms": 5,
  "features": { "signingKey": true, "cache": false, "muxerCore": false,
                "resolverFallback": false,
                "nativePlatforms": ["youtube","bilibili","facebook","instagram"] } }
```

Misconfigured — HTTP 503, and it tells you exactly what to do rather than saying
"something went wrong":

```json
{ "ok": false,
  "problems": ["SIGNING_KEY secret is missing or too short. Set it with
                `wrangler secret put SIGNING_KEY` ..."],
  "features": { "signingKey": false, ... } }
```

`/api/health` never depends on valid config — a health check that crashes on bad
config tells you nothing about the bad config.

`RESOLVER_BASE_URL` is optional and only needed for YouTube and Dailymotion; the
shipped `resolver.example.com` placeholder is treated as "not configured".

---

## YouTube cookies

A reasonable-sounding idea: log in once, save the session, use it until it expires.
It does not work in the Worker, and the reason is structural rather than legal.

**yt-dlp's own client table makes it impossible.** From `yt_dlp/extractor/youtube/_base.py`:

| Client | Accepts cookies | Needs a JS runtime |
|---|---|---|
| `web`, `web_safari`, `mweb`, `tv`, `web_embedded` | ✅ yes | ✅ **yes** |
| `android_vr`, `android`, `ios` | ❌ no | ❌ no |

There is **no client with both** `SUPPORTS_COOKIES: True` and `REQUIRE_JS_PLAYER: False`.
Cookie-capable clients return stream URLs whose signature/`n` parameters must be
descrambled by executing JavaScript from YouTube's player bundle — and Cloudflare
Workers have no `eval()` or `new Function()`. The JS-free clients never receive
cookies at all, so attaching one changes nothing.

**Cookies do not defeat the IP block either.** yt-dlp maintainer `seproDev`, on a
report of exactly this from Google Cloud (issue #14195, Aug 2025):

> "Data center IPs are being blocked by YouTube. Nothing we can do about that."

The reporter had already tried cookies: *"it didn't change anything."* Verified
independently here — when the bot check fires, the player response contains no
`streamingData` at all: no formats, no HLS manifest, nothing to select from.

**"Until the session expires" is shorter than it sounds.** The yt-dlp wiki:

> "YouTube rotates account cookies frequently on open YouTube browser tabs as a
> security measure."

Maintainer `bashonly`: *"If you browse the site at all in the same logged-in session
that you exported the cookies from, your cookiefile could be DOA."* Hours, not months,
unless exported from a browser profile you then never touch.

**And there is a real account risk.** The wiki, verbatim:

> "By using your account with yt-dlp, you run the risk of it being banned
> (temporarily or permanently) ... consider using a throwaway account."

### Where cookies DO work

In the resolver service, which has both a JS runtime and — if you host it at home —
a residential IP. Off by default:

```bash
export YTDLP_COOKIE_FILE=/secure/path/cookies.txt
uvicorn app:app --port 8080
# GET /health reports {"cookies": true}
```

Export with `yt-dlp --cookies-from-browser`, or a cookies.txt extension. Use a
throwaway account, keep the file out of git, and expect to refresh it.

This unlocks **age-restricted and members-only content you have access to** — it is
not a workaround for the datacenter IP block. If the resolver runs on a cloud host,
YouTube blocks it with or without cookies, and the service now says so explicitly
(HTTP 503, `"YouTube bot-check: this host's IP is blocked"`).

### What this project will not do

Ask the app's visitors to sign in to Google, or import their session cookies. That
is a credential-harvesting pattern whatever the intent: it trains users to type
Google passwords into a third-party site, and a stored session is full account
access, not a download permission. Cookies here are strictly operator-supplied,
single-account, opt-in.

---

## Hosting the ffmpeg core

`ffmpeg-core.wasm` is ~31 MiB, and two constraints collide:

1. **Workers Assets rejects any single file over 25 MiB.** A whole copy under
   `public/` makes `wrangler deploy` fail at deploy time.
2. **`COEP: require-corp` blocks cross-origin subresources without CORP headers.**
   The app sets that header because `SharedArrayBuffer` needs cross-origin
   isolation, and the multithreaded muxer needs `SharedArrayBuffer`. unpkg,
   jsdelivr and public R2 URLs all omit CORP, so a CDN is not an option either.

**Resolution: split it.** `npm run vendor:ffmpeg` (which `postinstall` runs) cuts
the wasm into 10 MiB parts under `public/vendor/ffmpeg/` with a manifest, and the
browser fetches them in parallel and rejoins them into a `blob:` URL. `blob:` URLs
inherit the document's cross-origin isolation, so COEP is satisfied for free.

**Nothing to configure. No bucket, no upload, no extra service.** Verified: the
reassembled bytes are sha256-identical to the original, and every part deploys at
10 MiB — well under the ceiling.

```
ffmpeg-core.js               0.1 MiB   plain asset
ffmpeg-core.worker.js        0.0 MiB   plain asset
ffmpeg-core.wasm.0.part     10.0 MiB   ┐
ffmpeg-core.wasm.1.part     10.0 MiB   │ rejoined in the browser
ffmpeg-core.wasm.2.part     10.0 MiB   │
ffmpeg-core.wasm.3.part      1.2 MiB   ┘
core-manifest.json           ~100 B    byteLength + part order
```

Parts are immutable and served from the edge cache, so a returning visitor pays
nothing. The single-threaded core is no smaller (30.7 MiB), so switching to it
would not have avoided this.

### Optional: serve it from R2 instead

Only worth it if you want the ~31 MiB out of your asset bundle. Cloudflare already
skips unchanged assets on redeploy, so most deployments should ignore this.

```bash
npx wrangler r2 bucket create mediafetch-vendor
npm run upload:ffmpeg
# then uncomment [[r2_buckets]] in wrangler.toml
```

The client prefers the split parts and falls back to `/vendor/ffmpeg/ffmpeg-core.wasm`
(the Worker's R2 route) only when no manifest is deployed.

**Future optimisation:** this app only stream-copies, so it needs ffmpeg's
demuxers and muxers but none of its decoders. A custom Emscripten build limited to
mp4/webm/matroska would cut 31 MiB to single-digit megabytes and need no splitting.

---

## Adding a platform

Four steps, no framework knowledge required.

**1.** Copy the template:

```bash
cp src/worker/platforms/_template.ts src/worker/platforms/tiktok.ts
```

**2.** Add the descriptor in `src/shared/platforms.ts`:

```ts
export const PLATFORM_IDS = [..., 'tiktok'] as const;

tiktok: {
  id: 'tiktok',
  name: 'TikTok',
  accent: '#ff0050',
  glyph: 'M…',                    // 24x24 path data
  hint: '/video/, vm.tiktok.com',
  splitStreamsCommon: false,
},
```

**3.** Implement `match()` and declare `cdnHosts`:

```ts
export const tiktok = defineProvider({
  id: 'tiktok',
  hosts: ['tiktok.com', 'vm.tiktok.com'],
  cdnHosts: ['tiktokcdn.com', 'tiktokv.com'],   // security boundary — be precise
  match(url) { /* return { confidence, mediaId, canonicalUrl } */ },
});
```

**4.** Register it in `src/worker/platforms/registry.ts`:

```ts
import { tiktok } from './tiktok';
export const PROVIDERS = [youtube, bilibili, facebook, instagram, dailymotion, tiktok];
```

Done. Detection, the dropdown, the platform gallery and the proxy allowlist all update automatically.

### Provider rules

- `match()` is **pure** — no network, no I/O, and it must never throw.
- **Confidence is a real signal.** Return `< 0.75` when genuinely unsure; the UI then asks the user instead of guessing wrong and failing five seconds later.
- **`cdnHosts` is a security boundary,** not a convenience list. Never wildcard it.
- `enrich()` is optional and must only call public, keyless, documented endpoints.

---

## Security

Reviewed deliberately, because a media proxy is an attractive thing to abuse.

| Risk | Control |
|---|---|
| Open proxy / traffic laundering | Every upstream URL is HMAC-SHA256 signed with an expiry. The Worker only fetches URLs it minted itself. |
| SSRF to internal services | `assertSafeUpstream()`: HTTPS-only, no credentials in URL, no IP literals, no cloud-metadata hosts, port 443 only, CDN allowlist. |
| SSRF via redirect | Redirects are followed **manually**, re-validating every hop (`safeFetch`). `redirect: 'follow'` would allow a single unchecked jump to `169.254.169.254`. |
| Upstream URL leakage | Signed tokens only. Raw CDN URLs (which carry IP-bound session tokens) never reach the browser. |
| Header injection | `Referer` comes from the signed payload, never the request. Filenames are sanitised before entering `Content-Disposition`. |
| Cookie injection | `set-cookie` is stripped from every proxied response. |
| XSS via media titles | Remote text is written with `textContent` only; strict CSP with no `unsafe-inline` scripts. |
| API abuse | Same-origin enforcement (no wildcard CORS) + per-IP rate limit on the expensive `/resolve` path. |
| Secret leakage in logs | Errors log a fixed reason enum, never URLs or payloads. |

Set a strong `SIGNING_KEY` (`openssl rand -base64 48`) and never commit `.dev.vars`.

---

## Known limitations

Stated plainly rather than discovered later:

- **Muxing is memory-bound.** ffmpeg.wasm runs in a browser heap capped around 2 GB, so combined inputs above ~1.8 GB are refused with a clear message. Very long 4K videos need a desktop app.
- **Segmented streams (HLS/DASH manifests) are skipped.** Only progressive HTTP URLs are offered, because assembling fragments client-side is a separate project. In practice yt-dlp exposes progressive URLs for all five platforms.
- **Live streams are rejected** — no fixed end, so no file.
- **Cobalt backend gives no quality picker.** Its API returns one prepared result rather than a format list, so the mux flow is largely bypassed. Use the yt-dlp backend for the full experience.
- **Rate limiting is eventually consistent** (KV fixed window). A client hitting several colos at once can briefly exceed the limit. Swap in Cloudflare's rate-limiting binding if you need strict counting; only `middleware/rateLimit.ts` changes.
- **Streaming save to disk needs the File System Access API** (Chromium). Elsewhere the muxed file is materialised as a Blob first — direct single-file downloads are unaffected.

---

## Verified

Measured on this codebase, not asserted:

| Check | Result |
|---|---|
| `npm run typecheck` (3 projects) | passes |
| `npm run build` | passes — 20 kB gzip initial JS, 4.4 kB gzip CSS |
| `wrangler deploy --dry-run` | passes — 56 kB gzip Worker |
| Detection, 13 canonical link shapes | correct platform + id on all |
| Native Bilibili extraction, no resolver | 9 variants, real 206 bytes for video + audio |
| Native YouTube extraction | 27 formats, 0 needing JS; blocked by bot check on 8/9 videos |
| Signed proxy replays client UA | WebM EBML + ISO-BMFF magic bytes verified |
| Detection, playlist / stories / unknown host | correctly below confidence threshold |
| URL buried in pasted text | extracted |
| Forged / garbage / missing stream token | 403 / 400, never fetched |
| Non-allowlisted CDN host (signed) | 502, blocked before any fetch |
| Allowlisted CDN host (signed) | fetched; real bytes streamed |
| `Range: bytes=0-99` | 206 + correct `Content-Range` |
| Rate limit (20/min) | 429 + `Retry-After` at the boundary |
| Cross-origin `Origin` header | 403 |
| Unknown `/api/*` path | JSON 404 (not the SPA shell) |
| Upstream URLs in client payload | none — all proxied, including thumbnails |

---

## Legal

This tool is for media you own, media you have permission to save, and content whose licence permits downloading. Every platform here has terms of service, and creators hold rights in their work — downloading does not transfer them.

The reference resolver deliberately ships **no** support for cookies or credentials, so it does not reach private, paywalled, or otherwise gated content. Do not add it. Do not run a public instance.

You are responsible for how you deploy and use this.
