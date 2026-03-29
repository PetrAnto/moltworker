# Wave 7 Execution Roadmap v2 (Comprehensive + Follow-up Ready)

This roadmap converts the reviewed prompts/specs into an execution board with clear entry/exit criteria, owners, and artifact outputs.

## A) Milestone Board

| ID | Sprint | Repo | Effort | Depends On | Output Artifacts | Status |
|---|---|---|---:|---|---|---|
| W7-S1 | Pricing Rewrite | ai-hub | 13h | — | pricing, subscription, stripe, webhook, pricing UI | READY |
| W7-S2 | Feature Gates | ai-hub | 4h | W7-S1 | `feature-gates.ts`, `useFeatureGate.ts`, gate tests | READY |
| W7-S3 | Flywheel Schema | ai-hub | 5h | W7-S1 (merged tier model) | D1 migrations + Drizzle/Zod flywheel schemas | READY |
| W7-S4 | Flywheel Logic | ai-hub | 8h | W7-S3 | quality gate + GeScore + templates + capture hooks | READY |
| W7-S5 | Project Backend | ai-hub | 12h | W7-S2 (for limit enforcement) | projects schema, APIs, store, tests | READY |
| W7-S6 | Chat-only Project UI | ai-hub | 6h | W7-S5 | selector + context cards + save action | READY |
| W7-M1 | Lyra Media | moltworker | 11h | — | new skill result kinds + prompts + renderers + tests | READY |
| W7-M2 | Integration Tests | moltworker | 3h | W7-M1 | `/simulate` coverage for media flows | READY |
| W7-M3 | Deploy Prep | moltworker | 3h | W7-M1 + W7-M2 | deployment checklist + docs closure | READY |

## B) Gate Checks (Must Pass)

### Before W7-S1
- Stripe €5/month Pro product exists (manual).
- Deep mode product archived.

### Before W7-S3/S4
- Workers AI env binding validated or REST fallback selected.
- Vectorize index provisioned.

### Before W7-S5
- Feature-gates merged (or project limit gate staged via TODO + tracked issue).

### Before W7-M3 deploy
- R2 prompts uploaded for Lyra media.
- KV namespace exists.
- R2 cleanup confirmed.

## C) Branch + Prompt Routing

| Sprint | Branch Pattern | Prompt Source |
|---|---|---|
| W7-S1 | `claude/w7-s1-pricing-rewrite-<id>` | `W7-S1-pricing-rewrite.md` |
| W7-S2 | `claude/w7-s2-feature-gates-<id>` | `W7-S2-to-M3-all-prompts.md` |
| W7-S3 | `claude/w7-s3-flywheel-schema-<id>` | `W7-S2-to-M3-all-prompts.md` |
| W7-S4 | `claude/w7-s4-flywheel-logic-<id>` | `W7-S2-to-M3-all-prompts.md` |
| W7-S5 | `claude/w7-s5-project-backend-<id>` | `W7-S2-to-M3-all-prompts.md` |
| W7-S6 | `claude/w7-s6-chat-project-ui-<id>` | `W7-S2-to-M3-all-prompts.md` |
| W7-M1 | `claude/w7-m1-lyra-media-<id>` | `W7-S2-to-M3-all-prompts.md` |
| W7-M2 | `claude/w7-m2-integration-tests-<id>` | `W7-S2-to-M3-all-prompts.md` |
| W7-M3 | `claude/w7-m3-deploy-prep-<id>` | `W7-S2-to-M3-all-prompts.md` |

## D) Follow-up Artifact Checklist Per Sprint

For each completed sprint, update:
- `claude-share/core/codex-log.md`
- `claude-share/core/GLOBAL_ROADMAP.md`
- `claude-share/core/WORK_STATUS.md`
- `claude-share/core/next_prompt.md`
- `claude-share/core/geckolife+pricing_update/WAVE7_FOLLOWUP.md`

## E) Fast Risk Dashboard

| Risk | Trigger | Response |
|---|---|---|
| Workers AI fails in target runtime | `env.AI.run` error | switch provider adapter to REST mode, continue sprint |
| Migration conflict | drizzle generate/apply fails | split migration and rerun from clean baseline |
| Deep-tier regression | test or grep finds `deep` | block merge until removed |
| PII in shared index | metadata includes content/title/user | fail test + strip metadata to allowlist |

## F) Next-Prompt Generator

When a sprint closes, `next_prompt.md` should include:
1. Sprint completed + PR reference
2. Remaining blockers (if any)
3. Exact next sprint prompt filename and branch seed
4. Manual actions required by PetrAnto before coding starts

