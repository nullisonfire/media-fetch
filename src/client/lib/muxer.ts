import type { OutputContainer } from '@shared/contracts';
import { pickOutputContainer } from '@shared/contracts';
import { isCrossOriginIsolated, isMuxSupported } from './capabilities';

/**
 * IN-BROWSER AUDIO/VIDEO MUXER
 * ============================
 *
 * Platforms serve high-quality video and audio as separate adaptive streams.
 * Combining them is the single feature that makes "best quality" actually
 * downloadable, and it happens here, on the user's machine, in WebAssembly.
 *
 * WHY NOT ON THE SERVER
 * --------------------
 * Cloudflare Workers cannot execute native binaries and have a bounded CPU
 * budget per request; ffmpeg is a native binary that would need to touch every
 * byte of a multi-gigabyte file. Even on a container platform, server-side muxing
 * means paying to move every byte twice and holding user media on your disks.
 * Doing it client-side is faster for the user, free for the operator, and means
 * the media never touches your infrastructure.
 *
 * WHY IT IS FAST ANYWAY
 * ---------------------
 * We only ever STREAM COPY (`-c copy`). No decoding, no re-encoding — ffmpeg just
 * rewrites container headers and interleaves the existing packets. A 1080p movie
 * remuxes in seconds and is I/O-bound, not CPU-bound.
 *
 * REQUIREMENTS
 * ------------
 * SharedArrayBuffer (used by the multithreaded core) requires cross-origin
 * isolation: COOP `same-origin` + COEP `require-corp`, set in public/_headers,
 * and every asset served same-origin (hence scripts/vendor-ffmpeg.mjs).
 */

/** Where scripts/vendor-ffmpeg.mjs puts the same-origin core. */
const CORE_BASE = '/vendor/ffmpeg';

/**
 * Resolves the wasm binary's URL.
 *
 * The core is ~31 MiB and Cloudflare Workers Assets rejects any single file over
 * 25 MiB, so it cannot ship whole. Two strategies, tried in order:
 *
 *  1. SPLIT STATIC ASSETS (default, zero infrastructure). The build splits the
 *     wasm into 10 MiB parts plus a manifest; we fetch them in parallel, join
 *     them, and hand ffmpeg a blob: URL. blob: URLs inherit this document's
 *     cross-origin isolation, so COEP is satisfied for free.
 *  2. R2 VIA THE WORKER (fallback). If no manifest is deployed, use the plain
 *     path and let the Worker stream it from R2. Keeps deploys lean at the cost
 *     of provisioning a bucket.
 *
 * Either way the bytes are same-origin, which COEP: require-corp requires.
 */
async function resolveWasmUrl(onProgress: MuxRequest['onProgress']): Promise<string> {
  let manifest: { byteLength: number; parts: string[] } | null = null;
  try {
    const response = await fetch(`${CORE_BASE}/core-manifest.json`, { cache: 'force-cache' });
    if (response.ok) manifest = await response.json();
  } catch {
    /* fall through to the R2 path */
  }

  if (!manifest?.parts?.length) return `${CORE_BASE}/ffmpeg-core.wasm`;

  const total = manifest.byteLength;
  let received = 0;
  const report = () =>
    onProgress({
      phase: 'load',
      ratio: total ? Math.min(1, received / total) : null,
      message: 'Loading the muxer…',
      bytesProcessed: received,
      ...(total ? { bytesTotal: total } : {}),
    });
  report();

  // Parallel: these are independent immutable files on the edge cache.
  const buffers = await Promise.all(
    manifest.parts.map(async (name) => {
      const response = await fetch(`${CORE_BASE}/${name}`, { cache: 'force-cache' });
      if (!response.ok) {
        throw new MuxError(`Could not load muxer part ${name} (HTTP ${response.status}).`);
      }
      const buffer = await response.arrayBuffer();
      received += buffer.byteLength;
      report();
      return new Uint8Array(buffer);
    }),
  );

  const joined = new Uint8Array(total || buffers.reduce((sum, b) => sum + b.byteLength, 0));
  let offset = 0;
  for (const buffer of buffers) {
    joined.set(buffer, offset);
    offset += buffer.byteLength;
  }

  if (total && offset !== total) {
    // A truncated or stale part set yields a binary that fails to instantiate
    // with an opaque error; catching it here says what actually went wrong.
    throw new MuxError(
      `The muxer binary is incomplete (${offset} of ${total} bytes). Redeploy to refresh it.`,
    );
  }

  return URL.createObjectURL(new Blob([joined as BlobPart], { type: 'application/wasm' }));
}

export interface MuxProgress {
  /** 'download' while fetching tracks, 'mux' while ffmpeg runs. */
  phase: 'load' | 'download' | 'mux' | 'finalize';
  /** 0..1, or null when the total size is unknown. */
  ratio: number | null;
  /** Human-readable status line. */
  message: string;
  bytesProcessed?: number;
  bytesTotal?: number;
}

export interface MuxRequest {
  videoUrl: string;
  audioUrl: string;
  videoCodec: string;
  audioCodec: string;
  videoContainer: string;
  audioContainer: string;
  /** Base filename without extension. */
  filename: string;
  onProgress: (progress: MuxProgress) => void;
  signal?: AbortSignal;
}

export interface MuxResult {
  blob: Blob;
  filename: string;
  container: OutputContainer;
}

export class MuxError extends Error {
  /**
   * Forwards to Error's own `cause` (ES2022) rather than declaring a field that
   * shadows it — a parameter property here would silently override the base
   * member and lose the standard behaviour devtools rely on.
   */
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'MuxError';
  }
}

/** Browsers cap a single WASM heap around 2 GB; warn well before that. */
const SAFE_TOTAL_BYTES = 1_800_000_000;

/* ------------------------------------------------------------------ *
 * ffmpeg lifecycle
 * ------------------------------------------------------------------ */

type FFmpegInstance = import('@ffmpeg/ffmpeg').FFmpeg;

let instance: FFmpegInstance | null = null;
let loading: Promise<FFmpegInstance> | null = null;

/**
 * Loads ffmpeg.wasm once and keeps it warm. The import is dynamic so the ~30 MB
 * core is never fetched by users who only download progressive files.
 */
async function getFFmpeg(onProgress: MuxRequest['onProgress']): Promise<FFmpegInstance> {
  if (instance) return instance;
  if (loading) return loading;

  loading = (async () => {
    onProgress({ phase: 'load', ratio: null, message: 'Loading the muxer…' });

    const [{ FFmpeg }, wasmURL] = await Promise.all([
      import('@ffmpeg/ffmpeg'),
      resolveWasmUrl(onProgress),
    ]);
    const ffmpeg = new FFmpeg();

    // Surface ffmpeg's own logs only in dev; they are noisy but invaluable.
    if (import.meta.env.DEV) {
      ffmpeg.on('log', ({ message }) => console.debug('[ffmpeg]', message));
    }

    await ffmpeg.load({
      coreURL: `${CORE_BASE}/ffmpeg-core.js`,
      wasmURL,
      // The worker file only exists in the -mt build; omit it when we are not
      // cross-origin isolated so we degrade to the single-threaded core instead
      // of failing to start at all.
      ...(isCrossOriginIsolated() ? { workerURL: `${CORE_BASE}/ffmpeg-core.worker.js` } : {}),
    });

    // ffmpeg has copied the bytes by now; release the 31 MiB blob.
    if (wasmURL.startsWith('blob:')) URL.revokeObjectURL(wasmURL);

    instance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await loading;
  } catch (cause) {
    loading = null;
    throw new MuxError(
      'The muxer could not start. Reload the page and try again.',
      cause,
    );
  }
}

/** Frees the WASM heap. Worth calling after very large jobs. */
export async function disposeMuxer(): Promise<void> {
  try {
    await instance?.terminate();
  } finally {
    instance = null;
    loading = null;
  }
}

/* ------------------------------------------------------------------ *
 * Download with progress
 * ------------------------------------------------------------------ */

/**
 * Streams a URL into memory while reporting progress.
 *
 * Uses the ReadableStream reader rather than `response.arrayBuffer()` so the user
 * sees movement on a 500 MB track instead of a frozen bar, and so an abort takes
 * effect immediately.
 */
async function fetchWithProgress(
  url: string,
  label: string,
  onProgress: (received: number, total: number | null) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) {
    throw new MuxError(
      response.status === 410
        ? 'The download link expired. Resolve the link again.'
        : `Could not fetch the ${label} track (HTTP ${response.status}).`,
    );
  }
  if (!response.body) throw new MuxError(`The ${label} track returned an empty response.`);

  const lengthHeader = response.headers.get('content-length');
  const total = lengthHeader ? Number(lengthHeader) : null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, total);
  }

  // Single allocation + copy, rather than repeated concatenation.
  const output = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Downloads a video track and an audio track, then combines them into one file.
 * Resolves with a Blob ready to hand to the save helper.
 */
export async function muxTracks(request: MuxRequest): Promise<MuxResult> {
  const { videoUrl, audioUrl, onProgress, signal } = request;

  if (!isMuxSupported()) {
    throw new MuxError('This browser cannot run the muxer (WebAssembly unavailable).');
  }

  const container = pickOutputContainer(request.videoCodec, request.audioCodec);
  const ffmpeg = await getFFmpeg(onProgress);

  // Extensions matter: ffmpeg infers the demuxer from them, and guessing wrong
  // ("all .mp4") makes WebM/Opus inputs fail to parse.
  const videoInput = `in_video.${request.videoContainer || 'mp4'}`;
  const audioInput = `in_audio.${request.audioContainer || 'm4a'}`;
  const output = `out.${container}`;

  try {
    /* ---- 1. Fetch both tracks in parallel ---- */
    let videoBytes = 0;
    let audioBytes = 0;
    let videoTotal: number | null = null;
    let audioTotal: number | null = null;

    const report = () => {
      const received = videoBytes + audioBytes;
      const total = videoTotal !== null && audioTotal !== null ? videoTotal + audioTotal : null;
      onProgress({
        phase: 'download',
        ratio: total ? Math.min(1, received / total) : null,
        message: 'Downloading video and audio tracks…',
        bytesProcessed: received,
        ...(total ? { bytesTotal: total } : {}),
      });
    };

    const [video, audio] = await Promise.all([
      fetchWithProgress(
        videoUrl,
        'video',
        (received, total) => {
          videoBytes = received;
          videoTotal = total;
          report();
        },
        signal,
      ),
      fetchWithProgress(
        audioUrl,
        'audio',
        (received, total) => {
          audioBytes = received;
          audioTotal = total;
          report();
        },
        signal,
      ),
    ]);

    if (video.byteLength + audio.byteLength > SAFE_TOTAL_BYTES) {
      throw new MuxError(
        'These tracks are too large to combine in the browser (over ~1.8 GB). Pick a lower resolution.',
      );
    }

    /* ---- 2. Feed the WASM filesystem ---- */
    await ffmpeg.writeFile(videoInput, video);
    await ffmpeg.writeFile(audioInput, audio);

    /* ---- 3. Remux ---- */
    onProgress({ phase: 'mux', ratio: 0, message: 'Combining tracks…' });

    const onFFmpegProgress = ({ progress }: { progress: number }) => {
      // ffmpeg reports slightly over 1.0 near the end; clamp for the UI.
      onProgress({
        phase: 'mux',
        ratio: Math.max(0, Math.min(1, progress)),
        message: 'Combining tracks…',
      });
    };
    ffmpeg.on('progress', onFFmpegProgress);

    const args = [
      '-i', videoInput,
      '-i', audioInput,
      // Explicit stream mapping: take video from input 0, audio from input 1.
      // Without this ffmpeg may pick a stream from the wrong input.
      '-map', '0:v:0',
      '-map', '1:a:0',
      // The whole point: copy packets, never re-encode.
      '-c', 'copy',
      // Stop at the shorter track so a metadata mismatch cannot produce a file
      // with several seconds of silence or a frozen frame at the end.
      '-shortest',
      ...(container === 'mp4'
        ? [
            // Move the moov atom to the front so the file is playable while
            // still downloading and seekable immediately.
            '-movflags', '+faststart',
            // Some audio streams (notably AAC in fragmented MP4) need this to
            // sit correctly in a plain MP4 container.
            '-bsf:a', 'aac_adtstoasc',
          ]
        : []),
      output,
    ];

    let exitCode: number;
    try {
      exitCode = await ffmpeg.exec(args);
    } catch (cause) {
      throw new MuxError('The muxer failed while combining the tracks.', cause);
    } finally {
      ffmpeg.off('progress', onFFmpegProgress);
    }

    // `aac_adtstoasc` is a no-op-or-error filter depending on the source. If the
    // first attempt fails, retry once without the optional MP4 flags — this
    // recovers the common "bitstream filter not applicable" case.
    if (exitCode !== 0 && container === 'mp4') {
      const fallback = args.filter(
        (arg, i) =>
          arg !== '-bsf:a' && args[i - 1] !== '-bsf:a',
      );
      exitCode = await ffmpeg.exec(fallback);
    }

    if (exitCode !== 0) {
      throw new MuxError(
        `The muxer exited with code ${exitCode}. The selected tracks may be incompatible — try a different pair.`,
      );
    }

    /* ---- 4. Read the result out ---- */
    onProgress({ phase: 'finalize', ratio: 1, message: 'Preparing your file…' });

    const data = await ffmpeg.readFile(output);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;

    if (bytes.byteLength === 0) {
      throw new MuxError('The muxer produced an empty file.');
    }

    return {
      blob: new Blob([bytes as BlobPart], { type: mimeFor(container) }),
      filename: `${request.filename}.${container}`,
      container,
    };
  } finally {
    // Always clear the virtual FS: the WASM heap does not shrink on its own and
    // a leftover 1 GB input would make the next mux fail with OOM.
    await Promise.allSettled([
      ffmpeg.deleteFile(videoInput),
      ffmpeg.deleteFile(audioInput),
      ffmpeg.deleteFile(output),
    ]);
  }
}

function mimeFor(container: OutputContainer): string {
  switch (container) {
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
  }
}
