# Coaching Flywheel / Wave 7 — File Placement & Execution Guide

## Canonical Files (Use These First)

> Added 2026-03-29 after deep review of all source files + cherry-picking best solutions from Codex PRs #443-#446.

1. [`W7_CANONICAL_SPEC.md`](./W7_CANONICAL_SPEC.md) — **Single consolidated spec** with conflict resolution, product rules, sprint-by-sprint DoD, and handoff format.
2. [`W7_CONNECTION_LINKS.md`](./W7_CONNECTION_LINKS.md) — Spec-to-code-to-validation connection matrix per sprint (includes actual `src/` file paths).
3. [`W7_EXECUTION_ROADMAP.md`](./W7_EXECUTION_ROADMAP.md) — Program board, gate checks, parallelization map, QA sign-off matrix, rollback markers.
4. [`W7_FOLLOWUP_AND_GOVERNANCE.md`](./W7_FOLLOWUP_AND_GOVERNANCE.md) — PR templates, per-sprint artifact pattern, manual action matrix, quality gates.

## Recommended Usage Order

1. Read `W7_CANONICAL_SPEC.md` for exact, de-duplicated requirements and conflict resolution.
2. Use `W7_CONNECTION_LINKS.md` while implementing each sprint.
3. Track progress and handoffs in `W7_EXECUTION_ROADMAP.md`.
4. Use `W7_FOLLOWUP_AND_GOVERNANCE.md` when closing each sprint PR.
5. Keep legacy files below as source context/reference only.

---

## Source Files (Legacy + Sprint Prompts)

### Strategy Specs
- `pricing-model-v3.md` — Pricing architecture (Free/Pro 2-tier)
- `gecko-life-knowledge-flywheel-spec-v1.1.md` — Flywheel architecture
- `project-architecture-lyra-media-spec-v1.1.md` — Project + Lyra media

### Roadmaps + Trackers
- `WAVE7_ROADMAP.md` — Cross-wave roadmap
- `WAVE7_FOLLOWUP.md` — Follow-up tracker (PetrAnto manual actions)
- `COACHING_FLYWHEEL_ROADMAP.md` — Coaching sprint sub-roadmap

### Sprint Prompts
- `W7-S1-pricing-rewrite.md` — Pricing rewrite prompt
- `W7-S2-to-M3-all-prompts.md` — Bundled prompts S2 through M3
- `sprint-0-workers-ai-infra.md` through `sprint-5-analytics-collective.md` — Coaching flywheel prompts

### File anomaly
- `i` — Empty placeholder file. Non-actionable.

---

## Original ai-hub Placement Guide

```
claude-share/
├── brainstorming/
│   └── wave7/
│       ├── WAVE7_ROADMAP.md
│       ├── WAVE7_FOLLOWUP.md
│       ├── pricing-model-v3.md
│       ├── gecko-life-knowledge-flywheel-spec-v1.1.md
│       └── project-architecture-lyra-media-spec-v1.1.md
├── core/
│   └── geckolife+pricing_update/
│       ├── W7_CANONICAL_SPEC.md          ← CANONICAL ENTRY POINT
│       ├── W7_CONNECTION_LINKS.md
│       ├── W7_EXECUTION_ROADMAP.md
│       └── W7_FOLLOWUP_AND_GOVERNANCE.md
└── codex-prompts/
    └── coaching/
        ├── sprint-0-workers-ai-infra.md
        └── ... (sprint 1-5)
```

## Cross-Reference: Existing Specs Read Per Sprint

| Sprint | Must Read Before Starting |
|--------|--------------------------|
| 0 | `workers-ai-native-provider-spec-v1.1.md` (§4, §6, §8) |
| 1 | `prompt-vault-spec-v1.md` (§7), Backend Audit (§4) |
| 2 | `gecko-companions-spec.md`, `mode-geckos-v3-FINAL.md` |
| 3 | `prompt-vault-spec-v1.md` (§6 CIS), existing `BottomBar.tsx` |
| 4 | Flywheel spec §6 (Gecko Roles), §10 (Morning Brief) |
| 5 | `posthog-event-schema.md` (full EventMap + privacy) |

## Total Effort: ~65h across 9 Wave 7 sprints + ~100.5h coaching flywheel sub-track
