# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-25 (S0+S1+S2+S3 complete, S3.7 DO extension next)

---

## Current Task: S3.7 — DO Extension for Nexus Full Dossier

### Context

All 4 Gecko Skills phases are complete but `/dossier` currently runs the same quick-mode pipeline inline in the Worker (classify → 2-4 sources → synthesize). S3.7 adds `type: 'skill'` task support to `TaskProcessor` so `/dossier` can run deep research beyond the Worker's 10-second timeout: more sources (6-10), multi-pass synthesis, and a HITL (human-in-the-loop) gate.

### Branch

Continue on current branch or create `claude/nexus-do-extension`

### Key References

- `src/durable-objects/task-processor.ts` — `TaskProcessor` DO (~2000 lines). Key types: `TaskRequest` (line 340), `TaskState`, `processTask()`
- `src/skills/nexus/nexus.ts` — Current Nexus handler (inline quick/decision/full modes)
- `src/skills/nexus/source-packs.ts` — `fetchSources()` for parallel source fetching
- `src/skills/runtime.ts` — `runSkill()` — the skill runtime executor
- `src/telegram/handler.ts` — Where `/dossier` dispatches to DO + callback buttons
- `SKILLS_ROADMAP.md` — S3.7 spec

### Implementation Plan

#### 1. Extend `TaskRequest` with skill task type

```typescript
// In task-processor.ts, add to TaskRequest:
type?: 'orchestra' | 'skill';  // default 'orchestra' for backward compat
skillRequest?: SkillRequest;    // Present when type === 'skill'
```

#### 2. Add skill task branch in `processTask()`

In the main task processing loop, add a branch for `type: 'skill'`:
- Import `runSkill` from `../skills/runtime`
- When `taskRequest.type === 'skill'`, call `runSkill(taskRequest.skillRequest)`
- Use existing DO infrastructure: R2 checkpoints, watchdog alarm, auto-resume
- Send result to Telegram via `sendMessage`
- Tool calls from Nexus source fetchers go through `executeSkillTool` (already policy-enforced)

#### 3. HITL gate for `/dossier` (source plan approval)

In the Nexus handler (`nexus.ts`):
- When mode is `'full'` and transport is `'telegram'`:
  - Classify query → select sources
  - Return a `source_plan` SkillResult with inline keyboard buttons: "Go" / "Cancel"
  - Store pending plan in R2 (`nexus/{userId}/pending-plan-{chatId}.json`)
- In `handler.ts`, add callback handler for `nexus_approve` / `nexus_cancel`:
  - On approve: dispatch to DO with `type: 'skill'`
  - On cancel: delete pending plan, send acknowledgement

#### 4. DO dispatch from handler

```typescript
// In handler.ts, on nexus_approve callback:
const doId = env.TASK_PROCESSOR!.idFromName(`nexus-${userId}-${Date.now()}`);
const stub = env.TASK_PROCESSOR!.get(doId);
const taskRequest: TaskRequest = {
  type: 'skill',
  skillRequest: { ... },
  taskId: crypto.randomUUID(),
  chatId, userId,
  telegramToken: this.telegramToken,
  openrouterKey: this.openrouterKey,
  // ... other keys
};
await stub.fetch('/dispatch', { method: 'POST', body: JSON.stringify(taskRequest) });
```

### Risk Assessment

- **HIGH**: `TaskProcessor` is ~2000 lines, tightly coupled to Orchestra's tool-calling loop. The skill branch must be isolated — no changes to the existing Orchestra code path.
- **MEDIUM**: HITL gate needs callback button handling in handler.ts (~5900 lines) — surgical insertion like S0.8.
- **LOW**: Nexus handler changes are minimal (add DO dispatch path for `full` mode).

### Testing

1. Unit test: `type: 'skill'` task dispatches correctly in TaskProcessor
2. Unit test: HITL gate returns `source_plan` with pending plan stored
3. Unit test: Callback handler dispatches to DO on approve, cleans up on cancel
4. `npm test` passes, `npm run typecheck` passes
5. Existing `/orch` commands unaffected (regression)

### Effort Estimate

2-4 hours. The TaskProcessor integration is the hardest part.

---

## After S3.7

1. **ST** — E2E Coding Agent Smoke Tests (see `claude-share/core/archive/Coding_Agent_Smoke_Tests.md`)
2. **F.6** — Fork to `storia-agent` (private) — when ready for IDE transport
3. **F.7** — Discord full integration

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-25 | S3 Nexus research | Claude Opus 4.6 | /research, /dossier. KV cache, 8 source fetchers, evidence model. 33 new tests (2569 total). |
| 2026-03-25 | S2 Spark brainstorm | Claude Opus 4.6 | /save, /spark, /gauntlet, /brainstorm, /ideas. 31 new tests (2534 total). |
| 2026-03-25 | S1 Lyra content creator | Claude Opus 4.6 | /write, /rewrite, /headline, /repurpose. 30 new tests (2503 total). |
| 2026-03-25 | S0 Gecko Skills runtime + hardening | Claude Opus 4.6 | Runtime foundation + reviewer feedback fixes. 2472 tests. |
