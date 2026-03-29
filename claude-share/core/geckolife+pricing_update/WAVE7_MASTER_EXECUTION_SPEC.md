# Wave 7 Master Execution Spec (Consolidated, Claude-Code Ready)

**Status**: Canonical implementation spec derived from a full review of every file in `claude-share/core/geckolife+pricing_update/`.
**Date**: 2026-03-29
**Goal**: Provide exact, execution-safe specs + dependency links so Claude Code can implement end-to-end with minimal ambiguity.

---

## 1) Source-of-Truth Map (Reviewed Inputs)

- Strategic pricing base: [`pricing-model-v3.md`](./pricing-model-v3.md)
- Flywheel architecture base: [`gecko-life-knowledge-flywheel-spec-v1.1.md`](./gecko-life-knowledge-flywheel-spec-v1.1.md)
- Project/Lyra architecture base: [`project-architecture-lyra-media-spec-v1.1.md`](./project-architecture-lyra-media-spec-v1.1.md)
- Wave sequencing baseline: [`WAVE7_ROADMAP.md`](./WAVE7_ROADMAP.md)
- Sprint prompt bundle: [`W7-S2-to-M3-all-prompts.md`](./W7-S2-to-M3-all-prompts.md)
- Operational tracker: [`WAVE7_FOLLOWUP.md`](./WAVE7_FOLLOWUP.md)
- Detailed flywheel sprint tracker: [`COACHING_FLYWHEEL_ROADMAP.md`](./COACHING_FLYWHEEL_ROADMAP.md)
- Standalone sprint prompts:
  - [`sprint-0-workers-ai-infra.md`](./sprint-0-workers-ai-infra.md)
  - [`sprint-1-schema-embeddings.md`](./sprint-1-schema-embeddings.md)
  - [`sprint-2-coaching-engine.md`](./sprint-2-coaching-engine.md)
  - [`sprint-3-capture-reuse.md`](./sprint-3-capture-reuse.md)
  - [`sprint-4-graph-brief.md`](./sprint-4-graph-brief.md)
  - [`sprint-5-analytics-collective.md`](./sprint-5-analytics-collective.md)
- Legacy/transition prompt: [`W7-S1-pricing-rewrite.md`](./W7-S1-pricing-rewrite.md)
- Placement helper: [`INDEX.md`](./INDEX.md)
- Noted stray file: [`i`](./i) (empty placeholder)

---

## 2) Critical Normalization Decisions (Applied)

### 2.1 Canonical Sprint Sequence
Use this sequence as authoritative:

1. **W7-S1** Pricing rewrite (2-tier Free/Pro)
2. **W7-S2** Feature gates (module/gecko/limits)
3. **W7-S3** Flywheel schema
4. **W7-S4** Flywheel logic (quality gate + GeScore v2)
5. **W7-S5** Project backend
6. **W7-S6** Chat-only project UI
7. **W7-M1** Moltworker Lyra media extension
8. **W7-M2** Moltworker integration tests
9. **W7-M3** Deploy prep + docs closure

### 2.2 Dependency Clarification
- S2 **hard-depends** on S1.
- S3 can run in parallel with late S1 hardening only if tier changes are already merged.
- S4 depends on S3.
- S5 can run parallel to S3/S4, but project-limit gate integration depends on S2.
- S6 depends on S5.
- M1/M2/M3 are moltworker-side and can run parallel to ai-hub work, but M2 depends on M1 and M3 depends on M1+M2.

### 2.3 Gate Policy (Non-negotiable)
- **No model-name paywall checks** in LLM proxy; routing is key-availability based.
- **No Deep tier references** in code, schema comments, Stripe tier enums, webhook mapping.
- **Flywheel features are capability-gated by tier**, not by model prefixes.

---

## 3) Exact Deliverables by Sprint (Definition of Done)

## W7-S1 — Pricing Rewrite (ai-hub)
**Spec links**: [`W7-S1-pricing-rewrite.md`](./W7-S1-pricing-rewrite.md), [`pricing-model-v3.md`](./pricing-model-v3.md), [`gecko-life-knowledge-flywheel-spec-v1.1.md`](./gecko-life-knowledge-flywheel-spec-v1.1.md)

**Must ship**:
- Tier model reduced to `free | pro`.
- `isDeepModeSubscriber` removed.
- Stripe mapping reduced to Pro monthly only.
- Tier enum updated to `['free', 'pro']`.
- LLM proxy refactored to key-availability routing.
- UI shifted to 2-column pricing, 1 upgrade CTA.

**Blocking validations**:
- `npm run build`
- `npm test`
- code search returns zero deep-tier artifacts.

## W7-S2 — Feature Gates (ai-hub)
**Spec links**: [`W7-S2-to-M3-all-prompts.md`](./W7-S2-to-M3-all-prompts.md), [`pricing-model-v3.md`](./pricing-model-v3.md)

**Must ship**:
- `feature-gates.ts` + `useFeatureGate.ts` + tests.
- Cockpit gating for locked modules/geckos.
- Backend limit checks for vault/project creation.

**Error contract**:
- `403` with `{ "error": "limit_reached", "upgrade_url": "/pricing" }`.

## W7-S3 — Flywheel Schema (ai-hub)
**Spec links**: [`sprint-1-schema-embeddings.md`](./sprint-1-schema-embeddings.md), [`gecko-life-knowledge-flywheel-spec-v1.1.md`](./gecko-life-knowledge-flywheel-spec-v1.1.md)

**Must ship**:
- D1 tables: `knowledge_captures`, `knowledge_edges`, `knowledge_reuses`, `morning_brief_prefs` (+ required indexes).
- ALTERs on `prompt_library` and `journal_entries` for embeddings/metadata.
- Drizzle + Zod parity with SQL.

## W7-S4 — Flywheel Logic (ai-hub)
**Spec links**: [`sprint-2-coaching-engine.md`](./sprint-2-coaching-engine.md), [`W7-S2-to-M3-all-prompts.md`](./W7-S2-to-M3-all-prompts.md)

**Must ship**:
- Quality gate (JS heuristics).
- GeScore v2 (velocity, capture_rate, reuse_rate, connection_density).
- Coaching proposal engine + accept/dismiss adaptation.
- Coaching UI labels updated (“Your Coaches”, “Coaching”).

## W7-S5 — Project Backend (ai-hub)
**Spec links**: [`W7-S2-to-M3-all-prompts.md`](./W7-S2-to-M3-all-prompts.md), [`project-architecture-lyra-media-spec-v1.1.md`](./project-architecture-lyra-media-spec-v1.1.md)

**Must ship**:
- Project schema + CRUD APIs + project-items APIs + transfer endpoint.
- Zustand project store.
- Limit check integration with S2 gates.

## W7-S6 — Chat-only Project UI (ai-hub)
**Spec link**: [`W7-S2-to-M3-all-prompts.md`](./W7-S2-to-M3-all-prompts.md)

**Must ship**:
- ProjectSelector in TopStrip.
- Context cards above chat input for transferred items.
- Save-to-project action on chat responses.

## W7-M1 — Lyra Media (moltworker)
**Spec links**: [`W7-S2-to-M3-all-prompts.md`](./W7-S2-to-M3-all-prompts.md), [`project-architecture-lyra-media-spec-v1.1.md`](./project-architecture-lyra-media-spec-v1.1.md)

**Must ship**:
- `image_brief` and `video_brief` result kinds.
- media types + prompts + command map routes.
- Telegram and web renderers for new output kinds.

## W7-M2 — Moltworker Integration Tests
**Spec link**: [`W7-S2-to-M3-all-prompts.md`](./W7-S2-to-M3-all-prompts.md)

**Must ship**:
- `/simulate/chat` coverage for Lyra media flows.
- Render consistency checks.
- Prompt loading checks.

## W7-M3 — Deploy Prep
**Spec links**: [`W7-S2-to-M3-all-prompts.md`](./W7-S2-to-M3-all-prompts.md), [`WAVE7_FOLLOWUP.md`](./WAVE7_FOLLOWUP.md)

**Must ship**:
- pre-deploy checklist + docs sync + roadmap closure updates.
- explicit R2 cleanup reminder before deploy.

---

## 4) Connection Links (Implementation Graph)

- Pricing → Gates: S1 outputs consumed by S2 (`Tier`, limits, UI messaging).
- Gates → Project API: S2 project-limit check integrated in S5 create route.
- Workers AI infra → Embeddings: S0/S1 prerequisites for S3/S4/S5 capture+reuse.
- S3 schema → S4 logic: GeScore/proposals query new flywheel tables.
- S4 logic → S5 analytics: events and neuron tracking rely on proposal/capture hooks.
- S5 backend → S6 UI: ProjectSelector/context/save actions call S5 endpoints.
- ai-hub flywheel → moltworker M1/M2: shared narrative + Creator future hooks.

---

## 5) Execution Contract for Claude Code

For each sprint task prompt:
1. Load sprint prompt + linked master spec(s).
2. Implement only that sprint’s scope with explicit file list.
3. Run build + tests.
4. Update sync docs (`codex-log`, `GLOBAL_ROADMAP`, `WORK_STATUS`, `next_prompt`).
5. Commit with `<type>(<scope>): <description>` and AI/session footer.

If dependency is unmet, mark task **BLOCKED** and update follow-up tracker before stopping.

---

## 6) Risks + Mitigations (Consolidated)

- **Workers AI binding uncertain**: run env.AI spike first; keep REST fallback ready.
- **Schema drift risk**: SQL ↔ Drizzle ↔ Zod lockstep; reject partial migrations.
- **Feature creep risk**: enforce sprint-local scope via DoD in this file.
- **PII leak risk in collective intelligence**: shared index metadata allowlist only (`tags`, reuse aggregates, knowledgeType).

---

## 7) File Hygiene Actions

- Keep [`i`](./i) as historical placeholder or remove in a dedicated cleanup PR.
- Continue using [`INDEX.md`](./INDEX.md) as placement guide, but this file is the canonical execution spec.
