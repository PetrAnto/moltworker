# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-25 (Gecko Skills roadmap — Sprint 4 planning)

---

## Current Task: S0 — Gecko Skills Shared Runtime

### Context

Sprint 4 begins the Gecko Skills system — specialist AI personas (Lyra/Spark/Nexus) with a shared runtime. Phase S0 creates the foundation that all skills depend on. The full spec is in `SKILLS_ROADMAP.md`. The implementation spec (user-provided) defines exact types, interfaces, and file structure.

### Branch

`claude/skills-runtime`

### Key References

- `SKILLS_ROADMAP.md` — Full roadmap with spec-vs-reality gap analysis
- `claude-share/core/GLOBAL_ROADMAP.md` — Sprint 4 section (Phase S0-S3)
- `src/types.ts` — `MoltbotEnv` (binding is `MOLTBOT_BUCKET`, not `R2_BUCKET`)
- `src/openrouter/client.ts` — `OpenRouterClient`, `ChatMessage`, `ChatCompletionRequest`
- `src/openrouter/tools.ts` — Tool definitions, `executeTool()`, `ToolContext`
- `src/openrouter/storage.ts` — `SkillStorage` (existing R2 skill loader)
- `src/orchestra/orchestra.ts` — Current orchestra (single file, needs refactor into `src/skills/orchestra/`)
- `src/telegram/handler.ts` — ~5900 lines, command dispatch logic

### Implementation Order

1. **S0.1** — `src/skills/types.ts` + `src/skills/validators.ts` (pure types, no deps)
2. **S0.2** — `src/skills/command-map.ts` (static map + regex flag parser)
3. **S0.3** — `src/skills/llm.ts` (wrapper around `OpenRouterClient` — the spec's `callLLM()`/`selectModel()` don't exist)
4. **S0.4** — `src/skills/registry.ts` + `src/skills/runtime.ts` (initially only `orchestra` handler)
5. **S0.5** — `src/skills/tool-policy.ts` (per-skill tool allowlists)
6. **S0.6** — `src/skills/renderers/telegram.ts` + `web.ts`
7. **S0.7** — Orchestra refactor: move `src/orchestra/` → `src/skills/orchestra/`, split into `types.ts`, `prompts.ts`, `orchestra.ts`. **HIGH RISK** — update all imports in handler.ts + task-processor.ts
8. **S0.8** — Handler routing: surgical insert in `src/telegram/handler.ts` — early `COMMAND_SKILL_MAP` check
9. **S0.9** — API route: `POST /api/skills/execute` in `src/routes/api.ts`
10. **S0.10** — Tests + typecheck: `npm test && npm run typecheck`

### Critical Gap Reminders

- R2 bucket binding is `env.MOLTBOT_BUCKET` (NOT `env.R2_BUCKET`)
- `callLLM()` / `selectModel()` don't exist — create `src/skills/llm.ts`
- `fetchUrl()` is internal to tools.ts — export or wrap for skill use
- `nanoid` is not a dep — use `crypto.randomUUID()`
- Orchestra is a single file — split carefully, preserve all behavior

### Validation

After completing S0, verify:
1. `npm test` passes
2. `npm run typecheck` passes
3. Existing `/orch` commands still work through new routing
4. `/simulate/command` with `/models` still returns expected output (regression check)

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-25 | Gecko Skills roadmap planning | Claude Opus 4.6 | SKILLS_ROADMAP.md created, GLOBAL_ROADMAP.md updated with Sprint 4 (S0-S3 + smoke tests), docs synced |
| 2026-03-23 | F.1b — ai-hub proactive alerts | Claude Opus 4.6 | fetchAiHubAlerts + formatAlertForTelegram, 5-min cron, 2083 tests |
| 2026-03-23 | F.1 — ai-hub data feeds integration | Claude Opus 4.6 | RSS + market in /brief, graceful degradation, 2073 tests |

---

## After S0: Next Phases

1. **S1** — Lyra (Crex Content Creator): `/write`, `/rewrite`, `/headline`, `/repurpose` — branch `claude/skill-lyra`
2. **S2** — Spark (Tach Brainstorm): `/save`, `/spark`, `/gauntlet`, `/brainstorm` — branch `claude/skill-spark`
3. **S3** — Nexus (Omni Research): `/research`, `/dossier` — branch `claude/skill-nexus` (needs KV decision first)
4. **ST** — E2E Coding Agent Smoke Tests (spec at `claude-share/core/archive/Coding_Agent_Smoke_Tests.md`)
