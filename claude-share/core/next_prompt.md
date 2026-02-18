# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-02-18 (P0 guardrails complete; next is P1 guardrails or Phase 3.3)

---

## Current Task: P1 Guardrails — Encoding Validation + REDO Mode Tracking

> Note: P0 guardrails (INCOMPLETE REFACTOR block, FALSE COMPLETION, DATA FABRICATION) are done. P1 items are next before resuming feature roadmap.

### Goal

Two P1 guardrail improvements from `docs/task-processor-spec.md` Section 13.3:

1. **Encoding validation** — Run a UTF-8 validation pass on all file contents before submitting to GitHub API. Replace or flag invalid byte sequences. This prevents mojibake in markdown files (observed in 1/6 rejected PRs).

2. **Fix REDO mode tracking** — Add `"Orchestra REDO Mode"` to the `isOrchestra` detection in `task-processor.ts`. Currently only `"Orchestra"` is matched, so REDO tasks lack audit trail.

### Context

- Encoding corruption was observed in bot/add-tax-guide-jurisdictions-q3coder branch
- REDO mode is triggered when orchestra retries a failed task — needs tracking for audit trail
- See `docs/task-processor-spec.md` Section 13.2 for structural gaps

### Files to Modify

| File | What to change |
|------|---------------|
| `src/openrouter/tools.ts` | Add UTF-8 validation in `githubCreatePr()` before blob creation |
| `src/durable-objects/task-processor.ts` | Add `"Orchestra REDO Mode"` to isOrchestra detection |
| Tests | Add tests for encoding validation and REDO detection |

### Queue After This Task

| Priority | Task | Effort | Notes |
|----------|------|--------|-------|
| Current | P1 guardrails: encoding validation + REDO tracking | Low | Prevents mojibake + audit gap |
| Next | 3.3: /learnings Telegram command | Medium | View past patterns and success rates |
| Then | 2.3: Acontext integration | Medium | API key now configured, unblocked |
| Then | 2.5.9: Holiday awareness (Nager.Date) | Low | Adjust briefing tone on holidays |
| Then | 4.1: Replace compressContext with token-budgeted retrieval | Medium | Depends on 2.3 |

---

## Recently Completed

| Date | Task | AI | Session |
|------|------|----|---------|
| 2026-02-18 | P0 guardrails: INCOMPLETE REFACTOR block, FALSE COMPLETION, DATA FABRICATION | Claude Opus 4.6 | 016ahHSwZCrJf5r2TJfwGbnB |
| 2026-02-18 | TaskProcessor infra: loop detection, watchdog, content filter, fetch_url, spec doc | Claude Opus 4.6 | 016ahHSwZCrJf5r2TJfwGbnB |
| 2026-02-11 | Phase 3.2: Structured task phases (Plan → Work → Review) | Claude Opus 4.6 | 019jH8X9pJabGwP2untYhuYE |
| 2026-02-11 | UX fixes: /start redesign, bot menu, briefing location, news links, crypto fix, Acontext key | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-10 | Fix auto-resume counter + revert GLM free tool flag | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-10 | 6 bot improvements: GLM tools, 402 handling, cross-task ctx, time cap, tool-intent, parallel prompt | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-10 | Phase 3.1+3.4: Compound learning loop + prompt injection | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-09 | Phase 1.5: Structured output support (json: prefix) | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
| 2026-02-09 | Phase 1.4: Vision + tools unified + /help update | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
| 2026-02-08 | Phase 2.5.6+2.5.8: Crypto + Geolocation tools | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
