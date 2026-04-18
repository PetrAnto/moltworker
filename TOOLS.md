# TOOLS.md — Moltworker Tool Reference

> Canonical reference for the tools exposed to runtime models via the OpenRouter tool-calling loop.
> **Source of truth:** `src/openrouter/tools.ts` — if this doc disagrees with the code, the code is right.
> Kept alongside `AGENTS.md` so both human and model readers can make routing decisions without re-deriving tool semantics.

---

## How to read this file

Every tool entry gives:

- **Purpose** — one line, what it is for.
- **Key args** — the arguments a caller actually has to think about. Full JSON schema is in `tools.ts`.
- **Latency** — wall-clock band from invocation to result returned to the model. Network/LLM/Cloudflare variance means these are order-of-magnitude, not SLAs.
- **Output size** — typical payload returned to the model, before truncation.
- **Truncation** — hard cap enforced in `tools.ts` (tool layer) or `task-processor.ts` (DO layer — 8KB).
- **Failure modes** — the realistic ways this tool returns an error-shaped result instead of data. Errors are *returned as tool results*, not thrown (see CLAUDE.md).
- **When to prefer** — cheaper/faster alternative if one exists.

### Latency bands

| Band | Wall clock | Typical tools |
|---|---|---|
| **instant** | <200 ms | pure computation, URL construction |
| **fast** | 200 ms – 1 s | single cached API call, R2 read/write |
| **medium** | 1 – 3 s | single external HTTP call (search, weather, GitHub read) |
| **slow** | 3 – 10 s | multi-step (PR creation, browser action, Cloudflare Code Mode) |
| **very slow** | 10 s+ | sandboxed shell / code execution, multi-page browser session |

### Output-size bands (pre-truncation)

| Band | Size | Notes |
|---|---|---|
| **tiny** | <1 KB | status lines, single values |
| **small** | 1 – 10 KB | structured API responses |
| **medium** | 10 – 50 KB | article text, code files, search result lists |
| **large** | 50 KB+ | full pages, API dumps — will hit truncation |

### Routing heuristic for callers

1. Prefer **fast + tiny/small** tools when the question is bounded.
2. Reach for **medium** only when structured retrieval is required.
3. Justify every **slow** or **very slow** call — each one burns a meaningful slice of the 120 s streaming window.
4. Two cheap calls usually beat one expensive one when the first can narrow the second (`github_list_files` → `github_read_file`).

---

## Web & content fetching

### `fetch_url`
- **Purpose:** Fetch the text content of a URL (HTML stripped to text, files returned as text).
- **Key args:** `url`.
- **Latency:** medium.
- **Output size:** small–medium.
- **Truncation:** 20 KB (`tools.ts:1153`).
- **Failure modes:** non-200 response, non-text content, DNS failure, timeout.
- **When to prefer:** use `url_metadata` if you only need title/description/OG image; use `browse_url` if the page is JS-rendered.

### `url_metadata`
- **Purpose:** Extract structured page metadata (title, description, image, author, publisher, date).
- **Key args:** `url`.
- **Latency:** medium.
- **Output size:** tiny.
- **Truncation:** none (payload is already small).
- **Failure modes:** non-200, no `<meta>` tags, malformed HTML.
- **When to prefer:** over `fetch_url` for link previews and bibliographic-style lookups.

### `web_search`
- **Purpose:** Search the web. Returns title/URL/snippet triples from Tavily (preferred) or Brave (fallback).
- **Key args:** `query`, `count` (default 5, max 10).
- **Latency:** medium.
- **Output size:** small.
- **Truncation:** implicit via `count` cap.
- **Failure modes:** missing API keys, rate limiter rejection (`webSearchLimiter`), empty results.
- **When to prefer:** as the first step before `fetch_url` / `browse_url`.

### `fetch_news`
- **Purpose:** Top stories from HackerNews, a subreddit, or an arXiv category.
- **Key args:** `source` (`hn` | `reddit` | `arxiv`), optional `topic`.
- **Latency:** medium.
- **Output size:** small.
- **Truncation:** implicit (fixed result counts).
- **Failure modes:** source outage, invalid subreddit/category.
- **When to prefer:** curated feeds are cheaper than `web_search` when the user asks for "latest X".

---

## GitHub — read

### `github_list_files`
- **Purpose:** List a directory in a GitHub repo. For the root, also returns description, language, stars, and README headings.
- **Key args:** `owner`, `repo`, `path` (empty = root), `ref` (optional).
- **Latency:** medium.
- **Output size:** small.
- **Truncation:** none.
- **Failure modes:** 404, rate limit, private repo without token.
- **When to prefer:** **always call this first** before `github_read_file` for repo exploration.

### `github_read_file`
- **Purpose:** Read a single file from a GitHub repo.
- **Key args:** `owner`, `repo`, `path`, `ref`, optional `line_start`/`line_end`.
- **Latency:** medium.
- **Output size:** medium.
- **Truncation:** 30 KB (`tools.ts:1254`). Binary files and `package-lock.json` / `yarn.lock` return metadata only.
- **Failure modes:** 404, truncation on large files (use line ranges), binary file metadata-only.
- **Notes:** **EXPENSIVE — ~7 K tokens of context per call** (self-declared in tool description). Use `line_start`/`line_end` aggressively on files >500 lines.

### `github_api`
- **Purpose:** Arbitrary GitHub REST call — issues, PRs, repo info, user, etc.
- **Key args:** `endpoint`, `method` (GET/POST/…), `body`.
- **Latency:** medium.
- **Output size:** small–medium.
- **Truncation:** 50 KB (`tools.ts:1436`).
- **Failure modes:** 4xx, rate limit, missing token, oversized response.
- **When to prefer:** only when no specialized tool covers the operation.

---

## GitHub — write (atomic PR path)

Two ways to write: **atomic** (`github_create_pr` / `github_push_files` / `github_merge_pr`) and **staged** (`workspace_*`). Pick one path per task.

### `github_create_pr`
- **Purpose:** Create a branch, commit file changes, open a PR — in one call.
- **Key args:** `owner`, `repo`, `title`, `branch` (auto-prefixed `bot/`), `base`, `files[]`, `body`.
- **Latency:** slow.
- **Output size:** tiny.
- **Truncation:** none.
- **Failure modes:** merge conflicts, base-branch drift, invalid `action` in `files[]`, missing token, bracket-balance check fails on patches (`tools.ts:1631`).
- **When to prefer:** small changes (≤3–4 files) that can fit in one call.

### `github_push_files`
- **Purpose:** Push a batch of file changes to a branch **without** opening a PR. Use to chain multiple batches, then finish with `github_create_pr`.
- **Key args:** same as `github_create_pr` minus title/body, plus `message`.
- **Latency:** slow.
- **Output size:** tiny.
- **Truncation:** none.
- **Failure modes:** as above; **keep batches to 3–4 files** or the streaming window closes mid-call.

### `github_merge_pr`
- **Purpose:** Merge an open PR (`squash` / `merge` / `rebase`).
- **Key args:** `owner`, `repo`, `pull_number`, `merge_method`.
- **Latency:** medium.
- **Output size:** tiny.
- **Truncation:** none.
- **Failure modes:** PR not mergeable, required checks failing, branch protection.

---

## Workspace (staged) — `workspace_*`

Alternative write path: stage locally, commit once. No GitHub call until `workspace_commit`. Works via callbacks on `ToolContext` (`tools.ts:218-220`) — only available inside the TaskProcessor DO.

### `workspace_write_file`
- **Purpose:** Stage a create/update.
- **Key args:** `path`, `content`.
- **Latency:** fast.
- **Output size:** tiny.
- **Truncation:** none.
- **Failure modes:** missing workspace callbacks (not inside DO).

### `workspace_delete_file`
- **Purpose:** Stage a deletion.
- **Key args:** `path`.
- **Latency:** fast.
- **Output size:** tiny.

### `workspace_commit`
- **Purpose:** Flush all staged ops to a branch in one atomic commit.
- **Key args:** `owner`, `repo`, `branch`, `message`, `base`.
- **Latency:** slow.
- **Output size:** tiny.
- **Failure modes:** empty workspace, bracket-balance check on patched files (`tools.ts:2673`), token/permission errors.

---

## Browser

### `browse_url`
- **Purpose:** Drive a real headless Chrome session — `extract_text`, `screenshot`, `pdf`, `accessibility_tree`, `click`, `fill`, `scroll`. **Session persists across calls** via `browserSessionId`.
- **Key args:** `url` (first call), `action`, `selector`, `text`, `wait_for`.
- **Latency:** **slow to very slow** — 3–15 s per action.
- **Output size:** small (text/a11y) to large (screenshots, PDFs).
- **Truncation:** varies per action; screenshots returned as URLs not inline.
- **Failure modes:** binding missing (`ToolContext.browser`), navigation timeout, selector not found, quota exhaustion.
- **When to prefer:** only when the page is JS-rendered or requires interaction. For static HTML use `fetch_url`.

---

## Code execution

### `run_code`
- **Purpose:** Execute Python, JavaScript, or Bash in a sandbox. Files persist across calls via Acontext session.
- **Key args:** `language`, `code`, `timeout` (default 30 s, max 120 s).
- **Latency:** very slow (1 s – 120 s).
- **Output size:** medium (logs).
- **Truncation:** stdout 10 KB, stderr 5 KB (`tools.ts:3036`).
- **Failure modes:** timeout, acontext session missing, runtime error surfaced in stderr.
- **When to prefer:** calculations, one-file scripts, data reshaping. Prefer this over `sandbox_exec` when you don't need shell/git.

### `sandbox_exec`
- **Purpose:** Run an ordered list of shell commands in a full sandbox container (git, node, npm, common CLI).
- **Key args:** `commands[]`, `timeout` (default 120, max 300 s per command).
- **Latency:** very slow.
- **Output size:** medium–large.
- **Truncation:** handled at TaskProcessor layer (8 KB per result per CLAUDE.md).
- **Failure modes:** no sandbox binding, individual command failure, total timeout.
- **When to prefer:** multi-file refactors or tasks that genuinely need git/npm. For simple file changes use `github_create_pr` instead.

---

## Persistent file storage (R2)

All four operate on per-user R2 keys scoped by `ToolContext.r2FilePrefix`.

### `save_file`
- **Purpose:** Write content to persistent R2 storage.
- **Key args:** `filename`, `content`.
- **Latency:** fast.
- **Output size:** tiny.

### `read_saved_file`
- **Purpose:** Read a previously saved file.
- **Key args:** `filename`.
- **Latency:** fast.
- **Output size:** varies with file.
- **Truncation:** same 50 KB ceiling as other tool outputs.

### `list_saved_files`
- **Purpose:** List files under an optional prefix.
- **Key args:** `prefix` (optional).
- **Latency:** fast.
- **Output size:** tiny–small.

### `delete_saved_file`
- **Purpose:** Delete one stored file.
- **Key args:** `filename`.
- **Latency:** fast.

---

## Data & lookup utilities

| Tool | Purpose | Latency | Output | Truncation | Notes |
|---|---|---|---|---|---|
| `get_weather` | Current + 7-day forecast for lat/lng (open-meteo). | medium | small | none | Coordinates required — pair with `geolocate_ip` if you only have an IP. |
| `convert_currency` | FX conversion, 150+ currencies, live rates. | fast | tiny | none | Stateless, cheap — preferred over LLM estimation. |
| `get_crypto` | CoinGecko — price / top-N / DEX pair. | medium | small | none | `mode` selects the variant. |
| `geolocate_ip` | IP → city/region/country/ISP/coords. | fast | tiny | none | Works for IPv4 and IPv6. |
| `generate_chart` | QuickChart URL for a Chart.js config. Returns a URL, does **not** render. | instant | tiny | none | Client follows the URL to get the PNG. |

---

## Cloudflare control plane

### `cloudflare_api`
- **Purpose:** Access the full Cloudflare API (2500+ endpoints) via Code Mode MCP. Two actions: `search` (find endpoints) then `execute` (run TypeScript against the typed SDK).
- **Key args:** `action`, `query` (search), code (execute).
- **Latency:** slow.
- **Output size:** varies — API dumps can be large.
- **Truncation:** standard 50 KB.
- **Failure modes:** missing `cloudflareApiToken`, invalid TypeScript in `execute`, API-side error.
- **When to prefer:** only when no other tool covers the need — Cloudflare API is powerful but expensive per call.

---

## ToolContext dependencies

Not every tool is available in every runtime surface. A tool silently degrades to an error result if its `ToolContext` dependency is missing (`tools.ts:204-221`).

| Dependency | Tools that need it |
|---|---|
| `githubToken` | all `github_*`, `workspace_commit` |
| `braveSearchKey` / `tavilyKey` | `web_search` |
| `webSearchLimiter` | `web_search` (rate limiting) |
| `browser` | `browse_url` |
| `browserSessionId` | `browse_url` (session continuity) |
| `sandbox` | `sandbox_exec` |
| `acontextClient` / `acontextSessionId` | `run_code` |
| `cloudflareApiToken` | `cloudflare_api` |
| `r2Bucket` + `r2FilePrefix` | `save_file`, `read_saved_file`, `list_saved_files`, `delete_saved_file` |
| `workspaceWrite` / `workspaceList` / `workspaceClear` | `workspace_*` (DO-only) |

---

## Global invariants

- Tool results are **returned as error-shaped strings**, never thrown — models see failure and can retry or route around.
- Every tool result is capped at the tool layer (`tools.ts` — 20 KB / 30 KB / 50 KB depending on tool) and again at the DO layer (8 KB, `task-processor.ts`).
- Worker tool-call loop max iterations: **10**. Durable Object max iterations: **100** (see CLAUDE.md).
- All tool arguments are JSON-parsed inside a try/catch — malformed JSON returns an error result rather than crashing the loop.

---

## Changelog

- **2026-04-18** — initial draft; covers 26 tools defined in `src/openrouter/tools.ts`.
