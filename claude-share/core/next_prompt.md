# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-31 (SEC-P1 fixes complete. ST smoke tests + P2 items next)

---

## Current Task: ST — E2E Coding Agent Smoke Tests

### Context

All Gecko Skills phases are complete (S0 runtime, S1 Lyra, S2 Spark, S3 Nexus + S3.7 DO extension). M4 milestone achieved. The final Sprint 4 task is running end-to-end smoke tests against the coding agent (Orchestra) to validate real-world reliability.

### Key References

- `claude-share/core/archive/Coding_Agent_Smoke_Tests.md` — Full spec
- `SKILLS_ROADMAP.md` — Post-Sprint section (ST.1-ST.3)
- `claude-share/core/geckolife+pricing_update/W7_CANONICAL_SPEC.md` — Canonical Wave 7 execution baseline (for parallel stream)
- `claude-share/core/geckolife+pricing_update/W7_CONNECTION_LINKS.md` — Spec-to-code mapping
- `claude-share/core/geckolife+pricing_update/W7_EXECUTION_ROADMAP.md` — Program board + follow-ups

### Implementation Order

1. **ST.1** — Create `PetrAnto/moltbot-test-arena` test repo (via `github_api` tool or manual)
2. **ST.2** — Run 5-test battery (scaffold, bug fix, add feature, refactor, multi-file) via `/simulate/chat` or Telegram `/orch`
3. **ST.3** — Score results + recommendations (pass rate, iterations, duration, model failures)

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-31 | SEC-P1 fixes (transient classifier + abort checkpoint) | Claude Opus 4.6 | isTransientApiError/isPermanentApiError, auto-rotation on 502/503/504, fail-fast on auth errors, stream abort checkpoint. 2732 tests. |
| 2026-03-31 | Upstream sync from cloudflare/moltworker | Claude Opus 4.6 | Cherry-picked 157 upstream commits: persistence, gateway reliability, cron wake, Dockerfile upgrades. PRs #456+#457 merged. 2717 tests. |
| 2026-03-30 | Security audit + upstream triage | Claude Opus 4.6 | React2Shell clean. 8 npm vulns fixed (hono 4.12.9). Upstream: 2 P1 items (api_error failover, tool-call abort). |
| 2026-03-29 | Wave 7 canonical spec pack | Claude Opus 4.6 | Cherry-picked best from Codex PRs #443-#446. Created `W7_CANONICAL_SPEC.md`, `W7_CONNECTION_LINKS.md`, `W7_EXECUTION_ROADMAP.md`, `W7_FOLLOWUP_AND_GOVERNANCE.md`. |
| 2026-03-25 | S3.7 DO extension | Claude Opus 4.6 | Async /dossier dispatch to TaskProcessor DO. 4 new tests (2573 total). |
| 2026-03-25 | S3 Nexus research | Claude Opus 4.6 | /research, /dossier. KV cache, 8 source fetchers, evidence model. 33 new tests (2569 total). |
| 2026-03-25 | S2 Spark brainstorm | Claude Opus 4.6 | /save, /spark, /gauntlet, /brainstorm, /ideas. 31 new tests (2534 total). |
| 2026-03-25 | S1 Lyra content creator | Claude Opus 4.6 | /write, /rewrite, /headline, /repurpose. 30 new tests (2503 total). |
| 2026-03-25 | S0 Gecko Skills runtime + hardening | Claude Opus 4.6 | Runtime foundation + reviewer feedback fixes. 2472 tests. |

---

## Deferred / Monitor Items

> **Check these at the start of each session.** They require an external trigger before work can start.

| ID | Item | Trigger Condition | Action When Triggered |
|----|------|-------------------|-----------------------|
| MON-1 | Workers AI image provider | FLUX.2 stable on Workers AI | Add `ai` binding, design provider abstraction, cost optimization |
| MON-2 | SecretRef auth for BYOK vault | BYOK vault ported to moltworker | Ensure unresolved keys fail closed (403) |
| MON-3 | Separate R2 backup bucket | Sprint planning / cleanup | Split `BACKUP_BUCKET` to dedicated bucket, migrate keys |

**Full details:** `claude-share/upstream-sync/openclaw-triage-2026-Q1.md`
