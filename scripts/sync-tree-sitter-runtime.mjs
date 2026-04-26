#!/usr/bin/env node
/**
 * Audit Skill — sync the bundled tree-sitter runtime WASM.
 *
 * Reads node_modules/web-tree-sitter/tree-sitter.wasm and writes
 * src/skills/audit/extractor/runtime/runtime-wasm.generated.ts with:
 *   - the bytes as a base64 string (decoded at runtime)
 *   - the SHA-256 of the bytes (cross-checked at load time)
 *   - the npm version + size for telemetry
 *
 * Why bundle the runtime when grammars live in R2:
 *   - The runtime is small (~192 KiB) — fits comfortably in a Worker.
 *   - Grammars (~2.4 MiB each) don't fit, so they stay in R2.
 *   - R2 cold-start can be slow / occasionally unavailable. The handler
 *     tries R2 first (so a hot-uploaded runtime takes effect without a
 *     redeploy), then falls back to the bundled bytes — no hard
 *     dependency on R2 being warm for /audit --analyze to work.
 *
 * Run via:
 *   npm run audit:sync-runtime          → write/update the generated file
 *   npm run audit:sync-runtime -- --check → exit non-zero if stale (CI gate)
 * Idempotent: re-running with no upstream change is a no-op.
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK_ONLY = process.argv.includes('--check');

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_WASM_PATH = resolve(__dirname, '..', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
const RUNTIME_PKG_JSON  = resolve(__dirname, '..', 'node_modules', 'web-tree-sitter', 'package.json');
const OUT_PATH = resolve(__dirname, '..', 'src', 'skills', 'audit', 'extractor', 'runtime', 'runtime-wasm.generated.ts');
/** Mirrors src/skills/audit/types.ts MAX_TREE_SITTER_RUNTIME_BYTES — kept
 *  duplicated so this Node-only script doesn't pull in TS toolchain. */
const MAX_RUNTIME_BYTES = 1 * 1024 * 1024;

function log(...m) { console.log('[sync-runtime]', ...m); }
function die(msg) { console.error('[sync-runtime] ERROR:', msg); process.exit(1); }

async function main() {
  // 1. Read the runtime + its package.json (for the source tag)
  let info;
  try { info = await stat(RUNTIME_WASM_PATH); }
  catch { die(`runtime not found: ${RUNTIME_WASM_PATH}\n  Run: npm install web-tree-sitter@^0.20.8`); }
  if (info.size > MAX_RUNTIME_BYTES) {
    die(`runtime is ${info.size} bytes — exceeds MAX_TREE_SITTER_RUNTIME_BYTES (${MAX_RUNTIME_BYTES})`);
  }
  const bytes = await readFile(RUNTIME_WASM_PATH);
  const pkg = JSON.parse(await readFile(RUNTIME_PKG_JSON, 'utf8'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const base64 = bytes.toString('base64');

  // 2. If the generated file already matches, no-op (idempotency)
  let existing = '';
  try { existing = await readFile(OUT_PATH, 'utf8'); } catch { /* missing */ }
  const marker = `RUNTIME_WASM_SHA256 = '${sha256}'`;
  if (existing.includes(marker)) {
    log(`unchanged (sha8=${sha256.slice(0, 8)}, version=${pkg.version}, ${bytes.length} bytes)`);
    return;
  }

  // 3. --check mode: exit non-zero so CI catches stale generated files.
  if (CHECK_ONLY) {
    console.error('[sync-runtime] STALE');
    console.error(`  installed:  web-tree-sitter@${pkg.version}, sha8=${sha256.slice(0, 8)}`);
    console.error(`  generated:  ${marker.replace('RUNTIME_WASM_SHA256 = ', '').replace(/'/g, '').slice(0, 8) || '(missing)'}`);
    console.error('  Run `npm run audit:sync-runtime` to regenerate before deploying.');
    process.exit(1);
  }

  // 4. Write (default mode)
  const source = generated({ base64, sha256, size: bytes.length, version: pkg.version });
  await writeFile(OUT_PATH, source, 'utf8');
  log(`wrote ${OUT_PATH}`);
  log(`  source:  web-tree-sitter@${pkg.version}`);
  log(`  size:    ${bytes.length} bytes (${(bytes.length / 1024).toFixed(1)} KiB)`);
  log(`  sha8:    ${sha256.slice(0, 8)}`);
  log(`  base64:  ${base64.length} chars (${((base64.length / 1024)).toFixed(1)} KiB inflated)`);
}

function generated({ base64, sha256, size, version }) {
  // The base64 line is wrapped at 76 chars to keep diffs readable.
  const wrapped = base64.match(/.{1,76}/g)?.join('\n') ?? base64;
  return `/**
 * GENERATED — do not edit by hand.
 *
 * Bundled web-tree-sitter runtime WASM. Source of truth:
 *   node_modules/web-tree-sitter/tree-sitter.wasm
 *
 * Regenerate with:
 *   npm run audit:sync-runtime
 *
 * The handler prefers R2-stored runtime (allows hot updates without a
 * redeploy); this bundled copy is the cold-start fallback so /audit
 * --analyze never depends on R2 being warm.
 */

/* eslint-disable */
// prettier-ignore
export const RUNTIME_WASM_BASE64 = \`
${wrapped}
\`.replace(/\\s+/g, '');

export const RUNTIME_WASM_SHA256 = '${sha256}';
export const RUNTIME_WASM_SIZE = ${size};
export const RUNTIME_WASM_SOURCE = 'web-tree-sitter@${version}';
`;
}

main().catch(err => die(err.stack ?? err.message ?? String(err)));
