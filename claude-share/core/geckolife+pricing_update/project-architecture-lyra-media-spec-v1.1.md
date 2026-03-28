# Storia Digital — Project Architecture & Lyra Media Extension v1.1

**Version**: 1.1 — Wave 7 Spec (revised)
**Date**: 2026-03-28
**Author**: Claude Opus 4.6 + PetrAnto
**Scope**: ai-hub Project System + Moltworker Lyra v2 Media Skills
**Status**: DRAFT — Awaiting multi-AI review
**Upload to**: `claude-share/brainstorming/wave7/project-architecture-lyra-media-spec.md`
**Supersedes**: v1.0

---

## Changelog v1.0 → v1.1

| Change | Reason |
|--------|--------|
| Added §8 Prerequisites Audit | v1.0 assumed module UIs exist in ai-hub. They don't. Skills are Telegram-only + API. |
| Gecko roster corrected to 8 | Old capability class eliminated |
| Module input bar section updated with actual Moltworker skill commands | Mapped to shipped S1-S3 commands, not hypothetical ones |
| Lyra media commands noted as FUTURE (not shipped in Sprint 4) | Sprint 4 shipped text-only Lyra: /write, /rewrite, /headline, /repurpose. Media briefs are v2. |
| Pricing references updated to Free(€0)/Pro(€5) | Kill Deep Mode, 2-tier model |
| Added §9 Codebase State Reconciliation | Maps what exists vs what's assumed |
| Effort estimates recalibrated | Added prerequisite work not counted in v1.0 |

---

## 1. Executive Summary

*(Core thesis unchanged from v1.0)*

This spec defines two tightly coupled systems:

**Part A — Project Architecture**: A cross-module project container in ai-hub that lets users flow work through SitMon → Chat → Code → Creator within a single project context.

**Part B — Lyra Media Extension**: Two new `SkillResult` kinds (`image_brief` and `video_brief`) for moltworker's Lyra skill.

**Core principle**: Lyra is the creative director, not the renderer. Projects are explicit user-controlled context, not auto-injection magic.

### 1.1 Critical Dependency — Module UIs Do Not Exist Yet (NEW)

As of March 28, 2026, the ai-hub cockpit has a **Chat tab** as its primary interface. The Creator, SitMon, Code, and Coaching tabs exist in concept but **have no functional UI in the codebase**. The moltworker skills (Lyra, Spark, Nexus, Orchestra) are accessible via:

- Telegram commands (`/write`, `/research`, `/orch`, etc.)
- API endpoint: `POST /api/skills/execute` with `X-Storia-Secret` auth

The Project Architecture's cross-module flow (SitMon → Chat → Creator → Code) requires these module UIs to exist. This means:

- **Part A (Projects)** can ship its backend (schema, API routes, Zustand store) independently
- **Part A (Suggestion Rail + module input bars)** depends on module UIs being built
- **Part B (Lyra Media)** can ship as moltworker-side code independently; the ai-hub execution pipeline depends on the Creator module UI

---

## 2-7. Parts A & B Technical Spec

*(Unchanged from v1.0 — D1 schema, Drizzle schema, Zod validations, API routes, SuggestionRail component, SkillRequest extension, Lyra media types/handlers/prompts/renderers all remain as specified)*

---

## 8. Prerequisites Audit (NEW in v1.1)

### 8.1 What Currently Exists in Moltworker

| Skill | Status | Commands | Tests |
|-------|--------|----------|-------|
| Orchestra (Edoc) | ✅ Shipped | `/orch` | In 2573 total |
| Lyra (Crex) — TEXT ONLY | ✅ Shipped (S1) | `/write`, `/rewrite`, `/headline`, `/repurpose` | 30 new tests |
| Spark (Tach) | ✅ Shipped (S2) | `/save`, `/spark`, `/gauntlet`, `/brainstorm`, `/ideas` | 31 new tests |
| Nexus (Omni) | ✅ Shipped (S3 + S3.7 DO) | `/research`, `/dossier` | 33 new tests |
| Lyra Media (image_brief, video_brief) | ❌ NOT shipped | `/image`, `/imagine`, `/video`, `/storyboard` | Part B of this spec |

### 8.2 What Does NOT Exist in ai-hub

| Component | Required For | Effort to Build | Notes |
|-----------|-------------|----------------|-------|
| Creator module tab + UI | Part A (module input bars), Part B (brief display + generate button) | 12-16h | Needs Crex Lyrae persona integration |
| SitMon module tab + UI | Part A (cross-module flow) | 16-24h | Needs Nexus research display, TradingView widgets |
| Code module tab + UI | Part A (cross-module flow) | 12-16h | Needs Orchestra integration, Monaco editor |
| Coaching module tab + UI | Knowledge Flywheel dashboard | 8-12h | Needs GeScore v2, flywheel visualization |
| Skills execution from web UI | All module tabs | 4-6h | Wire `POST /api/skills/execute` to cockpit UI |

**Total prerequisite work for module UIs**: ~52-74h — this is NOT counted in Part A's 26h or Part B's 21h.

### 8.3 What CAN Ship Without Module UIs

| Component | Ships Independently? | Notes |
|-----------|---------------------|-------|
| D1 schema (projects + project_items) | ✅ Yes | Pure migration, no UI dependency |
| API routes (7 endpoints) | ✅ Yes | Backend-only, testable via API |
| Zustand project store | ✅ Yes | State management, ready for UI |
| Zod validations | ✅ Yes | Validation layer |
| Lyra media types + handler (moltworker) | ✅ Yes | Extends moltworker, testable via Telegram |
| Lyra media renderers (Telegram + web) | ✅ Yes | Extends existing renderers |
| SuggestionRail component | ❌ No | Needs module tabs to exist |
| ProjectSelector in TopStrip | ⚠️ Partial | Can show in Chat tab only |
| Module input bar adaptations | ❌ No | Module tabs don't exist |
| ai-hub media execution pipeline | ❌ No | Creator canvas doesn't exist |

### 8.4 Recommended Phasing (REVISED)

| Phase | Scope | Effort | Dependencies |
|-------|-------|--------|-------------|
| **P1**: Project backend | Schema + API + Zustand + Zod | 7h | None |
| **P2**: Chat-only project context | ProjectSelector in Chat tab, context card above Chat input | 5h | P1 |
| **P3**: Lyra media types + handler (moltworker) | image_brief + video_brief SkillResult kinds | 8h | None — parallel |
| **P4**: Module UIs (Creator, SitMon, Code, Coaching) | Full module tabs in cockpit | 52-74h | Separate spec |
| **P5**: SuggestionRail + cross-module flow | Right panel, transfer flow | 11h | P4 |
| **P6**: ai-hub media execution pipeline | Provider adapters, Creator canvas | 9h | P4 |
| **P7**: Integration + polish | End-to-end cross-module flow | 5h | All above |

**Key insight**: P1+P2+P3 can ship in ~20h and deliver value: projects work in Chat, Lyra media briefs work in Telegram. The full cross-module vision (P4-P7) requires 77-99h of additional work, most of which is module UI development.

---

## 9. Codebase State Reconciliation (NEW in v1.1)

### 9.1 ai-hub Milestone Status (as of March 25, 2026)

| Gate | Status | Implications for This Spec |
|------|--------|---------------------------|
| M0 — "First 5 Minutes" | ✅ PASSED | Onboarding works, Chat works, geckos work |
| M1 — "Paying User" | ✅ PASSED | Free tier MVP (7 models), Stripe checkout works, PostHog tracking |
| M2 — "Connected" (ai-hub ↔ moltworker) | 🔄 Partial | Skills API exists but no web UI for skills |
| M4 — "Specialist" (moltworker skills) | ✅ PASSED | All 4 skills shipped, 2573 tests |

### 9.2 Pricing Code State

The codebase currently implements Free/Deep($3)/Pro($9). The 2-tier rewrite (Free/Pro(€5)) is a prerequisite for this spec's Pro-gated features (Projects unlimited, all modules, mode geckos). See Knowledge Flywheel spec v1.1 §15 for the complete file-by-file change list.

### 9.3 Moltworker Lyra — Current vs Extended

| Feature | Current (S1, shipped) | Extended (Part B, this spec) |
|---------|----------------------|------------------------------|
| `/write` | ✅ LyraArtifact (text) | Unchanged |
| `/rewrite` | ✅ Rewritten text | Unchanged |
| `/headline` | ✅ HeadlineResult | Unchanged |
| `/repurpose` | ✅ Repurposed text | Unchanged |
| `/image` | ❌ Not implemented | NEW: Returns `image_brief` SkillResult |
| `/video` | ❌ Not implemented | NEW: Returns `video_brief` SkillResult |

The media extension adds 2 new SkillResult kinds and 4 new commands to the existing Lyra skill. It does NOT modify the existing text commands. The `SkillResult.kind` union in `src/skills/types.ts` currently has: `'text' | 'draft' | 'dossier' | 'gauntlet' | 'digest' | 'source_plan' | 'capture_ack' | 'error'`. Part B adds `'image_brief' | 'video_brief'`.

---

## 10. Open Questions — UPDATED

*(Carries forward v1.0 questions 1-8, updates based on codebase analysis)*

| # | Question | v1.0 Recommendation | v1.1 Update |
|---|----------|--------------------|----|
| 1 | Max items per project? | 100 | Unchanged — 100 is safe for D1 |
| 2 | Project sharing? | Phase 2 | Unchanged |
| 3 | Auto-save every SkillResult? | Opt-in | Unchanged |
| 4 | Suggestion Rail default? | Collapsed | **Updated**: Hidden until module UIs exist. Show in Chat-only mode as a simple "Project items" expandable panel. |
| 5 | Image brief direct generation? | Always preview | Unchanged |
| 6 | Video brief auto-execute? | Step-by-step | Unchanged |
| 7 | Single vs multi-pass for briefs? | Single-pass | Unchanged — consistent with v1.2 skill spec |
| 8 | Project templates? | Phase 2 | Unchanged |
| **9** | **Module UI development ordering?** | *New* | **Creator first** (most tangible Pro value for content users), then Code (developer value), then SitMon (research value), then Coaching (flywheel dashboard). |
| **10** | **Should Projects work in Chat-only before module UIs ship?** | *New* | **Yes** — P2 delivers a ProjectSelector that scopes Chat conversations to projects. Users can accumulate project items from Chat and transfer them to modules once those UIs ship. This validates the project concept without the full 70h module UI investment. |

---

## 11. Resolved Decisions — UPDATED

*(Adds to v1.0 decisions)*

| Decision | Rationale |
|----------|-----------|
| *(all v1.0 decisions unchanged)* | |
| Module UIs are a separate spec, not Part A | Part A's 26h estimate was for project infrastructure, not module development. Module UIs are 52-74h of distinct work. |
| Projects ship Chat-only first | Validate concept with minimal investment before building cross-module flow |
| Lyra media extension can ship to moltworker independently | Telegram users get `/image` and `/video` briefs immediately. ai-hub execution pipeline waits for Creator module UI. |
| Pricing rewrite is a prerequisite for Pro-gated features | Feature gates (modules, mode geckos, unlimited vault/projects) depend on the 2-tier model being implemented in code |

---

## 12. Revised Total Effort

| Scope | v1.0 Estimate | v1.1 Estimate | Notes |
|-------|--------------|--------------|-------|
| Part A — Project backend + API | 7h | 7h | Unchanged |
| Part A — Suggestion Rail + ProjectSelector | 11h | 5h (Chat-only) + 11h (full, after module UIs) | Split into phases |
| Part A — Module input adaptations | 7h | 0h (deferred to module UI spec) | Depends on modules existing |
| Part A — Context card + Zustand + skill integration | 7h | 5h (Chat-only version) | Simplified for Phase 1 |
| Part B — Lyra media types + handler (moltworker) | 11h | 11h | Unchanged |
| Part B — ai-hub execution pipeline + Creator canvas | 10h | 0h (deferred to Creator module spec) | Depends on Creator module |
| **Shippable now (P1+P2+P3)** | N/A | **~20h** | Projects backend + Chat integration + Lyra media in moltworker |
| **Full vision (P4-P7)** | N/A | **~77-99h additional** | Module UIs + cross-module flow + media execution |
| **v1.0 total** | **47h** | — | Did not include module UI work |
| **v1.1 honest total** | — | **~97-119h** | Includes all prerequisite module UI work |

---

*End of spec v1.1. Upload to `claude-share/brainstorming/wave7/project-architecture-lyra-media-spec.md` (replace v1.0) after multi-AI review.*
