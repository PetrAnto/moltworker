# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-25 (S0 complete, S1 Lyra next)

---

## Current Task: S1 — Lyra (Crex Content Creator)

### Context

S0 Gecko Skills shared runtime is complete. The skill registry, command routing, LLM helper, renderers, and API endpoint are all in place. Phase S1 implements the first real skill — Lyra, a content creation persona with 4 commands.

### Branch

`claude/skill-lyra`

### Key References

- `SKILLS_ROADMAP.md` — Phase S1 spec (T1.1-T1.5)
- `src/skills/types.ts` — `SkillId`, `SkillRequest`, `SkillResult`, `SkillHandler`
- `src/skills/registry.ts` — `registerSkill()` — add Lyra here
- `src/skills/llm.ts` — `callSkillLLM()` for LLM calls
- `src/skills/renderers/telegram.ts` — Add `renderDraft()` etc.
- `src/skills/init.ts` — Register Lyra handler here

### Implementation Order

1. **S1.1** — `src/skills/lyra/types.ts` + `src/skills/lyra/prompts.ts`
2. **S1.2** — `src/skills/lyra/lyra.ts` (handler with 4 submodes)
3. **S1.3** — `src/storage/lyra.ts` (draft persistence in R2)
4. **S1.4** — Register in `src/skills/init.ts` + update renderers
5. **S1.5** — Tests + typecheck

### Commands to Implement

- `/write <topic>` — generate a draft (optional `--for twitter`, `--audience devs`)
- `/rewrite` — revise last draft (optional `--shorter`, `--formal`)
- `/headline <topic>` — generate 5 headline variants with commentary
- `/repurpose <url> --for twitter` — fetch URL, adapt for target platform

### Key Design Notes

- Each submode calls `callSkillLLM()` with JSON response_format
- `/rewrite` loads last draft from R2 (`lyra/{userId}/last-draft.json`)
- `/repurpose` uses `fetch_url` tool to get source content
- Quality < 3 on self-assessment triggers optional revision pass
- All results return `SkillResult` with appropriate `kind`

### Validation

1. `npm test` passes
2. `npm run typecheck` passes
3. `/write`, `/rewrite`, `/headline`, `/repurpose` commands all route through skill runtime
4. Existing commands unaffected (regression check)

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-25 | S0 Gecko Skills shared runtime | Claude Opus 4.6 | 16 new files, 2463 tests. Types, command-map, LLM helper, registry, runtime, tool-policy, renderers, orchestra refactor, handler routing, API route. |
| 2026-03-25 | Gecko Skills roadmap planning | Claude Opus 4.6 | SKILLS_ROADMAP.md created, GLOBAL_ROADMAP.md updated with Sprint 4 (S0-S3 + smoke tests), docs synced |
| 2026-03-23 | F.1b — ai-hub proactive alerts | Claude Opus 4.6 | fetchAiHubAlerts + formatAlertForTelegram, 5-min cron, 2083 tests |
| 2026-03-23 | F.1 — ai-hub data feeds integration | Claude Opus 4.6 | RSS + market in /brief, graceful degradation, 2073 tests |

---

## After S1: Next Phases

1. **S2** — Spark (Tach Brainstorm): `/save`, `/spark`, `/gauntlet`, `/brainstorm` — branch `claude/skill-spark`
2. **S3** — Nexus (Omni Research): `/research`, `/dossier` — branch `claude/skill-nexus` (needs KV decision first)
3. **ST** — E2E Coding Agent Smoke Tests (spec at `claude-share/core/archive/Coding_Agent_Smoke_Tests.md`)
