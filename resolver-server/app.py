"""
Reference resolver service for MediaFetch.

The Cloudflare Worker cannot run native code, so extraction lives here: a small
authenticated HTTP wrapper around yt-dlp that returns its `--dump-single-json`
output unchanged. The Worker's `ytdlp` backend adapter speaks exactly this
contract.

    POST /extract
    Authorization: Bearer <RESOLVER_TOKEN>
    {"url": "https://..."}
    -> 200 yt-dlp JSON | 404 unavailable | 401 unauthorised

Run it somewhere you control:

    pip install fastapi uvicorn yt-dlp
    export RESOLVER_TOKEN="$(openssl rand -hex 32)"
    uvicorn app:app --host 0.0.0.0 --port 8080

Deploy notes:
  - Put it behind HTTPS (Cloudflare Tunnel is the least-effort option and keeps
    the origin unpublished).
  - Keep RESOLVER_TOKEN out of source control; the Worker sends it as a bearer.
  - This service is for media you have the right to download. Do not expose it
    publicly.
  - Cookies (YTDLP_COOKIE_FILE) are supported but OFF by default, and are meant
    for YOUR OWN account only. They are not a way to reach other people's private
    content, and they will not rescue a datacenter IP — see the README.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Final

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, HttpUrl
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError, ExtractorError, GeoRestrictedError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("resolver")

TOKEN: Final[str | None] = os.environ.get("RESOLVER_TOKEN")

# Optional path to a Netscape-format cookies.txt.
#
# THIS is where cookies actually work. The Cloudflare Worker cannot use them:
# every InnerTube client that accepts cookies also needs a JavaScript runtime to
# descramble stream URLs, and Workers have no eval(). yt-dlp here has both a JS
# runtime and (if you host this on a home connection) a residential IP.
#
# Read the risks before enabling — see the README section "YouTube cookies".
COOKIE_FILE: Final[str | None] = os.environ.get("YTDLP_COOKIE_FILE")
# Extraction is CPU-light but network-bound; cap concurrency so a burst cannot
# exhaust file descriptors or get the host rate-limited upstream.
MAX_CONCURRENT: Final[int] = int(os.environ.get("MAX_CONCURRENT", "4"))
EXTRACT_TIMEOUT_SECONDS: Final[int] = int(os.environ.get("EXTRACT_TIMEOUT", "45"))

app = FastAPI(title="MediaFetch resolver", version="1.0.0", docs_url=None, redoc_url=None)
_semaphore = asyncio.Semaphore(MAX_CONCURRENT)

YDL_OPTIONS: Final[dict[str, Any]] = {
    # Metadata only. This service never writes a media file to disk.
    "skip_download": True,
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    # Fail fast rather than hanging a Worker request that has its own timeout.
    "socket_timeout": 15,
    "retries": 1,
    # Segmented formats are unusable by the browser muxer, so do not spend time
    # enumerating fragment lists for them.
    "extractor_args": {"youtube": {"skip": ["dash_manifest"]}},
}

if COOKIE_FILE:
    if os.path.isfile(COOKIE_FILE):
        YDL_OPTIONS["cookiefile"] = COOKIE_FILE
        log.info("cookies enabled from %s", COOKIE_FILE)
    else:
        # Loud, not silent: a typo here degrades every request in a way that is
        # otherwise indistinguishable from YouTube simply blocking you.
        log.error("YTDLP_COOKIE_FILE=%s does not exist; continuing WITHOUT cookies", COOKIE_FILE)


class ExtractRequest(BaseModel):
    url: HttpUrl = Field(..., description="Public media page URL")


def require_token(request: Request) -> None:
    """Bearer auth. Absent TOKEN means auth is disabled — local dev only."""
    if TOKEN is None:
        log.warning("RESOLVER_TOKEN is unset: authentication is DISABLED")
        return

    header = request.headers.get("authorization", "")
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    # Constant-time comparison: a naive `!=` leaks the token byte by byte.
    import hmac

    if not hmac.compare_digest(value, TOKEN):
        raise HTTPException(status_code=401, detail="Invalid token")


def _extract(url: str) -> dict[str, Any]:
    """Blocking yt-dlp call. Runs in a worker thread."""
    with YoutubeDL(YDL_OPTIONS) as ydl:
        info = ydl.extract_info(url, download=False)
        # Normalises internal objects into plain JSON-safe types.
        return ydl.sanitize_info(info)


@app.post("/extract")
async def extract(payload: ExtractRequest, _: None = Depends(require_token)) -> JSONResponse:
    url = str(payload.url)

    async with _semaphore:
        try:
            info = await asyncio.wait_for(
                asyncio.to_thread(_extract, url),
                timeout=EXTRACT_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            log.warning("extract timed out")
            raise HTTPException(status_code=504, detail="Extraction timed out")
        except GeoRestrictedError:
            raise HTTPException(status_code=451, detail="Geo restricted")
        except (DownloadError, ExtractorError) as err:
            # yt-dlp raises the same class for "gone" and "cannot parse"; the
            # message is the only discriminator available.
            message = str(err).lower()
            if any(hint in message for hint in ("private", "unavailable", "not exist", "removed")):
                raise HTTPException(status_code=404, detail="Media unavailable")
            if "not a bot" in message or "sign in to confirm" in message:
                # This host's IP is the problem, not the request. Say so plainly
                # so nobody wastes time hunting for a bad cookie or a bad URL.
                log.error(
                    "YouTube bot-check on this host's IP. Datacenter IPs are blocked; "
                    "run this service on a residential connection."
                )
                raise HTTPException(
                    status_code=503,
                    detail="YouTube bot-check: this host's IP is blocked",
                )
            log.warning("extract failed: %s", err)
            raise HTTPException(status_code=502, detail="Extraction failed")

    if not info:
        raise HTTPException(status_code=404, detail="Nothing extracted")

    # A playlist URL slipped through: return the first entry so the caller still
    # gets something useful.
    if info.get("_type") == "playlist":
        entries = [entry for entry in (info.get("entries") or []) if entry]
        if not entries:
            raise HTTPException(status_code=404, detail="Empty playlist")
        info = entries[0]

    return JSONResponse(info)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "auth": TOKEN is not None,
        "maxConcurrent": MAX_CONCURRENT,
        "cookies": "cookiefile" in YDL_OPTIONS,
    }
