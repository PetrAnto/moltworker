/**
 * Audit Skill — In-Worker Grammar Bootstrap
 *
 * Mirrors what `scripts/upload-audit-grammars.mjs` does, but from inside the
 * Worker: fetches the tree-sitter WASM grammars + the web-tree-sitter
 * runtime from a public npm CDN (jsdelivr, with unpkg as fallback) and
 * writes them to MOLTBOT_BUCKET in the exact manifest layout the loader
 * expects.
 *
 * Why this exists: the local script is a great operator path, but it
 * requires a host with `node_modules` and a logged-in `wrangler`. For an
 * "audit + improve repos independently" bot, the operator needs to be able
 * to bootstrap the audit pipeline from chat, not only from a laptop.
 *
 * Trust model:
 *   - Source: pinned by version (tree-sitter-wasms@0.1.13,
 *     web-tree-sitter@0.20.8) — the same versions the script consumes
 *     from package.json devDeps.
 *   - Integrity: WASM magic bytes are checked, hard size caps mirror the
 *     loader's, and we hash whatever we fetched and pin that hash in the
 *     manifest. The loader then re-verifies bytes-vs-manifest on every
 *     load. So a CDN swap won't poison a future load — the manifest we
 *     write IS the integrity contract.
 *   - Idempotent: re-running with no upstream change does no R2 writes
 *     beyond the manifest's updatedAt (and even that we skip when the
 *     entries are identical to what's already there).
 *
 * What we DON'T do here:
 *   - We don't support the `--all` (every grammar tree-sitter-wasms ships)
 *     mode — the npm package contents aren't enumerable via fetch and the
 *     MVP set is what /audit actually uses. Operators who want more can
 *     run the local script.
 */

import {
  type GrammarLanguage,
  type GrammarManifest,
  type GrammarManifestEntry,
  type RuntimeManifestEntry,
  MAX_GRAMMAR_BYTES,
  MAX_TREE_SITTER_RUNTIME_BYTES,
  MVP_GRAMMARS,
} from '../types';
import { _resetGrammarCachesForTesting } from './loader';

const MANIFEST_KEY = 'audit/grammars/manifest.json';

// Pinned upstream versions. Mirror package.json devDeps. Bumping these is a
// deliberate change — both this constant and the script's SOURCE_TAG get
// updated together. See scripts/upload-audit-grammars.mjs.
export const TREE_SITTER_WASMS_VERSION = '0.1.13';
export const WEB_TREE_SITTER_VERSION = '0.20.8';

const TREE_SITTER_WASMS_SOURCE = `tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}`;
const WEB_TREE_SITTER_SOURCE = `web-tree-sitter@${WEB_TREE_SITTER_VERSION}`;

// CDN list — tried in order. Both pin by exact version; both serve
// `application/wasm` for .wasm. unpkg is the historical fallback if
// jsdelivr is unreachable.
const CDN_BASES: ReadonlyArray<{ name: string; base: string }> = [
  { name: 'jsdelivr', base: 'https://cdn.jsdelivr.net/npm' },
  { name: 'unpkg',    base: 'https://unpkg.com' },
];

// WASM magic header: `\0asm` + version 0x01000000. Reject anything else
// before we hash + write — it's the cheapest sanity check against a CDN
// returning an HTML error page or a tarball.
const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

export interface BootstrapEnv {
  MOLTBOT_BUCKET?: R2Bucket;
}

export interface BootstrapOptions {
  /** When true, hash + diff but don't write to R2. */
  dryRun?: boolean;
  /** Override fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export type BootstrapItemStatus = 'uploaded' | 'unchanged' | 'skipped' | 'error';

export interface BootstrapItem {
  kind: 'grammar' | 'runtime';
  /** For grammars; absent on runtime. */
  language?: GrammarLanguage;
  status: BootstrapItemStatus;
  /** Bytes of the fetched WASM (when fetched). */
  size?: number;
  /** First 8 chars of sha256 — handy for telemetry. */
  sha8?: string;
  /** Which CDN served the bytes. */
  source?: string;
  /** Failure reason when status === 'error'. */
  error?: string;
}

export interface BootstrapResult {
  /** True iff the manifest in R2 now reflects MVP grammars + runtime. */
  ok: boolean;
  dryRun: boolean;
  items: BootstrapItem[];
  /** Whether the manifest was rewritten this run. */
  manifestWritten: boolean;
  /** Total bytes downloaded from CDNs (audit cost). */
  bytesFetched: number;
  durationMs: number;
}

/**
 * Bootstrap the MVP grammar set + tree-sitter runtime into R2.
 *
 * Returns a structured report so the caller (Telegram handler, admin
 * route, future scheduled job) can render whatever surface they want.
 */
export async function bootstrapGrammars(
  env: BootstrapEnv,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const start = Date.now();
  const dryRun = opts.dryRun === true;
  const fetchImpl = opts.fetchImpl ?? fetch;

  if (!env.MOLTBOT_BUCKET) {
    return {
      ok: false,
      dryRun,
      items: [{ kind: 'grammar', status: 'error', error: 'MOLTBOT_BUCKET not configured' }],
      manifestWritten: false,
      bytesFetched: 0,
      durationMs: Date.now() - start,
    };
  }
  const bucket = env.MOLTBOT_BUCKET;

  const items: BootstrapItem[] = [];
  let bytesFetched = 0;

  // 1. Read the existing manifest (if any) — drives idempotency.
  const existing = await readExistingManifest(bucket);
  const existingByLang = new Map<GrammarLanguage, GrammarManifestEntry>(
    (existing?.entries ?? []).map((e) => [e.language, e] as const),
  );

  // 2. Walk each MVP grammar.
  const newEntries: GrammarManifestEntry[] = [];
  for (const lang of MVP_GRAMMARS) {
    const url = `tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}/out/tree-sitter-${lang}.wasm`;
    const fetched = await fetchWasm(fetchImpl, url, MAX_GRAMMAR_BYTES);
    if (!fetched.ok) {
      items.push({ kind: 'grammar', language: lang, status: 'error', error: fetched.error });
      continue;
    }
    bytesFetched += fetched.bytes.byteLength;
    const sha = await sha256Hex(fetched.bytes);
    const sha8 = sha.slice(0, 8);
    const key = `audit/grammars/${lang}@${sha8}.wasm`;
    const prev = existingByLang.get(lang);
    const shaMatches = prev?.sha256 === sha;
    // SHA-only equality is not enough to declare a no-op: the manifest can
    // outlive the byte object (partial prior upload, manual prune, R2
    // binding swap), and in that state the loader returns null and audits
    // silently lose coverage. Verify the bytes are actually in R2 before
    // skipping the put — if missing, fall through to upload and self-heal.
    const bytesPresent = shaMatches && prev
      ? await objectExists(bucket, prev.key)
      : false;
    const unchanged = shaMatches && bytesPresent;

    if (!unchanged && !dryRun) {
      try {
        await bucket.put(key, fetched.bytes, {
          httpMetadata: { contentType: 'application/wasm' },
        });
      } catch (err) {
        items.push({
          kind: 'grammar', language: lang, status: 'error',
          error: `R2 put failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    }

    newEntries.push({
      language: lang,
      key,
      sha256: sha,
      size: fetched.bytes.byteLength,
      source: TREE_SITTER_WASMS_SOURCE,
      uploadedAt: unchanged && prev ? prev.uploadedAt : new Date().toISOString(),
    });
    items.push({
      kind: 'grammar', language: lang,
      status: unchanged ? 'unchanged' : 'uploaded',
      size: fetched.bytes.byteLength, sha8, source: fetched.source,
    });
  }

  // 3. Runtime WASM.
  const runtimeUrl = `web-tree-sitter@${WEB_TREE_SITTER_VERSION}/tree-sitter.wasm`;
  const runtimeFetched = await fetchWasm(fetchImpl, runtimeUrl, MAX_TREE_SITTER_RUNTIME_BYTES);
  let runtimeEntry: RuntimeManifestEntry | undefined = existing?.runtime;
  if (!runtimeFetched.ok) {
    items.push({ kind: 'runtime', status: 'error', error: runtimeFetched.error });
  } else {
    bytesFetched += runtimeFetched.bytes.byteLength;
    const sha = await sha256Hex(runtimeFetched.bytes);
    const sha8 = sha.slice(0, 8);
    const key = `audit/grammars/runtime@${sha8}.wasm`;
    const runtimeShaMatches = existing?.runtime?.sha256 === sha;
    // Same self-heal rule as grammars above: don't trust a SHA-equal
    // manifest entry whose R2 object has gone missing.
    const runtimeBytesPresent = runtimeShaMatches && existing?.runtime
      ? await objectExists(bucket, existing.runtime.key)
      : false;
    const unchanged = runtimeShaMatches && runtimeBytesPresent;

    if (!unchanged && !dryRun) {
      try {
        await bucket.put(key, runtimeFetched.bytes, {
          httpMetadata: { contentType: 'application/wasm' },
        });
      } catch (err) {
        items.push({
          kind: 'runtime', status: 'error',
          error: `R2 put failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        runtimeEntry = existing?.runtime; // keep prior entry if write failed
      }
    }

    if (!items.some((i) => i.kind === 'runtime' && i.status === 'error')) {
      runtimeEntry = {
        key,
        sha256: sha,
        size: runtimeFetched.bytes.byteLength,
        source: WEB_TREE_SITTER_SOURCE,
        uploadedAt: unchanged && existing?.runtime
          ? existing.runtime.uploadedAt
          : new Date().toISOString(),
      };
      items.push({
        kind: 'runtime',
        status: unchanged ? 'unchanged' : 'uploaded',
        size: runtimeFetched.bytes.byteLength, sha8, source: runtimeFetched.source,
      });
    }
  }

  // 4. Determine if any meaningful change happened.
  const allGrammarsOk = newEntries.length === MVP_GRAMMARS.length;
  const anyUploaded = items.some((i) => i.status === 'uploaded');
  const anyError = items.some((i) => i.status === 'error');

  // 5. Write the manifest if needed. We only skip the write when the entries
  //    are identical to what's already in R2 — same content, same shape.
  let manifestWritten = false;
  if (allGrammarsOk && runtimeEntry) {
    const sortedEntries = [...newEntries].sort((a, b) =>
      a.language.localeCompare(b.language),
    );
    const newManifest: GrammarManifest = {
      version: 1,
      entries: sortedEntries,
      runtime: runtimeEntry,
      updatedAt: anyUploaded || !existing
        ? new Date().toISOString()
        : existing.updatedAt,
    };
    const sameAsExisting =
      !!existing && manifestEquals(existing, newManifest);

    if (!sameAsExisting && !dryRun) {
      try {
        await bucket.put(MANIFEST_KEY, JSON.stringify(newManifest, null, 2), {
          httpMetadata: { contentType: 'application/json' },
        });
        manifestWritten = true;
      } catch (err) {
        items.push({
          kind: 'grammar', status: 'error',
          error: `Manifest put failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // 6. Reset isolate caches so subsequent /audit calls in this isolate pick
  //    up the new manifest immediately, not after MANIFEST_CACHE_TTL_MS.
  if (manifestWritten) {
    _resetGrammarCachesForTesting();
  }

  return {
    ok: allGrammarsOk && !!runtimeEntry && !anyError,
    dryRun,
    items,
    manifestWritten,
    bytesFetched,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchOk {
  ok: true;
  bytes: Uint8Array;
  /** Which CDN served the bytes — for telemetry. */
  source: string;
}
interface FetchErr {
  ok: false;
  error: string;
}

/** Try each CDN in order until one returns valid WASM bytes. */
async function fetchWasm(
  fetchImpl: typeof fetch,
  pathUnderNpm: string,
  maxBytes: number,
): Promise<FetchOk | FetchErr> {
  let lastError = 'no CDN configured';
  for (const cdn of CDN_BASES) {
    const url = `${cdn.base}/${pathUnderNpm}`;
    let resp: Response;
    try {
      resp = await fetchImpl(url, { method: 'GET' });
    } catch (err) {
      lastError = `${cdn.name} fetch threw: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (!resp.ok) {
      lastError = `${cdn.name} HTTP ${resp.status}`;
      continue;
    }
    let buffer: ArrayBuffer;
    try {
      buffer = await resp.arrayBuffer();
    } catch (err) {
      lastError = `${cdn.name} body read failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (buffer.byteLength === 0) {
      lastError = `${cdn.name} returned empty body`;
      continue;
    }
    if (buffer.byteLength > maxBytes) {
      // A too-large blob from one CDN won't get smaller from another, but
      // we still try the next in case the first served the wrong file.
      lastError = `${cdn.name} returned ${buffer.byteLength} bytes — exceeds cap ${maxBytes}`;
      continue;
    }
    const bytes = new Uint8Array(buffer);
    if (!hasWasmMagic(bytes)) {
      lastError = `${cdn.name} returned non-WASM bytes (magic header mismatch)`;
      continue;
    }
    return { ok: true, bytes, source: cdn.name };
  }
  return { ok: false, error: lastError };
}

function hasWasmMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < WASM_MAGIC.byteLength) return false;
  for (let i = 0; i < WASM_MAGIC.byteLength; i++) {
    if (bytes[i] !== WASM_MAGIC[i]) return false;
  }
  return true;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Slice into a fresh ArrayBuffer to satisfy lib.dom's BufferSource overload
  // — Uint8Array is fine at runtime but TS narrows .digest's input.
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', ab);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Cheap existence probe — `head` returns metadata without the body, so this
 * is O(1) regardless of object size. Some R2 mocks (and a hypothetical older
 * binding) may not implement `head`; fall back to `get` and discard the
 * stream. Errors are treated as "not present" so a transient R2 hiccup
 * triggers a re-upload rather than a silent skip.
 */
async function objectExists(bucket: R2Bucket, key: string): Promise<boolean> {
  try {
    if (typeof bucket.head === 'function') {
      const meta = await bucket.head(key);
      return meta != null;
    }
    const obj = await bucket.get(key);
    return obj != null;
  } catch {
    return false;
  }
}

async function readExistingManifest(bucket: R2Bucket): Promise<GrammarManifest | null> {
  let obj: R2ObjectBody | null;
  try {
    obj = await bucket.get(MANIFEST_KEY);
  } catch {
    return null;
  }
  if (!obj) return null;
  try {
    const parsed = (await obj.json()) as GrammarManifest;
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Structural equality on the manifest contents we care about. updatedAt
 *  is intentionally ignored — we only need to know whether the bytes-on-R2
 *  contract changed, not whether the timestamp drifted. */
function manifestEquals(a: GrammarManifest, b: GrammarManifest): boolean {
  if (a.version !== b.version) return false;
  if (a.entries.length !== b.entries.length) return false;
  const sortByLang = (xs: GrammarManifestEntry[]) =>
    [...xs].sort((x, y) => x.language.localeCompare(y.language));
  const ax = sortByLang(a.entries);
  const bx = sortByLang(b.entries);
  for (let i = 0; i < ax.length; i++) {
    const e1 = ax[i], e2 = bx[i];
    if (
      e1.language !== e2.language ||
      e1.key !== e2.key ||
      e1.sha256 !== e2.sha256 ||
      e1.size !== e2.size ||
      e1.source !== e2.source
    ) return false;
  }
  if (!a.runtime !== !b.runtime) return false;
  if (a.runtime && b.runtime) {
    if (
      a.runtime.key !== b.runtime.key ||
      a.runtime.sha256 !== b.runtime.sha256 ||
      a.runtime.size !== b.runtime.size ||
      a.runtime.source !== b.runtime.source
    ) return false;
  }
  return true;
}

/**
 * Render a BootstrapResult as a Telegram-friendly text body. Kept here so
 * the same renderer is reused by the slash-command handler and any future
 * surface (admin route, scheduled job log).
 */
export function renderBootstrapReport(r: BootstrapResult): string {
  const lines: string[] = [];
  const header = r.dryRun
    ? '🧪 Audit grammars — dry run'
    : r.ok
      ? '✅ Audit grammars bootstrap complete'
      : '⚠️ Audit grammars bootstrap finished with errors';
  lines.push(header);
  lines.push('');

  for (const item of r.items) {
    const label = item.kind === 'runtime'
      ? 'runtime'
      : item.language ?? 'grammar';
    const sizeStr = item.size != null ? ` ${formatBytes(item.size)}` : '';
    const shaStr = item.sha8 ? ` sha8=${item.sha8}` : '';
    const srcStr = item.source ? ` via ${item.source}` : '';
    switch (item.status) {
      case 'uploaded':
        lines.push(`  ⬆️  ${label}${sizeStr}${shaStr}${srcStr}`);
        break;
      case 'unchanged':
        lines.push(`  ✓  ${label}${sizeStr}${shaStr} (unchanged)`);
        break;
      case 'skipped':
        lines.push(`  ·  ${label} skipped`);
        break;
      case 'error':
        lines.push(`  ✗  ${label}: ${item.error ?? 'unknown error'}`);
        break;
    }
  }

  lines.push('');
  lines.push(
    `Manifest: ${r.manifestWritten ? 'rewritten' : 'unchanged'} • Downloaded ${formatBytes(r.bytesFetched)} • ${r.durationMs}ms`,
  );
  if (!r.dryRun && r.ok) {
    lines.push('Next /audit on this Worker will use the R2 grammars.');
  }
  return lines.join('\n');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MiB`;
}
