# Wave 7 Canonical Delivery Spec (Deep-Review Consolidation)

> Purpose: unify all files in `claude-share/core/geckolife+pricing_update` into one execution-safe spec that Claude Code can implement without ambiguity.
> Source set reviewed: **all files in this folder** (including orphan file `i`).
> Date: 2026-03-29.

---

## 1) Canonical Scope (What ships in Wave 7)

Wave 7 is split into 9 sprint units across 2 repos:

- **ai-hub track (S1–S6)**
  - S1: pricing rewrite (2-tier)
  - S2: feature gates
  - S3: flywheel schema
  - S4: flywheel logic
  - S5: projects backend
  - S6: chat-only project UI
- **moltworker track (M1–M3)**
  - M1: Lyra media extension
  - M2: integration/smoke tests
  - M3: deploy prep + sync docs

### Non-goals in Wave 7 (explicit)

- Full module UI buildout (Creator/Code/SitMon/Coaching full product surfaces).
- FreeModelRouter full rollout beyond the minimum gating architecture required by S1/S2.
- Any feature requiring new paid-model lock by default (pricing v3 forbids model-paywall strategy).

---

## 2) Canonical Product Rules (must not drift)

1. **Pricing is 2-tier only**: `free | pro`.
2. **No Deep tier anywhere**: no runtime logic, no webhook mapping, no UI text, no validation enum.
3. **Model access is key-availability routed, not blocked by model-name prefixes**.
4. **Knowledge Flywheel value is Pro differentiation**, not premium-model gating.
5. **Collective intelligence is opt-in and anonymized metadata only**.

---

## 3) Dependency-Safe Execution Order

## Phase A (parallel-safe start)
- A1: S1 (ai-hub)
- A2: S3 (ai-hub)
- A3: S5 (ai-hub)
- A4: M1 (moltworker)

## Phase B
- B1: S2 after S1
- B2: S4 after S3
- B3: S6 after S5
- B4: M2 after M1

## Phase C
- C1: M3 after M1 + M2
- C2: full integration verification across repos

---

## 4) Sprint-by-Sprint Exact Specs

## S1 — Pricing Rewrite (ai-hub)

### Hard requirements
- Rewrite pricing constants to 2-tier (`free`, `pro`) with EUR values and updated limits/features.
- Remove all `deep`, `team`, yearly leftovers from:
  - pricing/subscription logic
  - stripe mapping + webhook processing
  - tier validators
  - UI pricing/subscription components
- Update LLM proxy behavior:
  - remove premium-model 402 hard blocking by model prefix
  - route by provider key availability with fallback path to free router.

### Done definition
- Build/test pass.
- Repository grep returns no tier/runtime deep references in target source areas.
- Stripe webhook upgrades/downgrades still function for `free ↔ pro`.

## S2 — Feature Gates (ai-hub)

### Hard requirements
- Centralized gate table (module/gecko/vault/project/features).
- Reusable gate accessors + React hook.
- Enforce gates in both UI and backend create flows (vault/project).

### Done definition
- Free user gets chat-only + limits enforced.
- Pro unlocks full configured module/gecko set.
- API returns deterministic limit errors (`limit_reached` + upgrade path).

## S3 — Flywheel Schema (ai-hub)

### Hard requirements
- Create 4 tables:
  - `knowledge_captures`
  - `knowledge_edges`
  - `knowledge_reuses`
  - `morning_brief_prefs`
- Add/alter required columns in `prompt_library` and `journal_entries`.
- Add Drizzle + Zod parity with SQL schema.

### Done definition
- Migration applies cleanly.
- Drizzle generation/typecheck is clean.
- Schema contracts used by later sprint APIs compile without stub hacks.

## S4 — Flywheel Logic (ai-hub)

### Hard requirements
- Implement quality gate for capture eligibility.
- Implement GeScore v2 with 4 metric inputs.
- Implement gecko coaching templates + interpolation-safe delivery.
- Expose API endpoint(s) for score/proposal logic.

### Done definition
- Quality gate filters trivial chats.
- Score formula returns stable values and commentary banding.
- Template catalog complete and typed.

## S5 — Project Backend (ai-hub)

### Hard requirements
- Create project + project_item persistence and APIs.
- Support transfer/state mutation and ownership checks.
- Add validation and rate-limiting/auth parity with existing API patterns.

### Done definition
- CRUD + transfer route set passes integration tests.
- Project-item cardinality + user ownership enforced.

## S6 — Chat Project UI (ai-hub)

### Hard requirements
- Project selector + project context card + save-to-project action in chat flow.
- Mobile-safe rendering and Zustand wiring.

### Done definition
- User can create/select project, save chat output, and reuse items in chat context.

## M1 — Lyra Media (moltworker)

### Hard requirements
- Extend Lyra skill with `image` + `video` brief generation mode.
- Add type guards, prompt packs, renderer support (Telegram + web), and command aliases.

### Done definition
- `/image` and `/video` commands produce valid structured results end-to-end.
- Tests cover format + parser + renderer.

## M2 — Moltworker Integration Tests

### Hard requirements
- Simulate routes for media flows.
- Cross-render consistency checks.

### Done definition
- Simulation pipeline confirms valid responses + renderer outputs.

## M3 — Deploy Prep + Sync

### Hard requirements
- Update wave tracking docs and sync files.
- Perform deploy prerequisites checklist and operational verifications.

### Done definition
- Documentation state reflects real merge status.
- Deploy checklist and post-deploy smoke tests complete.

---

## 5) Cross-File Conflict Resolutions (from deep review)

1. **Roadmap effort totals differ by document**
   - Canonicalization: use per-sprint effort listed in each sprint prompt as source of truth.
2. **Upload paths vary (`core/` vs `brainstorming/wave7/`)**
   - Canonicalization: implementation prompts live in sprint files; mirrored archival location in `brainstorming/wave7/` is optional output.
3. **Some prompts imply unavailable module UIs**
   - Canonicalization: obey architecture v1.1 prerequisite audit; ship chat-surface integrations first.
4. **Orphan file `i` exists and contains no usable spec content**
   - Canonicalization: ignore in implementation planning.

---

## 6) Mandatory Quality Gates (all sprints)

- Typecheck + tests on each sprint branch.
- No secrets in commits.
- Sync docs updated after each sprint close.
- Each sprint PR includes explicit scope, risk, and rollback notes.

---

## 7) Handoff Format for Claude Code Sessions

Use this exact preflight block before coding:

```text
ACK: [Sprint ID] — [Sprint Name]
Branch: [branch-name]
Repo: [ai-hub|moltworker]
Files to modify: [explicit list]
Depends on: [merged sprint IDs]
Starting now.
```

And this postflight block after coding:

```text
DONE: [Sprint ID]
Build: [pass/fail]
Tests: [pass/fail]
Migrations: [applied/not-applicable]
Docs synced: [yes/no + files]
Manual actions required: [list]
Risks/rollback: [short]
```

