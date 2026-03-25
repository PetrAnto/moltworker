# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-25 (S0+S1+S2+S3 complete, ST smoke tests next)

---

## Current Task: ST — E2E Coding Agent Smoke Tests

### Context

All 4 Gecko Skills phases (S0 runtime, S1 Lyra, S2 Spark, S3 Nexus) are complete. M4 milestone achieved. The final Sprint 4 task is running end-to-end smoke tests against the coding agent (Orchestra) to validate real-world reliability.

### Key References

- `claude-share/core/archive/Coding_Agent_Smoke_Tests.md` — Full spec
- `SKILLS_ROADMAP.md` — Post-Sprint section (ST.1-ST.3)

### Implementation Order

1. **ST.1** — Create `PetrAnto/moltbot-test-arena` test repo (via `github_api` tool or manual)
2. **ST.2** — Run 5-test battery (scaffold, bug fix, add feature, refactor, multi-file) via `/simulate/chat` or Telegram `/orch`
3. **ST.3** — Score results + recommendations (pass rate, iterations, duration, model failures)

### Also Pending

- **S3.7** — DO extension for Nexus full dossier (deferred, not blocking)

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-25 | S3 Nexus research | Claude Opus 4.6 | /research, /dossier. KV cache, 8 source fetchers, evidence model. 33 new tests (2569 total). |
| 2026-03-25 | S2 Spark brainstorm | Claude Opus 4.6 | /save, /spark, /gauntlet, /brainstorm, /ideas. 31 new tests (2534 total). |
| 2026-03-25 | S1 Lyra content creator | Claude Opus 4.6 | /write, /rewrite, /headline, /repurpose. 30 new tests (2503 total). |
| 2026-03-25 | S0 Gecko Skills runtime + hardening | Claude Opus 4.6 | Runtime foundation + reviewer feedback fixes. 2472 tests. |
