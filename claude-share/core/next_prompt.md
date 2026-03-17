# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-17 (F.10 Kimidirect Reasoning COMPLETE)

---

## Current Task: Orchestra Observability — R2-Persisted Stall/Abort Metrics

### Why

Orchestra stall detection and abort events are currently only logged via `console.log`. These logs are ephemeral (Cloudflare Workers logs rotate quickly). Persisting key orchestra events to R2 enables:
- Post-mortem analysis of failed orchestra runs
- Tracking stall/abort rates per model over time
- Data-driven decisions about which models to recommend for orchestra tasks

### What to Build

1. Define an `OrchestraEvent` type (timestamp, taskId, modelAlias, eventType: 'stall' | 'abort' | 'validation_fail' | 'complete', details)
2. Create a function to append events to an R2 key like `orchestra-events/{YYYY-MM}/{taskId}.json`
3. Wire event logging into task-processor.ts at key points:
   - Stall detection (read-loop stall abort)
   - Deliverable validation failure (FAILED_DELIVERABLE)
   - Task abort/timeout
   - Successful completion
4. Add a `/orch events` or `/orch stats` command to query aggregated metrics

### Key Files

| File | Change |
|------|--------|
| `src/orchestra/orchestra.ts` | Add OrchestraEvent type and R2 persistence functions |
| `src/durable-objects/task-processor.ts` | Wire event logging at stall/abort/complete points |
| `src/telegram/handler.ts` | Add `/orch events` or `/orch stats` command |

### Testing

```bash
npm test -- --reporter=verbose 2>&1 | tail -20
npm run typecheck
```

### Definition of Done

- [ ] OrchestraEvent type defined
- [ ] Events persisted to R2 at stall, abort, validation failure, and completion points
- [ ] `/orch events` or `/orch stats` command shows aggregated metrics
- [ ] All existing tests pass, typecheck clean

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-17 | F.10 — Enable reasoning for kimidirect | Claude Opus 4.6 | 1831 tests |
| 2026-03-17 | Wire completion stats into /orch advise handler | Claude Opus 4.6 | 1829 tests |
| 2026-03-17 | F.9 — Orchestra hardening (validation, ranking, stall detection, /status API) | Claude Opus 4.6 | 2 commits, 1829 tests |
| 2026-03-16 | F.8 — Long-term Memory (fact extraction + injection) | Claude Opus 4.6 | 1826 tests |
| 2026-03-16 | F.5 — Analytics dashboard (API + metrics UI) | Codex+Claude | PRs 343-346, 1800 tests |
| 2026-03-16 | F.2 — Browser CDP (a11y tree, click/fill/scroll, sessions) | Claude Opus 4.6 | PR 342, 14 tests |

---

## Alternative Next Tasks (if above is done or blocked)

1. **Observability** (above) — R2-persisted orchestra event metrics
2. **F.1 — ai-hub data feeds** — Blocked on ai-hub `/api/situation/*`
3. **F.6** — Fork to `storia-agent` (private) — when ready for IDE transport
4. **F.7** — Discord full integration (read-only → two-way)
