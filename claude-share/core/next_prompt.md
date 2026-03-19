# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-19 (F.14 Fuzzy Patch Fallback + Bracket Balance Pre-Commit — 1861 tests)

---

## Current Task: F.3 — Code Execution Sandbox in Orchestra (Durable Objects)

### Why

Orchestra tasks run in Durable Objects, which currently exclude `sandbox_exec` (the Cloudflare Container tool). This means models can't build, test, or lint their own code before creating PRs — leading to broken PRs, untested code, and wasted iterations.

The Cloudflare Container (`@cloudflare/sandbox`) is already deployed and working for direct chat. Making it available in DOs would let orchestra models self-verify their work.

### Current State

- `sandbox_exec` — works in Worker context (direct Telegram), excluded from DO via `TOOLS_WITHOUT_BROWSER` filter
- `run_code` — wired into DOs via Acontext API, but requires `ACONTEXT_API_KEY` which is not configured
- The DO's `toolContext` has no `sandbox` field

### What to Build

1. Pass a sandbox reference (or sandbox stub ID) into the Durable Object's `TaskRequest`
2. Add `sandbox_exec` to the DO tool set (remove from `TOOLS_WITHOUT_BROWSER` filter or create a new filter)
3. Wire `sandbox` into the DO's `toolContext` so `sandboxExec()` can call `sandbox.startProcess()`
4. Add safety limits for DO context (longer timeouts since tasks are long-running, but cap total sandbox calls)
5. Update orchestra prompts to encourage models to test their code before creating PRs

### Key Files

| File | Change |
|------|--------|
| `src/durable-objects/task-processor.ts` | Add sandbox to toolContext, pass through from TaskRequest |
| `src/openrouter/tools.ts` | Update tool filtering for DO context |
| `src/telegram/handler.ts` | Pass sandbox binding to DO task request |
| `src/orchestra/orchestra.ts` | Add "test your code" step to prompts |

### Challenges

- DOs can't directly hold a `Sandbox` binding — may need to proxy through the Worker or pass a stub
- Sandbox container is `max_instances: 1` — concurrent orchestra tasks could contend
- Need to prevent sandbox abuse (infinite loops, resource exhaustion)

### Definition of Done

- [ ] Orchestra tasks can execute shell commands via `sandbox_exec`
- [ ] Models can run `npm test`, `npm run build`, etc. before creating PRs
- [ ] Safety limits prevent sandbox abuse in DO context
- [ ] All tests pass, typecheck clean

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-19 | F.14 — Fuzzy patch fallback + bracket balance pre-commit | Claude Opus 4.6 | 1861 tests. applyFuzzyPatch (exact→fuzzy line-by-line), checkBracketBalance before blob creation. MiniMax PR #98: cleanest Step 3 across 16+ attempts |
| 2026-03-19 | F.13 — MiniMax M2.7 upgrade + death loop fix | Claude Opus 4.6 | 1848 tests. Escalating stream-split nudges, size guards on workspace_write_file |
| 2026-03-18 | Orchestra gate bypass for proven models (event history) | Claude Opus 4.6 | 1848 tests |
| 2026-03-18 | Prompt dedup fix (WORK_LOG duplicates + code-first ordering) | Claude Opus 4.6 | 1848 tests |
| 2026-03-18 | Fix Proceed button loop + improve unknown model warning | Claude Opus 4.6 | 1848 tests |
| 2026-03-17 | F.12 — Event-based model scoring in /orch advise | Claude Opus 4.6 | 1848 tests |
| 2026-03-17 | F.11 — Orchestra observability (R2 events + /orch stats) | Claude Opus 4.6 | 1840 tests |

---

## Alternative Next Tasks (if above is done or blocked)

1. **F.3 — Code execution sandbox** (above)
2. **F.4 — File management tools** (R2 save/read/list/delete)
3. **F.1 — ai-hub data feeds** — Blocked on ai-hub `/api/situation/*`
4. **F.7** — Discord full integration (read-only → two-way)
5. **6.3** — Voice messages (Whisper + TTS)
