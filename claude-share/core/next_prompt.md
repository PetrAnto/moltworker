# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-02-18 (P0 guardrails complete; next is P1 guardrails or Phase 3.3)

---

## Current Task: P1 Guardrails — Encoding Validation + REDO Mode Tracking

> Note: P0 guardrails (INCOMPLETE REFACTOR block, FALSE COMPLETION, DATA FABRICATION) are done. P1 items are next before resuming feature roadmap.

### Goal

Two P1 guardrail improvements from `docs/task-processor-spec.md` Section 13.3:

1. **Encoding validation** — Add a UTF-8 validation pass in `githubCreatePr()` (in `src/openrouter/tools.ts`) before blob creation (~line 1220). Use `TextEncoder`/`TextDecoder` round-trip to detect invalid bytes. For each file in `changes`:
   - Encode `change.content` with `new TextEncoder().encode(content)`
   - Decode back with `new TextDecoder('utf-8', { fatal: false })`
   - If round-trip differs from original, either sanitize (replace bad bytes with `\uFFFD`) and warn, or hard block
   - This prevents mojibake in markdown files (observed in bot/add-tax-guide-jurisdictions-q3coder)

2. **Fix REDO mode tracking** — At `src/durable-objects/task-processor.ts:1527`, the `isOrchestra` check is:
   ```typescript
   const isOrchestra = systemContent.includes('Orchestra INIT Mode') || systemContent.includes('Orchestra RUN Mode');
   ```
   It's missing `'Orchestra REDO Mode'`. Add it. Note: line 1446 (`isOrchestraTask`) already includes REDO — only line 1527 is broken. This means REDO tasks don't get tracked in orchestra history (no learning extraction, no status recording).

### Context

- Encoding corruption was observed in bot/add-tax-guide-jurisdictions-q3coder branch — emojis/em-dashes became mojibake
- REDO mode is triggered when orchestra retries a failed task — needs tracking for audit trail
- See `docs/task-processor-spec.md` Sections 12, 13 for full gap analysis
- P0 guardrails (INCOMPLETE REFACTOR hard block, FALSE COMPLETION, DATA FABRICATION) were completed in the prior session
- `CLAUDE.md` has project rules (auto-read by Claude Code)
- After completing, follow `claude-share/core/SYNC_CHECKLIST.md` to update all docs

### Files to Modify

| File | What to change | Where |
|------|---------------|-------|
| `src/openrouter/tools.ts` | Add UTF-8 validation in `githubCreatePr()` before blob creation | ~line 1220 (before `for (const change of changes)` loop that creates blobs) |
| `src/durable-objects/task-processor.ts` | Add `'Orchestra REDO Mode'` to `isOrchestra` on line 1527 | Line 1527 only (line 1446 is already correct) |
| `src/openrouter/tools.test.ts` | Add test: file with invalid UTF-8 gets sanitized or blocked | New test in `github_create_pr tool` describe block |
| `src/durable-objects/task-processor.test.ts` | Add test: REDO mode detected as orchestra task | New test in existing test suite |

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
