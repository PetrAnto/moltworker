# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-07 (Orchestra stall audit + 499 resilience fix)

---

## Current Task: Validate Orchestra Stability After 499 Hardening

### Context

A new reliability fix landed for `/orch next` stalls observed in production:
- Added hard stream cap for direct provider SSE loops
- Added explicit handling for Anthropic-style `499 Client disconnected` errors
- Enabled free-model rotation on 499/client-disconnect failures
- Added regression coverage in `task-processor.test.ts`

Now validate whether these changes reduce long-running auto-resume loops and failed PR tasks.

### Immediate Validation Work (by priority)

| Priority | Task | Phase | Effort | Notes |
|----------|------|-------|--------|-------|
| 1 | **Run /orch next benchmark** on `/sonnet`, `/q3coder`, `/opus45` | Reliability | High | Compare stall rate, elapsed time, and PR completion |
| 2 | **Inspect 499 frequency** in provider logs after deploy | Reliability | High | Confirm disconnect retries/rotation are effective |
| 3 | **Add semantic-progress watchdog** (tool/output delta) if stalls persist | Reliability | Medium | Heartbeats alone can mask no-progress streams |
| 4 | **5.3 Acontext Sandbox** — code execution in sandbox containers | 5 | High | Requires Acontext setup |
| 5 | **5.4 Acontext Disk** — file management via Acontext | 5 | High | Requires Acontext setup |

### Recommendation

Run a focused reliability pass first:
- Execute 3-5 real `/orch next` tasks on coding-heavy repos
- Compare outcomes before/after this fix (stalls, retries, 499 events, successful PRs)
- If persistent long-stream no-progress cases remain, implement semantic-progress stall detection next.

---

## Recently Completed

| Date | Task | AI | Session |
|------|------|----|---------|
| 2026-02-23 | 5.1: Multi-Agent Review — cross-family reviewer for independent verification (1458 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |

| Date | Task | AI | Session |
|------|------|----|---------|
| 2026-02-23 | 7B.1: Speculative Tool Execution — start tools during streaming (1411 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-23 | 7B.5: Streaming User Feedback — phase + tool-level progress messages (1392 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-23 | Fix: Orchestra tool descriptions + partial failure handling (1348 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-23 | 7A.1: CoVe Verification Loop — post-work verification (1336 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-23 | 7B.4: Reduce Iteration Count — inject pre-loaded files (1312 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-23 | 7A.4: Structured Step Decomposition — JSON plan steps (1299 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-23 | 7B.3: Pre-fetch Context — extract file paths, prefetch from GitHub (1273 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-23 | 7B.2: Model Routing by Complexity — fast model for simple queries (1242 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-23 | MS.5-6: Dynamic /pick picker + /syncall menu + /start sync button | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-23 | MS.1-4: Full model catalog auto-sync from OpenRouter (1227 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-22 | 7A.5: Prompt Caching — cache_control for Anthropic models (1175 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-22 | 7A.3: Destructive Op Guard — block risky tool calls (1158 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
| 2026-02-22 | 7A.2: Smart Context Loading — skip R2 reads for simple queries (1133 tests) | Claude Opus 4.6 | session_01V82ZPEL4WPcLtvGC6szgt5 |
