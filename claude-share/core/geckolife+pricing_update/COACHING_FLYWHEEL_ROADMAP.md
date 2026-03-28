# Coaching Flywheel — Implementation Roadmap

> **Feature**: Coaching Module (formerly Gecko Life) — Knowledge Flywheel
> **Spec**: `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.md`
> **Total Effort**: ~100.5h (14.5h infra + 86h flywheel)
> **Last Updated**: 2026-03-28

---

## Decision Gate

| Gate | Status | Notes |
|------|--------|-------|
| `env.AI` spike (Pages Functions) | 🔲 | 30-min test. If fails → +4h REST adapter. **MUST pass before Sprint 0 continues.** |

---

## Sprint Tracker

### Sprint 0 — Workers AI Infrastructure (14.5h)

> **Prerequisite for ALL flywheel work. From Workers AI spec v1.1 Phases 2+3.**
> **Prompt**: `claude-share/codex-prompts/coaching/sprint-0-workers-ai-infra.md`
> **Branch**: `claude/coaching-s0-workers-ai`

| Task | Effort | Owner | Status |
|------|--------|-------|--------|
| `env.AI` spike test in Pages Functions | 0.5h | Claude Code | 🔲 |
| Add `[ai]` binding to `wrangler.toml` | 0.25h | Claude Code | 🔲 |
| Create `src/lib/providers/workers-ai.ts` (native + REST fallback) | 1.5h | Claude Code | 🔲 |
| Create `src/lib/providers/neuron-estimator.ts` | 1h | Claude Code | 🔲 |
| D1 migration: `workers_ai_neuron_log` table | 0.5h | Claude Code | 🔲 |
| Zod schemas for Workers AI responses | 0.5h | Claude Code | 🔲 |
| Create `src/lib/providers/embedding.ts` (`generateEmbedding()`) | 1h | Claude Code | 🔲 |
| Vectorize index creation + wrangler binding | 1h | **PetrAnto** | 🔲 |
| Create `src/app/api/search/semantic/route.ts` | 2h | Claude Code | 🔲 |
| Integrate Workers AI into FreeModelRouter config | 1h | Claude Code | 🔲 |
| Add Workers AI to `/api/llm-proxy/route.ts` | 1h | Claude Code | 🔲 |
| Update model selector UI (Edge badge) | 0.25h | Codex | 🔲 |
| Integration tests | 2h | Claude Code | 🔲 |

**Gate**: `npm run build` passes. `env.AI.run()` returns response on staging. Vectorize query returns results.

---

### Sprint 1 — Schema + Embeddings + Quality Gate (14h)

> **Prompt**: `claude-share/codex-prompts/coaching/sprint-1-schema-embeddings.md`
> **Branch**: `claude/coaching-s1-schema`
> **Depends on**: Sprint 0 complete

| Task | Effort | Owner | Status |
|------|--------|-------|--------|
| D1 migration `0024_coaching_knowledge.sql` (5 tables) | 2h | Claude Code | 🔲 |
| ALTER TABLE `prompt_library` + `journal_entries` | 1h | Claude Code | 🔲 |
| Drizzle schema additions in `src/lib/schema.ts` | 1h | Claude Code | 🔲 |
| Zod schemas in `src/lib/validations/coaching.ts` | 1.5h | Claude Code | 🔲 |
| Quality gate: `src/lib/coaching/quality-gate.ts` | 2h | Claude Code | 🔲 |
| Embedding hook on vault save: `src/lib/coaching/embed-on-save.ts` | 2h | Claude Code | 🔲 |
| Embedding hook on journal save | 1h | Claude Code | 🔲 |
| Backfill script for existing vault + journal entries | 1h | Claude Code | 🔲 |
| Unit tests | 2.5h | Claude Code | 🔲 |

**Gate**: Migration applies cleanly. Vault save triggers embedding. Vectorize returns similarity results for saved entries. Quality gate filters short/casual conversations.

---

### Sprint 2 — Coaching Engine + GeScore v2 (18h)

> **Prompt**: `claude-share/codex-prompts/coaching/sprint-2-coaching-engine.md`
> **Branch**: `claude/coaching-s2-engine`
> **Depends on**: Sprint 1 complete

| Task | Effort | Owner | Status |
|------|--------|-------|--------|
| Coaching proposal engine: `src/lib/coaching/proposal-engine.ts` | 4h | Claude Code | 🔲 |
| Proposal API routes: `src/app/api/coaching/proposals/route.ts` | 2h | Claude Code | 🔲 |
| Proposal accept/dismiss: `src/app/api/coaching/proposals/[id]/route.ts` | 1.5h | Claude Code | 🔲 |
| Dismiss-to-learn frequency adaptation | 1h | Claude Code | 🔲 |
| GeScore v2 formula: update `src/lib/gecko-life.ts` | 2h | Claude Code | 🔲 |
| GeScore v2 API: update `src/app/api/life/stats/route.ts` | 1.5h | Claude Code | 🔲 |
| Coaching tab UI: proposals section in `src/components/life/LifePanel.tsx` | 3h | Claude Code | 🔲 |
| "Your Coaches" label rename in `src/components/cockpit/*.tsx` | 0.5h | Claude Code | 🔲 |
| Gecko coaching template strings in `src/lib/gecko-life.ts` | 1h | Claude Code | 🔲 |
| Unit + integration tests | 1.5h | Claude Code | 🔲 |

**Gate**: Coaching tab shows proposals. Accept creates a task. Dismiss logs and adapts. GeScore uses new formula. "Your Coaches" label visible.

---

### Sprint 3 — Capture Flow + CIS Knowledge Cards (18h)

> **Prompt**: `claude-share/codex-prompts/coaching/sprint-3-capture-reuse.md`
> **Branch**: `claude/coaching-s3-capture`
> **Depends on**: Sprint 2 complete

| Task | Effort | Owner | Status |
|------|--------|-------|--------|
| Post-chat capture prompt UI | 3h | Claude Code | 🔲 |
| granite-micro vault entry extraction: `src/lib/coaching/auto-extract.ts` | 3h | Claude Code | 🔲 |
| Knowledge reuse tracking on CIS inject | 1.5h | Claude Code | 🔲 |
| CIS session pre-fetch: `src/lib/coaching/knowledge-context.ts` | 2h | Claude Code | 🔲 |
| CIS knowledge cards UI in BottomBar | 3h | Claude Code | 🔲 |
| `prompt_library.reuse_count` increment on inject | 1h | Claude Code | 🔲 |
| Reuse tracking API: `src/app/api/coaching/reuse/route.ts` | 1.5h | Claude Code | 🔲 |
| Unit + integration tests | 3h | Claude Code | 🔲 |

**Gate**: After a 5+ message chat, capture prompt appears. One-click creates vault entry. CIS shows knowledge cards when typing related terms. Reuse count increments on inject.

---

### Sprint 4 — Knowledge Graph + Morning Brief (16h)

> **Prompt**: `claude-share/codex-prompts/coaching/sprint-4-graph-brief.md`
> **Branch**: `claude/coaching-s4-graph`
> **Depends on**: Sprint 3 complete

| Task | Effort | Owner | Status |
|------|--------|-------|--------|
| Knowledge edge creation UI ("connect to..." action) | 4h | Claude Code | 🔲 |
| Edge API: `src/app/api/coaching/edges/route.ts` | 2h | Claude Code | 🔲 |
| Morning brief generator: `src/lib/coaching/morning-brief.ts` | 3h | Claude Code | 🔲 |
| Morning brief preferences API | 1h | Claude Code | 🔲 |
| Morning brief UI in Coaching tab | 2h | Claude Code | 🔲 |
| Gecko cross-domain discovery (Zori alerts) | 2h | Claude Code | 🔲 |
| Unit + integration tests | 2h | Claude Code | 🔲 |

**Gate**: Users can link vault entries to journal entries. Morning brief shows on tab open (when enabled). Zori fires when cross-domain match detected.

---

### Sprint 5 — Analytics + Collective Intelligence (20h)

> **Prompt**: `claude-share/codex-prompts/coaching/sprint-5-analytics-collective.md`
> **Branch**: `claude/coaching-s5-analytics`
> **Depends on**: Sprint 4 complete

| Task | Effort | Owner | Status |
|------|--------|-------|--------|
| PostHog `coaching.*` events in `analytics-types.ts` | 1h | Claude Code | 🔲 |
| Instrument capture/reuse/proposal events | 2h | Claude Code | 🔲 |
| `neurons.*` events + daily total tracking | 1h | Claude Code | 🔲 |
| PostHog Knowledge Flywheel dashboard spec | 1h | Claude Code | 🔲 |
| Shared Vectorize index for collective intelligence | 3h | Claude Code | 🔲 |
| Community pattern detection (scheduled worker) | 4h | Claude Code | 🔲 |
| Collective insight notification system | 3h | Claude Code | 🔲 |
| Privacy opt-in/opt-out for shared index | 2h | Claude Code | 🔲 |
| Unit + integration tests | 3h | Claude Code | 🔲 |

**Gate**: PostHog dashboard shows flywheel metrics. Capture rate, reuse rate, proposal acceptance visible. Collective intelligence opt-in works for Pro users.

---

## Dependency Chain

```
Cockpit UI Polish (current PROMPT_READY, ~4-6h)
    │
    ▼
Sprint 0: Workers AI Infrastructure (14.5h)
    │ ← HARD GATE: env.AI spike must pass
    ▼
Sprint 1: Schema + Embeddings + Quality Gate (14h)
    │
    ▼
Sprint 2: Coaching Engine + GeScore v2 (18h)  ← PARADIGM SHIFT
    │
    ▼
Sprint 3: Capture Flow + CIS Knowledge Cards (18h)
    │
    ▼
Sprint 4: Knowledge Graph + Morning Brief (16h)
    │
    ▼
Sprint 5: Analytics + Collective Intelligence (20h)
```

---

## Key Spec Cross-References

| Spec | Location | Read Before |
|------|----------|-------------|
| Coaching Flywheel v1.1 (master) | `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.md` | All sprints |
| Workers AI v1.1 | `claude-share/brainstorming/wave6/workers-ai-native-provider-spec-v1.1.md` | Sprint 0 |
| Prompt Vault v1 | `claude-share/brainstorming/wave6/prompt-vault-spec-v1.md` | Sprint 1, 3 |
| PostHog Event Schema v2 | `claude-share/specs/posthog-event-schema.md` | Sprint 5 |
| Gecko Companions | `claude-share/specs/gecko-companions-spec.md` | Sprint 2 |
| Mode Geckos v3 FINAL | `claude-share/specs/mode-geckos-v3-FINAL.md` | Sprint 2 |
| AI Code Standards | `claude-share/core/AI_CODE_STANDARDS.md` | All sprints |
| Backend Audit | `claude-share/audits/BACKEND_AUDIT_2026-02-11.md` | Sprint 1 (schema patterns) |

---

## PetrAnto Actions Required

| When | Action | Notes |
|------|--------|-------|
| Sprint 0 | Create Vectorize index in CF Dashboard | Name: `storia-knowledge`, dimensions: match bge-m3 output |
| Sprint 0 | Add Vectorize binding to wrangler.toml | After index created |
| Sprint 0 | Create Workers AI API token (if REST fallback needed) | CF Dashboard → API Tokens |
| Sprint 0 | Deploy staging build to verify `env.AI` | After spike test passes |
| Sprint 2 | Review "Your Coaches" label in cockpit UI | Visual approval |
| Sprint 5 | Configure PostHog dashboard | From spec template |

---

*Upload to: `claude-share/core/COACHING_FLYWHEEL_ROADMAP.md`*
