/**
 * Audit Skill — OSV.dev cross-reference for the `deps` lens
 *
 * The design doc §2 calls for cross-referencing the dependency tree against
 * the OSV vulnerability database. OSV exposes a public, unauthenticated
 * batch query endpoint suitable for Worker calls:
 *
 *   POST https://api.osv.dev/v1/querybatch
 *   Body: { queries: [{ package: { name, ecosystem }, version }, ...] }
 *
 * We parse direct dependencies out of root + nested package.json (the only
 * ecosystem we ship in the MVP — Python/Go/Rust manifests are wired
 * structurally below but emit empty queries until the lockfile parsers
 * land). The Scout calls this once per audit; results are attached to the
 * profile and surfaced in the Analyst's evidence block under the `deps`
 * lens prompt.
 *
 * Failure mode: never throws. Network / API errors return an empty alert
 * array with `failed: true` so the run body can warn about partial
 * coverage rather than silently rendering "no advisories".
 */

import type { ManifestFile, OsvAlert, Severity } from './types';

const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns';

/** Hard cap on packages queried per audit. Beyond this we sample the first
 *  N — the design tradeoff is "stay under the OSV rate budget" vs "full
 *  coverage". 100 is comfortably under their public guidance. */
const MAX_OSV_QUERIES = 100;

/** Cap on advisories returned per package. A package with 30 historical
 *  CVEs would otherwise dominate the evidence block. */
const MAX_ADVISORIES_PER_PACKAGE = 3;

/** Wall-clock budget for the whole OSV pass. The Worker's analyze path
 *  is already on a tight timeline; if OSV is slow we'd rather degrade
 *  than block the run. */
const OSV_TIMEOUT_MS = 6000;

interface OsvBatchResponse {
  results?: Array<{
    vulns?: Array<{ id: string; modified?: string }>;
  }>;
}

interface OsvVulnDetail {
  id: string;
  summary?: string;
  details?: string;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  references?: Array<{ type?: string; url: string }>;
}

interface QueryItem {
  packageName: string;
  ecosystem: OsvAlert['ecosystem'];
  version: string;
  manifestPath: string;
}

export interface OsvLookupResult {
  alerts: OsvAlert[];
  /** True when any HTTP / parse error happened mid-query — caller surfaces
   *  this so users know advisory absence may be incomplete. */
  failed: boolean;
}

/**
 * Cross-reference manifests against OSV. Returns a flat alert list plus a
 * failure flag. Never throws.
 */
export async function lookupOsvAdvisories(
  manifests: ReadonlyArray<ManifestFile>,
  fetchImpl: typeof fetch = fetch,
): Promise<OsvLookupResult> {
  const queries = collectQueries(manifests);
  if (queries.length === 0) return { alerts: [], failed: false };

  const sliced = queries.slice(0, MAX_OSV_QUERIES);
  const truncated = queries.length > MAX_OSV_QUERIES;

  let batch: OsvBatchResponse;
  try {
    const resp = await withTimeout(
      fetchImpl(OSV_BATCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queries: sliced.map((q) => ({
            package: { name: q.packageName, ecosystem: q.ecosystem },
            version: q.version,
          })),
        }),
      }),
      OSV_TIMEOUT_MS,
    );
    if (!resp.ok) {
      console.warn(`[OSV] batch query failed: HTTP ${resp.status}`);
      return { alerts: [], failed: true };
    }
    batch = (await resp.json()) as OsvBatchResponse;
  } catch (err) {
    console.warn('[OSV] batch query threw:', err instanceof Error ? err.message : err);
    return { alerts: [], failed: true };
  }

  const results = batch.results ?? [];
  // Collect vuln ids to enrich (severity + summary). querybatch returns
  // ids only; details require a per-id fetch. Bound the fan-out the same
  // way we cap queries so a single repo can't hammer OSV.
  const idToContext = new Map<string, QueryItem>();
  for (let i = 0; i < results.length; i++) {
    const ctx = sliced[i];
    if (!ctx) continue;
    const vulns = results[i]?.vulns ?? [];
    for (const v of vulns.slice(0, MAX_ADVISORIES_PER_PACKAGE)) {
      if (!idToContext.has(v.id)) idToContext.set(v.id, ctx);
    }
  }
  if (idToContext.size === 0) return { alerts: [], failed: truncated };

  const enriched = await Promise.all(
    [...idToContext.entries()].map(async ([id, ctx]): Promise<OsvAlert | null> => {
      try {
        const resp = await withTimeout(fetchImpl(`${OSV_VULN_URL}/${encodeURIComponent(id)}`), OSV_TIMEOUT_MS);
        if (!resp.ok) return fallbackAlert(id, ctx);
        const detail = (await resp.json()) as OsvVulnDetail;
        return {
          id,
          severity: pickSeverity(detail),
          summary: (detail.summary ?? detail.details ?? id).slice(0, 240),
          packageName: ctx.packageName,
          ecosystem: ctx.ecosystem,
          affectedVersion: ctx.version,
          manifestPath: ctx.manifestPath,
          url: detail.references?.find((r) => r.url)?.url ?? `https://osv.dev/vulnerability/${id}`,
        };
      } catch {
        return fallbackAlert(id, ctx);
      }
    }),
  );

  const alerts = enriched.filter((a): a is OsvAlert => a !== null);
  // Stable sort: severity (critical first), then id, so renderer + tests
  // see a deterministic order.
  alerts.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id));
  return { alerts, failed: truncated };
}

function fallbackAlert(id: string, ctx: QueryItem): OsvAlert {
  return {
    id,
    severity: 'medium',
    summary: id,
    packageName: ctx.packageName,
    ecosystem: ctx.ecosystem,
    affectedVersion: ctx.version,
    manifestPath: ctx.manifestPath,
    url: `https://osv.dev/vulnerability/${id}`,
  };
}

function pickSeverity(detail: OsvVulnDetail): Severity {
  const ds = detail.database_specific?.severity?.toLowerCase();
  if (ds === 'critical' || ds === 'high' || ds === 'medium' || ds === 'low') return ds;
  // OSV CVSS scores look like "CVSS:3.1/AV:N/.../I:H/A:H" with no embedded
  // numeric score in the type=CVSS_V3 entries. Use the first numeric
  // base-score we can recover from the vector; fall through to medium.
  for (const s of detail.severity ?? []) {
    if (s.type !== 'CVSS_V3' && s.type !== 'CVSS_V4') continue;
    const base = parseCvssBase(s.score);
    if (base == null) continue;
    if (base >= 9.0) return 'critical';
    if (base >= 7.0) return 'high';
    if (base >= 4.0) return 'medium';
    return 'low';
  }
  return 'medium';
}

function parseCvssBase(vector: string): number | null {
  // OSV sometimes ships the numeric base prefixed (e.g. "9.8" or
  // "CVSS:3.1/..." for vectors only). Take the leading number when it's
  // a bare score; otherwise return null and let the caller fall back.
  const m = /^(\d+(?:\.\d+)?)/.exec(vector);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null;
}

function severityRank(s: Severity): number {
  return s === 'critical' ? 4 : s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Manifest → query item extraction
// ---------------------------------------------------------------------------

/**
 * Convert manifest contents into OSV-batch query items. Today this covers
 * package.json's `dependencies` + `devDependencies` (npm ecosystem). Future
 * lockfile parsers slot in here without changing the public API.
 *
 * Direct deps only — transitive resolution lives in the lockfile. We're
 * deliberately not parsing pnpm-lock.yaml / package-lock.json yet because
 * (a) they're large and tree-walking them in a Worker is its own slice,
 * and (b) GitHub Dependabot already scans transitives; OSV here is for
 * the "what does this repo declare it depends on?" surface that the
 * design doc explicitly calls out.
 */
export function collectQueries(manifests: ReadonlyArray<ManifestFile>): QueryItem[] {
  const out: QueryItem[] = [];
  for (const m of manifests) {
    if (!m.content) continue;
    if (!isPackageJsonPath(m.path)) continue;
    pushNpmDeps(m, out);
  }
  return out;
}

function isPackageJsonPath(path: string): boolean {
  return path === 'package.json' || path.endsWith('/package.json');
}

function pushNpmDeps(m: ManifestFile, out: QueryItem[]): void {
  if (m.content == null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m.content);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const root = parsed as Record<string, unknown>;
  const sections = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
  const seen = new Set<string>(); // de-dup across sections
  for (const section of sections) {
    const block = root[section];
    if (typeof block !== 'object' || block === null) continue;
    for (const [name, raw] of Object.entries(block as Record<string, unknown>)) {
      if (typeof raw !== 'string') continue;
      const version = normalizeNpmVersion(raw);
      if (!version) continue;
      const key = `${name}@${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        packageName: name,
        ecosystem: 'npm',
        version,
        manifestPath: m.path,
      });
    }
  }
}

/**
 * Normalize a package.json version spec to something OSV can match.
 *
 * OSV's batch endpoint expects an exact version string. Most package.json
 * declarations are ranges (^1.2.3, ~1.2.3, >=1.2.3 <2). For OSV's purposes
 * the lowest concrete version in the range is the conservative answer:
 *   - "^1.2.3" → "1.2.3"  (queries the floor; advisories on 1.2.3 surface)
 *   - "1.2.3"  → "1.2.3"
 *   - "*", "latest", "workspace:*", file:/git: specs → null (skipped)
 *
 * This intentionally under-reports rather than over-reports — we'd rather
 * miss an advisory than incorrectly flag a fixed version. Operators with
 * lockfiles get fuller coverage from Dependabot anyway.
 */
export function normalizeNpmVersion(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Skip non-version specifiers — OSV can't match these.
  if (
    trimmed === '*' ||
    trimmed === 'latest' ||
    trimmed.startsWith('workspace:') ||
    trimmed.startsWith('file:') ||
    trimmed.startsWith('link:') ||
    trimmed.startsWith('git+') ||
    trimmed.startsWith('git:') ||
    trimmed.startsWith('http:') ||
    trimmed.startsWith('https:') ||
    trimmed.startsWith('npm:') // npm: aliases — would need resolving first
  ) {
    return null;
  }
  // Strip range operators; pull the first semver-shaped triple we can find.
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(trimmed);
  return m ? m[1] : null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`OSV timeout after ${ms}ms`)), ms),
    ),
  ]);
}
