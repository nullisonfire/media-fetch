# MediaFetch resolver — cPanel edition

A yt-dlp extraction service that runs under cPanel's **Setup Python App**. Same
`/extract` contract as `resolver-server/`, so the Worker talks to either one
without changes.

**Read this first:** cPanel shared hosting runs on a **datacenter IP**, which is
the thing YouTube throttles. This resolver may still help — yt-dlp works around
far more than raw API calls can, and it reliably fixed Dailymotion in testing —
but it is not the same as a residential connection. `GET /health` runs a live
self-test so you know within one request rather than guessing.

---

## Why this is plain WSGI and not FastAPI

| | `resolver-server/` (FastAPI) | `resolver-cpanel/` (this) |
|---|---|---|
| Protocol | ASGI, needs uvicorn | **WSGI — what Passenger speaks** |
| Process model | a daemon you supervise | Passenger starts/stops workers |
| Dependencies | fastapi, uvicorn, pydantic | **yt-dlp + certifi, nothing else** |
| Suits | VPS, Docker, a Pi at home | cPanel shared hosting |

Every avoided dependency is one less thing that fails to build on shared hosting,
so this version uses no web framework at all.

---

## Setup

### 1. Upload

Put `app.py`, `passenger_wsgi.py` and `requirements.txt` in a folder such as
`~/resolver`. Do **not** put it under `public_html` — Passenger serves the app on
its own URL, and files there could be downloaded as plain text.

### 2. Create the app

**cPanel → Setup Python App → Create Application**

| Field | Value |
|---|---|
| Python version | 3.10 or newer if offered |
| Application root | `resolver` |
| Application URL | pick a subdomain or path, e.g. `resolver.yourdomain.com` |
| Application startup file | `passenger_wsgi.py` |
| Application Entry point | `application` |

### 3. Install dependencies

The page shows a command like:

```bash
source /home/USER/virtualenv/resolver/3.11/bin/activate && cd /home/USER/resolver
```

Run it over SSH (or use the UI's **Run Pip Install** with `requirements.txt`), then:

```bash
pip install -r requirements.txt
```

### 4. Environment variables

Add these in the app's **Environment variables** section:

| Variable | Required | Purpose |
|---|---|---|
| `RESOLVER_TOKEN` | **yes** | Bearer token. Must match the Worker's `RESOLVER_TOKEN` secret. Generate: `openssl rand -hex 32` |
| `MAX_CONCURRENT` | no | Default 2. Keep low — shared hosts suspend accounts for resource spikes |
| `EXTRACT_TIMEOUT` | no | Default 45 seconds |
| `YTDLP_COOKIE_FILE` | no | Absolute path to a cookies.txt. See the main README's "YouTube cookies" section, including the account-ban warning |
| `INSECURE_TLS` | no | **Last resort only.** Disables certificate verification |

Without `RESOLVER_TOKEN` the endpoint is **open to the internet**. Always set it.

### 5. Restart, then check health

```bash
curl https://resolver.yourdomain.com/health
```

```json
{
  "ok": true,
  "ytdlp": "installed",
  "tlsVerification": "enabled",
  "egressIp": "203.0.113.45",
  "youtubeSelfTest": "OK — 23 formats (this host is NOT blocked)",
  "dailymotionMetadata": "HTTP 200"
}
```

`youtubeSelfTest` is the answer to the only question that matters:

| Value | Meaning |
|---|---|
| `OK — N formats` | This host works. Point the Worker at it. |
| `BLOCKED — bot check (datacenter IP)` | YouTube refuses this host. Dailymotion may still work. |
| `TLS trust store broken` | See below — fixable, and nothing to do with blocking. |

### 6. Point the Worker at it

In `wrangler.toml`:

```toml
[vars]
RESOLVER_BASE_URL = "https://resolver.yourdomain.com"
RESOLVER_BACKEND = "ytdlp"
```

Then `npx wrangler secret put RESOLVER_TOKEN` with the same value, and redeploy.

---

## Troubleshooting

**Every request fails with `CERTIFICATE_VERIFY_FAILED`.** The host's Python has no
usable CA bundle. This looks exactly like being blocked and is not.

```bash
pip install certifi     # then restart the app
```

The app prefers an explicit `SSL_CERT_FILE`, then certifi, then the system store.
If it still fails, set `INSECURE_TLS=1` **to confirm the diagnosis only** — it
disables verification for all upstream traffic, and `/health` will report
`tlsVerification: DISABLED` so it cannot be forgotten.

**502 from Passenger with no detail.** Almost always an import error. Check
`~/resolver/stderr.log`, and confirm dependencies went into the app's virtualenv
rather than the system Python.

**Extraction worked, then stopped.** yt-dlp goes stale as platforms change:

```bash
pip install -U yt-dlp
```

Worth doing monthly. Most "it broke by itself" reports are this.

**Timeouts on long videos.** Extraction only reads metadata and should take
seconds. If it times out, the host is likely rate-limited upstream — check
`/health`.

---

## Running it responsibly

Shared hosting is a shared machine. `MAX_CONCURRENT` defaults to 2 deliberately;
raising it risks your whole account, not just this app. Keep `RESOLVER_TOKEN` set
so the endpoint is not a free extraction service for the internet, and keep
yt-dlp current so you are not hammering platforms with requests that fail.
