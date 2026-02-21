# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-02-21 (DM.5 complete — approve endpoint for paused Dream Build jobs)

---

## Current Task: DM.7 — Enforce checkTrustLevel() at Route Layer

### Goal

Wire the existing `checkTrustLevel()` function into the dream-build route. The function is already implemented in `src/dream/auth.ts` but never called — add a one-line check in the POST `/dream-build` handler.

### Context

- DM.1-DM.5 are complete — full Dream Machine pipeline with AI code generation, budget enforcement, and human approval
- `checkTrustLevel()` is defined in `src/dream/auth.ts` but not invoked anywhere
- Trust levels: observer (read-only), planner (plan but don't execute), builder (execute), shipper (execute + deploy)
- The POST `/dream-build` route should enforce that the caller has `builder` or `shipper` trust level

### What Needs to Happen

1. **Check if `checkTrustLevel()` exists** in `src/dream/auth.ts` — understand the function signature
2. **Add trust level to DreamBuildJob** if not already present (may need a `trustLevel` field)
3. **Call `checkTrustLevel()`** in the POST `/dream-build` handler before starting the job
4. **Tests**: Add route tests for trust level enforcement

### Files to Modify

| File | What to change |
|------|---------------|
| `src/routes/dream.ts` | Add trust level check in POST handler |
| `src/dream/auth.ts` | May need adjustment if `checkTrustLevel` needs different params |
| Tests | Route tests for trust enforcement |

### Queue After This Task

| Priority | Task | Effort | Notes |
|----------|------|--------|-------|
| Current | DM.7: Enforce checkTrustLevel() | Low | One-line addition to route |
| Next | DM.8: CI trigger / test execution before PR | Medium | testing callback fires but no actual tests run |
| Then | Phase 5.1: Multi-agent review | High | Route results through reviewer model |

---

## Recently Completed

| Date | Task | AI | Session |
|------|------|----|---------|
| 2026-02-21 | DM.5: Add /dream-build/:jobId/approve endpoint (1001 tests) | Claude Opus 4.6 | session_01NzU1oFRadZHdJJkiKi2sY8 |
| 2026-02-21 | DM.4: Wire real AI code generation into Dream Build (993 tests) | Claude Opus 4.6 | session_01NzU1oFRadZHdJJkiKi2sY8 |
| 2026-02-21 | Audit Phase 2: P2 guardrails — tool result validation + No Fake Success enforcement | Claude Opus 4.6 | session_01NzU1oFRadZHdJJkiKi2sY8 |
| 2026-02-21 | DM.1-DM.3: Dream Machine Build stage + auth + route fix (935 tests) | Claude Opus 4.6 | session_01QETPeWbuAmbGASZr8mqoYm |
| 2026-02-20 | Phase 5.2: MCP integration — Cloudflare Code Mode MCP (38 tests, 872 total) | Claude Opus 4.6 | session_01QETPeWbuAmbGASZr8mqoYm |
| 2026-02-20 | Phase 5.5: Web search tool (Brave Search API, cache, key plumbing, tests) | Codex (GPT-5.2-Codex) | codex-phase-5-5-web-search-001 |
| 2026-02-20 | Phase 4.4: Cross-session context continuity (SessionSummary ring buffer) | Claude Opus 4.6 | session_01SE5WrUuc6LWTmZC8WBXKY4 |
| 2026-02-20 | Phase 4.3: Tool result caching with in-flight dedup | Codex+Claude | session_01SE5WrUuc6LWTmZC8WBXKY4 |
| 2026-02-20 | Phase 4.2: Real tokenizer (gpt-tokenizer cl100k_base) | Claude Opus 4.6 | session_01SE5WrUuc6LWTmZC8WBXKY4 |
| 2026-02-20 | Phase 2.4: Acontext sessions dashboard in admin UI | Codex+Claude | session_01SE5WrUuc6LWTmZC8WBXKY4 |
| 2026-02-20 | Sprint 48h: Phase budget circuit breakers + parallel tools allSettled | Claude Opus 4.6 | session_01AtnWsZSprM6Gjr9vjTm1xp |
