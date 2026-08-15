import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { createReadStream, statSync } from 'node:fs';

/**
 * Serves vendor/ffmpeg/* at /vendor/ffmpeg/* during `vite dev`.
 *
 * In production the Worker streams these from R2 (src/worker/routes/vendor.ts),
 * because the 31 MiB wasm core exceeds the Workers Assets file-size limit and so
 * cannot live in publicDir. This plugin reproduces that URL shape locally so the
 * muxer's CORE_BASE constant is identical in both environments.
 */
function ffmpegCoreDevServer(): Plugin {
  const TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
  };
  return {
    name: 'mediafetch:ffmpeg-core-dev',
    apply: 'serve',
    configureServer(server) {
      const dir = fileURLToPath(new URL('./vendor/ffmpeg/', import.meta.url));
      server.middlewares.use('/vendor/ffmpeg', (req, res, next) => {
        // Strip any query/hash, and refuse traversal outright.
        const name = (req.url ?? '').split('?')[0]?.replace(/^\//, '') ?? '';
        if (!name || name.includes('/') || name.includes('..')) return next();

        const file = dir + name;
        let size: number;
        try {
          size = statSync(file).size;
        } catch {
          return next();
        }

        const ext = name.slice(name.lastIndexOf('.'));
        res.setHeader('Content-Type', TYPES[ext] ?? 'application/octet-stream');
        res.setHeader('Content-Length', String(size));
        // Mirrors the production headers so COEP behaviour matches.
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        createReadStream(file).pipe(res);
      });
    },
  };
}

/**
 * The client is a plain-TS SPA (no framework runtime); the initial bundle is
 * ~21 kB gzipped, most of it Zod, which is shared with the Worker so response
 * validation cannot drift from the contract. ffmpeg.wasm is loaded lazily and only
 * when a mux is actually requested, so first paint never pays for it.
 */
export default defineConfig({
  plugins: [ffmpegCoreDevServer()],

  root: fileURLToPath(new URL('./src/client', import.meta.url)),
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),

  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@client': fileURLToPath(new URL('./src/client', import.meta.url)),
    },
  },

  build: {
    outDir: fileURLToPath(new URL('./dist/client', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    /**
     * No published source maps. Workers Assets serves everything in dist/ over
     * the public internet, so `sourcemap: true` uploads a browsable copy of the
     * entire client source (~290 kB) alongside the bundle. Use `sourcemap:
     * 'hidden'` plus an error-reporting upload step if you need them later.
     */
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          // Keep the muxer in its own chunk; it is dynamically imported.
          muxer: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
        },
      },
    },
  },

  server: {
    port: 5173,
    // SharedArrayBuffer (multithreaded ffmpeg.wasm) requires cross-origin isolation.
    // Production parity for these headers lives in public/_headers.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      // During `npm run dev`, forward API traffic to `wrangler dev`.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
