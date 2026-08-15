/**
 * Browser capability probes.
 *
 * These live in their own module, apart from muxer.ts, for a concrete build
 * reason: main.ts needs to know whether muxing is possible in order to render the
 * UI, but must NOT pull the muxer into the initial bundle. Importing muxer.ts both
 * statically (for a probe) and dynamically (for the real work) defeats code
 * splitting entirely — Rollup keeps it in the main chunk and warns. Probes here,
 * heavy machinery there.
 */

/** WebAssembly is the hard requirement for any muxing at all. */
export function isMuxSupported(): boolean {
  return typeof WebAssembly !== 'undefined' && typeof Blob !== 'undefined';
}

/**
 * True when the multithreaded ffmpeg core can run.
 *
 * Requires SharedArrayBuffer, which browsers only expose under cross-origin
 * isolation (COOP: same-origin + COEP: require-corp — see public/_headers).
 * When false the single-threaded core still works, roughly 3-5x slower.
 */
export function isCrossOriginIsolated(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
}
