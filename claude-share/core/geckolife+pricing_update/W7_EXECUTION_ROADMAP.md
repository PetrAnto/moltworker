# Wave 7 Execution Roadmap (Operational Board)

> Converts the reviewed prompts/specs into an execution board with clear entry/exit criteria, owners, and artifact outputs.
> Date: 2026-03-29

---

## A) Program Board

| Sprint | Repo | Effort | Depends On | Status | Branch Pattern | Owner |
|---|---|---:|---|---|---|---|
| W7-S1 Pricing Rewrite | ai-hub | 13h | -- | TODO | `claude/w7-s1-pricing-rewrite-<id>` | Claude Code |
| W7-S2 Feature Gates | ai-hub | 4h | S1 | TODO | `claude/w7-s2-feature-gates-<id>` | Claude Code |
| W7-S3 Flywheel Schema | ai-hub | 5h | -- | TODO | `claude/w7-s3-flywheel-schema-<id>` | Claude Code |
| W7-S4 Flywheel Logic | ai-hub | 8h | S3 | TODO | `claude/w7-s4-flywheel-logic-<id>` | Claude Code |
| W7-S5 Project Backend | ai-hub | 12h | S2 (for limits) | TODO | `claude/w7-s5-project-backend-<id>` | Claude Code |
| W7-S6 Chat Project UI | ai-hub | 6h | S5 | TODO | `claude/w7-s6-chat-project-ui-<id>` | Claude Code |
| W7-M1 Lyra Media | moltworker | 11h | -- | TODO | `claude/w7-m1-lyra-media-<id>` | Claude Code |
| W7-M2 Integration Tests | moltworker | 3h | M1 | TODO | `claude/w7-m2-integration-tests-<id>` | Claude Code |
| W7-M3 Deploy Prep | moltworker | 3h | M1+M2 | TODO | `claude/w7-m3-deploy-prep-<id>` | Claude Code |

**Total estimated effort**: ~65h across 9 sprints.

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

### Before W7-S1
- [ ] Stripe Pro product (EUR 5/month) created (manual: PetrAnto)
- [ ] Deep Mode product archived in Stripe (manual: PetrAnto)
- [ ] Stale Stripe secrets removed (`DEEP_MODE`, `PRO_YEARLY`, `TEAM_MONTHLY`)

### Before W7-S3/S4
- [ ] Workers AI env binding validated OR REST fallback selected (Sprint 0 spike)
- [ ] Vectorize index provisioned (manual: PetrAnto)

### Before W7-S5
- [ ] Feature-gates (S2) merged, or project limit gate staged via TODO + tracked issue

### Before W7-M3 Deploy
- [ ] R2 Lyra media prompts uploaded (`moltbot-data/skills/lyra/image-system.md`, `video-system.md`)
- [ ] KV namespace exists for Nexus cache
- [ ] R2 bucket cleanup confirmed

---

## D) Milestones and Critical Path

| Milestone | Depends On | Outcome |
|---|---|---|
| M0: Pricing Pivot Baseline | -- | 2-tier economics + no deep-tier logic |
| M1: Access Control Baseline | M0 | Gates enforce Free vs Pro in UI/API |
| M2: Coaching Engine Baseline | Sprint 0+1+2 | Proposal loop + GeScore v2 active |
| M3: Flywheel Closed Loop | M2 + Sprint 3+4 | Capture -> reuse -> connection -> brief working |
| M4: Measurement + Network Effects | M3 + Sprint 5 | Analytics visibility + collective intelligence |

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
| Pricing | Free user selects premium model alias | Routed/fallback, no 402 model-name block | TODO |
| Pricing | Pro with BYOK key | Uses BYOK provider path | TODO |
| Gates | Free vault limit boundary | 403 + upgrade URL when exceeded | TODO |
| Flywheel | Capture prompt appears after quality chat | Prompt shown with gecko voice | TODO |
| Flywheel | Inject knowledge card | Context injected + reuse tracked | TODO |
| Graph | Create edge | Edge exists + connection count visible | TODO |
| Morning Brief | Enabled user opens coaching tab | Cached brief generated or served | TODO |
| Collective | Opt-out user | Shared vectors removed within SLA | TODO |
| Moltworker Lyra | `/image` and `/video` commands | Structured brief output via renderers | TODO |

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
