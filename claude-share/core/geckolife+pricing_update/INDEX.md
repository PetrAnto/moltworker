# Coaching Flywheel — File Placement Guide

## Where Each File Goes in ai-hub Repo

```
claude-share/
├── brainstorming/
│   └── wave7/
│       └── gecko-life-knowledge-flywheel-spec-v1.md    ← MASTER SPEC (v1.1)
│
├── core/
│   └── COACHING_FLYWHEEL_ROADMAP.md                    ← TRACKING FILE (live updates)
│
└── codex-prompts/
    └── coaching/
        ├── sprint-0-workers-ai-infra.md                ← Claude Code prompt
        ├── sprint-1-schema-embeddings.md               ← Claude Code prompt
        ├── sprint-2-coaching-engine.md                  ← Claude Code prompt
        ├── sprint-3-capture-reuse.md                    ← Claude Code prompt
        ├── sprint-4-graph-brief.md                      ← Claude Code prompt
        └── sprint-5-analytics-collective.md             ← Claude Code prompt
```

## Execution Order

```
1. Upload all files to repo
2. Start with Sprint 0 — infrastructure (14.5h)
   └─ PetrAnto: Create Vectorize index in CF Dashboard
   └─ Claude Code: Run env.AI spike test
3. Sprint 1 — schema + embeddings (14h)
4. Sprint 2 — coaching engine ← PARADIGM SHIFT (18h)
5. Sprint 3 — capture + CIS cards (18h)
6. Sprint 4 — graph + morning brief (16h)
7. Sprint 5 — analytics + collective (20h)
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

## Canonical Execution Additions (2026-03-29)

Use these three files as the execution baseline for future Claude Code sessions:

1. [WAVE7_MASTER_SPEC_FOR_CLAUDE_CODE.md](./WAVE7_MASTER_SPEC_FOR_CLAUDE_CODE.md) — unified exact implementation spec across all Wave 7 docs.
2. [WAVE7_COMPREHENSIVE_EXECUTION_ROADMAP.md](./WAVE7_COMPREHENSIVE_EXECUTION_ROADMAP.md) — sprint/milestone roadmap with risk register and critical path.
3. [WAVE7_FOLLOWUP_FILES_SPEC.md](./WAVE7_FOLLOWUP_FILES_SPEC.md) — required follow-up files, PR schema, and link contract.

## Repository Hygiene Note

- File `./i` is currently empty and should be either removed or populated with an explicit purpose.

## Total Effort: ~100.5h across 6 sprints
