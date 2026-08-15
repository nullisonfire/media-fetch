/**
 * Saving files to disk.
 *
 * Two strategies, chosen at runtime:
 *
 *  1. File System Access API (`showSaveFilePicker`) — streams straight to disk.
 *     Nothing is buffered in memory, so a 4 GB download works on a laptop with
 *     8 GB of RAM. Chromium-based browsers only, and it must be called from a
 *     user gesture.
 *  2. Anchor + object URL — universal fallback. The browser handles the transfer
 *     for a direct URL, so memory is fine there too; only the muxed-Blob path is
 *     memory-bound, and that is unavoidable without the API above.
 */

export function supportsFileSystemAccess(): boolean {
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
}

interface SavePickerOptions {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}

type SaveFilePicker = (options: SavePickerOptions) => Promise<FileSystemFileHandle>;

const EXTENSION_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
};

function pickerTypes(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? 'mp4';
  const mime = EXTENSION_MIME[ext] ?? 'application/octet-stream';
  return [{ description: `${ext.toUpperCase()} file`, accept: { [mime]: [`.${ext}`] } }];
}

/** Raised when the user dismisses the save dialog — not an error worth showing. */
export class SaveCancelled extends Error {
  constructor() {
    super('Save cancelled');
    this.name = 'SaveCancelled';
  }
}

/**
 * Saves an already-materialised Blob (the muxer's output).
 * Prefers the streaming writer so a large Blob is not duplicated in memory by
 * `URL.createObjectURL`.
 */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  if (supportsFileSystemAccess()) {
    const picker = (globalThis as unknown as { showSaveFilePicker: SaveFilePicker })
      .showSaveFilePicker;
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({ suggestedName: filename, types: pickerTypes(filename) });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw new SaveCancelled();
      // Any other picker failure (e.g. cross-origin iframe restrictions) falls
      // through to the anchor strategy rather than dead-ending.
      return anchorSave(blob, filename);
    }
    const writable = await handle.createWritable();
    await blob.stream().pipeTo(writable);
    return;
  }
  return anchorSave(blob, filename);
}

function anchorSave(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  triggerAnchor(url, filename);
  // Revoke on the next macrotask: revoking synchronously can cancel the download
  // in Safari before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Downloads a URL directly, letting the browser own the transfer.
 * This is the right path for single-file (progressive / audio-only) downloads:
 * it is resumable, shows in the browser's download manager, and uses no page
 * memory at all.
 */
export function downloadUrl(url: string, filename?: string): void {
  // `dl=1` makes the Worker send Content-Disposition: attachment.
  const target = new URL(url, location.href);
  target.searchParams.set('dl', '1');
  triggerAnchor(target.toString(), filename);
}

function triggerAnchor(href: string, filename?: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  if (filename) anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Streams a remote URL straight to disk with progress, without buffering.
 * Used for very large single-track downloads when the browser supports it.
 */
export async function streamToDisk(
  url: string,
  filename: string,
  onProgress: (received: number, total: number | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!supportsFileSystemAccess()) {
    downloadUrl(url, filename);
    return;
  }

  const picker = (globalThis as unknown as { showSaveFilePicker: SaveFilePicker })
    .showSaveFilePicker;
  let handle: FileSystemFileHandle;
  try {
    handle = await picker({ suggestedName: filename, types: pickerTypes(filename) });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new SaveCancelled();
    downloadUrl(url, filename);
    return;
  }

  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (HTTP ${response.status}).`);
  }

  const lengthHeader = response.headers.get('content-length');
  const total = lengthHeader ? Number(lengthHeader) : null;
  let received = 0;

  const writable = await handle.createWritable();
  // A TransformStream keeps this a true pipe — bytes go disk-ward as they arrive
  // and progress is observed in passing, never accumulated.
  const meter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      onProgress(received, total);
      controller.enqueue(chunk);
    },
  });

  await response.body.pipeThrough(meter).pipeTo(writable);
}
