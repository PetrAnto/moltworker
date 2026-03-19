# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-19 (F.3 Code Execution Sandbox in Orchestra — 1865 tests)

---

## Current Task: F.4 — File Management Tools (R2 save/read/list/delete)

### Why

Users and orchestra models need to persist and retrieve files beyond GitHub. R2 is already available in the Worker and DO environments. Adding file management tools would let models save intermediate results, share artifacts between tasks, and store user-uploaded files.

### What to Build

1. Add `r2_save`, `r2_read`, `r2_list`, `r2_delete` tools
2. Scope files per user/chat to prevent cross-contamination
3. Add size limits and quotas
4. Wire into both Worker and DO tool contexts
5. Add Telegram commands for file management (`/files list`, `/files get`, etc.)

### Definition of Done

- [ ] Users can save/read/list/delete files via tools and Telegram commands
- [ ] Per-user scoping and size quotas enforced
- [ ] All tests pass, typecheck clean

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-19 | F.3 — Code Execution Sandbox in Orchestra | Claude Opus 4.6 | 1865 tests. sandbox_exec in DO via capability-aware `getToolsForPhase()`, plain-string parse fix, 15-call safety limit, /simulate/sandbox-test endpoint (60s poll), orchestra prompts inject verification step (clone→test→fix→PR) |
| 2026-03-19 | F.14 — Fuzzy patch fallback + bracket balance pre-commit | Claude Opus 4.6 | 1861 tests. applyFuzzyPatch (exact→fuzzy line-by-line), checkBracketBalance before blob creation. MiniMax PR #98: cleanest Step 3 across 16+ attempts |
| 2026-03-19 | F.13 — MiniMax M2.7 upgrade + death loop fix | Claude Opus 4.6 | 1848 tests. Escalating stream-split nudges, size guards on workspace_write_file |
| 2026-03-18 | Orchestra gate bypass for proven models (event history) | Claude Opus 4.6 | 1848 tests |
| 2026-03-18 | Prompt dedup fix (WORK_LOG duplicates + code-first ordering) | Claude Opus 4.6 | 1848 tests |
| 2026-03-18 | Fix Proceed button loop + improve unknown model warning | Claude Opus 4.6 | 1848 tests |
| 2026-03-17 | F.12 — Event-based model scoring in /orch advise | Claude Opus 4.6 | 1848 tests |
| 2026-03-17 | F.11 — Orchestra observability (R2 events + /orch stats) | Claude Opus 4.6 | 1840 tests |

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

1. **F.4 — File management tools** (above)
2. **F.1 — ai-hub data feeds** — Blocked on ai-hub `/api/situation/*`
3. **F.7** — Discord full integration (read-only → two-way)
4. **6.3** — Voice messages (Whisper + TTS)
