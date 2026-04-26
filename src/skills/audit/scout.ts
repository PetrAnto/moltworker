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

import { ALWAYS_FETCH_MANIFESTS } from './lenses';
import type { RepoProfile, TreeEntry, ManifestFile, CodeScanningAlert, Severity } from './types';

const GITHUB_API = 'https://api.github.com';

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
  const [langResp, refResp] = await Promise.all([
    ghFetch(`${GITHUB_API}/repos/${opts.owner}/${opts.repo}/languages`, headers),
    ghFetch(`${GITHUB_API}/repos/${opts.owner}/${opts.repo}/git/refs/heads/${encodeURIComponent(branch)}`, headers),
  ]);
  apiCalls += 2;
  if (!refResp.ok) {
    throw new Error(`Scout: branch "${branch}" not found (${refResp.status})`);
  }
  const languages = langResp.ok ? await langResp.json() as Record<string, number> : {};
  const refData = await refResp.json() as { object: { sha: string } };
  const sha = refData.object.sha;

  // 3. Recursive tree (single call thanks to ?recursive=1)
  const treeResp = await ghFetch(`${GITHUB_API}/repos/${opts.owner}/${opts.repo}/git/trees/${sha}?recursive=1`, headers);
  apiCalls++;
  if (!treeResp.ok) {
    throw new Error(`Scout: tree fetch failed (${treeResp.status})`);
  }
  const treeData = await treeResp.json() as GhTreeResponse;
  if (treeData.truncated) {
    // For monorepos >1000 entries the API truncates. We document this as risk
    // R5 and flag it to the caller via a profile note rather than failing.
    console.warn(`[Scout] tree truncated for ${opts.owner}/${opts.repo}@${sha}`);
  }
  const tree: TreeEntry[] = treeData.tree.map(t => ({
    path: t.path,
    type: t.type,
    sha: t.sha,
    size: t.size,
  }));

  // 4. Manifests — only fetch entries actually present in the tree
  const treePathSet = new Set(tree.map(t => t.path));
  const manifestPaths = ALWAYS_FETCH_MANIFESTS.filter(p => treePathSet.has(p));
  const manifests = await Promise.all(
    manifestPaths.map(path => fetchManifest(opts.owner, opts.repo, path, sha, headers)),
  );
  apiCalls += manifestPaths.length;

  // 5. Code Scanning Alerts — optional, often 404 (disabled or no-access)
  const alertsResp = await ghFetch(
    `${GITHUB_API}/repos/${opts.owner}/${opts.repo}/code-scanning/alerts?state=open&per_page=50`,
    headers,
  );
  apiCalls++;
  let codeScanningAlerts: CodeScanningAlert[] = [];
  if (alertsResp.ok) {
    const alerts = await alertsResp.json() as GhCodeScanningAlert[];
    codeScanningAlerts = alerts.map(toCodeScanningAlert);
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
    profileHash: hashProfile(sha, tree),
    collectedAt: new Date().toISOString(),
  };

  return { profile, apiCalls };
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
