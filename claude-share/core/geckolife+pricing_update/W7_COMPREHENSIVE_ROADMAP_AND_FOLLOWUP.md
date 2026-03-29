# Wave 7 Comprehensive Roadmap + Follow-Up Files

This file provides the operational layer required to fully execute Wave 7 with minimal coordination failure.

---

## A) Program Board (single-sheet)

| Sprint | Repo | Depends On | Status | Branch | PR | Owner | Notes |
|---|---|---|---|---|---|---|---|
| W7-S1 Pricing Rewrite | ai-hub | — | TODO | `claude/w7-s1-pricing-rewrite-*` | — | Claude Code | Remove deep tier everywhere |
| W7-S2 Feature Gates | ai-hub | S1 | TODO | `claude/w7-s2-feature-gates-*` | — | Claude Code | Enforce limits in API + UI |
| W7-S3 Flywheel Schema | ai-hub | — | TODO | `claude/w7-s3-flywheel-schema-*` | — | Claude Code | New flywheel tables + migration |
| W7-S4 Flywheel Logic | ai-hub | S3 | TODO | `claude/w7-s4-flywheel-logic-*` | — | Claude Code | Proposals + GeScore v2 |
| W7-S5 Project Backend | ai-hub | — | TODO | `claude/w7-s5-project-backend-*` | — | Claude Code | Project/item APIs |
| W7-S6 Chat Project UI | ai-hub | S5 | TODO | `claude/w7-s6-chat-project-ui-*` | — | Claude Code | Chat-only project surface |
| W7-M1 Lyra Media | moltworker | — | TODO | `claude/w7-m1-lyra-media-*` | — | Claude Code | New image/video submodes |
| W7-M2 Integration Tests | moltworker | M1 | TODO | `claude/w7-m2-integration-tests-*` | — | Claude Code | `/simulate` and renderer checks |
| W7-M3 Deploy Prep | moltworker | M1,M2 | TODO | `claude/w7-m3-deploy-prep-*` | — | Claude Code | Sync + deployment readiness |

---

## B) Follow-Up File 1 — Manual Ops Checklist (owner: PetrAnto)

## Before S1
- [ ] Create Stripe Pro product (€5/mo)
- [ ] Update production secret with new `STRIPE_PRO_MONTHLY_PRICE_ID`
- [ ] Archive/remove Deep Mode related Stripe products/secrets

## Before M3 deploy
- [ ] Verify KV namespaces/bindings required by moltworker
- [ ] Upload Lyra media system prompts to R2
- [ ] Run pre-deploy data hygiene checklist for R2 bucket

## After Wave 7 completion
- [ ] Stripe webhook end-to-end test (upgrade/downgrade/cancel)
- [ ] free→limit_reached→upgrade flow test
- [ ] dashboard refresh task completion

---

## C) Follow-Up File 2 — QA Sign-Off Matrix

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
| Moltworker Lyra | `/image` and `/video` command | Structured brief output via renderers | TODO |

---

## D) Follow-Up File 3 — Merge & Release Sequencing

1. Merge independent foundational branches first: S1, S3, S5, M1.
2. Then dependency branches: S2, S4, S6, M2.
3. Finalize M3 after test evidence from M2.
4. Run cross-repo regression (pricing + flywheel + lyra).
5. Publish release notes with migration order and rollback markers.

---

## E) Rollback Markers (must be in each sprint PR)

- Database: migration IDs and reversal strategy.
- Runtime: feature flag or guarded path for newly exposed APIs.
- UI: fallback rendering path if new gates/components fail.
- Integrations: safe disable path for shared collective index and new media modes.

---

## F) Final Documentation Sync Targets

After each sprint, update:
- `claude-share/core/GLOBAL_ROADMAP.md`
- `claude-share/core/WORK_STATUS.md`
- `claude-share/core/next_prompt.md`
- `claude-share/core/claude-log.md`

