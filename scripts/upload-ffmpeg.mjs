/**
 * Uploads the vendored ffmpeg core to R2.
 *
 * The core cannot ship as a static asset (31 MiB > the 25 MiB Workers Assets
 * limit) and cannot be loaded from a CDN (COEP: require-corp blocks cross-origin
 * subresources without CORP headers). So it lives in R2 and the Worker streams it
 * same-origin from /vendor/ffmpeg/*.
 *
 * Run once per ffmpeg version bump:
 *   wrangler r2 bucket create mediafetch-vendor   # first time only
 *   npm run vendor:ffmpeg
 *   npm run upload:ffmpeg
 */
import { spawnSync } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'vendor', 'ffmpeg');

// Must match CORE_FILES in src/worker/routes/vendor.ts.
const FILES = [
  ['ffmpeg-core.js', 'text/javascript'],
  ['ffmpeg-core.wasm', 'application/wasm'],
  ['ffmpeg-core.worker.js', 'text/javascript'],
];

const BUCKET = process.env.R2_BUCKET ?? 'mediafetch-vendor';
const REMOTE = process.argv.includes('--local') ? [] : ['--remote'];

async function main() {
  try {
    await access(SOURCE);
  } catch {
    console.error('[upload-ffmpeg] vendor/ffmpeg is missing. Run `npm run vendor:ffmpeg` first.');
    process.exit(1);
  }

  for (const [name, contentType] of FILES) {
    const path = join(SOURCE, name);
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch {
      console.warn(`[upload-ffmpeg] skipping missing ${name}`);
      continue;
    }

    console.log(`[upload-ffmpeg] ${name} (${(size / 1024 / 1024).toFixed(1)} MiB) -> r2://${BUCKET}/ffmpeg/${name}`);

    const result = spawnSync(
      'npx',
      [
        'wrangler',
        'r2',
        'object',
        'put',
        `${BUCKET}/ffmpeg/${name}`,
        '--file',
        path,
        '--content-type',
        contentType,
        // Immutable: the filename is version-pinned by the vendor script.
        '--cache-control',
        'public, max-age=31536000, immutable',
        ...REMOTE,
      ],
      { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' },
    );

    if (result.status !== 0) {
      console.error(`[upload-ffmpeg] failed on ${name}`);
      process.exit(result.status ?? 1);
    }
  }

  console.log('[upload-ffmpeg] done. The muxer will now load from /vendor/ffmpeg/.');
}

main().catch((err) => {
  console.error('[upload-ffmpeg] failed:', err);
  process.exit(1);
});
