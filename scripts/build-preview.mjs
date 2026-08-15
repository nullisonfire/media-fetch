/**
 * Builds a single self-contained preview.html from the real index.html + styles.css,
 * swapping the module entry for a mock API so the UI can be clicked through
 * without a Worker, a resolver, or ffmpeg.wasm.
 *
 * The markup and CSS are the SHIPPING ones — only the data layer is faked, so the
 * preview cannot drift from the real interface.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const html = await readFile(join(ROOT, 'src/client/index.html'), 'utf8');
const css = await readFile(join(ROOT, 'src/client/styles.css'), 'utf8');
const mock = await readFile(join(ROOT, 'scripts/preview-mock.js'), 'utf8');

const output = html
  .replace('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />', '')
  .replace('</head>', `  <style>\n${css}\n  </style>\n  </head>`)
  .replace(
    '<script type="module" src="/main.ts"></script>',
    `<div class="preview-flag">Interactive preview — mock data, no network calls</div>\n    <script>\n${mock}\n    </script>`,
  )
  .replace(
    '</style>',
    `.preview-flag{position:fixed;bottom:0;left:0;right:0;padding:7px 16px;text-align:center;
  font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;font-weight:600;
  color:#0a0b10;background:linear-gradient(90deg,#6d8bff,#a76bff,#ff7ac6);z-index:99}
  body{padding-bottom:34px}
</style>`,
  );

await writeFile(join(ROOT, 'preview.html'), output, 'utf8');
console.log(`[preview] wrote preview.html (${(output.length / 1024).toFixed(0)} kB)`);
