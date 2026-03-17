# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-17 (F.11 Orchestra Observability COMPLETE)

---

## Current Task: Feed Orchestra Events into /orch advise Model Rankings

### Why

F.11 added R2-persisted orchestra events (stall_abort, task_abort, validation_fail, task_complete, deliverable_retry). The `/orch advise` command already uses Bayesian-smoothed historical completion rates from `getModelCompletionStats()`. But these stats come from `OrchestraHistory` (per-user task records), which only tracks final status.

The new `OrchestraEvent` data is richer — it distinguishes stalls from aborts from validation failures. Feeding event-level stats into the model ranking would give more nuanced recommendations (e.g. penalize models that stall frequently even if they eventually complete on retry).

### What to Build

1. In `orchestra.ts`, add a function like `getEventBasedModelScores(events: OrchestraEvent[])` that computes per-model reliability scores from events
2. In `handler.ts` `/orch advise`, load events via `getRecentOrchestraEvents()` and pass scores to ranking
3. Display event-based insights alongside existing historical rates in the advise output

### Key Files

| File | Change |
|------|--------|
| `src/orchestra/orchestra.ts` | New scoring function from events |
| `src/telegram/handler.ts` | Wire into /orch advise |

### Definition of Done

- [ ] /orch advise shows event-based model reliability alongside existing stats
- [ ] Models with frequent stalls are penalized in recommendations
- [ ] All tests pass, typecheck clean

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-17 | F.11 — Orchestra observability (R2 events + /orch stats) | Claude Opus 4.6 | 1840 tests |
| 2026-03-17 | F.10 — Enable reasoning for kimidirect | Claude Opus 4.6 | 1831 tests |
| 2026-03-17 | Wire completion stats into /orch advise handler | Claude Opus 4.6 | 1829 tests |
| 2026-03-17 | F.9 — Orchestra hardening (validation, ranking, stall detection) | Claude Opus 4.6 | 1829 tests |
| 2026-03-16 | F.8 — Long-term Memory (fact extraction + injection) | Claude Opus 4.6 | 1826 tests |
| 2026-03-16 | F.5 — Analytics dashboard (API + metrics UI) | Codex+Claude | PRs 343-346 |

---

## Alternative Next Tasks (if above is done or blocked)

1. **Event-based model scoring** (above) — enrich /orch advise with event data
2. **F.1 — ai-hub data feeds** — Blocked on ai-hub `/api/situation/*`
3. **F.6** — Fork to `storia-agent` (private) — when ready for IDE transport
4. **F.7** — Discord full integration (read-only → two-way)
5. **Event cleanup cron** — 30-90 day expiration for old orchestra-events/ files
