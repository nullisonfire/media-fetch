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

import json
import os
import ssl
import threading
import traceback
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
    400: "400 Bad Request",
    401: "401 Unauthorized",
    404: "404 Not Found",
    405: "405 Method Not Allowed",
    413: "413 Payload Too Large",
    451: "451 Unavailable For Legal Reasons",
    500: "500 Internal Server Error",
    502: "502 Bad Gateway",
    503: "503 Service Unavailable",
    504: "504 Gateway Timeout",
}

#: 8 KB is far more than any URL needs and caps a trivial memory-abuse vector.
MAX_BODY_BYTES = 8 * 1024


class HttpError(Exception):
    """An error with an intended status code. Anything else becomes a 500."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _json_response(
    start_response: StartResponse, status: int, payload: dict[str, Any]
) -> Iterable[bytes]:
    body = json.dumps(payload).encode("utf-8")
    start_response(
        STATUS_TEXT.get(status, f"{status} Error"),
        [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ],
    )
    return [body]


def _require_token(environ: dict[str, Any]) -> None:
    """Bearer auth. No token configured means auth is OFF — never do that publicly."""
    if not TOKEN:
        return

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
        "cookies": "cookiefile" in YDL_OPTIONS,
        "maxConcurrent": MAX_CONCURRENT,
        "egressIp": egress,
        "youtubeSelfTest": youtube_status,
        "dailymotionMetadata": _probe(
            "https://geo.dailymotion.com/video/xaxvs5m.json?legacy=true"
        ),
    }


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

        raise HttpError(404, f"No route for {path}")

    except HttpError as exc:
        return _json_response(start_response, exc.status, {"detail": exc.detail})

    except Exception:  # noqa: BLE001
        # Log the trace to Passenger's stderr; return nothing revealing.
        traceback.print_exc()
        return _json_response(start_response, 500, {"detail": "Internal error"})
