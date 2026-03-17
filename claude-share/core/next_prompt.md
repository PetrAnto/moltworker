# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-17 (Completion stats wiring COMPLETE)

---

## Current Task: Enable Reasoning for Kimi Direct API

### Why

Orchestra tasks fail more often with `kimidirect` (Moonshot direct API) than with `minimax` (OpenRouter). Root cause analysis found the key difference is that MiniMax has `reasoning: 'fixed'` (mandatory chain-of-thought), which helps with complex multi-step orchestration. Kimidirect has no reasoning enabled, so it doesn't benefit from thinking before acting.

Moonshot's Kimi K2.5 API supports reasoning mode — the bot already has `ensureMoonshotReasoning()` to inject `reasoning_content` placeholders. Adding `reasoning: 'configurable'` (or `'fixed'` if the API requires it) to the kimidirect model definition should improve orchestra success rates.

### What to Build

1. In `src/openrouter/models.ts`, find the `kimidirect` model definition (~line 659)
2. Add `reasoning: 'configurable'` (or `'fixed'` if Moonshot API requires reasoning to always be on)
3. Verify that `getReasoningParam('kimidirect', 'medium')` returns the correct parameter
4. Test with `/simulate/chat` using kimidirect to verify the Moonshot API accepts the reasoning parameter without errors

### Key Files

| File | Change |
|------|--------|
| `src/openrouter/models.ts` | Add `reasoning` field to kimidirect definition |

### Testing

```bash
npm test -- --reporter=verbose 2>&1 | tail -20
npm run typecheck
```

After deployment, test with:
```bash
curl -X POST https://moltbot-sandbox.petrantonft.workers.dev/simulate/chat \
  -H "Authorization: Bearer $DEBUG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "What is 2+2?", "model": "kimidirect", "timeout": 30000}'
```

### Definition of Done

- [ ] kimidirect model has reasoning enabled
- [ ] `getReasoningParam('kimidirect')` returns correct value
- [ ] All existing tests pass, typecheck clean
- [ ] `/simulate/chat` with kimidirect doesn't return API errors

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-17 | Wire completion stats into /orch advise handler | Claude Opus 4.6 | 1829 tests |
| 2026-03-17 | F.9 — Orchestra hardening (validation, ranking, stall detection, /status API) | Claude Opus 4.6 | 2 commits, 1829 tests |
| 2026-03-16 | F.8 — Long-term Memory (fact extraction + injection) | Claude Opus 4.6 | 1826 tests |
| 2026-03-16 | F.5 — Analytics dashboard (API + metrics UI) | Codex+Claude | PRs 343-346, 1800 tests |
| 2026-03-16 | F.2 — Browser CDP (a11y tree, click/fill/scroll, sessions) | Claude Opus 4.6 | PR 342, 14 tests |

---

## Alternative Next Tasks (if above is done or blocked)

1. **Enable reasoning for kimidirect** (above) — 15 min
2. **Observability** — Add R2-persisted metrics for orchestra stall/abort events (currently only console.log)
3. **F.1 — ai-hub data feeds** — Blocked on ai-hub `/api/situation/*`
4. **F.6** — Fork to `storia-agent` (private) — when ready for IDE transport
5. **F.7** — Discord full integration (read-only → two-way)
