# Wave 7 Master Spec (Canonical) — For Claude Code Execution

> Purpose: unify all files in `claude-share/core/geckolife+pricing_update/` into one **exact execution spec** with dependency links, acceptance gates, and handoff artifacts.
> Date: 2026-03-29
> Audience: Claude Code implementation sessions

---

## 1) Source-of-Truth Map (Reviewed Files)

### Primary strategy specs
- Pricing model decision: [pricing-model-v3.md](./pricing-model-v3.md)
- Coaching flywheel architecture: [gecko-life-knowledge-flywheel-spec-v1.1.md](./gecko-life-knowledge-flywheel-spec-v1.1.md)
- Project architecture + Lyra extension: [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md)

### Roadmaps + trackers
- Cross-wave roadmap: [WAVE7_ROADMAP.md](./WAVE7_ROADMAP.md)
- Follow-up tracker: [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md)
- Coaching sprint roadmap: [COACHING_FLYWHEEL_ROADMAP.md](./COACHING_FLYWHEEL_ROADMAP.md)
- Placement index: [INDEX.md](./INDEX.md)

### Execution prompts (sprint-level)
- Pricing rewrite prompt: [W7-S1-pricing-rewrite.md](./W7-S1-pricing-rewrite.md)
- Bundled prompts S2→M3: [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)
- Coaching Sprint 0: [sprint-0-workers-ai-infra.md](./sprint-0-workers-ai-infra.md)
- Coaching Sprint 1: [sprint-1-schema-embeddings.md](./sprint-1-schema-embeddings.md)
- Coaching Sprint 2: [sprint-2-coaching-engine.md](./sprint-2-coaching-engine.md)
- Coaching Sprint 3: [sprint-3-capture-reuse.md](./sprint-3-capture-reuse.md)
- Coaching Sprint 4: [sprint-4-graph-brief.md](./sprint-4-graph-brief.md)
- Coaching Sprint 5: [sprint-5-analytics-collective.md](./sprint-5-analytics-collective.md)

### File anomaly
- `i` is an empty file and should be removed or repurposed with explicit intent.

---

## 2) Canonical Scope and Final Product Definition

Wave 7 combines two tracks:

1. **Pricing + gating pivot**
   - Replace 3-tier model with 2-tier (`free`, `pro`)
   - Remove deep-tier logic everywhere
   - Enforce module/gecko/vault/project access centrally

2. **Coaching Knowledge Flywheel**
   - Infra (Workers AI + Vectorize)
   - Schema + embeddings + quality gate
   - Proposal engine + GeScore v2
   - Capture + reuse loop
   - Graph edges + morning brief
   - Analytics + collective intelligence

This master spec resolves conflicts by priority:
1. `pricing-model-v3.md` and `gecko-life-knowledge-flywheel-spec-v1.1.md` (strategic truth)
2. Sprint prompt files (implementation truth)
3. Roadmap files (tracking truth)

---

## 3) Hard Dependency Chain (Do Not Break)

```text
W7-S1 Pricing Rewrite
  -> W7-S2 Feature Gates
  -> W7-S3 Knowledge Schema
  -> W7-S4 Flywheel Logic
  -> W7-S5 Project Backend
  -> W7-S6 UI Modules
  -> W7-S7 PostHog
  -> W7-S8 Polish
  -> W7-M3 Deploy

Coaching sub-track gating:
Sprint 0 (Workers AI infra) -> Sprint 1 -> Sprint 2 -> Sprint 3 -> Sprint 4 -> Sprint 5
```

Mandatory early gate:
- `env.AI` Pages Functions spike must pass before continuing Sprint 0.
  - Source: [sprint-0-workers-ai-infra.md](./sprint-0-workers-ai-infra.md), [COACHING_FLYWHEEL_ROADMAP.md](./COACHING_FLYWHEEL_ROADMAP.md)

---

## 4) Exact Implementation Specs by Phase

## Phase A — Pricing Core (W7-S1)
Reference: [W7-S1-pricing-rewrite.md](./W7-S1-pricing-rewrite.md), [pricing-model-v3.md](./pricing-model-v3.md)

### Required deliverables
- `Tier` union is exactly: `'free' | 'pro'`
- `src/lib/pricing.ts` rewritten to Free €0 + Pro €5/mo model
- Remove deep-tier logic from:
  - `src/lib/subscription.ts`
  - `src/lib/stripe.ts`
  - `src/lib/validations/stripe.ts`
  - webhook and UI pricing surfaces
- LLM proxy architecture rewrite:
  - never hard-block by model-name premium prefixes
  - route by key availability (BYOK or free-router fallback)

### Definition of done
- no `deep` tier references in source
- build + tests pass
- pricing UI shows only 2 plans

---

## Phase B — Feature Gate Enforcement (W7-S2)
Reference: [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)

### Required deliverables
- `src/lib/feature-gates.ts` created
- `src/hooks/useFeatureGate.ts` created
- cockpit modules gated with locked-state fallback + upgrade CTA
- vault/project API limits enforce tier caps with 403 payload:
  - `{ error: 'limit_reached', upgrade_url: '/pricing' }`

### Definition of done
- centralized gates used by both UI and API
- tests cover gate matrix and limit paths

---

## Phase C — Coaching Flywheel Foundation (S0 + S1)
References: [sprint-0-workers-ai-infra.md](./sprint-0-workers-ai-infra.md), [sprint-1-schema-embeddings.md](./sprint-1-schema-embeddings.md)

### S0 exact outputs
- Workers AI binding and provider with native + REST fallback
- neuron estimator and usage logging table
- embedding utility and semantic search route
- Vectorize index connectivity verified

### S1 exact outputs
- D1 migration for flywheel core tables
- Drizzle + Zod schema additions
- quality gate logic
- embedding hooks on vault/journal save
- backfill script

---

## Phase D — Coaching Engine (S2)
Reference: [sprint-2-coaching-engine.md](./sprint-2-coaching-engine.md)

### Required deliverables
- proposal engine (6 proposal types)
- proposal CRUD endpoints + dismiss learning
- GeScore v2 formula + API + UI stats
- cockpit naming updates (“Your Coaches”, “Coaching”)
- gecko coaching commentary/template map

---

## Phase E — Capture & Reuse Loop (S3)
Reference: [sprint-3-capture-reuse.md](./sprint-3-capture-reuse.md)

### Required deliverables
- post-chat capture banner
- granite-micro extraction to structured vault entry
- CIS prefetch knowledge cache
- client-side knowledge cards with inject action
- reuse tracking API + slash-command integration

---

## Phase F — Graph & Brief (S4)
Reference: [sprint-4-graph-brief.md](./sprint-4-graph-brief.md)

### Required deliverables
- “Connect to…” flow (vault + journal)
- knowledge edges API (POST/GET/DELETE)
- Zori cross-domain detection in proposal engine
- morning brief generator + prefs API + 24h cache + UI

---

## Phase G — Analytics & Collective Intelligence (S5)
Reference: [sprint-5-analytics-collective.md](./sprint-5-analytics-collective.md)

### Required deliverables
- `coaching.*` and `neurons.*` PostHog events end-to-end
- shared Vectorize index binding and anonymized writes
- opt-in/out API and delete-on-opt-out flow
- community pattern detector + proposal injection
- PII guardrails tests

---

## 5) Non-Negotiable Guardrails

- No new npm dependencies unless explicitly justified in sprint prompt.
- Build/test/typecheck must pass at every sprint boundary.
- Migration compatibility: D1 SQL + Drizzle schema aligned in same sprint.
- Privacy: no user content in shared collective index.
- Cost protection: neuron logging and visibility retained.

---

## 6) Required Manual/External Actions (Human Owner)

From [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md) and [COACHING_FLYWHEEL_ROADMAP.md](./COACHING_FLYWHEEL_ROADMAP.md):

1. Create Vectorize index(es): personal + shared
2. Add wrangler bindings after index creation
3. Configure Workers AI tokens if REST fallback required
4. Deploy staging for env.AI verification
5. Configure PostHog dashboard

No sprint claiming “done” without these external gates acknowledged.

---

## 7) Unified Acceptance Gate (Per Sprint)

Each sprint PR must include:
- Changed files list aligned to prompt scope
- Explicit acceptance criteria checklist copied from sprint prompt
- Evidence commands:
  - `npm run build`
  - `npm test`
  - `npm run typecheck`
- grep/rg proof for deprecated term cleanup when relevant

---

## 8) Handoff Contract for Claude Code

Every implementation PR should attach these links:
- roadmap state: [WAVE7_ROADMAP.md](./WAVE7_ROADMAP.md)
- sprint tracker: [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md)
- coaching sub-roadmap: [COACHING_FLYWHEEL_ROADMAP.md](./COACHING_FLYWHEEL_ROADMAP.md)
- detailed sprint prompt used (one of the sprint files)

This ensures the next session can continue without re-discovery.
