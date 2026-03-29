# Wave 7 Execution Roadmap (Operational Board)

> Converts the reviewed prompts/specs into an execution board with clear entry/exit criteria, owners, and artifact outputs.
> Date: 2026-03-29

---

## A) Program Board

| Sprint | Repo | Effort | Depends On | Status | Branch Pattern | Owner |
|---|---|---:|---|---|---|---|
| W7-S1 Pricing Rewrite | ai-hub | 13h | -- | **COMPLETE** | merged | Claude Code |
| W7-S2 Feature Gates | ai-hub | 4h | S1 | **COMPLETE** | merged | Claude Code |
| W7-S3 Flywheel Schema | ai-hub | 5h | -- | **COMPLETE** (20 migrations, all tables) | merged | Claude Code |
| W7-S4 Flywheel Logic | ai-hub | 8h | S3 | **SHIPPED** (3/6 proposal types, post-fix #680) | merged | Claude Code |
| W7-S5 Project Backend | ai-hub | 12h | S2 (for limits) | **SHIPPED** (10 endpoints, post-fix #672) | merged | Claude Code |
| W7-S6 Chat Project UI | ai-hub | 6h | S5 | **SHIPPED** (post-fix #683,#685) | merged | Claude Code |
| **W7-CAPA** | **ai-hub** | **~13-16h** | **S1-S6** | **TODO — BLOCKING** | `claude/w7-capa-<id>` | **Claude Code** |
| W7-M1 Lyra Media | moltworker | 11h | -- | TODO | `claude/w7-m1-lyra-media-<id>` | Claude Code |
| W7-M2 Integration Tests | moltworker | 3h | M1 | TODO | `claude/w7-m2-integration-tests-<id>` | Claude Code |
| W7-M3 Deploy Prep | moltworker | 3h | M1+M2 | TODO | `claude/w7-m3-deploy-prep-<id>` | Claude Code |

### Real Status (Updated 2026-03-29 post-audit)

```
Wave 7 ai-hub core:  SHIPPED (S1-S4 + S6 with post-merge fixes)
Sprint 5 collective:  SCAFFOLDED — engine missing, consent broken
CAPA sprint:          TODO — 6 corrective actions blocking "complete"
Moltworker M1-M3:    TODO — not started
```

**WARNING**: PR #686 claimed "WAVE 7 COMPLETE" but this is premature.
See [`W7_CAPA_SPRINT.md`](./W7_CAPA_SPRINT.md) for detailed corrective actions.

**Remaining effort**: ~27-30h (CAPA ~13-16h + M1-M3 ~17h).

---

## B) Prompt Routing (What to Read per Sprint)

| Sprint | Primary Prompt Source | Architecture Anchor |
|---|---|---|
| W7-S1 | `W7-S1-pricing-rewrite.md` | `pricing-model-v3.md` |
| W7-S2 | `W7-S2-to-M3-all-prompts.md` (S2) | `pricing-model-v3.md` |
| W7-S3 | `W7-S2-to-M3-all-prompts.md` (S3) | `gecko-life-knowledge-flywheel-spec-v1.1.md` |
| W7-S4 | `W7-S2-to-M3-all-prompts.md` (S4) | `gecko-life-knowledge-flywheel-spec-v1.1.md` |
| W7-S5 | `W7-S2-to-M3-all-prompts.md` (S5) | `project-architecture-lyra-media-spec-v1.1.md` |
| W7-S6 | `W7-S2-to-M3-all-prompts.md` (S6) | `project-architecture-lyra-media-spec-v1.1.md` |
| W7-M1 | `W7-S2-to-M3-all-prompts.md` (M1) | `project-architecture-lyra-media-spec-v1.1.md` |
| W7-M2 | `W7-S2-to-M3-all-prompts.md` (M2) | -- |
| W7-M3 | `W7-S2-to-M3-all-prompts.md` (M3) | `WAVE7_FOLLOWUP.md` |

---

## C) Gate Checks (Must Pass Before Starting)

### Before W7-S1 — DONE
- [x] Stripe Pro product (EUR 5/month) created
- [x] Deep Mode product archived in Stripe
- [x] Stale Stripe secrets removed (only `STRIPE_PRO_MONTHLY_PRICE_ID` remains)

### Before W7-S3/S4 — PARTIALLY DONE
- [x] Workers AI `env.AI` binding exists + REST fallback (`workers-ai.ts`)
- [x] `storia-knowledge` Vectorize index created (1024 dims, cosine)
- [ ] **`storia-collective` Vectorize index NOT YET CREATED** (blocks CAPA-3)
- [ ] **`/api/test-ai` spike NOT YET RUN on staging** (blocks confidence in env.AI)

### Before W7-S5 — DONE
- [x] Feature-gates (S2) merged with limit enforcement

### Before W7-CAPA (NEW)
- [ ] Create `storia-collective` Vectorize index (manual: PetrAnto)
- [ ] Run `/api/test-ai` spike on staging to confirm env.AI works
- [ ] Confirm PostHog dashboard configured for coaching events

### Before W7-M3 Deploy
- [ ] R2 Lyra media prompts uploaded (`moltbot-data/skills/lyra/image-system.md`, `video-system.md`)
- [ ] KV namespace exists for Nexus cache
- [ ] R2 bucket cleanup confirmed

---

## D) Milestones and Critical Path

| Milestone | Depends On | Outcome | Status |
|---|---|---|---|
| M0: Pricing Pivot Baseline | -- | 2-tier economics + no deep-tier logic | **COMPLETE** |
| M1: Access Control Baseline | M0 | Gates enforce Free vs Pro in UI/API | **COMPLETE** |
| M2: Coaching Engine Baseline | Sprint 0+1+2 | Proposal loop + GeScore v2 active | **SHIPPED** (3/6 proposal types) |
| M3: Flywheel Closed Loop | M2 + Sprint 3+4 | Capture -> reuse -> connection -> brief working | **SHIPPED** (with post-merge fixes) |
| M4: Measurement + Network Effects | M3 + Sprint 5 | Analytics visibility + collective intelligence | **SCAFFOLDED** (engine missing) |
| **M4-CAPA: Corrective Sprint** | **M3** | **Consent fix + collective engine + validation** | **TODO** |

---

## E) Parallelization Map

Safe concurrent lanes (do NOT parallelize within a lane):

- **Lane 1**: W7-S1 -> W7-S2
- **Lane 2**: W7-S3 -> W7-S4
- **Lane 3**: W7-S5 -> W7-S6
- **Lane 4**: W7-M1 -> W7-M2 -> W7-M3

**Merge sequencing**:
1. Merge independent foundational branches first: S1, S3, S5, M1
2. Then dependency branches: S2, S4, S6, M2
3. Finalize M3 after test evidence from M2
4. Run cross-repo regression (pricing + flywheel + lyra)

---

## F) Risk Dashboard

| Risk | Impact | Mitigation | Owner |
|---|---|---|---|
| `env.AI` unavailable in Pages runtime | Blocks Sprint 0 embeddings | Run spike first; REST fallback path | Claude + Human |
| Vectorize index config mismatch | Blocks embeddings/search | Enforce index schema checklist before merge | Human |
| Schema drift (SQL vs Drizzle) | Runtime failures | Treat migration + schema as atomic PR | Claude |
| Deep-tier regression | Billing/logic breakage | Test/grep blocks merge until removed | Claude |
| PII in shared index | Compliance issue | Metadata allowlist tests required | Claude |
| Migration conflicts | Deploy failures | Split migration and rerun from clean baseline | Claude |
| UI modules lag backend features | Broken UX | Lock-state placeholders + phased module rollouts | Claude/Codex |

---

## G) QA Sign-Off Matrix

| Area | Scenario | Expected | Status |
|---|---|---|---|
| Pricing | Free user selects premium model alias | Routed via FreeModelRouter, no 402 | **CONFIRMED** (isPremiumModel removed) |
| Pricing | Pro with BYOK key | Uses VaultClient BYOK provider path | **CONFIRMED** (isProSubscriber gate) |
| Gates | Free vault limit boundary (50) | 403 `limit_reached` + upgrade URL | **CONFIRMED** (getVaultLimit=50) |
| Gates | Free project limit boundary (3) | 403 `project_limit_reached` + upgrade URL | **CONFIRMED** (getProjectLimit=3) |
| Flywheel | Capture prompt appears after quality chat | Prompt shown with gecko voice | **WIRED** (CapturePrompt component exists) |
| Flywheel | Inject knowledge card | Context injected + reuse tracked | **FIXED** (PR #683) |
| Graph | Create edge | Edge exists + connection count visible | **WIRED** (POST/GET/DELETE endpoints exist) |
| Morning Brief | Enabled user opens coaching tab | Cached brief generated or served | **FIXED** (PR #685, 24h cache added) |
| Collective | Opt-in stores real consent | Dedicated consent record, not proxy | **BROKEN** (uses includeSitmon proxy) |
| Collective | Opt-out user | Shared vectors deleted from VECTORIZE_SHARED | **NOT IMPLEMENTED** (engine missing) |
| Collective | No PII in shared metadata | Allowlist-only metadata | **NOT IMPLEMENTED** (no writes yet) |
| Moltworker Lyra | `/image` and `/video` commands | Structured brief output via renderers | **TODO** |

---

## H) Rollback Markers (Required in Each Sprint PR)

- **Database**: Migration IDs and reversal strategy
- **Runtime**: Feature flag or guarded path for newly exposed APIs
- **UI**: Fallback rendering path if new gates/components fail
- **Integrations**: Safe disable path for shared collective index and new media modes

---

## I) Next-Prompt Generator

When a sprint closes, update `next_prompt.md` with:
1. Sprint completed + PR reference
2. Remaining blockers (if any)
3. Exact next sprint prompt filename and branch seed
4. Manual actions required by PetrAnto before coding starts
