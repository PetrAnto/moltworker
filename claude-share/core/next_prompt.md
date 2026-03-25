# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-25 (S0+S1+S2 complete, S3 Nexus next)

---

## Current Task: S3 — Nexus (Omni Research)

### Context

S0 runtime, S1 Lyra, and S2 Spark are complete. The skill system is proven with two full end-to-end skills. Phase S3 implements Nexus — a research persona with source fetching, caching, and HITL (human-in-the-loop) gates.

**Important decision needed:** KV vs R2 for Nexus cache (S3.1). See SKILLS_ROADMAP.md.

### Branch

`claude/skill-nexus`

### Key References

- `SKILLS_ROADMAP.md` — Phase S3 spec (T3.1-T3.10)
- `src/skills/lyra/lyra.ts` + `src/skills/spark/spark.ts` — Reference skill implementations
- `src/skills/skill-tools.ts` — `executeSkillTool()` for source fetching
- `src/skills/llm.ts` — `callSkillLLM()` for LLM calls

### Implementation Order

1. **S3.1** — Resolve KV binding (add to wrangler.toml + MoltbotEnv, OR R2 TTL wrapper)
2. **S3.2** — Types + prompts
3. **S3.3** — Source packs (10 fetchers) — HIGH EFFORT
4. **S3.4** — Cache (4h TTL)
5. **S3.5** — Evidence model
6. **S3.6** — Nexus handler (full/quick/decision modes)
7. **S3.7** — DO extension (type: 'skill' in task-processor)
8. **S3.8** — Storage
9. **S3.9** — Register + render
10. **S3.10** — Tests + typecheck

### Commands to Implement

- `/research <topic>` — quick mode (top 3 sources, parallel fetch, synthesize)
- `/research <topic> --quick` — explicit quick mode
- `/research <topic> --decision` — decision mode (pros/cons/risks)
- `/dossier <entity>` — full mode (HITL gate → source plan → approve → DO dispatch)

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-25 | S2 Spark brainstorm | Claude Opus 4.6 | /save, /spark, /gauntlet, /brainstorm, /ideas. 31 new tests (2534 total). |
| 2026-03-25 | S1 Lyra content creator | Claude Opus 4.6 | /write, /rewrite, /headline, /repurpose. 30 new tests (2503 total). |
| 2026-03-25 | S0 Gecko Skills runtime + hardening | Claude Opus 4.6 | Runtime foundation + reviewer feedback fixes. 2472 tests. |

---

## After S3: Next

1. **ST** — E2E Coding Agent Smoke Tests (spec at `claude-share/core/archive/Coding_Agent_Smoke_Tests.md`)
