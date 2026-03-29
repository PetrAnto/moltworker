# GeckoLife + Pricing Update — Claude Code Master Spec (v1)

**Date:** 2026-03-29  
**Source reviewed:** Every file in `claude-share/core/geckolife+pricing_update/`  
**Purpose:** One canonical execution spec Claude Code can follow without ambiguity.

---

## 1) Canonical Scope

This workstream merges three tracks into one delivery program:

1. **Pricing v3 rewrite (Free/Pro only).**
2. **Knowledge Flywheel delivery (Sprint 0 → Sprint 5).**
3. **Project System + Lyra Media (ai-hub + moltworker coordination).**

Primary source docs:
- [WAVE7_ROADMAP.md](./WAVE7_ROADMAP.md)
- [pricing-model-v3.md](./pricing-model-v3.md)
- [gecko-life-knowledge-flywheel-spec-v1.1.md](./gecko-life-knowledge-flywheel-spec-v1.1.md)
- [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md)
- [COACHING_FLYWHEEL_ROADMAP.md](./COACHING_FLYWHEEL_ROADMAP.md)

---

## 2) Source-of-Truth Priority (Conflict Resolution)

When docs conflict, Claude Code must apply this order:

1. `CLAUDE_CODE_MASTER_SPEC.md` (this file)
2. `gecko-life-knowledge-flywheel-spec-v1.1.md` (strategic/corrective architecture)
3. `pricing-model-v3.md` (commercial/product model)
4. `project-architecture-lyra-media-spec-v1.1.md` (project/media boundaries)
5. `WAVE7_ROADMAP.md` and `COACHING_FLYWHEEL_ROADMAP.md` (execution order/tracking)
6. Sprint prompt files (`sprint-*.md`, `W7-S*.md`, `W7-S2-to-M3-all-prompts.md`) for implementation detail

If a prompt conflicts with v1.1 architecture specs, **follow v1.1 spec** and log deviation in PR notes.

---

## 3) Delivery Sequence (Exact)

### Phase A — Pricing + Entitlements Foundation
1. Execute **W7-S1** pricing rewrite.
2. Execute **W7-S2** feature gates immediately after S1.
3. Verify zero residual Deep tier references.

References:
- [W7-S1-pricing-rewrite.md](./W7-S1-pricing-rewrite.md)
- [pricing-model-v3.md](./pricing-model-v3.md)
- [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)

### Phase B — Flywheel Foundation + Core Loop
4. **Sprint 0** Workers AI + Vectorize infra.
5. **Sprint 1** schema + embeddings + quality gate.
6. **Sprint 2** coaching engine + GeScore v2.
7. **Sprint 3** capture + CIS reuse loop.
8. **Sprint 4** knowledge graph + morning brief.
9. **Sprint 5** analytics + collective intelligence.

References:
- [sprint-0-workers-ai-infra.md](./sprint-0-workers-ai-infra.md)
- [sprint-1-schema-embeddings.md](./sprint-1-schema-embeddings.md)
- [sprint-2-coaching-engine.md](./sprint-2-coaching-engine.md)
- [sprint-3-capture-reuse.md](./sprint-3-capture-reuse.md)
- [sprint-4-graph-brief.md](./sprint-4-graph-brief.md)
- [sprint-5-analytics-collective.md](./sprint-5-analytics-collective.md)

### Phase C — Projects + Lyra Media Parallel Track
10. Run **W7-S5** (project backend) in parallel with Flywheel mid-phases if capacity allows.
11. Run **W7-S6** chat-only project UI after S5.
12. Run **W7-M1** Lyra media in moltworker.
13. Run **W7-M2** moltworker integration tests.
14. Run **W7-M3** deploy prep last.

References:
- [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)
- [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md)

---

## 4) Hard Technical Rules for Claude Code

1. **No model-name paywall checks in LLM proxy.** Gate by BYOK key availability + feature gates.
2. **Two-tier only:** `free | pro` everywhere (DB comments/types/validation/UI/webhook/Stripe mapping).
3. **Feature gating is centralized** (`feature-gates.ts` + hook), not ad-hoc checks.
4. **All flywheel write APIs require Zod validation + auth + tests.**
5. **Embedding-dependent features cannot ship before Sprint 0 infra gate passes.**
6. **No new npm dependencies unless absolutely required and justified.**
7. **Collective intelligence must never store PII in shared index metadata.**

---

## 5) Implementation Contracts by Domain

### Pricing Contract
- `Tier` union is exactly `'free' | 'pro'`.
- Stripe only maps active Pro monthly ID.
- Subscription UI is one upgrade path: Free → Pro (€5/mo).

### Flywheel Contract
- Core tables exist and are indexed before proposal/brief/reuse features.
- Capture/reuse/proposals/brief flows emit typed analytics events.
- GeScore v2 uses 4-metric formula and personality-gecko commentary.

### Project/Lyra Contract
- Chat-only project UX can ship before full module UI rollout.
- Lyra media extends existing text Lyra paths; no regressions to `/write` family.
- Telegram + web renderers stay shape-compatible with `SkillResult` unions.

---

## 6) Required PR Evidence (for each sprint)

Claude Code output must include:
1. Changed file list grouped by domain (pricing/flywheel/projects/moltworker).
2. Acceptance checks copied from sprint spec and marked pass/fail.
3. Migration IDs + backward compatibility notes.
4. Any manual PetrAnto actions with exact dashboard/secret commands.

---

## 7) Known Risks + Guardrails

- **Risk:** `env.AI` binding fails in Pages Functions.  
  **Guardrail:** Run Sprint 0 decision gate first; switch to REST adapter path if needed.

- **Risk:** Deep tier leftovers break billing logic.  
  **Guardrail:** repo-wide grep checks for `deep`, `DEEP_MODE`, yearly/team stale IDs.

- **Risk:** Feature creep into unbuilt module UIs.  
  **Guardrail:** Respect chat-only interim phase from project architecture v1.1.

- **Risk:** Privacy regression in shared vector index.  
  **Guardrail:** explicit test asserting no `userId/title/content` in shared metadata.

---

## 8) Special Note on File `i`

`./i` is a 1-line artifact and contains no actionable specification content. Ignore in implementation planning unless repository owners repurpose it.
