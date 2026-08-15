/**
 * Copies the ffmpeg.wasm core into vendor/ffmpeg/ (NOT public/).
 *
 * Deliberately NOT public/: `ffmpeg-core.wasm` is ~31 MiB and Cloudflare Workers
 * Assets rejects any single file over 25 MiB, so a copy under public/ would make
 * `wrangler deploy` fail outright. Instead the core lives in R2 and is streamed
 * by the Worker at /vendor/ffmpeg/* (src/worker/routes/vendor.ts).
 *
 * It must still be SAME-ORIGIN: the app sets
 * `Cross-Origin-Embedder-Policy: require-corp` (needed for SharedArrayBuffer, in
 * turn needed for the multithreaded muxer), and under that policy a cross-origin
 * script/wasm load is blocked unless the host sends CORP headers -- unpkg,
 * jsdelivr and public R2 URLs do not.
 *
 * In dev, vite.config.ts serves this directory at the same /vendor/ffmpeg path.
 *
 * Runs automatically on `npm install` (postinstall). Safe to re-run.
 */
import { mkdir, copyFile, access, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'vendor', 'ffmpeg');

/**
 * Where the browser-served copy goes. This IS inside publicDir, on purpose.
 *
 * The 31 MiB wasm cannot ship as one asset (Workers Assets rejects files over
 * 25 MiB), so it is SPLIT into parts that each sit comfortably under the limit
 * and are reassembled in the browser. That removes the need for R2 entirely:
 * no bucket, no upload step, no extra service — just static files on the edge.
 *
 * The small .js files are copied whole; only the wasm needs splitting.
 */
const PUBLIC_DEST = join(ROOT, 'public', 'vendor', 'ffmpeg');

/** 10 MiB parts: a wide margin under the 25 MiB per-file ceiling. */
const PART_BYTES = 10 * 1024 * 1024;

/**
 * core-mt = multithreaded build. `ffmpeg-core.worker.js` only exists in the -mt
 * package; the single-threaded fallback omits it.
 */
const FILES = [
  ['node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.js', 'ffmpeg-core.js'],
  ['node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.wasm', 'ffmpeg-core.wasm'],
  ['node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.worker.js', 'ffmpeg-core.worker.js'],
];

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  await mkdir(DEST, { recursive: true });

  let copied = 0;
  for (const [from, to] of FILES) {
    const src = join(ROOT, from);
    if (!(await exists(src))) {
      console.warn(`[vendor-ffmpeg] missing ${from} -- skipping`);
      continue;
    }
    await copyFile(src, join(DEST, to));
    copied += 1;
  }

  if (copied === 0) {
    console.warn(
      '[vendor-ffmpeg] Nothing copied. Run `npm i -D @ffmpeg/core-mt` then `npm run vendor:ffmpeg`.',
    );
    return;
  }
  console.log(`[vendor-ffmpeg] vendored ${copied} file(s) -> vendor/ffmpeg/`);

  await publishSplitCore();
}

/**
 * Publishes the browser-facing copy into publicDir: the .js files verbatim, and
 * the wasm split into sub-25-MiB parts plus a manifest the client reads.
 */
async function publishSplitCore() {
  // Start clean so a version bump cannot leave stale parts behind — a mixed set
  // of parts would produce a corrupt binary and a baffling error.
  await rm(PUBLIC_DEST, { recursive: true, force: true });
  await mkdir(PUBLIC_DEST, { recursive: true });

  for (const name of ['ffmpeg-core.js', 'ffmpeg-core.worker.js']) {
    const from = join(DEST, name);
    if (await exists(from)) await copyFile(from, join(PUBLIC_DEST, name));
  }

  const wasmPath = join(DEST, 'ffmpeg-core.wasm');
  if (!(await exists(wasmPath))) {
    console.warn('[vendor-ffmpeg] no ffmpeg-core.wasm to split');
    return;
  }

  const wasm = await readFile(wasmPath);
  const parts = [];
  for (let offset = 0, index = 0; offset < wasm.length; offset += PART_BYTES, index += 1) {
    const name = `ffmpeg-core.wasm.${index}.part`;
    await writeFile(join(PUBLIC_DEST, name), wasm.subarray(offset, offset + PART_BYTES));
    parts.push(name);
  }

  // byteLength lets the client allocate once and verify the reassembly.
  await writeFile(
    join(PUBLIC_DEST, 'core-manifest.json'),
    JSON.stringify({ byteLength: wasm.length, parts }, null, 2),
  );

  const mib = (wasm.length / 1048576).toFixed(1);
  console.log(
    `[vendor-ffmpeg] split ${mib} MiB wasm into ${parts.length} part(s) -> public/vendor/ffmpeg/`,
  );
  console.log('[vendor-ffmpeg] no R2 bucket required; parts ship as static assets');
}

main().catch((err) => {
  console.error('[vendor-ffmpeg] failed:', err);
  process.exit(1);
});
