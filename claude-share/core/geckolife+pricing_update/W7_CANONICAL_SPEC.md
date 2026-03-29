# Wave 7 Canonical Delivery Spec (Cherry-Picked Consolidation)

> **Purpose**: Unify all files in `claude-share/core/geckolife+pricing_update` into one execution-safe spec that Claude Code can implement without ambiguity.
> **Source set reviewed**: All 16 files in this folder + 4 Codex PR proposals (#443-#446).
> **Date**: 2026-03-29.
> **Audience**: Claude Code implementation sessions.

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
- Bundled prompts S2-M3: [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)
- Coaching Sprint 0: [sprint-0-workers-ai-infra.md](./sprint-0-workers-ai-infra.md)
- Coaching Sprint 1: [sprint-1-schema-embeddings.md](./sprint-1-schema-embeddings.md)
- Coaching Sprint 2: [sprint-2-coaching-engine.md](./sprint-2-coaching-engine.md)
- Coaching Sprint 3: [sprint-3-capture-reuse.md](./sprint-3-capture-reuse.md)
- Coaching Sprint 4: [sprint-4-graph-brief.md](./sprint-4-graph-brief.md)
- Coaching Sprint 5: [sprint-5-analytics-collective.md](./sprint-5-analytics-collective.md)

### File anomaly
- `i` is an empty placeholder file. Ignore in implementation planning.

---

## 2) Source-of-Truth Priority (Conflict Resolution)

When docs conflict, apply this order:

1. **This file** (`W7_CANONICAL_SPEC.md`) — canonical override
2. `gecko-life-knowledge-flywheel-spec-v1.1.md` — strategic/corrective architecture
3. `pricing-model-v3.md` — commercial/product model
4. `project-architecture-lyra-media-spec-v1.1.md` — project/media boundaries
5. `WAVE7_ROADMAP.md` and `COACHING_FLYWHEEL_ROADMAP.md` — execution order/tracking
6. Sprint prompt files (`sprint-*.md`, `W7-S*.md`, `W7-S2-to-M3-all-prompts.md`) — implementation detail

If a sprint prompt conflicts with a v1.1 architecture spec, **follow v1.1 spec** and log deviation in PR notes.
If both are unclear, log decision in sprint PR under **"Spec Decision Notes"** with file references.

---

## 3) Canonical Scope (What Ships in Wave 7)

Wave 7 is split into 9 sprint units across 2 repos:

### ai-hub track (S1-S6) — CONFIRMED STATE (2026-03-29)
- S1: Pricing rewrite — **COMPLETE** (`Tier = 'free' | 'pro'`, key-based LLM routing, no deep mode)
- S2: Feature gates — **COMPLETE** (`feature-gates.ts`, `useFeatureGate.ts`, 403 enforcement)
- S3: Flywheel schema — **COMPLETE** (20 migrations, all tables, Drizzle/Zod parity)
- S4: Flywheel logic — **SHIPPED** (3/6 proposal types, GeScore v2, quality gate, post-fix #680)
- S5: Project backend — **SHIPPED** (hub-projects 10 endpoints, Zustand store, post-fix #672)
- S6: Chat Project UI — **SHIPPED** (ProjectSelector, SaveToProject, ContextCards, post-fix #683/#685)
- Sprint 5 Collective — **SCAFFOLDED** (analytics-types + opt-in route only; engine missing)
- **CAPA Sprint** — **TODO** (6 corrective actions, ~13-16h; see [`W7_CAPA_SPRINT.md`](./W7_CAPA_SPRINT.md))

### moltworker track (M1-M3) — NOT STARTED
- M1: Lyra media extension (image_brief + video_brief)
- M2: Integration/smoke tests (/simulate coverage)
- M3: Deploy prep + sync docs

### Non-goals in Wave 7 (explicit)
- Full module UI buildout (Creator/Code/SitMon/Coaching product surfaces)
- FreeModelRouter full rollout beyond minimum gating architecture
- Any feature requiring new paid-model lock by default (pricing v3 forbids model-paywall strategy)

---

## 4) Canonical Product Rules (Must Not Drift)

1. **Pricing is 2-tier only**: `free | pro`.
2. **No Deep tier anywhere**: no runtime logic, no webhook mapping, no UI text, no validation enum.
3. **Model access is key-availability routed, not blocked by model-name prefixes**.
4. **Knowledge Flywheel value is Pro differentiation**, not premium-model gating.
5. **Feature gating is centralized** (`feature-gates.ts` + hook), not ad-hoc checks.
6. **All flywheel write APIs require Zod validation + auth + tests.**
7. **Embedding-dependent features cannot ship before Sprint 0 infra gate passes.**
8. **Collective intelligence is opt-in and anonymized metadata only** (no PII in shared index).
9. **No new npm dependencies** unless absolutely required and justified.

---

## 5) Dependency-Safe Execution Order

### Phase A (parallel-safe start)
- A1: **S1** Pricing Rewrite (ai-hub)
- A2: **S3** Flywheel Schema (ai-hub) — can parallel S1 if tier model is pre-agreed
- A3: **S5** Project Backend (ai-hub) — project-limit gate integration depends on S2
- A4: **M1** Lyra Media (moltworker) — independent

### Phase B (first dependencies)
- B1: **S2** Feature Gates — after S1
- B2: **S4** Flywheel Logic — after S3
- B3: **S6** Chat Project UI — after S5
- B4: **M2** Integration Tests — after M1

### Phase C (final)
- C1: **M3** Deploy Prep — after M1 + M2
- C2: Full integration verification across repos

### Coaching sub-track gating
```
Sprint 0 (Workers AI infra) -> Sprint 1 -> Sprint 2 -> Sprint 3 -> Sprint 4 -> Sprint 5
```
Mandatory early gate: `env.AI` Pages Functions spike must pass before continuing Sprint 0.

---

## 6) Sprint-by-Sprint Exact Specs

### S1 — Pricing Rewrite (ai-hub, ~13h)
**Spec links**: [W7-S1-pricing-rewrite.md](./W7-S1-pricing-rewrite.md), [pricing-model-v3.md](./pricing-model-v3.md)

**Must ship**:
- `Tier` union reduced to exactly `'free' | 'pro'`
- `isDeepModeSubscriber` removed everywhere
- Stripe mapping reduced to Pro monthly only
- Tier enum updated to `['free', 'pro']`
- LLM proxy refactored to key-availability routing (no model-prefix paywall)
- UI shifted to 2-column pricing, 1 upgrade CTA

**Done definition**:
- `npm run build && npm test` pass
- Repository grep returns zero `deep`/`DEEP_MODE`/`PRO_YEARLY`/`TEAM_MONTHLY` references in target source areas
- Stripe webhook upgrades/downgrades still function for `free <-> pro`

---

### S2 — Feature Gates (ai-hub, ~4h)
**Spec links**: [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md), [pricing-model-v3.md](./pricing-model-v3.md)

**Must ship**:
- `src/lib/feature-gates.ts` + `src/hooks/useFeatureGate.ts` + tests
- Cockpit gating for locked modules/geckos with upgrade CTA
- Backend limit checks for vault/project creation

**Error contract**:
- `403` with `{ "error": "limit_reached", "upgrade_url": "/pricing" }`

**Done definition**:
- Free user gets chat-only + limits enforced
- Pro unlocks full configured module/gecko set
- Centralized gates used by both UI and API
- Tests cover gate matrix and limit paths

---

### S3 — Flywheel Schema (ai-hub, ~5h)
**Spec links**: [sprint-1-schema-embeddings.md](./sprint-1-schema-embeddings.md), [gecko-life-knowledge-flywheel-spec-v1.1.md](./gecko-life-knowledge-flywheel-spec-v1.1.md)

**Must ship**:
- D1 tables: `knowledge_captures`, `knowledge_edges`, `knowledge_reuses`, `morning_brief_prefs` (+ required indexes)
- ALTERs on `prompt_library` and `journal_entries` for embeddings/metadata
- Drizzle + Zod parity with SQL

**Done definition**:
- Migration applies cleanly
- Drizzle generation/typecheck is clean
- Schema contracts used by later sprint APIs compile without stub hacks

---

### S4 — Flywheel Logic (ai-hub, ~8h)
**Spec links**: [sprint-2-coaching-engine.md](./sprint-2-coaching-engine.md), [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)

**Must ship**:
- Quality gate for capture eligibility (JS heuristics)
- GeScore v2 (velocity, capture_rate, reuse_rate, connection_density)
- Coaching proposal engine (6 types) + accept/dismiss adaptation
- Cockpit naming updates ("Your Coaches", "Coaching")
- Gecko coaching commentary/template map

**Done definition**:
- Quality gate filters trivial chats
- Score formula returns stable values and commentary banding
- Template catalog complete and typed
- Proposal accept/dismiss adaptation flows pass tests

---

### S5 — Project Backend (ai-hub, ~12h)
**Spec links**: [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md), [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md)

**Must ship**:
- Project schema + CRUD APIs + project-items APIs + transfer endpoint
- Zustand project store
- Limit check integration with S2 gates
- Validation and rate-limiting/auth parity with existing API patterns

**Done definition**:
- CRUD + transfer route set passes integration tests
- Project-item cardinality + user ownership enforced
- Feature-gate limits applied

---

### S6 — Chat-Only Project UI (ai-hub, ~6h)
**Spec link**: [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)

**Must ship**:
- ProjectSelector in TopStrip
- Context cards above chat input for transferred items
- Save-to-project action on chat responses
- Mobile-safe rendering and Zustand wiring

**Done definition**:
- User can create/select project, save chat output, and reuse items in chat context

---

### M1 — Lyra Media (moltworker, ~11h)
**Spec links**: [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md), [project-architecture-lyra-media-spec-v1.1.md](./project-architecture-lyra-media-spec-v1.1.md)

**Must ship**:
- `image_brief` and `video_brief` result kinds
- Media types + prompts + command map routes
- Telegram and web renderers for new output kinds
- No regressions to `/write` family

**Done definition**:
- `/image` and `/video` commands produce valid structured results end-to-end
- Tests cover format + parser + renderer
- Telegram + web renderers stay shape-compatible with `SkillResult` unions

---

### M2 — Moltworker Integration Tests (~3h)
**Spec link**: [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md)

**Must ship**:
- `/simulate/chat` coverage for Lyra media flows
- Render consistency checks
- Prompt loading checks

---

### M3 — Deploy Prep (~3h)
**Spec links**: [W7-S2-to-M3-all-prompts.md](./W7-S2-to-M3-all-prompts.md), [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md)

**Must ship**:
- Pre-deploy checklist + docs sync + roadmap closure updates
- Explicit R2 cleanup reminder before deploy

---

## 7) Cross-File Conflict Resolutions (From Deep Review)

1. **Roadmap effort totals differ by document** — Use per-sprint effort listed in each sprint prompt as source of truth.
2. **Upload paths vary (`core/` vs `brainstorming/wave7/`)** — Implementation prompts live in sprint files; mirrored archival location in `brainstorming/wave7/` is optional output.
3. **Some prompts imply unavailable module UIs** — Obey architecture v1.1 prerequisite audit; ship chat-surface integrations first.
4. **Orphan file `i` exists** — Contains no usable spec content. Ignore.

---

## 8) Known Risks + Guardrails

| Risk | Guardrail |
|------|-----------|
| `env.AI` binding fails in Pages Functions | Run Sprint 0 decision gate first; switch to REST adapter path if needed |
| Deep tier leftovers break billing logic | Repo-wide grep checks for `deep`, `DEEP_MODE`, yearly/team stale IDs |
| Feature creep into unbuilt module UIs | Respect chat-only interim phase from project architecture v1.1 |
| Privacy regression in shared vector index | Explicit test asserting no `userId/title/content` in shared metadata |
| Schema drift (SQL vs Drizzle) | Treat migration + schema as atomic PR; reject partial migrations |
| Vectorize index config mismatch | Enforce index schema checklist before merge (human owner) |

---

## 9) Post-Implementation Audit Findings (2026-03-29)

> Based on audit of ai-hub PRs #662 through #686. Full CAPA spec in [`W7_CAPA_SPRINT.md`](./W7_CAPA_SPRINT.md).

### 9.1) Status Correction
The ai-hub implementation chain (S1-S6) has shipped but Sprint 5 (Analytics + Collective Intelligence) is **scaffolded, not complete**. PR #686's "WAVE 7 COMPLETE" claim is premature.

### 9.2) Critical: Collective Consent Storage
The `/api/coaching/collective/opt-in` route reuses `morning_brief_prefs.include_sitmon` as a proxy for collective opt-in consent. This MUST be replaced with dedicated consent storage (new table or column) before collective features are considered operational. **This is a privacy/compliance issue.**

Rule added: **Never reuse an existing column for a different semantic purpose**, especially for consent, billing, or audit data.

### 9.3) Critical: LifePanel Proposal Bug
Proposal accept/dismiss in `LifePanel` does not check `resp.ok` before tracking analytics and removing the proposal from UI. This causes false analytics events and UI/server desync. Fix is straightforward: gate side effects on response success.

### 9.4) Sprint 5 Missing Deliverables
The following were specified but not delivered:
- `src/lib/coaching/collective-intelligence.ts` (the actual engine)
- Anonymized embedding writes to `VECTORIZE_SHARED`
- Vector deletion on opt-out
- Community pattern detection
- Full PostHog instrumentation (spec vs implementation mismatch on event names/payloads)
- Dedicated Sprint 5 tests (0 test files added in #686)

### 9.5) Post-Merge Fix Volume
4 corrective PRs were needed after initial merges:
- #672: limit bypass, archived project mutations, item_count drift, schema drift
- #680: proposal deduplication + cooldown (coaching generated noise)
- #683: "Save to Vault" and "Inject" had no real effect
- #685: morning brief checkboxes were no-op handlers

This indicates specs were good for velocity but **not constraining enough for behavioral correctness**.

### 9.6) Four-Level Completion Taxonomy (New Rule)

| Level | Meaning | Merge OK? | Mark Complete? |
|---|---|---|---|
| scaffolded | Types + routes exist, no real logic | Yes (behind flag) | No |
| wired | Logic exists, calls real APIs | Yes | No |
| validated | Tests pass, negative paths covered | Yes | Almost |
| complete | User-path verification + no blocking TODOs | Yes | Yes |

---

## 10) CAPA Sprint (Corrective Actions — Must Execute Before Wave 7 Closure)

See full spec: [`W7_CAPA_SPRINT.md`](./W7_CAPA_SPRINT.md)

Execution order:
1. **CAPA-1**: Retract "Wave 7 Complete" status (docs only, immediate)
2. **CAPA-4**: Fix LifePanel `resp.ok` check (~30min)
3. **CAPA-2**: Dedicated collective consent storage (~2-3h, migration)
4. **CAPA-3**: Complete collective intelligence engine (~6-8h)
5. **CAPA-5**: Audit remaining no-op UI actions (~2h)
6. **CAPA-6**: Realign analytics event taxonomy (~2h)

Total: ~13-16h. After completion, Wave 7 ai-hub = COMPLETE (with evidence).
Moltworker M1-M3 remains a separate track (~17h).

---

## 11) Handoff Format for Claude Code Sessions

**Preflight block** (before coding):
```text
ACK: [Sprint ID] -- [Sprint Name]
Branch: [branch-name]
Repo: [ai-hub|moltworker]
Files to modify: [explicit list]
Depends on: [merged sprint IDs]
Starting now.
```

**Postflight block** (after coding):
```text
DONE: [Sprint ID]
Build: [pass/fail]
Tests: [pass/fail]
Migrations: [applied/not-applicable]
Docs synced: [yes/no + files]
Manual actions required: [list]
Risks/rollback: [short]
```
