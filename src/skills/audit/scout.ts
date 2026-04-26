/**
 * Audit Skill — Scout (cheap pre-pass, no LLM)
 *
 * Builds a `RepoProfile` from GitHub API data only:
 *   1. GET /repos/{owner}/{repo}                 — meta + default branch
 *   2. GET /repos/{owner}/{repo}/languages       — language mix
 *   3. GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
 *   4. Always-fetch manifests via /contents/{path}
 *   5. GET /repos/{owner}/{repo}/code-scanning/alerts (optional, may 404)
 *
 * Rate-limit awareness: total calls are bounded (≤ 5 + |manifests fetched|)
 * which is well within the 5000/hr authenticated primary budget. Caching is
 * the caller's responsibility (see ./cache.ts).
 */

import { ALWAYS_FETCH_MANIFESTS, VENDORED_PATTERNS } from './lenses';
import type { RepoProfile, TreeEntry, ManifestFile, CodeScanningAlert, Severity } from './types';

const GITHUB_API = 'https://api.github.com';

/** First-page cap for Code Scanning Alerts. We don't paginate in v0; if the
 *  response equals this we record a `codeScanningAlertsTruncated` flag. */
const ALERTS_PER_PAGE = 50;

/** Manifest basenames worth discovering at any depth (monorepos). */
const NESTED_MANIFEST_BASENAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'pyproject.toml',
  'requirements.txt',
  'poetry.lock',
  'wrangler.toml',
  'wrangler.jsonc',
  'Dockerfile',
]);

/** Cap on nested-manifest discovery to keep the API fan-out bounded. */
const MAX_NESTED_MANIFESTS = 32;

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export interface ScoutOptions {
  owner: string;
  repo: string;
  /** Optional branch override; defaults to repo's default branch. */
  branch?: string;
  /** GitHub PAT or OAuth token. */
  token: string | undefined;
}

export interface ScoutResult {
  profile: RepoProfile;
  /** GitHub API call count — for telemetry. */
  apiCalls: number;
}

/**
 * Run the Scout pass. Throws on hard failures (404 repo, auth, network).
 * Soft failures (Code Scanning disabled, manifests missing) degrade gracefully.
 */
export async function scout(opts: ScoutOptions): Promise<ScoutResult> {
  const headers = ghHeaders(opts.token);
  let apiCalls = 0;

  // 1. Repo meta — fail-fast on 404 / 403
  const metaResp = await ghFetch(`${GITHUB_API}/repos/${opts.owner}/${opts.repo}`, headers);
  apiCalls++;
  if (!metaResp.ok) {
    throw new Error(`Scout: repo not accessible (${metaResp.status} ${metaResp.statusText})`);
  }
  const meta = await metaResp.json() as GhRepoMeta;
  const branch = opts.branch ?? meta.default_branch;

  // 2. Languages (parallel with branch ref)
  // NOTE: branch names may contain '/' (e.g. "feature/audit-v1"). The slashes
  // are path separators inside the ref, not part of segment names — encode
  // each segment individually so we don't double-encode the separators.
  const branchPath = branch.split('/').map(encodeURIComponent).join('/');
  const [langResp, refResp] = await Promise.all([
    ghFetch(`${GITHUB_API}/repos/${opts.owner}/${opts.repo}/languages`, headers),
    ghFetch(`${GITHUB_API}/repos/${opts.owner}/${opts.repo}/git/refs/heads/${branchPath}`, headers),
  ]);
  apiCalls += 2;
  if (!refResp.ok) {
    throw new Error(`Scout: branch "${branch}" not found (${refResp.status})`);
  }
  // refs/heads with slashes can return either a single ref object or an array
  // (when GitHub treats the partial path as a prefix match). Handle both.
  const languages = langResp.ok ? await langResp.json() as Record<string, number> : {};
  const refDataRaw = await refResp.json() as
    | { ref: string; object: { sha: string } }
    | Array<{ ref: string; object: { sha: string } }>;
  const exactRefName = `refs/heads/${branch}`;
  const matchedRef = Array.isArray(refDataRaw)
    ? (refDataRaw.find(r => r.ref === exactRefName) ?? refDataRaw[0])
    : refDataRaw;
  if (!matchedRef || !matchedRef.object?.sha) {
    throw new Error(`Scout: branch "${branch}" did not resolve to a commit SHA`);
  }
  const sha = matchedRef.object.sha;

  // 3. Recursive tree (single call thanks to ?recursive=1)
  const treeResp = await ghFetch(`${GITHUB_API}/repos/${opts.owner}/${opts.repo}/git/trees/${sha}?recursive=1`, headers);
  apiCalls++;
  if (!treeResp.ok) {
    throw new Error(`Scout: tree fetch failed (${treeResp.status})`);
  }
  const treeData = await treeResp.json() as GhTreeResponse;
  const treeTruncated = treeData.truncated === true;
  if (treeTruncated) {
    // GitHub caps recursive tree listings at ~100k entries / 7 MB. Surfaced
    // through `RepoProfile.treeTruncated` so the user is told the audit
    // coverage is partial.
    console.warn(`[Scout] tree truncated for ${opts.owner}/${opts.repo}@${sha}`);
  }
  const tree: TreeEntry[] = treeData.tree.map(t => ({
    path: t.path,
    type: t.type,
    sha: t.sha,
    size: t.size,
  }));

  // 4. Manifests — root-pinned set + nested discovery (monorepo support).
  const treePathSet = new Set(tree.map(t => t.path));
  const rootManifestPaths = ALWAYS_FETCH_MANIFESTS.filter(p => treePathSet.has(p));
  const nestedManifestPaths = discoverNestedManifests(tree, new Set(rootManifestPaths));
  const manifestPaths = [...rootManifestPaths, ...nestedManifestPaths];
  const manifests = await Promise.all(
    manifestPaths.map(path => fetchManifest(opts.owner, opts.repo, path, sha, headers)),
  );
  apiCalls += manifestPaths.length;

  // 5. Code Scanning Alerts — optional, often 404 (disabled or no-access).
  // First page only; v0 documents the cap rather than paginating.
  const alertsResp = await ghFetch(
    `${GITHUB_API}/repos/${opts.owner}/${opts.repo}/code-scanning/alerts?state=open&per_page=${ALERTS_PER_PAGE}`,
    headers,
  );
  apiCalls++;
  let codeScanningAlerts: CodeScanningAlert[] = [];
  let codeScanningAlertsTruncated = false;
  if (alertsResp.ok) {
    const alerts = await alertsResp.json() as GhCodeScanningAlert[];
    codeScanningAlerts = alerts.map(toCodeScanningAlert);
    // Best-effort signal: if we got a full page back, more probably exist.
    codeScanningAlertsTruncated = alerts.length >= ALERTS_PER_PAGE;
  }
  // 404 / 403 / 410 are all "code scanning not available here" — silent.

  const profile: RepoProfile = {
    owner: opts.owner,
    repo: opts.repo,
    defaultBranch: meta.default_branch,
    sha,
    meta: {
      private: meta.private,
      archived: meta.archived,
      sizeKb: meta.size,
      primaryLanguage: meta.language,
      languages,
      description: meta.description,
    },
    tree,
    manifests: manifests.filter((m): m is ManifestFile => m !== null),
    codeScanningAlerts,
    codeScanningAlertsTruncated,
    treeTruncated,
    profileHash: hashProfile(sha, tree),
    collectedAt: new Date().toISOString(),
  };

  return { profile, apiCalls };
}

/**
 * Discover monorepo manifests beyond the root set. Walks the tree once,
 * keeping blob entries whose basename is a known manifest, excluding
 * vendored paths and anything already in the root set, capped to
 * MAX_NESTED_MANIFESTS to bound the API fan-out.
 */
function discoverNestedManifests(tree: TreeEntry[], alreadyFetched: Set<string>): string[] {
  const results: string[] = [];
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    if (alreadyFetched.has(entry.path)) continue;
    if (VENDORED_PATTERNS.some(re => re.test(entry.path))) continue;
    const slash = entry.path.lastIndexOf('/');
    if (slash === -1) continue; // root-level handled by ALWAYS_FETCH_MANIFESTS
    const basename = entry.path.slice(slash + 1);
    if (!NESTED_MANIFEST_BASENAMES.has(basename)) continue;
    results.push(entry.path);
    if (results.length >= MAX_NESTED_MANIFESTS) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ghHeaders(token: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'moltworker-audit-scout',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Wrapper that ensures we never crash the Worker on a network error. */
async function ghFetch(url: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetch(url, { headers });
  } catch (err) {
    return new Response(null, { status: 599, statusText: err instanceof Error ? err.message : 'network' });
  }
}

async function fetchManifest(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  headers: Record<string, string>,
): Promise<ManifestFile | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const resp = await ghFetch(url, headers);
  if (!resp.ok) return null;

  const data = await resp.json() as { content?: string; encoding?: string; sha?: string; size?: number };
  if (data.encoding !== 'base64' || typeof data.content !== 'string' || typeof data.sha !== 'string') {
    return null;
  }
  // Files >1 MB are returned as a download URL by the API instead of inline base64.
  // We skip them here — manifests should never be that large; if one is, it's noise.
  const MAX_MANIFEST_BYTES = 256 * 1024;
  if ((data.size ?? 0) > MAX_MANIFEST_BYTES) {
    return { path, content: null, sha: data.sha };
  }
  try {
    const decoded = atob(data.content.replace(/\n/g, ''));
    return { path, content: decoded, sha: data.sha };
  } catch {
    return { path, content: null, sha: data.sha };
  }
}

function toCodeScanningAlert(a: GhCodeScanningAlert): CodeScanningAlert {
  return {
    number: a.number,
    state: a.state,
    severity: mapSeverity(a.rule?.security_severity_level ?? a.rule?.severity ?? 'medium'),
    rule: a.rule?.id ?? a.rule?.name ?? 'unknown',
    description: a.rule?.description ?? a.most_recent_instance?.message?.text ?? '',
    path: a.most_recent_instance?.location?.path ?? '',
    lineStart: a.most_recent_instance?.location?.start_line,
    lineEnd: a.most_recent_instance?.location?.end_line,
  };
}

function mapSeverity(raw: string): Severity {
  switch (raw.toLowerCase()) {
    case 'critical': return 'critical';
    case 'high':
    case 'error':
      return 'high';
    case 'low':
    case 'note':
      return 'low';
    default:
      return 'medium';
  }
}

/** Stable hash of (sha + tree shape) — used as cache key salt. */
function hashProfile(sha: string, tree: TreeEntry[]): string {
  // Cheap rolling hash; collisions are tolerable since (owner, repo, sha) is
  // already part of the cache key. This guards against re-using a cached
  // profile if the tree truncation changed (e.g. permissions shifted).
  let h = 5381 >>> 0;
  h = ((h * 33) ^ sha.charCodeAt(0)) >>> 0;
  h = ((h * 33) ^ tree.length) >>> 0;
  for (let i = 0; i < tree.length; i += Math.max(1, Math.floor(tree.length / 32))) {
    const t = tree[i];
    h = ((h * 33) ^ (t.size ?? 0)) >>> 0;
    for (let j = 0; j < t.path.length; j += 8) {
      h = ((h * 33) ^ t.path.charCodeAt(j)) >>> 0;
    }
  }
  return h.toString(36);
}

// ---------------------------------------------------------------------------
// GitHub API response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface GhRepoMeta {
  default_branch: string;
  private: boolean;
  archived: boolean;
  size: number;
  language: string | null;
  description: string | null;
}

interface GhTreeResponse {
  truncated: boolean;
  tree: Array<{
    path: string;
    type: 'blob' | 'tree';
    sha: string;
    size?: number;
  }>;
}

interface GhCodeScanningAlert {
  number: number;
  state: 'open' | 'closed' | 'dismissed' | 'fixed';
  rule?: {
    id?: string;
    name?: string;
    description?: string;
    severity?: string;
    security_severity_level?: string;
  };
  most_recent_instance?: {
    message?: { text?: string };
    location?: {
      path?: string;
      start_line?: number;
      end_line?: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Repo URL parsing (helper used by the handler)
// ---------------------------------------------------------------------------

/** Parse "owner/repo" or any GitHub URL form into (owner, repo). */
export function parseRepoCoords(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();
  // 1) owner/repo shorthand
  const short = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(trimmed);
  if (short) return { owner: short[1], repo: short[2] };
  // 2) URL forms
  try {
    const url = new URL(trimmed);
    if (!/github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
  } catch {
    return null;
  }
}
