# GeckoLife + Pricing Update — Claude Code Execution Roadmap

This roadmap is optimized for implementability, dependency safety, and parallelization.

## A. Sequenced Roadmap

| Order | Milestone | Blocking Dependencies | Deliverable |
|---|---|---|---|
| 1 | W7-S1 Pricing rewrite | none | 2-tier runtime + billing + UI update |
| 2 | W7-S2 Feature gates | W7-S1 | centralized entitlement enforcement |
| 3 | Sprint 0 Workers AI infra | none | AI+Vectorize wiring + neuron logging |
| 4 | Sprint 1 Flywheel schema/embeddings | Sprint 0 | flywheel data model + embed-on-save |
| 5 | Sprint 2 Coaching engine | Sprint 1 | proposals + GeScore v2 core |
| 6 | Sprint 3 Capture/reuse loop | Sprint 2 | capture prompt + CIS knowledge cards |
| 7 | Sprint 4 Graph + brief | Sprint 3 | edges + morning brief |
| 8 | Sprint 5 Analytics + collective | Sprint 4 | full measurement + shared intelligence |
| 9 | W7-S5 Project backend | none (parallel-safe) | projects API + schema |
| 10 | W7-S6 Chat-only projects UI | W7-S5 | project selector/context in chat |
| 11 | W7-M1 Lyra media (moltworker) | none (parallel-safe) | image/video brief result kinds |
| 12 | W7-M2 Integration tests (moltworker) | W7-M1 | simulate/renderer E2E checks |
| 13 | W7-M3 Deploy prep (moltworker) | W7-M1 + W7-M2 | release-ready packaging/manual ops |

## B. Connection Links (Exact Inputs per Step)

- W7-S1: [W7-S1-pricing-rewrite.md](./W7-S1-pricing-rewrite.md), [pricing-model-v3.md](./pricing-model-v3.md)
- W7-S2: [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)
- Sprint 0: [sprint-0-workers-ai-infra.md](./sprint-0-workers-ai-infra.md)
- Sprint 1: [sprint-1-schema-embeddings.md](./sprint-1-schema-embeddings.md)
- Sprint 2: [sprint-2-coaching-engine.md](./sprint-2-coaching-engine.md)
- Sprint 3: [sprint-3-capture-reuse.md](./sprint-3-capture-reuse.md)
- Sprint 4: [sprint-4-graph-brief.md](./sprint-4-graph-brief.md)
- Sprint 5: [sprint-5-analytics-collective.md](./sprint-5-analytics-collective.md)
- Architecture guardrails: [gecko-life-knowledge-flywheel-spec-v1.1.md](./gecko-life-knowledge-flywheel-spec-v1.1.md), [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md)
- Cross-program overview: [WAVE7_ROADMAP.md](./WAVE7_ROADMAP.md), [COACHING_FLYWHEEL_ROADMAP.md](./COACHING_FLYWHEEL_ROADMAP.md)

## C. Definition of Done per Sprint (applies to all)

1. Build/typecheck/tests pass.
2. Acceptance criteria in sprint prompt explicitly checked in PR notes.
3. No regression to existing commands/routes/components.
4. Tracking docs updated (`GLOBAL_ROADMAP`, `WORK_STATUS`, session log, `next_prompt`).

## D. Parallelization Map

Safe concurrent lanes:
- Lane 1: W7-S1 → W7-S2.
- Lane 2: Sprint 0 → Sprint 5 (strict chain).
- Lane 3: W7-S5 → W7-S6.
- Lane 4: W7-M1 → W7-M2 → W7-M3.

Do **not** parallelize within strict chains above.
