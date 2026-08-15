/**
 * Injects the resolver's origin into the Content-Security-Policy at build time.
 *
 * THE PROBLEM
 *
 * The app streams media bytes straight from the resolver to the browser, because
 * YouTube signs its CDN URLs against the extracting host's IP and refuses every
 * other address. That fetch is cross-origin, and the page ships
 * `connect-src 'self' blob:`, so the browser blocks it:
 *
 *   Refused to connect ... violates the following Content Security Policy
 *   directive: "connect-src 'self' blob:"
 *
 * THE AWKWARD PART
 *
 * CSP is a static header in public/_headers, served by Workers Assets without
 * ever invoking the Worker — so it cannot read RESOLVER_BASE_URL from the
 * environment at request time. And it cannot be loosened from inside the page
 * either: multiple policies INTERSECT, so a <meta> CSP can only ever restrict
 * further, never permit more.
 *
 * THE FIX
 *
 * wrangler.toml is committed, and it is already where RESOLVER_BASE_URL lives.
 * So read it here, after the client build, and rewrite the emitted _headers with
 * that one extra origin. Deterministic, needs no CI environment variables, and
 * keeps the policy as tight as it can be — one named origin rather than the
 * `https:` wildcard that would otherwise be the easy way out.
 *
 * Runs automatically as part of `npm run build`.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const headersPath = resolve(root, 'dist/client/_headers');
const wranglerPath = resolve(root, 'wrangler.toml');

/**
 * Pulls RESOLVER_BASE_URL out of wrangler.toml without a TOML parser.
 *
 * Deliberately skips commented lines: a `#`-prefixed example must not be
 * mistaken for live configuration, which is the exact confusion that made a
 * commented `[vars]` header look like a working one.
 */
function readResolverOrigin() {
  if (!existsSync(wranglerPath)) return null;

  const line = readFileSync(wranglerPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => !l.startsWith('#') && /^RESOLVER_BASE_URL\s*=/.test(l));

  if (!line) return null;

  const value = /=\s*["']([^"']+)["']/.exec(line)?.[1];
  if (!value || value.includes('example.')) return null;

  try {
    return new URL(value).origin;
  } catch {
    console.warn(`[build-headers] RESOLVER_BASE_URL is not a valid URL: ${value}`);
    return null;
  }
}

const origin = readResolverOrigin();

if (!existsSync(headersPath)) {
  console.warn('[build-headers] dist/client/_headers not found — run the client build first.');
  process.exit(0);
}

if (!origin) {
  console.log('[build-headers] No resolver configured; CSP left at same-origin only.');
  process.exit(0);
}

const original = readFileSync(headersPath, 'utf8');

/**
 * connect-src covers fetch() — the muxer reading track bytes.
 * media-src covers <video>/<audio> — the in-page preview.
 * Both need the resolver, and neither should get a blanket `https:`.
 */
const updated = original.replace(
  /(connect-src|media-src) ([^;]*)/g,
  (match, directive, sources) =>
    sources.includes(origin) ? match : `${directive} ${sources.trim()} ${origin}`,
);

if (updated === original) {
  console.log(`[build-headers] CSP already allows ${origin}.`);
} else {
  writeFileSync(headersPath, updated);
  console.log(`[build-headers] CSP now allows the resolver: ${origin}`);
}
