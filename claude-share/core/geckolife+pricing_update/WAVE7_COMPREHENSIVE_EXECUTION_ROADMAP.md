# Wave 7 Comprehensive Execution Roadmap (Operational)

Date: 2026-03-29
Owner: Multi-agent (Claude/Codex/Human)

## Milestones and Critical Path

| Milestone | Depends On | Outcome |
|---|---|---|
| M0: Pricing Pivot Baseline | none | 2-tier economics + no deep-tier logic |
| M1: Access Control Baseline | M0 | gates enforce Free vs Pro in UI/API |
| M2: Coaching Engine Baseline | S0+S1+S2 | proposal loop + GeScore v2 active |
| M3: Flywheel Closed Loop | M2 + S3 + S4 | capture→reuse→connection→brief working |
| M4: Measurement + Network Effects | M3 + S5 | analytics visibility + collective intelligence |

## Sprint-by-Sprint Plan

## W7-S1 — Pricing Rewrite (Target: 1 session)
- Input docs:
  - [W7-S1-pricing-rewrite.md](./W7-S1-pricing-rewrite.md)
  - [pricing-model-v3.md](./pricing-model-v3.md)
- Exit gates:
  - all tier logic = free/pro
  - llm routing by key availability
  - subscription + pricing UI updated

## W7-S2 — Feature Gates (Target: 1 session)
- Input docs:
  - [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)
- Exit gates:
  - centralized gate library + hook
  - cockpit lock states
  - vault/project limit enforcement

## W7-S3 — Flywheel Schema (Target: 1 session)
- Input docs:
  - [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)
  - [gecko-life-knowledge-flywheel-spec-v1.1.md](./gecko-life-knowledge-flywheel-spec-v1.1.md)
- Exit gates:
  - migrations + Drizzle types + indexes
  - schema tests pass

## W7-S4 — Flywheel Logic Core (Target: 1–2 sessions)
- Input docs:
  - [sprint-1-schema-embeddings.md](./sprint-1-schema-embeddings.md)
  - [sprint-2-coaching-engine.md](./sprint-2-coaching-engine.md)
- Exit gates:
  - quality gate operational
  - proposal engine and GeScore v2 operational
  - coaching labels/templates integrated

## W7-S5 — Project Backend (Target: 1–2 sessions)
- Input docs:
  - [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)
  - [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md)
- Exit gates:
  - projects tables + API endpoints
  - feature-gate limits applied

## W7-S6 — Module UIs (Target: 2+ sessions)
- Input docs:
  - [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md)
- Exit gates:
  - minimally working Creator/Code/SitMon/Coaching UIs
  - module boundaries consistent with gates

## W7-S7 — Analytics (Target: 1 session)
- Input docs:
  - [sprint-5-analytics-collective.md](./sprint-5-analytics-collective.md)
- Exit gates:
  - PostHog events emitted at all required touchpoints
  - daily neuron rollups available

## W7-S8 — Polish + QA (Target: 1 session)
- Input docs:
  - [WAVE7_ROADMAP.md](./WAVE7_ROADMAP.md)
- Exit gates:
  - end-to-end smoke checklist complete
  - pricing/flywheel UAT complete

## W7-M3 — Deploy + Post-Deploy Validation
- Input docs:
  - [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md)
- Exit gates:
  - staging + production verification
  - observability + rollback notes captured

## Risk Register

| Risk | Impact | Mitigation | Owner |
|---|---|---|---|
| env.AI unavailable in Pages runtime | blocks S0 | run spike first, REST fallback path | Claude + Human |
| Vectorize index config mismatch | blocks embeddings/search | enforce index schema checklist before merge | Human |
| Schema drift (SQL vs Drizzle) | runtime failures | treat migration + schema as atomic PR | Claude |
| Privacy leak to shared index | compliance issue | metadata allowlist tests required | Claude |
| UI modules lag backend features | broken UX | lock-state placeholders + phased module rollouts | Claude/Codex |

## Execution Cadence

- One sprint per PR when possible.
- If split needed:
  - backend-first PR
  - UI integration PR
  - analytics instrumentation PR
- Mandatory sync updates after each sprint:
  - `GLOBAL_ROADMAP.md`
  - `WORK_STATUS.md`
  - `next_prompt.md`
  - agent log file
