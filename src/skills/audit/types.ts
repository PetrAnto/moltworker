/**
 * Audit Skill — Core Types
 *
 * Shared types for the /audit skill. See brainstorming/audit-skill-design-v1.md
 * for the full design rationale.
 */

// ---------------------------------------------------------------------------
// Public surface (used by handler + DO + renderer)
// ---------------------------------------------------------------------------

/** Audit lenses. Only MVP set is wired in v0; the rest land post-MVP. */
export type Lens =
  | 'security'
  | 'deps'
  | 'types'
  | 'tests'
  | 'deadcode'
  | 'perf';

export const MVP_LENSES: ReadonlyArray<Lens> = ['security', 'deps', 'types', 'tests', 'deadcode', 'perf'];

/** Severity scale per finding. */
export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Coarse-grained confidence in a finding (post-validation). */
export type Confidence = 0.25 | 0.5 | 0.75 | 1.0;

/** Audit depth tiers — controls token + tool budgets. */
export type Depth = 'quick' | 'standard' | 'deep';

/** Source of an evidence record. */
export type EvidenceSource = 'github' | 'static' | 'wasm-ast' | 'llm';

/** Preventive-action artifact kinds. */
export type PreventiveKind =
  | 'ci'
  | 'lint'
  | 'semgrep'
  | 'ast-grep'
  | 'dep-policy'
  | 'doc'
  | 'test-fixture'
  | 'claude-md';

// ---------------------------------------------------------------------------
// Scout output — the cheap pre-pass artifact
// ---------------------------------------------------------------------------

/**
 * Repo profile produced by the Scout. Cacheable by (owner, repo, sha).
 * Contains zero-LLM evidence: tree, manifests, existing alerts.
 */
export interface RepoProfile {
  /** Repo coordinates. */
  owner: string;
  repo: string;
  defaultBranch: string;
  /** Commit SHA the profile is pinned to — every claim downstream cites this. */
  sha: string;
  /** Repo-level metadata returned by GET /repos/{owner}/{repo}. */
  meta: {
    private: boolean;
    archived: boolean;
    sizeKb: number;
    primaryLanguage: string | null;
    languages: Record<string, number>; // bytes per language
    description: string | null;
  };
  /** Flattened tree from /git/trees/{sha}?recursive=1. */
  tree: TreeEntry[];
  /** Manifests + critical config files we always fetch. */
  manifests: ManifestFile[];
  /** Pre-existing GitHub Code Scanning Alerts. Empty if disabled on the repo. */
  codeScanningAlerts: CodeScanningAlert[];
  /** True if the alerts list was truncated (we only paginate the first page). */
  codeScanningAlertsTruncated: boolean;
  /** True if GitHub truncated the recursive tree response (>~100k entries or
   *  >7 MB serialized — the API caps recursive listings). When true, audit
   *  coverage is partial and the user must be told. */
  treeTruncated: boolean;
  /** Hash of (sha + tree byte sizes) for cache invalidation. */
  profileHash: string;
  /** When the profile was collected (ISO). */
  collectedAt: string;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  /** Blob SHA for files; lets us pin evidence by content. */
  sha: string;
  /** Byte size for blobs (not present for trees). */
  size?: number;
}

export interface ManifestFile {
  path: string;
  /** Verbatim content (decoded from base64) or null if too large. */
  content: string | null;
  sha: string;
}

export interface CodeScanningAlert {
  number: number;
  state: 'open' | 'closed' | 'dismissed' | 'fixed';
  severity: Severity;
  rule: string;
  description: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

// ---------------------------------------------------------------------------
// Audit plan — what the Extractor + Analyst will work on
// ---------------------------------------------------------------------------

/**
 * Output of `/audit ... --plan` (the cheap pre-flight). Also embedded in
 * full audit runs as the first stage of the four-role pipeline.
 */
export interface AuditPlan {
  profile: RepoProfile;
  lenses: Lens[];
  depth: Depth;
  /** Files the Scout selected for the Extractor, grouped by lens. */
  selections: Record<Lens, string[]>;
  /** Crude cost estimate (LLM calls + tokens), driven by depth. */
  estimate: {
    llmCalls: number;
    inputTokens: number;
    costUsd: number;
  };
  notes: string[];
}

// ---------------------------------------------------------------------------
// Findings + Run (post-Analyst — empty in v0 Scout-only handler)
// ---------------------------------------------------------------------------

export interface AuditEvidence {
  /** MUST be a real path from `RepoProfile.tree`. The Analyst's path enum is
   *  populated from this list and a post-LLM validator rejects anything else. */
  path: string;
  /** e.g. "42-58". */
  lines?: string;
  /** Verbatim, never paraphrased. */
  snippet?: string;
  source: EvidenceSource;
  /** Blob/commit SHA that locks the claim to a point in time. */
  sha?: string;
}

export interface AuditFinding {
  /** Stable hash of (lens + path + symptom) — used for /suppress and dedup. */
  id: string;
  lens: Lens;
  severity: Severity;
  confidence: Confidence;
  /** Non-empty. No claim without citation. */
  evidence: AuditEvidence[];
  /** Observable defect. */
  symptom: string;
  /** 5-Whys terminus — process/design/config, not a single bad line. */
  rootCause: string;
  /** Immediate patch. Becomes orchestra task when --pr is set. */
  correctiveAction: string;
  preventiveAction: {
    kind: PreventiveKind;
    /** Concrete artifact — e.g. the lint rule body, the workflow yaml, etc. */
    detail: string;
  };
  /** Ready-to-execute task description for orchestra. Optional. */
  orchestraPatchBrief?: string;
  /** True when this finding's id is on the per-repo suppression list at
   *  audit time. Suppressed findings are persisted with the run (so
   *  /audit export remains transparent — the user can see what their
   *  prior suppression decisions hid) but excluded from the default
   *  inline view. */
  suppressed?: boolean;
}

export interface AuditRun {
  runId: string;
  repo: { owner: string; name: string; sha: string };
  lenses: Lens[];
  depth: Depth;
  findings: AuditFinding[];
  telemetry: {
    durationMs: number;
    llmCalls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    githubApiCalls: number;
  };
  /** Prior runId if this run was a delta against a cached profile. */
  cachedFrom?: string;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isLens(value: unknown): value is Lens {
  return typeof value === 'string' && (MVP_LENSES as ReadonlyArray<string>).includes(value);
}

export function isDepth(value: unknown): value is Depth {
  return value === 'quick' || value === 'standard' || value === 'deep';
}

// ---------------------------------------------------------------------------
// Grammar manifest (R2-stored tree-sitter WASM grammars)
// ---------------------------------------------------------------------------

/**
 * Languages we ship MVP grammars for. Each entry has a corresponding
 * `audit/grammars/<lang>@<sha8>.wasm` blob in R2 and a manifest entry.
 */
export type GrammarLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go';

export const MVP_GRAMMARS: ReadonlyArray<GrammarLanguage> = ['typescript', 'tsx', 'javascript', 'python', 'go'];

/**
 * Per-language entry in the R2 manifest. Versioning is by content SHA so a
 * cache lookup MISS only happens when the actual WASM bytes change.
 */
export interface GrammarManifestEntry {
  language: GrammarLanguage;
  /** R2 key — path in MOLTBOT_BUCKET. Includes the SHA8 for cache-busting. */
  key: string;
  /** Hex SHA-256 of the WASM bytes. Full hash, manifest-pinned. */
  sha256: string;
  /** Size in bytes — used by the loader as the size guard. */
  size: number;
  /** Source tag — e.g. "tree-sitter-wasms@0.1.13". Free-form. */
  source: string;
  /** ISO timestamp the entry was uploaded. */
  uploadedAt: string;
}

/**
 * Top-level manifest stored at `audit/grammars/manifest.json` in R2.
 *
 * `runtime` (optional) carries the web-tree-sitter runtime WASM
 * (~192 KiB) that the Worker passes to `Parser.init({wasmBinary})`.
 * Lives in the same manifest so a single uploader run pushes everything
 * the Extractor needs to bootstrap inside the Worker. Older manifests
 * without `runtime` still validate (back-compat for the slice 1 build).
 */
export interface GrammarManifest {
  version: 1;
  entries: GrammarManifestEntry[];
  /** Optional — present once the runtime WASM has been uploaded. */
  runtime?: RuntimeManifestEntry;
  /** ISO timestamp of the most recent uploader run. */
  updatedAt: string;
}

/**
 * Per-runtime entry. Distinct shape from `GrammarManifestEntry` because the
 * runtime has no `language` field and lives at a fixed key.
 */
export interface RuntimeManifestEntry {
  /** R2 key — always `audit/grammars/runtime@<sha8>.wasm`. */
  key: string;
  sha256: string;
  size: number;
  source: string; // e.g. "web-tree-sitter@0.20.8"
  uploadedAt: string;
}

/** Maximum grammar WASM size the loader will accept. Hard guard against
 *  accidental oversized uploads (a malicious or buggy upload could blow
 *  CPU budgets during compile). 5 MiB covers the largest production
 *  grammar (TSX at ~2.4 MiB) with comfortable headroom. */
export const MAX_GRAMMAR_BYTES = 5 * 1024 * 1024;

/** Maximum web-tree-sitter runtime WASM size. The shipped runtime is
 *  ~192 KiB; 1 MiB is a generous cap that catches accidental uploads
 *  of the wrong file (e.g. a grammar masquerading as the runtime).
 *  Distinct from MAX_GRAMMAR_BYTES so alerts read "runtime too large"
 *  not "grammar too large". */
export const MAX_TREE_SITTER_RUNTIME_BYTES = 1 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Extractor output (zero-LLM AST snippets passed to the Analyst)
// ---------------------------------------------------------------------------

/** Categories the Extractor emits. The Analyst's prompts vary by kind. */
export type SnippetKind =
  | 'function'    // function declarations + methods
  | 'class'       // class / interface / type alias declarations
  | 'import'      // top-of-file imports — security/dep evidence
  | 'export'      // public surface — types/deadcode evidence
  | 'workflow'    // .github/workflows/*.yml — security lens, full file
  | 'manifest';   // package.json/tsconfig.json/etc — verbatim, full file

export interface ExtractedSnippet {
  /** Path from RepoProfile.tree — the only paths the Analyst will ever
   *  see, enforced via a path enum at the prompt boundary. */
  path: string;
  kind: SnippetKind;
  /** The symbol or anchor name (e.g. "handleAudit", "AuthMiddleware",
   *  "@actions/checkout"). Empty for kinds where it doesn't apply. */
  name: string;
  /** Line range from the source file (1-indexed, inclusive on both ends). */
  startLine: number;
  endLine: number;
  /** Verbatim slice of the source, never paraphrased. Truncated to
   *  MAX_SNIPPET_CHARS if the node is huge (e.g. an enormous function). */
  text: string;
  /** Language the source was parsed as. Used by the Analyst for routing. */
  language: GrammarLanguage | 'yaml' | 'json' | 'plain';
  /** Blob SHA from the tree entry — locks the snippet to a content hash. */
  sha?: string;
  /** Whether `text` was truncated (i.e. node bigger than the cap). */
  truncated?: boolean;
}

/** Cap for any single snippet's verbatim text, in UTF-16 *characters* (i.e.
 *  `string.length`). Token count and char count are both reasonable proxies
 *  for the Analyst's per-call context budget; UTF-8 byte size matters only at
 *  transport boundaries we don't control here. ~8k chars ≈ 2k tokens —
 *  plenty for RCA on a single function. */
export const MAX_SNIPPET_CHARS = 8 * 1024;

// ---------------------------------------------------------------------------
// Type guards & utilities
// ---------------------------------------------------------------------------

export function isGrammarLanguage(value: unknown): value is GrammarLanguage {
  return typeof value === 'string' && (MVP_GRAMMARS as ReadonlyArray<string>).includes(value);
}

/** Priority score per the design doc §6 — used for top-N display ranking. */
export function findingPriority(f: AuditFinding): number {
  const severityWeight: Record<Severity, number> = { critical: 1.0, high: 0.75, medium: 0.5, low: 0.25 };
  // Without an LLM in v0, likelihood/blast-radius are derived heuristics; for now
  // collapse to a simple severity + confidence ranking. The Analyst will populate
  // the missing inputs in v1.
  return 0.6 * severityWeight[f.severity] + 0.4 * f.confidence;
}
