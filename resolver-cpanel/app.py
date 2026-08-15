"""
MediaFetch resolver — cPanel "Setup Python App" edition.

Same `/extract` contract as resolver-server/, so the Worker's `ytdlp` backend
talks to either without changes. What differs is the runtime, and it differs in
ways that rule out the FastAPI version:

  * cPanel runs Python apps under **Phusion Passenger**, which speaks **WSGI**.
    FastAPI is ASGI. Running it here needs an adapter plus an ASGI server, and
    neither survives Passenger's process model cleanly.
  * Shared hosting has no systemd, no uvicorn, no long-lived daemon you control.
    Passenger starts and stops workers on demand; the app must be import-safe and
    hold no global state that matters.
  * Dependency installs are the most common failure on shared hosting, so this
    file deliberately uses **no web framework at all** — plain WSGI, stdlib only.
    The single third-party dependency is yt-dlp itself.

Endpoints
---------
  POST /extract   {"url": "..."}  -> yt-dlp --dump-single-json output
  GET  /health                    -> config + a live reachability self-test

The self-test matters: whether this host can reach YouTube at all depends on how
its IP is classified, and that is not something anyone can predict for you. One
request to /health answers it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import ssl
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Iterable

# ---------------------------------------------------------------------------
# TLS trust store
# ---------------------------------------------------------------------------
#
# Shared hosting frequently ships a Python without a usable CA bundle, and the
# symptom is brutal to diagnose: EVERY extraction fails with
# "CERTIFICATE_VERIFY_FAILED", which reads like the platform blocking you rather
# than a local trust-store problem.
#
# certifi carries Mozilla's CA bundle as a pip package, so pointing OpenSSL at it
# fixes the whole class of failure. Setting the environment variables (rather
# than only building a context) also covers the subprocesses and libraries that
# read them directly.
def _resolve_ca_bundle() -> str | None:
    """
    Picks a CA bundle, in order of authority:

      1. An explicit SSL_CERT_FILE. If an operator set it, they know something we
         do not — a corporate CA, or a proxy that intercepts TLS. Overriding it
         with certifi would break exactly the environments that configured it.
      2. certifi's Mozilla bundle, for hosts whose Python has no usable store.
      3. The system default.
    """
    explicit = os.environ.get("SSL_CERT_FILE")
    if explicit and os.path.isfile(explicit):
        return explicit

    try:
        import certifi

        bundle = certifi.where()
        os.environ.setdefault("SSL_CERT_FILE", bundle)
        os.environ.setdefault("REQUESTS_CA_BUNDLE", bundle)
        return bundle
    except Exception:  # noqa: BLE001 - strongly recommended, not required
        return None


_CA_BUNDLE: str | None = _resolve_ca_bundle()


def _ssl_context() -> ssl.SSLContext:
    """A verifying context using whichever bundle _resolve_ca_bundle chose."""
    if _CA_BUNDLE:
        return ssl.create_default_context(cafile=_CA_BUNDLE)
    return ssl.create_default_context()

try:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError, ExtractorError, GeoRestrictedError

    YTDLP_IMPORT_ERROR: str | None = None
except Exception as exc:  # pragma: no cover - only on a broken install
    YoutubeDL = None  # type: ignore[assignment]
    DownloadError = ExtractorError = GeoRestrictedError = Exception  # type: ignore
    YTDLP_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------------------
# Configuration (environment variables, set in the cPanel Python App UI)
# ---------------------------------------------------------------------------

TOKEN = os.environ.get("RESOLVER_TOKEN")
COOKIE_FILE = os.environ.get("YTDLP_COOKIE_FILE")
EXTRACT_TIMEOUT = int(os.environ.get("EXTRACT_TIMEOUT", "45"))

#: Passenger already limits how many workers exist. This is a second, in-process
#: guard so one worker cannot be handed a burst that exhausts a shared host's
#: process or memory allowance — the fastest way to get an account suspended.
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "2"))
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)

YDL_OPTIONS: dict[str, Any] = {
    "skip_download": True,
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "socket_timeout": 15,
    "retries": 1,
    # Shared hosting punishes stray writes and often has a read-only or
    # quota-limited home. yt-dlp's cache is not worth the risk.
    "cachedir": False,
    # Segmented DASH is unusable by the browser muxer; skip the work.
    "extractor_args": {"youtube": {"skip": ["dash_manifest"]}},
}

# NOTE: yt-dlp has no `ca_certs` parameter — an earlier version of this file
# passed one and it was silently ignored, which is worse than not trying. The
# supported mechanism is the SSL_CERT_FILE environment variable, which
# _resolve_ca_bundle() sets above before yt-dlp builds any SSL context.
#
# Last resort for a host whose trust store cannot be fixed: set INSECURE_TLS=1.
# This disables certificate verification for ALL upstream requests, so traffic
# becomes vulnerable to interception. Use it only to confirm a diagnosis, never
# as a permanent setting.
if os.environ.get("INSECURE_TLS") == "1":
    YDL_OPTIONS["nocheckcertificate"] = True

if COOKIE_FILE and os.path.isfile(COOKIE_FILE):
    YDL_OPTIONS["cookiefile"] = COOKIE_FILE


# ---------------------------------------------------------------------------
# Tiny WSGI plumbing
# ---------------------------------------------------------------------------

StartResponse = Callable[[str, list[tuple[str, str]]], Any]

STATUS_TEXT = {
    200: "200 OK",
    # 206 is not an edge case here: every ranged request — which is how a browser
    # resumes a download, and how the client fetches segments in parallel — comes
    # back as Partial Content. Omitting it produced the reason phrase "206 Error".
    206: "206 Partial Content",
    400: "400 Bad Request",
    401: "401 Unauthorized",
    403: "403 Forbidden",
    404: "404 Not Found",
    405: "405 Method Not Allowed",
    410: "410 Gone",
    413: "413 Payload Too Large",
    416: "416 Range Not Satisfiable",
    451: "451 Unavailable For Legal Reasons",
    500: "500 Internal Server Error",
    502: "502 Bad Gateway",
    503: "503 Service Unavailable",
    504: "504 Gateway Timeout",
}

#: 8 KB is far more than any URL needs and caps a trivial memory-abuse vector.
MAX_BODY_BYTES = 8 * 1024


def _query_param(environ: dict[str, Any], name: str) -> str:
    """Reads a single query parameter, refusing repeats.

    A repeated parameter is how request-smuggling tricks slip a second value
    past a check that only looked at the first, so `?t=good&t=evil` is rejected
    outright rather than resolved by precedence.
    """
    values = urllib.parse.parse_qs(environ.get("QUERY_STRING", "")).get(name, [])
    if len(values) != 1:
        raise HttpError(400, f"Expected exactly one '{name}' parameter")
    return values[0]


class HttpError(Exception):
    """An error with an intended status code. Anything else becomes a 500."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _json_response(
    start_response: StartResponse,
    status: int,
    payload: dict[str, Any],
    extra_headers: list[tuple[str, str]] | None = None,
) -> Iterable[bytes]:
    body = json.dumps(payload).encode("utf-8")
    start_response(
        STATUS_TEXT.get(status, f"{status} Error"),
        (extra_headers or [])
        + [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ],
    )
    return [body]


#: Refusing to run without a token is deliberate. An unauthenticated extraction
#: endpoint on shared hosting is a standing invitation: anyone who finds the URL
#: can burn your CPU allowance and upstream reputation, and the usual outcome is
#: the whole cPanel account getting suspended. Fail closed, not open.
ALLOW_NO_AUTH = os.environ.get("ALLOW_NO_AUTH") == "1"


def _require_token(environ: dict[str, Any]) -> None:
    """Bearer auth, mandatory unless explicitly waived for local testing."""
    if not TOKEN:
        if ALLOW_NO_AUTH:
            return
        raise HttpError(
            503,
            "RESOLVER_TOKEN is not set, so this endpoint refuses to run. Set it in "
            "the cPanel Python App environment variables (generate with "
            "`openssl rand -hex 32`) and restart the app. To run without auth on a "
            "private machine, set ALLOW_NO_AUTH=1.",
        )

    header = environ.get("HTTP_AUTHORIZATION", "")
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value:
        raise HttpError(401, "Missing bearer token")

    # Constant-time: a plain != leaks the token one byte at a time under timing.
    import hmac

    if not hmac.compare_digest(value, TOKEN):
        raise HttpError(401, "Invalid token")


def _read_json_body(environ: dict[str, Any]) -> dict[str, Any]:
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        raise HttpError(400, "Invalid Content-Length")

    if length > MAX_BODY_BYTES:
        raise HttpError(413, "Request body too large")
    if length <= 0:
        raise HttpError(400, 'Empty body. Send {"url": "..."}')

    raw = environ["wsgi.input"].read(length)
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        raise HttpError(400, "Body is not valid JSON")

    if not isinstance(parsed, dict):
        raise HttpError(400, "Body must be a JSON object")
    return parsed


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def _extract_sync(url: str) -> dict[str, Any]:
    with YoutubeDL(YDL_OPTIONS) as ydl:  # type: ignore[misc]
        return ydl.sanitize_info(ydl.extract_info(url, download=False))


def _extract_with_timeout(url: str) -> dict[str, Any]:
    """
    Runs yt-dlp on a worker thread so a hung extraction cannot pin a Passenger
    worker forever.

    A thread cannot be force-killed in Python, so on timeout the thread is left
    to finish on its own (it is daemonised, so it will not block shutdown) and
    the request returns 504. yt-dlp's own socket_timeout keeps that window short.
    """
    result: dict[str, Any] = {}
    failure: list[BaseException] = []

    def run() -> None:
        try:
            result.update(_extract_sync(url) or {})
        except BaseException as exc:  # noqa: BLE001 - re-raised on the main thread
            failure.append(exc)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(EXTRACT_TIMEOUT)

    if thread.is_alive():
        raise HttpError(504, "Extraction timed out")
    if failure:
        raise failure[0]
    return result


def _map_extractor_error(exc: BaseException) -> HttpError:
    """Turns yt-dlp's single error class into codes the Worker understands."""
    message = str(exc).lower()

    if isinstance(exc, GeoRestrictedError):
        return HttpError(451, "Geo restricted")

    if "not a bot" in message or "sign in to confirm" in message:
        # The single most likely failure on shared hosting, and the one whose
        # cause is invisible unless it is named.
        return HttpError(
            503,
            "YouTube bot-check: this host's IP is classified as a datacenter and "
            "is blocked. Check /health for the egress IP. A residential "
            "connection is the only reliable fix.",
        )

    if "certificate_verify_failed" in message or "certificate verify failed" in message:
        # Local trust-store problem, NOT the platform refusing you. Without this
        # branch it looks identical to a block and sends you hunting the wrong bug.
        return HttpError(
            500,
            "TLS certificate verification failed — this host's Python has no usable "
            "CA bundle. Fix: `pip install certifi` in the app's virtualenv, then "
            "restart the app. See /health for whether certifi was loaded.",
        )

    if any(hint in message for hint in ("private", "unavailable", "not exist", "removed")):
        return HttpError(404, "Media unavailable")

    if "403" in message or "forbidden" in message:
        return HttpError(503, "The platform's CDN refused this host (HTTP 403)")

    return HttpError(502, "Extraction failed")


def handle_extract(environ: dict[str, Any]) -> dict[str, Any]:
    if YoutubeDL is None:
        raise HttpError(500, f"yt-dlp is not installed correctly: {YTDLP_IMPORT_ERROR}")

    _require_token(environ)
    payload = _read_json_body(environ)

    url = payload.get("url")
    if not isinstance(url, str) or not url.strip():
        raise HttpError(400, 'Missing "url"')
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        raise HttpError(400, "Only http(s) URLs are supported")

    if not _slots.acquire(blocking=False):
        raise HttpError(503, "Busy: too many extractions in flight. Retry shortly.")

    try:
        info = _extract_with_timeout(url)
    except HttpError:
        raise
    except (DownloadError, ExtractorError) as exc:
        raise _map_extractor_error(exc) from exc
    except Exception as exc:  # noqa: BLE001
        raise HttpError(502, f"Extraction failed: {type(exc).__name__}") from exc
    finally:
        _slots.release()

    if not info:
        raise HttpError(404, "Nothing extracted")

    # A playlist slipped past noplaylist: return the first entry so the caller
    # still gets something usable.
    if info.get("_type") == "playlist":
        entries = [entry for entry in (info.get("entries") or []) if entry]
        if not entries:
            raise HttpError(404, "Empty playlist")
        info = entries[0]

    return info


# ---------------------------------------------------------------------------
# Health, with a live self-test
# ---------------------------------------------------------------------------


def _probe(url: str, timeout: int = 8) -> str:
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "MediaFetch-Resolver/1.0"})
        with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context()) as response:
            return f"HTTP {response.status}"
    except Exception as exc:  # noqa: BLE001
        detail = str(exc)
        if "CERTIFICATE_VERIFY_FAILED" in detail:
            return "TLS trust store broken (pip install certifi)"
        return f"{type(exc).__name__}"


def handle_health() -> dict[str, Any]:
    """
    Reports configuration AND what this host can actually reach.

    The egress IP is the single most useful fact here: it decides whether YouTube
    will serve this machine at all, and no amount of configuration changes it.
    """
    egress = "unknown"
    try:
        with urllib.request.urlopen(
            "https://api.ipify.org", timeout=8, context=_ssl_context()
        ) as response:
            egress = response.read().decode("utf-8").strip()
    except Exception:  # noqa: BLE001
        pass

    youtube_status = "not tested"
    if YoutubeDL is not None:
        try:
            info = _extract_with_timeout("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
            formats = len(info.get("formats") or [])
            youtube_status = f"OK — {formats} formats (this host is NOT blocked)"
        except HttpError as exc:
            youtube_status = f"{exc.status}: {exc.detail[:80]}"
        except Exception as exc:  # noqa: BLE001
            detail = str(exc).lower()
            if "not a bot" in detail or "sign in to confirm" in detail:
                youtube_status = "BLOCKED — bot check (datacenter IP)"
            elif "certificate" in detail:
                youtube_status = "TLS trust store broken — pip install certifi"
            else:
                # Include a trimmed reason: on your own server the detail is
                # diagnostic, not a leak, and "failed" alone is useless.
                youtube_status = f"failed: {str(exc)[:120]}"


    return {
        "ok": YoutubeDL is not None,
        "ytdlp": "missing" if YoutubeDL is None else "installed",
        "caBundle": _CA_BUNDLE or "system default (install certifi if TLS fails)",
        "tlsVerification": "DISABLED (INSECURE_TLS=1)"
        if YDL_OPTIONS.get("nocheckcertificate")
        else "enabled",
        "ytdlpImportError": YTDLP_IMPORT_ERROR,
        "auth": bool(TOKEN),
        "authWarning": None
        if TOKEN
        else (
            "OPEN ENDPOINT — /extract is disabled until RESOLVER_TOKEN is set "
            "(or ALLOW_NO_AUTH=1 for a private machine)"
        ),
        "cookies": "cookiefile" in YDL_OPTIONS,
        "maxConcurrent": MAX_CONCURRENT,
        # The passthrough is what makes YouTube and Dailymotion downloadable at
        # all, and it silently does nothing without a token, so report it.
        "fetchPassthrough": "enabled" if TOKEN else "DISABLED (needs RESOLVER_TOKEN)",
        "allowedOrigin": ALLOWED_ORIGIN,
        "allowedOriginWarning": (
            "Set ALLOWED_ORIGIN to your Worker URL — '*' lets any site stream through this host"
            if ALLOWED_ORIGIN == "*"
            else None
        ),
        "maxFetchMb": MAX_FETCH_MB,
        "egressIp": egress,
        "youtubeSelfTest": youtube_status,
        "dailymotionMetadata": _probe(
            "https://geo.dailymotion.com/video/xaxvs5m.json?legacy=true"
        ),
    }


# ---------------------------------------------------------------------------
# /fetch — byte passthrough
# ---------------------------------------------------------------------------
#
# WHY THIS EXISTS
#
# A googlevideo URL produced here embeds `ip=<this host's IP>`, and `ip` appears
# in the URL's own `sparams` list, so it is covered by the signature. Fetching it
# from any other address returns 403 — the request 302s and the redirect comes
# back carrying `ipbypass=yes&mip=<caller>`. The Cloudflare Worker cannot use
# these URLs. Neither can the visitor's browser. Only this machine can.
#
# Dailymotion is the same wall from the other side: its CDN refuses datacenter
# IPs and sends no Access-Control-Allow-Origin, so the browser cannot read it
# directly either.
#
# So the bytes have to leave from here. The browser streams from this endpoint
# and muxes locally; the Worker never touches media, which keeps it inside
# Cloudflare's CPU limits and keeps egress off the Cloudflare bill.
#
# COST WARNING: this moves real bandwidth through your hosting account. A 1080p
# video is a few hundred MB. Shared hosts meter this and some suspend accounts
# that sustain it. MAX_FETCH_MB caps a single response; there is no monthly
# quota tracking here, so watch your host's usage panel.
#
# SECURITY
#
# An endpoint that fetches an arbitrary URL is an open proxy, so three locks:
#   1. HMAC — the Worker signs every URL with RESOLVER_TOKEN. Same token format
#      as src/worker/lib/signing.ts. Unsigned requests are refused.
#   2. Expiry — inside the signed payload, so it cannot be edited.
#   3. Host allowlist — enforced here, independently. Even a leaked signing key
#      cannot point this at an internal address or an arbitrary third party.

#: Only these CDNs. Suffix-matched on a dot boundary so "evil-googlevideo.com"
#: does not match, and exact-matched so the apex works too.
ALLOWED_FETCH_HOSTS = (
    "googlevideo.com",
    "dailymotion.com",
    "dmcdn.net",
    "bilivideo.com",
    "fbcdn.net",
    "cdninstagram.com",
)

#: Per-response ceiling. Guards against a signed URL being replayed to pull
#: unbounded data through a metered connection.
MAX_FETCH_MB = int(os.environ.get("MAX_FETCH_MB", "2048"))

#: Browser origin allowed to read these bytes. MUST be set for the muxer to
#: work: without a matching Access-Control-Allow-Origin the browser fetches the
#: response and then refuses to let JavaScript see it.
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

#: Streaming chunk. Large enough to keep syscall overhead low, small enough that
#: a Passenger worker never holds much in memory.
_CHUNK = 256 * 1024


def _host_allowed(host: str) -> bool:
    host = host.lower()
    return any(host == h or host.endswith("." + h) for h in ALLOWED_FETCH_HOSTS)


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _verify_token(token: str) -> dict[str, Any]:
    """
    Verifies a Worker-minted token: base64url(json) "." base64url(HMAC-SHA256).

    Mirrors src/worker/lib/signing.ts exactly. Order matters — the signature is
    checked before the payload is parsed or trusted, and hmac.compare_digest
    keeps the comparison constant-time.
    """
    if not TOKEN:
        raise HttpError(503, "RESOLVER_TOKEN is not set; /fetch is disabled")

    body, _, signature = token.partition(".")
    if not body or not signature:
        raise HttpError(400, "Malformed token")

    expected = hmac.new(TOKEN.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest()
    try:
        provided = _b64url_decode(signature)
    except Exception:
        raise HttpError(403, "Bad token signature") from None
    if not hmac.compare_digest(expected, provided):
        raise HttpError(403, "Bad token signature")

    try:
        payload = json.loads(_b64url_decode(body))
    except Exception:
        raise HttpError(400, "Malformed token payload") from None

    # Checked only after the signature, so this branch reveals nothing about the
    # key to someone probing with forged tokens.
    if not isinstance(payload.get("u"), str) or not isinstance(payload.get("e"), (int, float)):
        raise HttpError(400, "Malformed token payload")
    if payload["e"] <= time.time():
        raise HttpError(410, "This download link expired. Resolve it again.")

    return payload


def _cors_headers() -> list[tuple[str, str]]:
    return [
        ("Access-Control-Allow-Origin", ALLOWED_ORIGIN),
        # Range is what makes parallel and resumable downloads possible; without
        # it in the allow-list the browser blocks the preflight.
        ("Access-Control-Allow-Headers", "Range, Content-Type"),
        ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
        # JS cannot read a response header unless it is exposed. The muxer needs
        # these to size its buffers and verify partial responses.
        (
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Range, Accept-Ranges, Content-Type",
        ),
        ("Access-Control-Max-Age", "600"),
        # The app page is cross-origin isolated (COEP: require-corp) so it can
        # use SharedArrayBuffer for ffmpeg.wasm. Under that policy a cross-origin
        # subresource is blocked unless it opts in with this header.
        ("Cross-Origin-Resource-Policy", "cross-origin"),
    ]


def handle_fetch(environ: dict[str, Any], start_response: StartResponse) -> Iterable[bytes]:
    payload = _verify_token(_query_param(environ, "t"))

    target = payload["u"]
    try:
        host = urllib.parse.urlparse(target).hostname or ""
    except Exception:
        raise HttpError(400, "Malformed target URL") from None

    if not _host_allowed(host):
        raise HttpError(403, f"Host not allowed: {host}")

    headers = {
        # Replayed from the signed payload: googlevideo validates the UA against
        # the InnerTube client that minted the URL and 403s on a mismatch.
        "User-Agent": payload.get("ua") or "Mozilla/5.0",
        "Accept": "*/*",
    }
    if payload.get("r"):
        headers["Referer"] = payload["r"]

    # Range comes from the browser, not the token, so it is passed through but
    # never used to choose a destination.
    client_range = environ.get("HTTP_RANGE")
    if client_range:
        headers["Range"] = client_range

    request = urllib.request.Request(target, headers=headers, method="GET")

    try:
        upstream = urllib.request.urlopen(request, timeout=30, context=_ssl_context())
    except urllib.error.HTTPError as exc:
        detail = (
            "The CDN refused this host."
            if exc.code in (401, 403)
            else f"Upstream returned {exc.code}."
        )
        raise HttpError(502 if exc.code not in (404, 410) else exc.code, detail) from None
    except Exception as exc:
        raise HttpError(504, f"Upstream fetch failed: {type(exc).__name__}") from None

    status = upstream.status or 200
    out: list[tuple[str, str]] = _cors_headers()
    for name in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag"):
        value = upstream.headers.get(name)
        if value:
            out.append((name, value))
    out.append(("Cache-Control", "private, no-store"))
    out.append(("X-Content-Type-Options", "nosniff"))

    # ?dl=1 turns the response into a browser download. The name comes from the
    # SIGNED payload, never the query string, so it cannot be used to inject
    # header content. Non-ASCII is stripped for the plain filename and preserved
    # in the RFC 5987 form that modern browsers prefer.
    if environ.get("QUERY_STRING") and "dl=1" in environ["QUERY_STRING"]:
        name = str(payload.get("f") or "download")
        ascii_name = "".join(c for c in name if 32 <= ord(c) < 127).replace('"', "").replace("\\", "")
        quoted = urllib.parse.quote(name, safe="")
        out.append(
            (
                "Content-Disposition",
                f'attachment; filename="{ascii_name or "download"}"; filename*=UTF-8\'\'{quoted}',
            )
        )

    start_response(STATUS_TEXT.get(status, f"{status} OK"), out)

    def stream() -> Iterable[bytes]:
        """
        Streams in chunks and closes the upstream connection no matter how the
        client goes away. Passenger workers are long-lived and few, so a leaked
        socket per aborted download would exhaust them quickly.
        """
        sent = 0
        limit = MAX_FETCH_MB * 1024 * 1024
        try:
            while True:
                chunk = upstream.read(_CHUNK)
                if not chunk:
                    break
                sent += len(chunk)
                if sent > limit:
                    break
                yield chunk
        finally:
            upstream.close()

    return stream()


# ---------------------------------------------------------------------------
# WSGI entry point
# ---------------------------------------------------------------------------


def application(environ: dict[str, Any], start_response: StartResponse) -> Iterable[bytes]:
    path = environ.get("PATH_INFO", "/").rstrip("/") or "/"
    method = environ.get("REQUEST_METHOD", "GET").upper()

    try:
        if path in ("/health", "/"):
            if method != "GET":
                raise HttpError(405, "Use GET for /health")
            return _json_response(start_response, 200, handle_health())

        if path == "/extract":
            if method != "POST":
                raise HttpError(405, "Use POST for /extract")
            return _json_response(start_response, 200, handle_extract(environ))

        if path == "/fetch":
            # The browser preflights any request carrying a Range header.
            if method == "OPTIONS":
                start_response("200 OK", _cors_headers() + [("Content-Length", "0")])
                return [b""]
            if method not in ("GET", "HEAD"):
                raise HttpError(405, "Use GET for /fetch")
            # Streams its own response: the body can be gigabytes and must never
            # be buffered into a Passenger worker's memory.
            return handle_fetch(environ, start_response)

        raise HttpError(404, f"No route for {path}")

    except HttpError as exc:
        # Without CORS headers on the error too, a failing /fetch surfaces in the
        # browser as an unexplained network error rather than the actual reason.
        extra = _cors_headers() if path == "/fetch" else None
        return _json_response(start_response, exc.status, {"detail": exc.detail}, extra)

    except Exception:  # noqa: BLE001
        # Log the trace to Passenger's stderr; return nothing revealing.
        traceback.print_exc()
        return _json_response(start_response, 500, {"detail": "Internal error"})
