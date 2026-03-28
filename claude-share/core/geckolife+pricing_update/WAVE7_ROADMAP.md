# Wave 7 — Implementation Roadmap

> **Single source of truth** for Wave 7 development across ai-hub and moltworker.
> Upload to: `claude-share/brainstorming/wave7/WAVE7_ROADMAP.md`
> **Created**: 2026-03-28

---

## Overview

Wave 7 implements three interconnected features:
1. **Pricing Model v3** — Kill Deep Mode, go 2-tier Free(€0)/Pro(€5/mo)
2. **Knowledge Flywheel Foundation** — Schema, quality gate, gecko templates, GeScore v2
3. **Project System + Lyra Media** — Project backend, Chat-only integration, Lyra image/video briefs

**Total effort**: ~65h across 8 sprints (5 ai-hub, 3 moltworker)
**Parallelization**: ai-hub and moltworker sprints can run simultaneously

---

## Sprint Dependency Graph

```
W7-S1 (Pricing Rewrite)        ← START HERE (ai-hub, ~13h)
  │
  ├──► W7-S2 (Feature Gates)    (ai-hub, ~4h) — depends on S1
  │
  ├──► W7-S3 (Flywheel Schema)  (ai-hub, ~5h) — independent of S1
  │
  └──► W7-S4 (Flywheel Logic)   (ai-hub, ~8h) — depends on S3

W7-M1 (Lyra Media Extension)   ← PARALLEL (moltworker, ~11h) — independent
  │
  └──► W7-M2 (Smoke Tests)      (moltworker, ~3h) — depends on M1

W7-S5 (Project Backend)         ← PARALLEL (ai-hub, ~12h) — independent
  │
  └──► W7-S6 (Chat Project UI)  (ai-hub, ~6h) — depends on S5

W7-M3 (Moltworker Deploy Prep)  ← LAST (moltworker, ~3h) — after M1+M2
```

---

## Sprint Details

### W7-S1: Pricing Model Rewrite (ai-hub, ~13h)

**Prompt file**: `claude-share/brainstorming/wave7/prompts/W7-S1-pricing-rewrite.md`
**Branch**: `claude/w7-s1-pricing-rewrite-<id>`
**Spec**: `claude-share/brainstorming/wave7/pricing-model-v3.md`

| Task | Effort | Files |
|------|--------|-------|
| Rewrite `pricing.ts` — 2 tiers with new limits | 2h | `src/lib/pricing.ts` |
| Simplify `subscription.ts` — remove Deep Mode | 1h | `src/lib/subscription.ts` |
| Update Stripe mapping + validations | 1h | `src/lib/stripe.ts`, `src/lib/validations/stripe.ts` |
| LLM proxy architecture change — key-based routing | 3h | `src/app/api/llm-proxy/route.ts` |
| Update webhook handler | 1h | `src/app/api/stripe/webhook/route.ts` |
| Update SubscriptionPanel + PricingTable | 3h | `src/components/settings/SubscriptionPanel.tsx`, `src/components/pricing/PricingTable.tsx` |
| Update schema tier comment | 30min | `src/lib/schema.ts` |
| Clean residual env vars from iteration 1 | 30min | `wrangler.toml` or secrets |

**Acceptance**: `npm run build` clean, `npm run test` pass, no references to `deep` tier in src/

---

### W7-S2: Feature Gates (ai-hub, ~4h)

**Prompt file**: `claude-share/brainstorming/wave7/prompts/W7-S2-feature-gates.md`
**Branch**: `claude/w7-s2-feature-gates-<id>`
**Depends on**: W7-S1

| Task | Effort | Files |
|------|--------|-------|
| Create `feature-gates.ts` with module/gecko/vault/project limits | 1h | `src/lib/feature-gates.ts` (NEW) |
| Create `useFeatureGate` hook | 1h | `src/hooks/useFeatureGate.ts` (NEW) |
| Wire gates into cockpit tab visibility | 1h | `src/components/cockpit/CockpitTabs.tsx` |
| Add gate checks to vault save endpoints | 30min | `src/app/api/vault/*/route.ts` |
| Add gate checks to project create endpoint | 30min | `src/app/api/projects/route.ts` (once created in S5) |

**Acceptance**: Free users see only Chat tab; Pro users see all tabs. Vault save returns 403 at 50 entries for free users.

---

### W7-S3: Knowledge Flywheel Schema (ai-hub, ~5h)

**Prompt file**: `claude-share/brainstorming/wave7/prompts/W7-S3-flywheel-schema.md`
**Branch**: `claude/w7-s3-flywheel-schema-<id>`
**Spec**: `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.1.md` §6
**Independent** — can run parallel to S1

| Task | Effort | Files |
|------|--------|-------|
| D1 migration: `knowledge_captures` table | 1h | `drizzle/migrations/XXXX_knowledge_captures.sql` |
| D1 migration: `knowledge_edges` table | 1h | `drizzle/migrations/XXXX_knowledge_edges.sql` |
| D1 migration: `knowledge_reuses` table | 30min | `drizzle/migrations/XXXX_knowledge_reuses.sql` |
| D1 migration: `morning_brief_prefs` table | 30min | `drizzle/migrations/XXXX_morning_brief_prefs.sql` |
| ALTER TABLE: `prompt_library` + `journal_entries` | 30min | `drizzle/migrations/XXXX_flywheel_columns.sql` |
| Drizzle schema TypeScript | 1h | `src/lib/schema.ts` (extend) |
| Zod validation schemas for flywheel | 30min | `src/lib/validations/flywheel.ts` (NEW) |

**Acceptance**: `npx drizzle-kit generate` runs clean. Schema matches spec §6.

---

### W7-S4: Flywheel Logic — Quality Gate + GeScore v2 + Gecko Templates (ai-hub, ~8h)

**Prompt file**: `claude-share/brainstorming/wave7/prompts/W7-S4-flywheel-logic.md`
**Branch**: `claude/w7-s4-flywheel-logic-<id>`
**Spec**: `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.1.md` §2-5, §7
**Depends on**: W7-S3

| Task | Effort | Files |
|------|--------|-------|
| Quality gate — JS heuristic classifier | 2h | `src/lib/flywheel/quality-gate.ts` (NEW) |
| GeScore v2 formula — 4 metric calculations | 2h | `src/lib/flywheel/gescore.ts` (NEW) |
| Gecko coaching templates — static strings with variable slots | 1.5h | `src/lib/flywheel/gecko-templates.ts` (NEW) |
| GeScore API endpoint | 1h | `src/app/api/flywheel/gescore/route.ts` (NEW) |
| Capture logging utility | 1h | `src/lib/flywheel/capture.ts` (NEW) |
| Tests for quality gate + GeScore + templates | 30min | `src/lib/flywheel/__tests__/` |

**Acceptance**: GeScore endpoint returns correct scores. Quality gate correctly filters substantive vs trivial conversations. All templates interpolate variables without LLM calls.

---

### W7-S5: Project System Backend (ai-hub, ~12h)

**Prompt file**: `claude-share/brainstorming/wave7/prompts/W7-S5-project-backend.md`
**Branch**: `claude/w7-s5-project-backend-<id>`
**Spec**: `claude-share/brainstorming/wave7/project-architecture-lyra-media-spec-v1.1.md` §2
**Independent** — can run parallel to S1-S4

| Task | Effort | Files |
|------|--------|-------|
| D1 migration: `projects` table | 30min | `drizzle/migrations/XXXX_projects.sql` |
| D1 migration: `project_items` table | 30min | `drizzle/migrations/XXXX_project_items.sql` |
| D1 migration: `prompt_library` add `project_id` FK | 15min | `drizzle/migrations/XXXX_vault_project_link.sql` |
| Drizzle schema TypeScript | 1h | `src/lib/schema-projects.ts` (NEW) |
| Zod validations (6 schemas) | 1h | `src/lib/validations/projects.ts` (NEW) |
| API: POST /api/projects (create) | 45min | `src/app/api/projects/route.ts` (NEW) |
| API: GET /api/projects (list) | 30min | same file |
| API: GET /api/projects/:id (get with counts) | 45min | `src/app/api/projects/[id]/route.ts` (NEW) |
| API: PATCH /api/projects/:id (update) | 30min | same file |
| API: DELETE /api/projects/:id (archive) | 30min | same file |
| API: POST /api/projects/:id/items (save item) | 45min | `src/app/api/projects/[id]/items/route.ts` (NEW) |
| API: GET /api/projects/:id/items (list) | 30min | same file |
| API: PATCH /api/projects/:id/items/:itemId | 30min | `src/app/api/projects/[id]/items/[itemId]/route.ts` (NEW) |
| API: POST /api/projects/:id/items/:itemId/transfer | 45min | same file |
| API: DELETE /api/projects/:id/items/:itemId | 15min | same file |
| Zustand project store | 1h | `src/stores/project-store.ts` (NEW) |
| Tests (API routes) | 1.5h | `src/app/api/projects/__tests__/` |

**Acceptance**: All 7 API endpoints respond correctly. Zod validates all inputs. Auth required on all routes. Rate limiting active.

---

### W7-S6: Chat-Only Project UI (ai-hub, ~6h)

**Prompt file**: `claude-share/brainstorming/wave7/prompts/W7-S6-chat-project-ui.md`
**Branch**: `claude/w7-s6-chat-project-ui-<id>`
**Depends on**: W7-S5

| Task | Effort | Files |
|------|--------|-------|
| ProjectSelector dropdown in TopStrip | 2h | `src/components/cockpit/ProjectSelector.tsx` (NEW) |
| Context card above Chat input (transferred items) | 2h | `src/components/chat/ProjectContextCard.tsx` (NEW) |
| "Save to project" button on chat responses | 1h | `src/components/chat/SaveToProjectButton.tsx` (NEW) |
| Wire Zustand store to Chat component | 1h | `src/components/chat/ChatPanel.tsx` (modify) |

**Acceptance**: User can create project from dropdown, save chat responses to project, see project items as context cards. Mobile responsive.

---

### W7-M1: Lyra Media Extension (moltworker, ~11h)

**Prompt file**: `claude-share/brainstorming/wave7/prompts/W7-M1-lyra-media.md`
**Branch**: `claude/w7-m1-lyra-media-<id>`
**Spec**: `claude-share/brainstorming/wave7/project-architecture-lyra-media-spec-v1.1.md` §3
**Independent** — runs in parallel with all ai-hub work

| Task | Effort | Files |
|------|--------|-------|
| Types: `ImageBrief`, `VideoBrief` + type guards | 2h | `src/skills/lyra/media-types.ts` (NEW) |
| Platform dimension maps | 30min | same file |
| System prompts (image + video) | 2h | `src/skills/lyra/media-prompts.ts` (NEW) |
| Handler extension: `image` + `video` submodes | 3h | `src/skills/lyra/handler.ts` (modify) |
| Command map: `/image`, `/imagine`, `/video`, `/storyboard` | 15min | `src/skills/command-map.ts` (modify) |
| Telegram renderer: image_brief + video_brief | 1h | `src/skills/renderers/telegram.ts` (modify) |
| Web renderer extension | 30min | `src/skills/renderers/web.ts` (modify) |
| SkillResult kind union extension | 15min | `src/skills/types.ts` (modify) |
| Tests | 1.5h | `src/skills/lyra/__tests__/media.test.ts` (NEW) |

**Acceptance**: `/image --for instagram-post --style photorealistic create a sunset scene` returns valid `image_brief` SkillResult via Telegram and API. `/video --for instagram-reel --duration 30 product launch teaser` returns valid `video_brief`. All type guards pass. ~25 new tests.

---

### W7-M2: Moltworker Integration Tests (moltworker, ~3h)

**Prompt file**: `claude-share/brainstorming/wave7/prompts/W7-M2-moltworker-tests.md`
**Branch**: `claude/w7-m2-integration-tests-<id>`
**Depends on**: W7-M1

| Task | Effort | Files |
|------|--------|-------|
| `/simulate/chat` integration tests for Lyra media | 1.5h | `src/routes/__tests__/lyra-media.test.ts` (NEW) |
| Cross-skill render consistency checks | 1h | `src/skills/renderers/__tests__/` |
| R2 prompt upload for Lyra media personas | 30min | R2 bucket manual upload |

**Acceptance**: Simulation endpoint returns correct SkillResult for image/video commands. Renderers produce valid Telegram HTML and JSON web output.

---

### W7-M3: Moltworker Deploy Prep (moltworker, ~3h)

**Prompt file**: `claude-share/brainstorming/wave7/prompts/W7-M3-deploy-prep.md`
**Branch**: `claude/w7-m3-deploy-prep-<id>`
**Depends on**: W7-M1 + W7-M2

| Task | Effort | Files |
|------|--------|-------|
| Update GLOBAL_ROADMAP.md with Wave 7 status | 30min | `claude-share/core/GLOBAL_ROADMAP.md` |
| Update WORK_STATUS.md | 30min | `claude-share/core/WORK_STATUS.md` |
| Update next_prompt.md for post-Wave 7 | 30min | `claude-share/core/next_prompt.md` |
| KV namespace creation (if not done) | 15min | `wrangler kv:namespace create nexus-cache` |
| Pre-deploy checklist | 45min | Manual |

**⚠️ DEPLOYMENT REMINDER**: Before deploy, delete R2 bucket contents at https://dash.cloudflare.com/5200b896d3dfdb6de35f986ef2d7dc6b/r2/default/buckets/moltbot-data

---

## Execution Order (Recommended)

**Week 1**: W7-S1 (pricing) + W7-M1 (Lyra media) in parallel
**Week 2**: W7-S2 (gates) + W7-S3 (schema) + W7-M2 (tests)
**Week 3**: W7-S4 (flywheel logic) + W7-S5 (project backend) + W7-M3 (deploy)
**Week 4**: W7-S6 (Chat project UI)

**PetrAnto actions (between sprints)**:
- Create new Stripe Pro product at €5/mo → get price ID
- Archive Deep Mode product in Stripe dashboard
- Run `wrangler kv:namespace create nexus-cache` for moltworker if not done
- Upload Lyra media R2 prompts after W7-M1

---

## Post-Wave 7 Queue

These are NOT in Wave 7 but are next:

| Task | Repo | Effort | Depends On |
|------|------|--------|-----------|
| Full FreeModelRouter (spec v1.4 Phase 1 MVP) | ai-hub | 12h | W7-S1 (pricing rewrite) |
| Workers AI binding confirmation | ai-hub | 2h | Nothing |
| Embedding pipeline (bge-m3 on save events) | ai-hub | 6h | Workers AI binding |
| Module UIs (Creator → Code → SitMon → Coaching) | ai-hub | 52-74h | Separate spec needed |
| CIS knowledge cards | ai-hub | 8h | Embeddings + module UIs |
| Morning brief | ai-hub | 8h | Embeddings + scheduled workers |
| ST smoke tests | moltworker | 3h | Nothing (pending from Sprint 4) |

---

## Cross-Reference Index

| Spec | Location | Used By |
|------|----------|---------|
| Pricing Model v3 | `claude-share/brainstorming/wave7/pricing-model-v3.md` | W7-S1, W7-S2 |
| Knowledge Flywheel v1.1 | `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.1.md` | W7-S3, W7-S4 |
| Project Architecture v1.1 | `claude-share/brainstorming/wave7/project-architecture-lyra-media-spec-v1.1.md` | W7-S5, W7-S6, W7-M1 |
| Free Models Spec v1.4 | `claude-share/brainstorming/wave6/free-models-integration-spec-v1.4.md` | Post-Wave 7 FreeModelRouter |
| Workers AI Spec v1.1 | `claude-share/brainstorming/wave6/workers-ai-native-provider-spec-v1.1.md` | Post-Wave 7 embeddings |
| Gecko Skills Spec v1.2 | `claude-share/brainstorming/gecko-specialist-skills-spec-v1.2-FINAL.md` | W7-M1 (Lyra extension) |
| AI Code Standards | `claude-share/core/AI_CODE_STANDARDS.md` | All sprints |
| Sync Checklist | `claude-share/core/SYNC_CHECKLIST.md` | All sprints |

---

*Last Updated: 2026-03-28*
