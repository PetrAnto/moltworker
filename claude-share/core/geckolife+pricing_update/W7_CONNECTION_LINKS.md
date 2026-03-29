# Wave 7 Connection Links Matrix (Spec -> Code -> Validation)

> Use this matrix as the implementation router for Claude Code.
> Each sprint maps: primary docs -> must-touch code files -> validation commands.

---

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
- `sprint-0-workers-ai-infra.md` through `sprint-5-analytics-collective.md`
- `i` (empty; non-actionable)

---

## 2) Sprint Connections

### S1 Pricing Rewrite

- **Primary docs**:
  - [W7-S1-pricing-rewrite.md](./W7-S1-pricing-rewrite.md)
  - [pricing-model-v3.md](./pricing-model-v3.md)
- **Must-touch code**:
  - `src/lib/pricing.ts`
  - `src/lib/subscription.ts`
  - `src/lib/stripe.ts`
  - `src/lib/validations/stripe.ts`
  - `src/lib/schema.ts`
  - `src/app/api/llm-proxy/route.ts`
  - `src/app/api/stripe/webhook/route.ts`
  - `src/components/settings/SubscriptionPanel.tsx`
  - `src/components/pricing/PricingTable.tsx`
- **Validation commands**:
  - `npm run build`
  - `npm run test`
  - targeted grep for `deep`, `DEEP_MODE`, `PRO_YEARLY`, `TEAM_MONTHLY`

---

### S2 Feature Gates

- **Primary docs**:
  - [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md) (S2 section)
- **Must-touch code**:
  - `src/lib/feature-gates.ts` (new)
  - `src/hooks/useFeatureGate.ts` (new)
  - Cockpit tabs rendering components
  - Vault/project create routes
- **Validation**:
  - feature-gates unit tests
  - free/pro role behavior checks in UI + API

---

### S3 Flywheel Schema

- **Primary docs**:
  - [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md) (S3 section)
  - [gecko-life-knowledge-flywheel-spec-v1.1.md](./gecko-life-knowledge-flywheel-spec-v1.1.md)
- **Must-touch code**:
  - D1 migration file(s)
  - `src/lib/schema.ts`
  - `src/lib/validations/coaching.ts` or `flywheel.ts`
- **Validation**:
  - Migration apply/generate
  - Schema typecheck (`npm run typecheck`)

---

### S4 Flywheel Logic

- **Primary docs**:
  - [sprint-2-coaching-engine.md](./sprint-2-coaching-engine.md)
  - [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md) (S4 section)
  - [gecko-life-knowledge-flywheel-spec-v1.1.md](./gecko-life-knowledge-flywheel-spec-v1.1.md)
- **Must-touch code**:
  - Proposal engine + APIs
  - `src/lib/gecko-life.ts` (or split modules)
  - Stats route and coaching UI labels/components
- **Validation**:
  - Acceptance flows for proposal accept/dismiss adaptation
  - GeScore v2 output verification tests

---

### S5 Project Backend

- **Primary docs**:
  - [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md) (S5 section)
  - [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md)
- **Must-touch code**:
  - Project tables + migration
  - Project API endpoints (CRUD + transfer)
  - Zustand project store
  - Feature-gate integration on create routes
- **Validation**:
  - CRUD integration tests
  - Limit enforcement tests

---

### S6 Chat Project UI

- **Primary docs**:
  - [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md) (S6 section)
  - [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md)
- **Must-touch code**:
  - `ProjectSelector` component (TopStrip)
  - Context card components
  - Save-to-project action handler
  - Zustand store integration
- **Validation**:
  - Create/select/save flows pass end-to-end
  - Mobile rendering checks

---

### M1 Lyra Media (moltworker)

- **Primary docs**:
  - [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md) (M1 section)
  - [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md)
- **Must-touch code**:
  - Lyra skill handlers/types/prompts
  - `src/skills/lyra/` — new media subtypes
  - Telegram + web renderers for `image_brief`/`video_brief`
  - Command map routes (`/image`, `/video`)
- **Validation**:
  - Simulate chat/command tests
  - Renderer parity tests
  - No regressions to `/write` family

---

### M2 Integration Tests (moltworker)

- **Primary docs**:
  - [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md) (M2 section)
- **Must-touch code**:
  - `/simulate` test routes
  - New test files for media flows
- **Validation**:
  - All simulate endpoints return valid responses
  - Cross-render consistency

---

### M3 Deploy Prep (moltworker)

- **Primary docs**:
  - [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md) (M3 section)
  - [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md)
- **Must-touch code**:
  - Operational checklist docs in `claude-share/core/*`
  - Deploy config verification
- **Validation**:
  - Documentation state reflects real merge status
  - Deploy checklist complete

---

## 3) Cross-Spec Architecture Anchors

| Domain | Anchor Document |
|--------|----------------|
| Pricing architecture | [pricing-model-v3.md](./pricing-model-v3.md) |
| Flywheel architecture | [gecko-life-knowledge-flywheel-spec-v1.1.md](./gecko-life-knowledge-flywheel-spec-v1.1.md) |
| Project + Lyra architecture | [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md) |
| Program sequencing | [WAVE7_ROADMAP.md](./WAVE7_ROADMAP.md) |
| Manual/operator actions | [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md) |

---

## 4) Implementation Graph (Data Flow Between Sprints)

```
Pricing -> Gates:      S1 outputs consumed by S2 (Tier, limits, UI messaging)
Gates -> Project API:  S2 project-limit check integrated in S5 create route
Schema -> Logic:       S3 tables consumed by S4 GeScore/proposals
Logic -> Analytics:    S4 events/hooks consumed by Sprint 5 collective
Backend -> UI:         S5 endpoints consumed by S6 ProjectSelector/save
ai-hub Flywheel -> moltworker: Shared narrative + future Creator hooks
```

---

## 5) No-Ambiguity Conflict Rules

1. If sprint prompt conflicts with roadmap summary, **sprint prompt wins** for code-level behavior.
2. If architectural feasibility conflicts with sprint ambition, follow architecture spec v1.1 prerequisite audit and ship phased subset.
3. If both are unclear, log decision in sprint PR under **"Spec Decision Notes"** with file references.
