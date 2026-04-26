# `/audit` Skill — Design v1 (Synthesis)

**Status:** Design proposal, pre-implementation
**Date:** 2026-04-26
**Provenance:** Synthesis of Grok / GPT / Gemini research outputs against the prompt in conversation. Every external claim below is tagged `[verified]` (URL fetched and cross-checked) or `[needs-verify]` (plausible but not yet confirmed). No `[hallucination-risk]` claims survived to this draft.

---

## TL;DR

Add a new skill `/audit <repo-url>` that performs professional-grade repo audits with root-cause analysis (RCA) and corrective + preventive actions (CAPA), runs entirely on the Cloudflare Workers + Durable Object infrastructure we already have, and targets **<$0.50 per small repo / <$2 per medium repo** at quality comparable to a human-grade reviewer. Hand-off to `orchestra` opens the corrective PR.

The architecture is a **four-role pipeline** (Scout → Extractor → Analyst → Distiller) scaffolded by **DMAIC** (Define, Measure, Analyze, Improve, Control). The Extractor uses **tree-sitter WASM inside the Worker** for zero-token AST extraction — this is the load-bearing technical bet; if it doesn't fit the Worker bundle/CPU envelope, the Extractor collapses into a small LLM call and the cost story shifts.

---

## 1. Problem statement

**Current pain:** users want a fast, repeatable way to audit any GitHub repo and get back actionable, evidence-grounded findings. Existing options are expensive (paid SaaS), heavy (require local clone + Docker), or noisy (LLM-only review hallucinates). We can do better by reusing our cheap-model routing, our tree-fetch + GitHub Code Scanning Alerts evidence, and the orchestra PR pipeline.

**Goals (MVP):**

| Dimension | Target |
|---|---|
| Cost / small repo (≤200 files) | < $0.50 |
| Cost / medium repo (≤2000 files) | < $2 |
| Quality (precision) | ≥ CodeRabbit's 49.2% on bug-finding tasks `[verified]` |
| Quality (recall) | ≥ 80% of findings a paid tool surfaces on the same lens |
| Latency (quick depth) | ≤ 60s |
| Latency (deep depth) | ≤ 5 min (DO-backed) |

**Non-goals (v1):** local clone, Docker-based static analysis, full SAST coverage, multi-repo / org-wide audit, IDE integration.

---

## 2. Methodology choice — DMAIC over PDCA

Two of three model reviewers (GPT, Gemini) picked **DMAIC** over PDCA; Grok picked PDCA. DMAIC wins on the merits for a defect-analysis workflow:

- **Define** maps cleanly to subcommand + lens scope.
- **Measure** maps to the cheap-evidence pass (tree, manifests, existing alerts).
- **Analyze** maps to the LLM-backed RCA (5 Whys + fishbone categorization).
- **Improve** maps to the corrective patch.
- **Control** explicitly names the *preventive* artifact (CI gate, Semgrep/ast-grep rule, lint config, dep policy, doc update). This is the half PDCA's "Act" leaves under-specified, and it's the half that distinguishes professional from amateur auditing.

We borrow PDCA's outer iteration shape only for the multi-round resume case in the DO.

---

## 3. Architecture — the four-role pipeline

```
┌──────────┐   tree + manifests       ┌────────────┐   AST chunks    ┌──────────┐   findings JSON   ┌────────────┐
│  SCOUT   │ ──────────────────────►  │ EXTRACTOR  │ ──────────────► │ ANALYST  │ ────────────────► │ DISTILLER  │
│ (no LLM) │   GitHub API only        │ (WASM AST) │  zero LLM cost  │ (LLM)    │   DMAIC scaffold  │ (cheap LLM)│
└──────────┘                          └────────────┘                 └──────────┘                   └────────────┘
                                                                          │                              │
                                                                          ▼                              ▼
                                                                    AuditFinding[]                Telegram chunks
                                                                                                  + orchestra payload
```

| Role | Runtime | Job | LLM calls | Why this split |
|---|---|---|---|---|
| **Scout** | Worker, no LLM | Fetch tree, manifests, workflows, existing GitHub Code Scanning Alerts. Build compact repo profile. | 0 | Cheap pre-pass eliminates files that don't matter for the requested lens. |
| **Extractor** | Worker, tree-sitter WASM | Parse selected files, extract function/class/import nodes only. Hand isolated AST chunks (not full files) to the Analyst. | 0 | Avoids paying LLM tokens for parsing. Aider's repo-map approach achieves 4.3–6.5% context utilization with this technique. `[verified]` |
| **Analyst** | DO (LLM, strong model) | Apply DMAIC scaffold per finding. Produces structured `AuditFinding` JSON with evidence pointers. | 1–N per lens, capped by depth | Strong model only sees pre-filtered chunks — small context, high reasoning density. |
| **Distiller** | Worker, cheap LLM | Compress findings into Telegram-ready chunks (≤4 KB each) and the orchestra hand-off payload. | 1 | Output formatting is a separate concern; runs on Haiku/Flash. |

Each stage **summarizes-and-discards**: the next stage receives a compressed artifact, not raw upstream data.

---

## 4. Subcommand taxonomy

**MVP:**

```
/audit <repo-url>                                     # default mixed audit, --depth=quick
/audit <repo-url> --lens security|deps|types|tests|deadcode|perf
/audit <repo-url> --depth quick|standard|deep
/audit <repo-url> --branch <name>
/audit <repo-url> --pr                                # hand off to orchestra for fix PR
```

**v2 (post-MVP):**

```
/audit pr <repo-url> <pr-number>                      # diff-focused review (separate mode)
/audit plan <repo-url>                                # produce only the audit plan, no findings
/audit rules <repo-url>                               # propose missing CI/lint/security gates
/audit compare <repo-url> --base <sha> --head <sha>
/audit file <repo-url> <path> --lens ...
/audit trend <repo-url>                               # delta vs. last audit (cached profile)
/audit suppress <finding-id> --reason "..."
/audit export <run-id> --format sarif|md|json
```

**Why split repo-audit from PR-audit:** they have fundamentally different evidence shapes — repo-audit is tree-first sampling, PR-audit is diff-first review. Bundling them produces a worse experience in both modes.

---

## 5. Audit lens catalog

Each lens is **a tuple of**: cheap evidence sources + AST patterns + LLM prompt. The Scout uses lens-specific path filters; the Extractor uses lens-specific AST queries; the Analyst uses lens-specific DMAIC sub-prompts.

| Lens | MVP? | Cheap evidence | Tooling reference |
|---|---|---|---|
| **security** | ✓ | GitHub Code Scanning Alerts API, secret-pattern search, auth/middleware/route files, workflow permissions | Semgrep, CodeQL, GitGuardian patterns `[needs-verify]` |
| **deps** | ✓ | `package.json`, lockfiles, dependency graph, OSV public API for advisory lookups | OSV-Scanner, Snyk `[needs-verify]` |
| **types** | ✓ | `tsconfig.json` strictness flags, `any` density, `@ts-ignore` count, public-API-shaped files | TS compiler heuristics + ast-grep `[verified]` |
| **tests** | ✓ | Test-to-source ratio, CI commands, coverage config, modules without colocated tests | (no external tool) |
| **deadcode** | ✓ | Tree map, import-graph approximation via ast-grep + GitHub code search | Knip (TS/JS), ts-prune. Knip is the 2026 default; depcheck is older. `[verified]` |
| **perf** | ✓ | Hot-path entrypoints, sync I/O in async paths, N+1 patterns, unbounded loops | AST queries via tree-sitter |
| **observability** | v2 | Logging hooks, error boundaries, retry/backoff, structured error types | (custom prompt) |
| **CI hygiene** | v2 | `.github/workflows/*` — pinned actions, permissions, secret exposure, cache usage | Trivy / pin-action patterns `[needs-verify]` |
| **architecture drift** | v2 | Repo map + dependency cycles + folder conventions vs. `ARCHITECTURE.md` rules | Greptile-style repo graph idea `[needs-verify]` |
| **accessibility** | v2 | React/HTML files — labels, alt text, button semantics | Cheap regex/AST first; LLM only for ambiguous components |

Every lens follows the same pipeline: tree → lens-filter → ast-extract → DMAIC analyze → distill.

---

## 6. `AuditFinding` schema

The single most important contract — every finding the user (or orchestra) sees must satisfy this shape.

```ts
type Severity = 'critical' | 'high' | 'medium' | 'low';
type Confidence = 0.25 | 0.5 | 0.75 | 1.0;
type Lens = 'security' | 'deps' | 'types' | 'tests' | 'deadcode' | 'perf' | string;

interface AuditEvidence {
  path: string;                  // MUST be a real path from the injected tree
  lines?: string;                // e.g. "42-58"
  snippet?: string;              // verbatim, never paraphrased
  source: 'github' | 'static' | 'wasm-ast' | 'llm';
  sha?: string;                  // blob/commit SHA, locks the claim to a point in time
}

interface AuditFinding {
  id: string;                    // stable hash of (lens + path + symptom) for suppress/dedupe
  lens: Lens;
  severity: Severity;
  confidence: Confidence;
  evidence: AuditEvidence[];     // MUST be non-empty; no claim without citation
  symptom: string;               // what's wrong, observable
  rootCause: string;             // 5-Whys terminus — process/design/config, not just "bad line"
  correctiveAction: string;      // immediate patch (becomes orchestra task)
  preventiveAction: {
    kind: 'ci' | 'lint' | 'semgrep' | 'ast-grep' | 'dep-policy' | 'doc' | 'test-fixture' | 'claude-md';
    detail: string;              // concrete artifact, e.g. the lint rule body
  };
  orchestraPatchBrief?: string;  // ready-to-execute task description for orchestra skill
}

interface AuditRun {
  runId: string;
  repo: { owner: string; name: string; sha: string };
  lenses: Lens[];
  depth: 'quick' | 'standard' | 'deep';
  findings: AuditFinding[];
  telemetry: {
    durationMs: number;
    llmCalls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    githubApiCalls: number;
  };
  cachedFrom?: string;           // prior runId if this is a delta against a cached profile
}
```

**Prioritization formula** (used when ranking findings for Telegram top-N display):

```
priority = severity_weight (0.4)
         + likelihood       (0.2)
         + blast_radius     (0.2)
         + confidence       (0.2)
         - fix_complexity   (0.1)
```

Drop any finding with `confidence < 0.5` from the user-visible report (precision discipline — see §11).

---

## 7. Token-budget design pattern

Hard caps, enforced in the runtime:

```
quick:     max 2 LLM calls,  ≤1 retrieval round,  ≤25 files fetched, ≤30 AST chunks
standard:  max 4 LLM calls,  ≤2 retrieval rounds, ≤25 files fetched, ≤80 AST chunks
deep:      max 7 LLM calls,  ≤4 retrieval rounds, ≤200 files fetched (paginated), ≤200 AST chunks
```

**Stop conditions:** no new high-confidence finding after 2 retrieval rounds; budget hit; CPU time exceeded; user-cancel.

**Cheap-first model routing** (existing model catalog):

| Stage | Default model | Why |
|---|---|---|
| Scout | (no LLM) | API-only |
| Extractor | (no LLM, WASM) | AST-only |
| Analyst (per-finding) | DeepSeek / Moonshot | Cheap reasoning, supports tools |
| Analyst (synthesis) | Sonnet 4.6 / GPT-class | Strong RCA only when multiple findings need correlation |
| Distiller | Haiku 4.5 / Flash | Output formatting |

This mirrors TeaRAG's approach, which reduced output tokens by 59–61% on Qwen2.5-14B / Llama3-8B by compressing retrieval and reasoning. `[verified]`

---

## 8. Evidence-gathering — GitHub API only, no clone

Order matters (per-call cost + cache implications):

1. `GET /repos/{owner}/{repo}` — default branch, size, language, archived/private status. `[verified]` 1 point.
2. `GET /repos/{owner}/{repo}/languages` — stack routing.
3. `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` — full tree map. Use Git Trees API (not Contents) above ~1000 files. `[verified]`
4. `GET /repos/{owner}/{repo}/code-scanning/alerts` — free pre-existing findings. Skipped only if Code Scanning is disabled on the repo. Major signal Grok missed.
5. Lens-targeted file fetch via Contents/Blob API: `package.json`, lockfiles, `tsconfig.json`, `.github/workflows/*`, entrypoints declared in manifests. **Only files the Scout flagged.**
6. `GET /search/code?q=repo:{owner}/{repo}+{pattern}` — offload first-pass pattern matching to GitHub's index (eval, dangerouslySetInnerHTML, hardcoded secrets, etc.) so we don't pay LLM tokens for it.
7. `GET /commits?path={file}&per_page=5` + blame — *only* in `--depth=deep` and only when a finding's RCA needs history.

**Rate-limit budget:** primary 5000 req/hr authenticated, secondary 900 points/min REST (GET=1pt). `[verified]` MVP audit on a medium repo: ~50–100 calls (well within bounds). Parallelize independent calls; back off on `X-RateLimit-Remaining` < 100.

**Caching (NEXUS_KV pattern):** key = `audit:profile:{owner}/{repo}@{sha}`, TTL 24h. The Scout result (tree + manifests + alerts) is fully cacheable per commit SHA. A second `--audit` on the same SHA pays only the LLM cost.

**Reproducibility:** all evidence is pinned by commit SHA. Same SHA + same prompt + same model = same finding ID hash. Exposed in the report as "audited at sha…".

---

## 9. RCA → CAPA pipeline

```
findings[]
  │
  ├── group by severity + lens
  ├── 5-Whys per finding (Analyst, DMAIC.Analyze)
  │     └── terminus must be process/design/config, not "bad line of code"
  ├── prioritize via formula in §6
  ├── split:
  │     ├── corrective:   patch payload  ──► orchestra task (`/audit ... --pr` or button)
  │     └── preventive:   one of {ci, lint, semgrep, ast-grep, dep-policy, doc, test-fixture, claude-md}
  └── distill:
        ├── Telegram chunks (top-N findings, ≤4 KB each, inline keyboard for "Fix in PR")
        └── orchestra payload (full corrective + preventive bundle)
```

**Preventive-action examples:**

| Defect class | Preventive artifact |
|---|---|
| Hardcoded secret in source | CI gate: GitGuardian / pre-commit secret scan |
| Missing input validation | Semgrep rule + CI lint step |
| Missing test for changed module | CI check enforcing test coverage on changed files |
| Repeated dependency drift | Dependabot config + version policy in `CONTRIBUTING.md` |
| AI-agent rediscovers same bug | Append lesson to `CLAUDE.md` / `.cursorrules` (Gemini's "self-improving loop" idea) |

---

## 10. Prompt scaffold (DMAIC, Analyst stage)

System fragment shared across all lenses:

```
You are a senior code auditor. Work in DMAIC order.
Never claim a defect without direct evidence.
Every finding MUST include: evidence (path + lines + snippet), impact,
root cause, corrective action, preventive action, confidence.
You MAY only reference paths from the injected `tree` array.
If you cannot ground a claim in supplied evidence, drop it.
```

Per-phase fragments:

```
DEFINE:   State the defect in one sentence. Identify the lens and scope.
MEASURE:  Quantify impact (severity, blast radius, likelihood).
ANALYZE:  Apply 5-Whys until the root cause is process/design/config,
          not merely a bad line. Cite evidence at each step.
IMPROVE:  Propose the minimal corrective patch. Output unified-diff-ready
          before/after for the orchestra hand-off.
CONTROL:  Propose ONE preventive control from {ci, lint, semgrep, ast-grep,
          dep-policy, doc, test-fixture, claude-md}. Provide the exact
          artifact (rule body, workflow yaml, doc paragraph), not a description.
```

**Anti-hallucination guard:** the Analyst's tool schema accepts `path` only as an enum populated from the injected tree. Out-of-tree paths are rejected at the JSON-schema validation step before the finding is recorded.

---

## 11. Telegram UX

- Top-3 findings only by default (precision discipline — CodeRabbit's top F1 is 51.2%, so our default presentation should over-index on precision). `[verified]`
- One Telegram message per finding (≤4 KB, HTML formatting), with an inline keyboard:
  - `🔧 Fix in PR` → dispatches orchestra
  - `🔇 Suppress` → records finding-id in NEXUS_KV (per-repo)
  - `📄 Full report` → fetches full markdown via `/audit export <run-id>`
- Long reports split via the existing telegram chunker.
- Async pattern: same as `/dossier` — Worker dispatches to TaskProcessor DO, returns "🔍 Audit started…" immediately, DO sends results when ready.

---

## 12. Anti-patterns to avoid (consolidated from all three reviewers + lessons from this codebase)

1. **LLM-only auditing** — every finding must cite a fetched blob; Analyst's schema enforces it.
2. **Full-repo stuffing** — repo-map first, never raw files.
3. **Line-based chunking** — AST-aware chunking only; preserves semantic units.
4. **Surrogate fixes** — corrective ≠ preventive; both are required for severity ≥ medium.
5. **Over-commenting low-confidence findings** — `confidence < 0.5` is dropped from the user-visible report.
6. **Path hallucination** — Analyst can only reference paths from the injected tree array.
7. **Trusting stale tooling references** — Knip > depcheck/ts-prune for TS/JS in 2026. `[verified]`
8. **Ignoring generated/vendor files** — `dist/`, `build/`, `node_modules/`, lockfile contents (except deps lens), generated SDKs, migrations excluded by default.
9. **Env-over-the-wire** — `SkillRequest.env` already taught us this lesson today; the audit skill must not include live bindings in any DO-bound payload.

---

## 13. Open risks + feasibility spikes needed before MVP build

| # | Risk | Why it matters | Spike |
|---|---|---|---|
| R1 | tree-sitter WASM bundle size in Worker | Each grammar is 100–500 KB; Workers free is 3 MiB, paid 10 MiB. `[verified]` | Lazy-load grammars per lens; measure bundle delta with TS+JS+Python+Go grammars. Hard cap: ≤2 MiB total across grammars. |
| R2 | tree-sitter WASM CPU cost | Worker has 30s CPU per request; DO has 30s per event. Parsing 25 files in a Worker request must fit. | Benchmark: parse 25 typical TS files end-to-end, target <500 ms wall-clock. If it exceeds, push Extractor into the DO. |
| R3 | GitHub Code Scanning Alerts coverage | Free signal but only if Code Scanning is enabled. Many target repos won't have it. | Treat as optional input; degrade gracefully. |
| R4 | Path hallucination despite enum guard | Models occasionally bypass schema constraints. | Add a post-LLM validator that rejects findings whose `path` isn't in the tree array. |
| R5 | Cost overrun on monorepos | 200-file cap is arbitrary; some monorepos have 200 files in a single package. | Add `--scope <subpath>` flag; sample-mode for repos > 5000 files. |
| R6 | Reproducibility under model non-determinism | Same SHA + same prompt may yield different findings across runs. | Set `temperature=0` for Analyst; cache findings by (sha, lens, model). |
| R7 | Private repo auth | Currently we have a single `GITHUB_TOKEN`. Per-user OAuth is out of scope. | MVP: only audit repos visible to our PAT. Document the limitation. |
| R8 | Citation hygiene in this very doc | I tagged claims `[verified]` / `[needs-verify]`; some `[needs-verify]` items (Semgrep multimodal blog, Greptile graph specifics) need their URLs fetched before the design freezes. | Resolve before MVP build kicks off. |

**R1 + R2 are blocking.** If WASM doesn't fit, the Extractor collapses into a small LLM call (cheap-model AST extraction prompt) and the cost target shifts to ~$0.80 small / ~$3 medium. Worth knowing before we commit.

---

## 14. MVP scope — one-week sprint

| Day | Deliverable |
|---|---|
| 1 | Feasibility spikes R1 + R2 (tree-sitter WASM bundle + CPU). Decision: WASM Extractor vs LLM Extractor. |
| 2 | Skill skeleton (`src/skills/audit/`) following the Gecko skills pattern: handler, types, tests. Wire into command-map and skill-tools allowlist. |
| 2 | Scout: GitHub tree + manifests + Code Scanning Alerts collector + NEXUS_KV cache. |
| 3 | Extractor (per R1/R2 outcome): WASM AST extraction for TS/JS/Python OR a cheap-model AST prompt. |
| 4 | Analyst: DMAIC scaffold + `AuditFinding` schema + path-enum guard + 3 lenses live (security, deps, deadcode). |
| 5 | Distiller + Telegram renderer + inline keyboards. |
| 6 | DO dispatch path (mirror `/dossier`): async run + checkpointing. |
| 7 | End-to-end on 3 real repos (small/medium/monorepo), token + cost benchmarks, write the actual cost-vs-quality numbers back into this doc as v1.1. |

**Cut lines if behind schedule:** drop the inline keyboard (text-only commands), drop deadcode lens, drop monorepo testing. Keep: security + deps + WASM extraction (or its fallback) + DMAIC scaffold + orchestra hand-off.

---

## 15. Verified citations

Every claim above tagged `[verified]` traces back to:

- **Aider repo-map + tree-sitter** — [Building a better repo map with tree-sitter](https://aider.chat/2023/10/22/repomap.html), [Aider repo-map docs](https://aider.chat/docs/repomap.html). Confirms PageRank-ranked symbol map, 40+ languages, default 1k token budget, 4.3–6.5% context utilization.
- **TeaRAG** — [arXiv 2511.05385](https://arxiv.org/abs/2511.05385). Confirms 61% / 59% output-token reduction on Llama3-8B / Qwen2.5-14B with retrieval + reasoning compression. (My earlier "hallucination-risk" flag was wrong — paper exists.)
- **CodeRabbit Martian benchmark** — [CodeRabbit blog](https://www.coderabbit.ai/blog/coderabbit-tops-martian-code-review-benchmark), [CodeAnt benchmark writeup](https://www.codeant.ai/blogs/ai-code-review-benchmark-results-from-200-000-real-pull-requests). Confirms F1 51.2% / precision 49.2% / recall 53.5% across ~300k PRs.
- **ast-grep** — [ast-grep.github.io](https://ast-grep.github.io/), [GitHub repo](https://github.com/ast-grep/ast-grep). Confirms tree-sitter–backed structural search/rewrite vs. regex.
- **Knip** — [knip.dev](https://knip.dev/), [Knip vs depcheck 2026](https://www.pkgpulse.com/blog/knip-vs-depcheck-2026). Confirms Knip is the modern default for TS/JS dead code in 2026.
- **GitHub REST rate limits** — [GitHub Docs: REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). Confirms 5000/hr authenticated primary + 900 points/min secondary (GET=1pt).
- **Cloudflare Workers limits** — [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/). Confirms 3 MiB free / 10 MiB paid bundle cap.

`[needs-verify]` claims (Semgrep multimodal triage, Greptile codegraph specifics, Snyk PR-fix flow, Continue.dev source-controlled checks) are inherited from the model reviewers and need their primary URLs fetched before the design freezes.

---

## 16. Provenance

This document synthesizes:
- **Grok**: Aider repo-map framing, PDCA scaffold (rejected), per-lens prompt fragments, $0.50 / $2 cost targets.
- **GPT**: DMAIC framework, repo-audit vs PR-audit split, `AuditFinding` schema + priority formula, GitHub Code Scanning Alerts ingestion, deterministic-detectors-before-LLM principle.
- **Gemini**: Tree-sitter WASM in Worker, four-role Scout/Extractor/Analyst/Distiller pipeline, path-enum anti-hallucination guard, CLAUDE.md-as-CONTROL artifact.
- **This engineer**: citation verification, feasibility-risk register, NEXUS_KV caching strategy, rate-limit budget, env-over-the-wire lesson, MVP cut lines.

Next action: resolve R1 + R2 spikes, then implement per §14.
