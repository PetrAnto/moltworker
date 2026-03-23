# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-23 (F.1b ai-hub proactive alerts — 2083 tests)

---

## Current Task: E2E Bot Testing — Coding Agent Smoke Tests

### Context

We just completed F.1 + F.1b (ai-hub data feeds + proactive alerts). Before moving to the next feature, we need to validate the bot's orchestra mode with real coding tasks — the kind users actually send.

### Step 1: Create the test repo

The bot can create repos via `github_api`. Send this to the bot (via Telegram or /simulate):

```
Use the github_api tool to create a new public repository called "moltbot-test-arena" under the PetrAnto account with this description: "Test repo for moltbot orchestra coding tasks". Then push an initial commit with a README.md and a basic package.json for a TypeScript Node.js project (name: moltbot-test-arena, typescript + vitest as devDependencies).
```

If that fails (permissions), create the repo manually:
```bash
gh repo create PetrAnto/moltbot-test-arena --public --description "Test repo for moltbot orchestra coding tasks"
# Then push a basic TS project scaffold
```

### Step 2: Run the test battery

Use `/simulate/chat` or Telegram to send these tasks **one at a time via orchestra mode** (`/orch`). Each tests a different common coding pattern.

**Test 1 — Scaffold + implement from scratch** (most common request)
```
/orch In PetrAnto/moltbot-test-arena, create a src/utils/string-helpers.ts file with these functions: capitalize(str), slugify(str), truncate(str, maxLen, suffix?), camelToKebab(str), escapeHtml(str). Add comprehensive tests in src/utils/string-helpers.test.ts. Use vitest. Make sure all tests pass.
```

**Test 2 — Bug fix from issue description** (second most common)
```
/orch In PetrAnto/moltbot-test-arena, there's a bug in src/utils/string-helpers.ts: the slugify function doesn't handle consecutive hyphens or leading/trailing hyphens. For example slugify("--hello--world--") should return "hello-world", not "--hello--world--". Fix the bug and add regression tests.
```

**Test 3 — Add feature to existing code** (extending existing code)
```
/orch In PetrAnto/moltbot-test-arena, add a new file src/http/fetch-retry.ts that implements a fetchWithRetry(url, options?) function. It should retry on 429/500/502/503 with exponential backoff (default 3 retries, 1s/2s/4s delays). Add tests using vi.fn() to mock fetch — test success, retry on 503, give up after max retries, and respect Retry-After header.
```

**Test 4 — Refactor existing code** (restructuring without breaking)
```
/orch In PetrAnto/moltbot-test-arena, refactor src/utils/string-helpers.ts: split it into separate files under src/utils/strings/ (capitalize.ts, slugify.ts, truncate.ts, camel-to-kebab.ts, escape-html.ts) with an index.ts barrel export. Update all imports in test files. All existing tests must still pass.
```

**Test 5 — Multi-file feature with config** (complex, cross-file task)
```
/orch In PetrAnto/moltbot-test-arena, implement a simple key-value cache in src/cache/memory-cache.ts with: get(key), set(key, value, ttlMs?), delete(key), clear(), size(), has(key). TTL should auto-expire entries. Add a src/cache/cache.config.ts with defaults (maxSize: 1000, defaultTtlMs: 300000). Add comprehensive tests including TTL expiration (use vi.useFakeTimers). Create a PR with all changes.
```

### Step 3: Score each test

For each test, record:

| Test | ✅/❌ | PR link | Tools used | Iterations | Duration | Notes |
|------|-------|---------|------------|------------|----------|-------|
| T1 Scaffold | | | | | | |
| T2 Bug fix | | | | | | |
| T3 Add feature | | | | | | |
| T4 Refactor | | | | | | |
| T5 Multi-file | | | | | | |

**Pass criteria:** PR created, tests pass, code is correct, no destructive rewrites.

### Step 4: Report

After all 5 tests, summarize:
- Overall pass rate
- Average iterations/duration
- Any model failures or tool errors
- Recommendations for prompt tuning or guardrail adjustments

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-23 | F.1b — ai-hub proactive alerts | Claude Opus 4.6 | fetchAiHubAlerts + formatAlertForTelegram, wired into 5-min cron, priority-tagged Telegram messages. 10 new tests (2083 total) |
| 2026-03-23 | F.1 — ai-hub data feeds integration | Claude Opus 4.6 | fetchAiHubRss + fetchAiHubMarket wired into /brief, graceful degradation, 11 new tests (2073 total) |
| 2026-03-23 | F.21+F.24+taskForStorage — Review cleanup batch | Claude Opus 4.6 | pendingChildren consumers (resume caps + display), model floor with paid escalation suggestion, post-aggressive storage verification. 8 new tests (2062 total) |
| 2026-03-23 | F.26 — Smart resume truncation | Claude Opus 4.6 | Tool-type-aware truncation, file read deduplication, structured summaries. 10 new tests (2054 total) |
| 2026-03-23 | F.25 — Byte counting + extraction escalation + context decoupling | Claude Opus 4.6 | taskForStorage() uses TextEncoder byte length, extraction failure escalates to reasoning model, extractionMeta persisted for resume resilience. 3 new tests (2044 total) |
| 2026-03-23 | F.23 — Branch-level concurrency mutex | Claude Opus 4.6 | R2-based repo-level lock with 45-min TTL. Acquire before dispatch, release on all terminal paths. 21 new tests (2041 total) |
| 2026-03-22 | F.22 — Profile enforcement regression tests | Claude Opus 4.6 | 14 tests: promptTierOverride (4), sandbox tool-level gating (5), forceEscalation (5). 2020 total |
| 2026-03-22 | F.20 — Runtime/diff-based risk classification | Claude Opus 4.6 | RuntimeRiskProfile: file tracking (16 config patterns), scope expansion, error accumulation, drift detection. Integrated into DO loop + RunHealth. 24 new tests (2006 total) |
| 2026-03-22 | F.18.1 — ExecutionProfile authoritative enforcement | Claude Opus 4.6 | promptTierOverride, sandbox tool-level gating, forceEscalation auto-upgrade. F.20–F.24 tracked from reviewer feedback |
| 2026-03-22 | F.18 — OrchestraExecutionProfile | Claude Opus 4.6 | Centralized task classification: sandbox gate, resume cap modulation, force-escalation. 8 tests (1982 total) |
| 2026-03-22 | F.17 — Sandbox stagnation detection + run health | Claude Opus 4.6 | detectSandboxStagnation(), sandboxStalled/prefetch404Count signals |
| 2026-03-22 | Architecture review prompt | Claude Opus 4.6 | 5 architectural decisions documented for external AI review |
| 2026-03-21 | F.16 — Orchestra branch retry fix | Claude Opus 4.6 | Root cause from PR #108: "retry with different branch" loses prior commits. Updated 5 prompt locations |
| 2026-03-21 | F.15 — EOL normalization + GitHub path encoding | Claude Opus 4.6 | 1911 tests. applyFuzzyPatch dominant EOL detection, encodeGitHubPath on all 7 API URLs, 9 new tests |
| 2026-03-21 | Docs sync — roadmap, future-integrations, claude-log | Claude Opus 4.6 | Marked 6 completed features in future-integrations.md, added brainstorming cross-refs to roadmap |

---

## Alternative Next Tasks (after testing)

1. **F.7** — Discord full integration (read-only → two-way)
2. **6.3** — Voice messages (Whisper + TTS)
3. **Slack integration** — Two-way Slack bot support
