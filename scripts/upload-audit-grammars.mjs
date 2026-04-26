#!/usr/bin/env node
/**
 * Audit Skill — Grammar Uploader
 *
 * Uploads tree-sitter WASM grammars from `tree-sitter-wasms` (devDep) to the
 * MOLTBOT_BUCKET R2 bucket so the Worker-side grammar loader can fetch them
 * at runtime. Idempotent: compares each local grammar's SHA-256 against the
 * existing R2 manifest and skips unchanged entries.
 *
 * Usage:
 *   npm run audit:upload-grammars                       # upload MVP set
 *   npm run audit:upload-grammars -- --all              # everything tree-sitter-wasms ships
 *   npm run audit:upload-grammars -- --dry-run          # plan without writing
 *   npm run audit:upload-grammars -- --env production   # target a Wrangler environment
 *   npm run audit:upload-grammars -- --help             # show usage
 *
 * Wrangler is always invoked with --remote so that R2 writes hit the
 * Cloudflare-side bucket (never a local emulator). The script's own --env
 * flag selects the Wrangler environment (e.g. staging vs production).
 *
 * R2 layout produced:
 *   audit/grammars/manifest.json
 *   audit/grammars/<lang>@<sha8>.wasm
 *
 * Constraints:
 *   - No bundling assumptions: this is a local Node script, never imported
 *     by the Worker. Wrangler is shelled-out via `npx wrangler r2 object put/get`
 *     so the operator's existing CF Access auth applies.
 *   - Idempotent: re-running with no changes does no R2 writes.
 *   - Hard size guard mirrors src/skills/audit/types.ts MAX_GRAMMAR_BYTES.
 */

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Mirrors src/skills/audit/types.ts MVP_GRAMMARS + MAX_GRAMMAR_BYTES.
// Kept duplicated rather than imported so this script has no TS toolchain dependency.
const MVP_GRAMMARS = ['typescript', 'tsx', 'javascript', 'python', 'go'];
const MAX_GRAMMAR_BYTES = 5 * 1024 * 1024;
const BUCKET_BINDING = 'MOLTBOT_BUCKET';
const MANIFEST_KEY = 'audit/grammars/manifest.json';
const SOURCE_TAG = 'tree-sitter-wasms@0.1.13';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRAMMAR_DIR = resolve(__dirname, '..', 'node_modules', 'tree-sitter-wasms', 'out');
const RUNTIME_WASM_PATH = resolve(__dirname, '..', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
const RUNTIME_SOURCE_TAG = 'web-tree-sitter@0.20.8';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printUsageAndExit(0);
}
const DRY_RUN = args.includes('--dry-run');
const ALL = args.includes('--all');
const ENV_IDX = args.indexOf('--env');
const WRANGLER_ENV = ENV_IDX !== -1 ? args[ENV_IDX + 1] : null; // e.g. "production"
if (ENV_IDX !== -1 && (!WRANGLER_ENV || WRANGLER_ENV.startsWith('--'))) {
  console.error('[grammars] ERROR: --env requires a value (e.g. --env production)');
  printUsageAndExit(1);
}
// Backwards-compat warning: the v0 of this script accepted --remote <env>
// to mean "use this wrangler environment". That conflated wrangler's own
// --remote (operate on Cloudflare-side resources) with environment
// selection. Now --env names the environment, and --remote is always
// passed to wrangler internally. Tell operators if they used the old form.
if (args.includes('--remote')) {
  console.error('[grammars] ERROR: --remote was renamed to --env. Use: --env <wrangler-env>');
  printUsageAndExit(1);
}

function printUsageAndExit(code) {
  console.log(`Usage: node scripts/upload-audit-grammars.mjs [options]

Options:
  --all                Upload every grammar tree-sitter-wasms ships (not just MVP set)
  --dry-run            Show what would happen without writing to R2
  --env <name>         Use the named Wrangler environment (e.g. production, staging)
  --help, -h           Show this message

Wrangler is always invoked with --remote so writes go to the real Cloudflare
bucket. Re-running with no changes is a no-op.`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...m) { console.log('[grammars]', ...m); }
function warn(...m) { console.warn('[grammars] WARN:', ...m); }
function die(msg) { console.error('[grammars] ERROR:', msg); process.exit(1); }

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function wranglerArgs(...rest) {
  const out = ['wrangler', ...rest];
  if (WRANGLER_ENV) out.push(`--env=${WRANGLER_ENV}`);
  out.push('--remote');
  return out;
}

/** Run `npx wrangler ...` synchronously; return { code, stdout, stderr }. */
function runWrangler(...wranglerCliArgs) {
  const argv = wranglerArgs(...wranglerCliArgs);
  if (DRY_RUN && (wranglerCliArgs[1] === 'put' || wranglerCliArgs[1] === 'delete')) {
    log('dry-run:', 'npx', argv.join(' '));
    return { code: 0, stdout: '', stderr: '' };
  }
  const r = spawnSync('npx', argv, { encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function readGrammar(language) {
  const path = join(GRAMMAR_DIR, `tree-sitter-${language}.wasm`);
  let info;
  try { info = await stat(path); }
  catch { die(`grammar not found: ${path}\n  Run: npm install tree-sitter-wasms@^0.1.13`); }
  if (info.size > MAX_GRAMMAR_BYTES) {
    die(`grammar ${language} is ${info.size} bytes — exceeds MAX_GRAMMAR_BYTES (${MAX_GRAMMAR_BYTES})`);
  }
  const bytes = await readFile(path);
  return { language, bytes, size: info.size, sha256: sha256Hex(bytes) };
}

async function readRuntimeWasm() {
  let info;
  try { info = await stat(RUNTIME_WASM_PATH); }
  catch { die(`runtime not found: ${RUNTIME_WASM_PATH}\n  Run: npm install web-tree-sitter@^0.20.8`); }
  if (info.size > MAX_GRAMMAR_BYTES) {
    die(`runtime is ${info.size} bytes — exceeds MAX_GRAMMAR_BYTES`);
  }
  const bytes = await readFile(RUNTIME_WASM_PATH);
  return { bytes, size: info.size, sha256: sha256Hex(bytes) };
}

function makeKey(language, sha256) {
  return `audit/grammars/${language}@${sha256.slice(0, 8)}.wasm`;
}

function makeRuntimeKey(sha256) {
  return `audit/grammars/runtime@${sha256.slice(0, 8)}.wasm`;
}

/** Fetch existing manifest from R2; null if absent. */
function fetchManifest() {
  const tmp = mkdtempSync(join(tmpdir(), 'grammars-'));
  const out = join(tmp, 'manifest.json');
  try {
    const r = runWrangler('r2', 'object', 'get', `${BUCKET_BINDING}/${MANIFEST_KEY}`, '--file', out);
    if (r.code !== 0) {
      // 404 is expected on first run — wrangler exits non-zero
      return null;
    }
    const raw = readFileSync(out, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    warn('manifest read failed:', err.message);
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function uploadObject(key, bytes, contentType) {
  const tmp = mkdtempSync(join(tmpdir(), 'grammars-'));
  const file = join(tmp, 'blob');
  try {
    writeFileSync(file, bytes);
    const r = runWrangler(
      'r2', 'object', 'put',
      `${BUCKET_BINDING}/${key}`,
      '--file', file,
      '--content-type', contentType,
    );
    if (r.code !== 0) {
      throw new Error(`wrangler r2 object put failed: ${r.stderr || r.stdout}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const targets = ALL
    ? await listAllAvailableGrammars()
    : MVP_GRAMMARS;
  log(`uploading ${targets.length} grammar(s):`, targets.join(', '));
  if (DRY_RUN) log('DRY RUN — no R2 writes');

  // 1. Fetch existing manifest (idempotency)
  const existingManifest = fetchManifest();
  const existingByLang = new Map(
    (existingManifest?.entries ?? []).map(e => [e.language, e]),
  );

  // 2. Hash + diff
  const grammars = await Promise.all(targets.map(readGrammar));
  const newEntries = [];
  const uploads = [];
  for (const g of grammars) {
    const prev = existingByLang.get(g.language);
    const key = makeKey(g.language, g.sha256);
    const entry = {
      language: g.language,
      key,
      sha256: g.sha256,
      size: g.size,
      source: SOURCE_TAG,
      uploadedAt: prev?.sha256 === g.sha256 ? prev.uploadedAt : new Date().toISOString(),
    };
    newEntries.push(entry);
    if (prev?.sha256 === g.sha256) {
      log(`unchanged: ${g.language} (${g.size} bytes, sha8=${g.sha256.slice(0, 8)})`);
    } else {
      uploads.push({ key, bytes: g.bytes, language: g.language, size: g.size });
      log(`upload:    ${g.language} (${g.size} bytes, sha8=${g.sha256.slice(0, 8)})`);
    }
  }

  // 3. Push grammars (only the changed ones)
  for (const u of uploads) {
    uploadObject(u.key, u.bytes, 'application/wasm');
  }

  // 4. Push the runtime WASM (web-tree-sitter/tree-sitter.wasm). Same
  //    SHA-keyed idempotent pattern. The Worker's Extractor needs this
  //    via Parser.init({wasmBinary}); without it /audit --analyze stays
  //    feature-gated off.
  const runtime = await readRuntimeWasm();
  const runtimeEntry = {
    key: makeRuntimeKey(runtime.sha256),
    sha256: runtime.sha256,
    size: runtime.size,
    source: RUNTIME_SOURCE_TAG,
    uploadedAt: existingManifest?.runtime?.sha256 === runtime.sha256
      ? existingManifest.runtime.uploadedAt
      : new Date().toISOString(),
  };
  if (existingManifest?.runtime?.sha256 === runtime.sha256) {
    log(`unchanged: runtime (${runtime.size} bytes, sha8=${runtime.sha256.slice(0, 8)})`);
  } else {
    uploadObject(runtimeEntry.key, runtime.bytes, 'application/wasm');
    log(`upload:    runtime (${runtime.size} bytes, sha8=${runtime.sha256.slice(0, 8)})`);
  }

  // 5. Write manifest (always — even on no-change runs we update updatedAt
  //    only when there were uploads, to keep idempotency honest).
  const noChange = uploads.length === 0 && existingManifest?.runtime?.sha256 === runtime.sha256;
  const newManifest = {
    version: 1,
    entries: newEntries.sort((a, b) => a.language.localeCompare(b.language)),
    runtime: runtimeEntry,
    updatedAt: noChange && existingManifest?.updatedAt
      ? existingManifest.updatedAt
      : new Date().toISOString(),
  };
  if (noChange && existingManifest && manifestEquals(existingManifest, newManifest)) {
    log('manifest unchanged — skipping write');
  } else {
    uploadObject(MANIFEST_KEY, Buffer.from(JSON.stringify(newManifest, null, 2)), 'application/json');
    log('manifest written');
  }

  log('done.');
}

function manifestEquals(a, b) {
  if (a.version !== b.version) return false;
  if (a.entries.length !== b.entries.length) return false;
  const byLang = new Map(a.entries.map(e => [e.language, e]));
  for (const e of b.entries) {
    const prev = byLang.get(e.language);
    if (!prev) return false;
    if (prev.sha256 !== e.sha256 || prev.size !== e.size || prev.key !== e.key) return false;
  }
  if ((a.runtime?.sha256 ?? null) !== (b.runtime?.sha256 ?? null)) return false;
  if ((a.runtime?.key ?? null) !== (b.runtime?.key ?? null)) return false;
  return true;
}

async function listAllAvailableGrammars() {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(GRAMMAR_DIR);
  return files
    .filter(f => f.startsWith('tree-sitter-') && f.endsWith('.wasm'))
    .map(f => f.replace(/^tree-sitter-/, '').replace(/\.wasm$/, ''));
}

main().catch(err => die(err.stack ?? err.message ?? String(err)));
