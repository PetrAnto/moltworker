# Wave 7 Connection Links Matrix (Spec → Code → Validation)

Use this matrix as the implementation router for Claude Code.

## 1) Source Specs Reviewed

- `COACHING_FLYWHEEL_ROADMAP.md`
- `INDEX.md`
- `W7-S1-pricing-rewrite.md`
- `W7-S2-to-M3-all-prompts.md`
- `WAVE7_FOLLOWUP.md`
- `WAVE7_ROADMAP.md`
- `gecko-life-knowledge-flywheel-spec-v1.1.md`
- `pricing-model-v3.md`
- `project-architecture-lyra-media-spec-v1.1.md`
- `sprint-0-workers-ai-infra.md`
- `sprint-1-schema-embeddings.md`
- `sprint-2-coaching-engine.md`
- `sprint-3-capture-reuse.md`
- `sprint-4-graph-brief.md`
- `sprint-5-analytics-collective.md`
- `i` (empty; non-actionable)

---

## 2) Sprint Connections

## S1 Pricing Rewrite

- Primary docs:
  - `W7-S1-pricing-rewrite.md`
  - `pricing-model-v3.md`
- Must-touch code:
  - `src/lib/pricing.ts`
  - `src/lib/subscription.ts`
  - `src/lib/stripe.ts`
  - `src/lib/validations/stripe.ts`
  - `src/lib/schema.ts`
  - `src/app/api/llm-proxy/route.ts`
  - `src/app/api/stripe/webhook/route.ts`
  - `src/components/settings/SubscriptionPanel.tsx`
  - `src/components/pricing/PricingTable.tsx`
- Validation commands:
  - `npm run build`
  - `npm run test`
  - targeted grep for `deep`, `DEEP_MODE`, `PRO_YEARLY`, `TEAM_MONTHLY`

## S2 Feature Gates

- Primary docs:
  - `W7-S2-to-M3-all-prompts.md` (S2 section)
- Must-touch code:
  - `src/lib/feature-gates.ts` (new)
  - `src/hooks/useFeatureGate.ts` (new)
  - cockpit tabs rendering components
  - vault/project create routes
- Validation:
  - feature-gates unit tests
  - free/pro role behavior checks in UI + API

## S3 Flywheel Schema

- Primary docs:
  - `W7-S2-to-M3-all-prompts.md` (S3 section)
  - `gecko-life-knowledge-flywheel-spec-v1.1.md`
- Must-touch code:
  - D1 migration file(s)
  - `src/lib/schema.ts`
  - `src/lib/validations/coaching.ts` or `flywheel.ts`
- Validation:
  - migration apply/generate
  - schema typecheck

## S4 Flywheel Logic

- Primary docs:
  - `W7-S2-to-M3-all-prompts.md` (S4 section)
  - `gecko-life-knowledge-flywheel-spec-v1.1.md`
- Must-touch code:
  - proposal engine + APIs
  - `src/lib/gecko-life.ts` (or split modules)
  - stats route and coaching UI labels/components
- Validation:
  - acceptance flows for proposal accept/dismiss adaptation
  - GeScore v2 output verification

## S5 Analytics + Collective (and Sprint 5 doc parity)

- Primary docs:
  - `sprint-5-analytics-collective.md`
  - `W7-S2-to-M3-all-prompts.md` (S5 section)
- Must-touch code:
  - analytics event map/types
  - collective intelligence engine + opt-in route
  - vectorize shared binding + privacy logic
- Validation:
  - no PII in shared index metadata
  - analytics event emission at touchpoints

## M1-M3 Moltworker

- Primary docs:
  - `WAVE7_ROADMAP.md`
  - `project-architecture-lyra-media-spec-v1.1.md`
- Must-touch code:
  - Lyra handlers/types/prompts/renderers
  - simulate test routes
  - operational checklist docs in `claude-share/core/*`
- Validation:
  - simulate chat command tests
  - renderer parity tests

---

## 3) Cross-Spec Anchors

- Pricing architecture anchor: `pricing-model-v3.md`
- Flywheel architecture anchor: `gecko-life-knowledge-flywheel-spec-v1.1.md`
- Project + Lyra architecture anchor: `project-architecture-lyra-media-spec-v1.1.md`
- Program-level sequencing anchor: `WAVE7_ROADMAP.md`
- Manual/operator anchor: `WAVE7_FOLLOWUP.md`

---

## 4) No-Ambiguity Link Rules for Implementers

1. If sprint prompt conflicts with roadmap summary, **sprint prompt wins** for code-level behavior.
2. If architectural feasibility conflicts with sprint ambition, follow architecture spec v1.1 prerequisite audit and ship phased subset.
3. If both are unclear, log decision in sprint PR under **“Spec Decision Notes”** with file references.

