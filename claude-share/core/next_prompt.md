# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-25 (S0+S1+S2+S3 complete, S3.7 async DO extension next)

---

## Current Task: S3.7 — Async Durable Object execution for Nexus full dossier

### Goal

Implement the minimum safe version of S3.7: make `/dossier` full mode run asynchronously inside the `TaskProcessor` Durable Object so long research jobs can continue beyond the Worker request timeout.

Today `/dossier` full mode still executes inline and behaves like enhanced quick mode. The repo explicitly notes that HITL gate + DO dispatch were deferred to S3.7.

This task is **not** about redesigning the whole research system. Keep the change surgical.

---

## What already exists

- `src/skills/nexus/nexus.ts`
  - `/dossier` currently routes to `executeResearch(request, 'full')`
  - comment says full mode currently behaves like quick mode and DO/HITL were deferred
- `src/skills/runtime.ts`
  - `runSkill(request: SkillRequest): Promise<SkillResult>` already exists
- `src/skills/types.ts`
  - `SkillRequest`, `SkillResult`, `SkillResultKind` already exist
- `src/durable-objects/task-processor.ts`
  - current DO endpoints are `/process`, `/status`, `/usage`, `/cancel`, `/steer`
  - current `TaskRequest` is built for the orchestra/chat pipeline and has no `type` discriminator yet
- `src/skills/renderers/telegram.ts`
  - skill results can already be rendered for Telegram
  - `source_plan` kind exists, but full HITL UX is optional follow-up, not required for minimum S3.7

---

## Required scope

### 1) Add async skill-task support to `TaskProcessor`

Extend the DO request contract so it can process either:
- the existing chat/orchestra task flow
- a new skill execution flow for long-running skills

Recommended approach:
- use a discriminated union for the DO payload
- preserve backward compatibility for the existing `/process` endpoint

Suggested shape:

```ts
type TaskProcessorRequest =
  | ({
      kind: 'chat';
    } & TaskRequest)
  | {
      kind: 'skill';
      taskId: string;
      chatId: number;
      userId: string;
      telegramToken: string;
      skillRequest: SkillRequest;
      openrouterKey?: string;
      githubToken?: string;
      braveSearchKey?: string;
      dashscopeKey?: string;
      moonshotKey?: string;
      deepseekKey?: string;
      anthropicKey?: string;
      cloudflareApiToken?: string;
    };
```

Do not break the existing orchestra/chat path.

### 2) Add a dedicated skill-processing path inside the DO

Inside TaskProcessor, add a branch for skill tasks that:

- calls `runSkill(skillRequest)`
- stores minimal task state
- sends progress / completion result to Telegram
- uses existing DO lifecycle machinery where practical
- does not interfere with the existing orchestra loop

Recommended implementation:
- add a small dedicated method such as `processSkillTask(...)`
- call it from `fetch('/process')` after inspecting the discriminant
- keep `processTask(...)` for the existing chat/orchestra flow

### 3) Dispatch `/dossier` full mode to the DO

In `src/skills/nexus/nexus.ts`:

- keep `quick` and `decision` inline
- for `full` mode:
  - if `transport !== 'telegram'`, keep inline fallback
  - if `env.TASK_PROCESSOR` is missing, keep inline fallback
  - if Telegram + TASK_PROCESSOR available:
    - build a `SkillRequest` for Nexus full mode
    - dispatch it to the DO
    - immediately return a lightweight `SkillResult` telling the user that research has started and the result will arrive asynchronously in chat

Use the existing `/process` endpoint unless there is a compelling reason to add a new one. Do not invent `/dispatch` unless you also update the DO fetch router and tests accordingly.

### 4) Render async skill completion back to Telegram

When the DO finishes the skill:

- render the returned `SkillResult` with the existing Telegram skill renderer
- send all chunks to Telegram
- mark the DO task as completed
- ensure failures also notify the user cleanly

### 5) Tests

Add focused tests for:

- DO request discrimination: existing chat/orchestra path still works
- new `kind: 'skill'` path calls `runSkill`
- `/dossier` full mode dispatches to DO when Telegram + TASK_PROCESSOR are available
- `/dossier` full mode falls back inline when DO binding is unavailable
- Telegram async completion sends rendered skill output
- typecheck passes

---

## Explicitly out of scope for this task

Unless everything above is complete and low-risk, do **not** add these now:

- full HITL approval flow with callback buttons
- multi-pass adaptive research planner
- sequential query refinement loop
- generic async execution for all skills
- new storage model for Nexus beyond what is necessary for dispatch/completion

Those can be follow-up tasks after minimum S3.7 lands safely.

---

## Constraints

- Reuse `runSkill()` rather than duplicating skill runtime logic
- Preserve existing orchestra behavior exactly
- Do not refactor large sections of TaskProcessor unless required
- Prefer a small isolated skill path over mixing skill logic into the orchestra loop
- Keep backward compatibility for current `/process` callers
- Use graceful fallback when `env.TASK_PROCESSOR` is absent
- No new runtime dependencies

---

## Files most likely to change

- `src/durable-objects/task-processor.ts`
- `src/skills/nexus/nexus.ts`
- possibly `src/types.ts` if env/type wiring needs extension
- tests covering DO + Nexus dispatch

Optional only if truly needed:
- `src/telegram/handler.ts`
- `src/skills/renderers/telegram.ts`

---

## Acceptance criteria

S3.7 is complete when all of the following are true:

1. `/dossier <topic>` in full mode can dispatch asynchronously to TaskProcessor
2. the Worker request returns quickly with an "in progress" message
3. the final dossier arrives later in Telegram from the DO
4. quick and decision modes still work inline
5. existing orchestra/chat behavior is unchanged
6. `npm test` passes
7. `npm run typecheck` passes

---

## Nice-to-have only if trivial

If the minimum async path is complete and stable, optionally:

- return a `source_plan` result before dispatch for full mode
- store a pending full-research request for later approval flow

But do **not** block S3.7 on HITL.

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-25 | S3 Nexus research | Claude Opus 4.6 | /research, /dossier. KV cache, 8 source fetchers, evidence model. 33 new tests (2569 total). |
| 2026-03-25 | S2 Spark brainstorm | Claude Opus 4.6 | /save, /spark, /gauntlet, /brainstorm, /ideas. 31 new tests (2534 total). |
| 2026-03-25 | S1 Lyra content creator | Claude Opus 4.6 | /write, /rewrite, /headline, /repurpose. 30 new tests (2503 total). |
| 2026-03-25 | S0 Gecko Skills runtime + hardening | Claude Opus 4.6 | Runtime foundation + reviewer feedback fixes. 2472 tests. |

---

## After S3.7

1. **ST** — E2E Coding Agent Smoke Tests (see `claude-share/core/archive/Coding_Agent_Smoke_Tests.md`)
2. **F.6** — Fork to `storia-agent` (private) — when ready for IDE transport
3. **F.7** — Discord full integration
