# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-17 (F.9 Orchestra Hardening COMPLETE)

---

## Current Task: Wire Historical Completion Stats into /orch advise Handler

### Why

F.9 added `getModelCompletionStats()` and `loadAllOrchestraHistories()` to `orchestra.ts`, and `getRankedOrchestraModels()` now accepts `completionStats`. But the actual `/orch advise` handler in `handler.ts` doesn't yet load the histories and pass them through.

### What to Build

1. In `handler.ts`, find where `getOrchestraRecommendations()` is called for `/orch advise`
2. Load all orchestra histories via `loadAllOrchestraHistories(r2)`
3. Compute stats via `getModelCompletionStats(histories)`
4. Pass stats to `getOrchestraRecommendations(stats)` → `getRankedOrchestraModels({ completionStats: stats })`
5. Ensure the `/orch advise` output includes the historical rate (already shown as `N% hist(M)` highlight when total >= 3)

### Key Files

| File | Change |
|------|--------|
| `src/telegram/handler.ts` | Wire loadAllOrchestraHistories + getModelCompletionStats into /orch advise handler |
| `src/orchestra/orchestra.ts` | Already has `getModelCompletionStats()`, `loadAllOrchestraHistories()` — no changes needed |
| `src/openrouter/models.ts` | Already accepts `completionStats` — no changes needed |

### Testing

```bash
npm test -- --reporter=verbose 2>&1 | tail -20
npm run typecheck
```

Test with `/simulate/command` using `/orch advise` after deployment.

### Definition of Done

- [ ] `/orch advise` loads R2 histories and passes completion stats to ranking
- [ ] Models with 3+ tasks show their historical completion % in output
- [ ] All existing tests pass, typecheck clean

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-17 | F.9 — Orchestra hardening (validation, ranking, stall detection, /status API) | Claude Opus 4.6 | 2 commits, 1829 tests |
| 2026-03-16 | F.8 — Long-term Memory (fact extraction + injection) | Claude Opus 4.6 | 1826 tests |
| 2026-03-16 | F.5 — Analytics dashboard (API + metrics UI) | Codex+Claude | PRs 343-346, 1800 tests |
| 2026-03-16 | F.2 — Browser CDP (a11y tree, click/fill/scroll, sessions) | Claude Opus 4.6 | PR 342, 14 tests |

---

## Alternative Next Tasks (if above is done or blocked)

1. **Wire completion stats** (above) — 30 min
2. **Enable reasoning for kimidirect** — Add `reasoning: 'fixed'` or `'configurable'` to kimidirect model definition in models.ts. Test with `/simulate/chat` to verify Moonshot API accepts the reasoning parameter.
3. **F.1 — ai-hub data feeds** — Blocked on ai-hub `/api/situation/*`
4. **Observability** — Add R2-persisted metrics for orchestra stall/abort events (currently only console.log)
