# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-25 (S0+S1 complete, S2 Spark next)

---

## Current Task: S2 — Spark (Tach Brainstorm)

### Context

S0 Gecko Skills shared runtime and S1 Lyra are complete. The skill registry, command routing, LLM helper, tool execution, renderers, and API endpoint are all in place and proven by Lyra's end-to-end flow. Phase S2 implements Spark — a brainstorm and ideas capture persona.

### Branch

`claude/skill-spark`

### Key References

- `SKILLS_ROADMAP.md` — Phase S2 spec (T2.1-T2.6)
- `src/skills/types.ts` — `SkillId`, `SkillRequest`, `SkillResult`
- `src/skills/lyra/lyra.ts` — Reference implementation for a real skill handler
- `src/skills/init.ts` — Register Spark here
- `src/skills/llm.ts` — `callSkillLLM()` for LLM calls
- `src/skills/skill-tools.ts` — `executeSkillTool()` for URL fetching

### Implementation Order

1. **S2.1** — `src/skills/spark/types.ts` + `src/skills/spark/prompts.ts`
2. **S2.2** — `src/storage/spark.ts` (per-item R2 CRUD, `crypto.randomUUID()` for IDs)
3. **S2.3** — `src/skills/spark/capture.ts`, `gauntlet.ts`, `brainstorm.ts`
4. **S2.4** — `src/skills/spark/spark.ts` (handler + submode router)
5. **S2.5** — Register in `src/skills/init.ts`
6. **S2.6** — Tests + typecheck

### Commands to Implement

- `/save <idea>` or `/bookmark` — save an idea/link to inbox
- `/spark <idea>` — quick reaction (short LLM analysis)
- `/gauntlet <idea>` — 6-stage structured gauntlet evaluation
- `/brainstorm` — cluster + challenge all inbox items
- `/ideas` — list inbox items

### Key Design Notes

- R2 key pattern: `spark/{userId}/items/{timestamp}-{id}.json`
- ID generation: `crypto.randomUUID()` (no nanoid dep)
- `/save` with URL: fetch URL metadata for a summary
- `/brainstorm` with no input: cluster all inbox items
- `/brainstorm` with input: list inbox (same as `/ideas`)
- Gauntlet is a single structured LLM call returning 6 stages

### Validation

1. `npm test` passes
2. `npm run typecheck` passes
3. All commands route through skill runtime
4. Existing commands unaffected

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-25 | S1 Lyra content creator | Claude Opus 4.6 | /write, /rewrite, /headline, /repurpose. Self-review, R2 drafts, URL fetch. 30 new tests (2503 total). |
| 2026-03-25 | S0 Gecko Skills shared runtime | Claude Opus 4.6 | 16 new files, types/registry/runtime/renderers/API. 2463 tests. |
| 2026-03-25 | S0 hardening (reviewer feedback) | Claude Opus 4.6 | SkillContext, parser fix, executeSkillTool, API tests, chunking. 2472 tests. |

---

## After S2: Next Phases

1. **S3** — Nexus (Omni Research): `/research`, `/dossier` — branch `claude/skill-nexus` (needs KV decision first)
2. **ST** — E2E Coding Agent Smoke Tests (spec at `claude-share/core/archive/Coding_Agent_Smoke_Tests.md`)
