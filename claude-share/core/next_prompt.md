# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-29 (ST smoke tests still next; geckolife/pricing spec pack added for future parallel stream)

---

## Current Task: ST — E2E Coding Agent Smoke Tests

### Context

All Gecko Skills phases are complete (S0 runtime, S1 Lyra, S2 Spark, S3 Nexus + S3.7 DO extension). M4 milestone achieved. The final Sprint 4 task is running end-to-end smoke tests against the coding agent (Orchestra) to validate real-world reliability.

### Key References

- `claude-share/core/archive/Coding_Agent_Smoke_Tests.md` — Full spec
- `SKILLS_ROADMAP.md` — Post-Sprint section (ST.1-ST.3)

### Implementation Order

1. **ST.1** — Create `PetrAnto/moltbot-test-arena` test repo (via `github_api` tool or manual)
2. **ST.2** — Run 5-test battery (scaffold, bug fix, add feature, refactor, multi-file) via `/simulate/chat` or Telegram `/orch`
3. **ST.3** — Score results + recommendations (pass rate, iterations, duration, model failures)

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-29 | geckolife+pricing deep spec pack | Codex (GPT-5.3-Codex) | Reviewed all files in `claude-share/core/geckolife+pricing_update/`; created `CLAUDE_CODE_MASTER_SPEC.md`, `CLAUDE_CODE_EXECUTION_ROADMAP.md`, `CLAUDE_CODE_FOLLOWUP_FILES.md`. |
| 2026-03-25 | S3.7 DO extension | Claude Opus 4.6 | Async /dossier dispatch to TaskProcessor DO. 4 new tests (2573 total). |
| 2026-03-25 | S3 Nexus research | Claude Opus 4.6 | /research, /dossier. KV cache, 8 source fetchers, evidence model. 33 new tests (2569 total). |
| 2026-03-25 | S2 Spark brainstorm | Claude Opus 4.6 | /save, /spark, /gauntlet, /brainstorm, /ideas. 31 new tests (2534 total). |
| 2026-03-25 | S1 Lyra content creator | Claude Opus 4.6 | /write, /rewrite, /headline, /repurpose. 30 new tests (2503 total). |
| 2026-03-25 | S0 Gecko Skills runtime + hardening | Claude Opus 4.6 | Runtime foundation + reviewer feedback fixes. 2472 tests. |
