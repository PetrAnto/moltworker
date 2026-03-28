# Gecko Life → Knowledge Flywheel — Architecture Spec v1.1

**Created**: 2026-03-28
**Revised**: 2026-03-28 (v1.1 — pricing model update, gecko roster correction, prerequisite audit, codebase reconciliation)
**Author**: Claude (architecture) + PetrAnto (vision)
**Repos**: `PetrAnto/ai-hub` (storia.digital)
**Status**: DRAFT — Ready for multi-AI review
**Upload to**: `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.md`
**Supersedes**: Gecko Life as standalone productivity dashboard (Phase 3C); v1.0 of this spec

---

## Changelog v1.0 → v1.1

| Change | Reason |
|--------|--------|
| Gecko roster corrected to 8 (was inconsistently referencing 12) | Old "capability" class (Tool Guy, Artist, Researcher, Based Dev) eliminated — merged into 4 mode geckos |
| Pricing model updated: Kill Deep Mode (€3/mo), go 2-tier Free (€0) / Pro (€5/mo) | Free models are now good enough that model access gating is obsolete; revenue comes from knowledge OS, not model access |
| Added §14 Prerequisites Audit — maps all unbuilt infrastructure | v1.0 assumed Workers AI binding, Vectorize, module UIs exist. They don't yet. |
| Added §15 Codebase Reconciliation — lists specific files to change | v1.0 was architecture-only; v1.1 maps to actual code paths |
| Tach Cygnus confirmed as Chat + Coaching (not Chat only) | Tach/Spark owns both the Chat module and the Coaching (Gecko Life) module |
| Free tier feature set expanded: all free models via FreeModelRouter, 4 personality geckos, 50 vault entries, 3 projects | Aligned with 2-tier pricing decision |
| Pro tier feature set consolidated: BYOK + full flywheel + 4 mode geckos + all modules + unlimited vault/projects | Single paid tier at €5/mo replaces Deep(€3)+Pro(€9) |
| GeScore gecko assignment updated to use correct 4 personality geckos only | Was referencing mode geckos for coaching; personality geckos are the coaches |

---

## 1. Thesis

*(Unchanged from v1.0)*

Gecko Life is not a productivity dashboard that lives inside an AI platform. It is a **personal knowledge operating system** whose interface happens to include tasks, journal, and calendar. The AI platform (Chat, Creator, SitMon, Code) feeds it. The geckos coach it. The flywheel compounds it.

Every AI tool on the market treats conversations as disposable. Storia treats them as raw material for a personal knowledge graph that gets more valuable every day. The user's accumulated intelligence — not model access — is the moat.

**Product positioning shift**: "Personal knowledge operating system powered by any AI" replaces "ChatGPT alternative with multiple models."

**Revenue justification shift**: Users renew because their knowledge graph compounds monthly, not because they need another chat window.

---

## 2. The Three Tiers

*(Unchanged from v1.0 — Learning, Capture, Optimization tiers remain as designed)*

---

## 3. Workers AI Cost Model

*(Unchanged from v1.0 — neuron budgets remain accurate)*

---

## 4. Gecko Roles Redefined — CORRECTED

The 8 geckos (not 12 — the old "capability" class is eliminated):

### 4.1 Personality Geckos — Knowledge Coaches (Free Tier, Gold Border)

These are the coaches that drive the knowledge flywheel. They appear on the free tier, creating emotional attachment and habit formation.

**Zori Halley — Discovery**
Personality: Excitable, tangential, associative.
Knowledge role: Surfaces unexpected connections across domains.
Trigger: New content with >0.75 cosine similarity to existing knowledge from a *different domain*.

**Kai Polaris — Integration**
Personality: Calm, connective, reflective.
Knowledge role: Synthesizes patterns across entries. Suggests creating collections.
Trigger: 3+ entries within 0.8 cosine distance in 7-day window.

**Vex Sirius — Pattern Extraction**
Personality: Analytical, precise, efficiency-obsessed.
Knowledge role: Identifies redundancy and optimization opportunities.
Trigger: 2+ vault entries with >0.85 cosine similarity (near-duplicates).

**Razz Io — Application Pressure**
Personality: Intense, impatient, results-oriented.
Knowledge role: Enforces the capture-to-application cycle.
Trigger: Deterministic captures/reuses ratio > 5:1 in 14-day window.

### 4.2 Mode Geckos — Module Operators (Pro Tier, Blue Border)

These own modules and moltworker skills. They are NOT coaches — they are operators. Their specialist knowledge surfaces in the module UIs.

| Mode Gecko | Skill | Module | Moltworker Commands |
|------------|-------|--------|-------------------|
| Edoc Rigel | Orchestra | Code/IDE | `/orch` |
| Tach Cygnus | Spark | Chat + Coaching | `/save`, `/spark`, `/gauntlet`, `/brainstorm`, `/ideas` |
| Omni Vega | Nexus | Situation Monitor / Web3 | `/research`, `/dossier` |
| Crex Lyrae | Lyra | Creator / image+video | `/write`, `/rewrite`, `/headline`, `/repurpose` |

**Note on Tach Cygnus**: Tach owns BOTH Chat and Coaching (Gecko Life). This means the Coaching module — where the knowledge flywheel dashboard lives — is a Pro feature. Free users get personality gecko coaching via template strings in the Chat interface; Pro users get the full Coaching dashboard with GeScore v2, knowledge graph visualization, and morning briefs.

### 4.3 Free Tier Coaching Surface

Free users still get gecko coaching, but through a limited surface:

- **Post-chat capture prompts**: Personality geckos nudge saves (template strings, $0)
- **GeScore v1 lite**: Basic activity tracking shown in a compact widget, not the full Coaching dashboard
- **Vault ceiling messaging**: When hitting 50 entries, personality geckos explain the value of the full flywheel
- **No morning briefs, no knowledge graph UI, no scheduled intelligence**

This creates natural upgrade pressure without degrading the free experience.

---

## 5. GeScore v2 — Growth Metrics

### 5.1 CORRECTED Gecko Score Commentary

Uses personality geckos only (they are the coaches):

| Score Range | Gecko | Template |
|-------------|-------|----------|
| 0-15 | Kai Polaris | "Every knowledge journey starts with a single question. What are you curious about today?" |
| 16-35 | Zori Halley | "I see seeds! {velocity} new captures this week. Now let's connect them to something..." |
| 36-55 | Vex Sirius | "Metrics: {velocity} velocity, {capture_rate}% capture, {reuse_rate}% reuse. The reuse number needs work." |
| 56-75 | Vex Sirius | "Solid knowledge graph. {connection_density} connection density. You're starting to think in systems." |
| 76-90 | Razz Io | "Your graph is COMPOUNDING. {reuse_rate}% reuse rate. Keep this up." |
| 91-100 | Razz Io | "UNSTOPPABLE. {edges} connections across {nodes} knowledge nodes. You're not using AI — you're growing with it." |

*(Rest of GeScore v2 formula unchanged from v1.0)*

---

## 6-13. Unchanged from v1.0

Schema additions, data flow architecture, CIS integration, morning brief, collective intelligence, implementation phases, relationship to existing specs, and what this does NOT change — all remain as specified in v1.0.

---

## 14. Prerequisites Audit (NEW in v1.1)

**v1.0 assumed infrastructure that does not exist in the codebase as of March 28, 2026.** This section maps what must be built before the flywheel can function.

### 14.1 Infrastructure Prerequisites

| Prerequisite | Current State | Required For | Effort |
|-------------|--------------|-------------|--------|
| Workers AI binding in Pages Functions | ❓ Unconfirmed — spec §12 Q1 flags this. REST API fallback exists. | All embedding + extraction calls | 2h to test; 4h for REST adapter if needed |
| Vectorize index for user embeddings | Not created | CIS knowledge cards, similarity search, cross-domain discovery | 1h (wrangler config + index creation) |
| `env.AI` binding in wrangler.toml | Not configured for ai-hub | Workers AI calls | 30min |
| Module UIs in cockpit (Creator, SitMon, Code, Coaching tabs) | DO NOT EXIST in ai-hub | Post-chat capture UI, GeScore dashboard, module-context captures | 40-60h (separate from this spec) |
| FreeModelRouter (full spec v1.4) | Basic 7-model MVP exists; full archetype-aware routing NOT deployed | Free tier quality described in pricing model | 20-30h (Tier 1.5 in roadmap) |
| Prompt Vault remaining 3 files | Phase A shipped; library UI, CIS slash commands, VariableFillForm pending | Vault as Tier 2 capture target | 8-12h |

### 14.2 Codebase Prerequisites (from existing GLOBAL_ROADMAP)

The following ai-hub roadmap items must complete before Knowledge Flywheel development starts:

1. **Prompt Vault completion** — vault is the primary Tier 2 capture target
2. **Workers AI binding confirmed** — test `env.AI` in Pages Functions
3. **Vectorize index created** — `storia-embeddings` exists in CF dashboard but may need user-scoped metadata

### 14.3 What CAN Ship Without Prerequisites

| Flywheel Phase | Depends On | Can Ship Independently? |
|----------------|-----------|------------------------|
| F-1: Schema additions | Nothing | ✅ Yes — pure D1 migration |
| F-3: Quality gate (Layer 0 JS classifier) | Nothing | ✅ Yes — pure TypeScript heuristics |
| F-6: Gecko knowledge archetypes (templates) | Nothing | ✅ Yes — static template strings |
| F-7: GeScore v2 formula | F-1 schema | ✅ Yes — pure D1 queries |
| F-2: Embedding pipeline | Workers AI binding | ❌ No — needs env.AI or REST adapter |
| F-4: CIS knowledge cards | F-2 + CIS shipped | ❌ No — needs embeddings + module UIs |
| F-5: Post-chat capture prompt | F-2 + F-3 | ❌ No — needs embeddings |
| F-8-F-11: All remaining | F-2 | ❌ No — embedding-dependent |

**Recommended approach**: Ship F-1, F-3, F-6, F-7 as an independent "Flywheel Foundation" sprint (~19h). This creates the schema, quality gate, gecko templates, and GeScore v2 without any infrastructure dependency. Then tackle F-2 (embeddings) once Workers AI binding is confirmed.

---

## 15. Codebase Reconciliation — Pricing Model (NEW in v1.1)

### 15.1 Current State in Code

The codebase currently implements Free/Deep($3)/Pro($9) from the Feb 21 session:

| File | Current State | Required Change |
|------|--------------|----------------|
| `src/lib/pricing.ts` | 3 tiers: free/deep/pro with limits | Rewrite to 2 tiers: free/pro at €5. Update all limits. |
| `src/lib/subscription.ts` | `getUserTier()`, `isDeepModeSubscriber()`, `isProSubscriber()` | Remove `isDeepModeSubscriber()`. Simplify tier logic. |
| `src/lib/stripe.ts` | `getTierKeyFromPriceId()` maps DEEP+PRO price IDs | Remove DEEP mapping. Single PRO price ID. |
| `src/lib/validations/stripe.ts` | Tier enum: `['free', 'deep', 'pro']` | Change to `['free', 'pro']` |
| `src/app/api/llm-proxy/route.ts` | Premium model prefix check → 402 for free users | **ARCHITECTURE CHANGE**: Remove model-based blocking. Route based on BYOK key availability. Free users get FreeModelRouter; BYOK users get their keys routed through. |
| `src/app/api/stripe/webhook/route.ts` | Tier mapping for deep/pro | Remove deep tier mapping |
| `src/components/settings/SubscriptionPanel.tsx` | 3-tier upgrade path: free→deep→pro | 2-tier: free→pro. Single upgrade CTA. |
| `src/components/pricing/PricingTable.tsx` | 3 columns comparing free/deep/pro | 2 columns: free vs pro. Emphasize knowledge flywheel, not model access. |
| `src/lib/schema.ts` | Tier column comment: `'free' \| 'deep' \| 'pro'` | Update to `'free' \| 'pro'` |
| Stripe env vars | `STRIPE_DEEP_MODE_MONTHLY_PRICE_ID` + `STRIPE_PRO_MONTHLY_PRICE_ID` | Remove DEEP. Create new PRO product at €5/mo in Stripe dashboard. |

**Also check**: Residual env vars from iteration 1 (`STRIPE_PRO_YEARLY_PRICE_ID`, `STRIPE_TEAM_MONTHLY_PRICE_ID`) — remove if still present.

### 15.2 LLM Proxy Gate — Architecture Change Detail

**Current logic** (Feb 21 code):
```typescript
// Premium model check
const isPremium = model.startsWith('claude-') || 
                  model.startsWith('gpt-4') || 
                  model.startsWith('gemini-pro');
if (isPremium && userTier === 'free') {
  return Response.json({ error: 'Upgrade required' }, { status: 402 });
}
```

**New logic** (2-tier model):
```typescript
// Route based on key availability, not model name
const hasBYOKKey = await checkUserHasBYOKKey(userId, provider);
if (hasBYOKKey) {
  // Route through user's BYOK key (Pro feature — vault integration)
  return proxyWithBYOKKey(request, userId, provider);
} else {
  // Route through FreeModelRouter (all users)
  return freeModelRouter.route(request, userArchetype);
}
```

This is NOT a minor change. It removes the entire premium model gating concept and replaces it with key-based routing. Free users never see a 402 for model access — they simply get routed to the best available free model.

### 15.3 Feature Gates (NEW — replaces model gating)

Create `src/lib/feature-gates.ts`:

```typescript
export const FEATURE_GATES = {
  free: {
    vaultEntries: 50,
    projects: 3,
    modules: ['chat'],           // Only Chat tab
    geckos: ['zori', 'kai', 'vex', 'razz'],  // Personality coaches only
    morningBrief: false,
    knowledgeGraph: false,
    collectiveIntelligence: false,
    byokVault: false,
    freeModelAccess: true,       // Full FreeModelRouter
  },
  pro: {
    vaultEntries: Infinity,
    projects: Infinity,
    modules: ['chat', 'creator', 'code', 'sitmon', 'coaching'],
    geckos: ['zori', 'kai', 'vex', 'razz', 'edoc', 'tach', 'omni', 'crex'],
    morningBrief: true,
    knowledgeGraph: true,
    collectiveIntelligence: true,
    byokVault: true,
    freeModelAccess: true,       // Pro users ALSO get free models
  },
} as const;
```

### 15.4 Effort Estimate — Pricing Rewrite

| Task | Effort | Notes |
|------|--------|-------|
| Rewrite `pricing.ts` (2 tiers + feature gates) | 2h | New feature definitions |
| Simplify `subscription.ts` | 1h | Remove deep mode functions |
| Update `stripe.ts` + `validations/stripe.ts` | 1h | Remove deep, update enum |
| Rewrite LLM proxy gate logic | 3h | Architecture change — key-based routing |
| Update webhook handler | 1h | Remove deep tier mapping |
| Update SubscriptionPanel + PricingTable | 3h | 2-column comparison, knowledge OS messaging |
| Create `feature-gates.ts` | 1h | Module/gecko/vault gating |
| Stripe dashboard: create €5/mo product | 30min | PetrAnto action |
| Clean up residual env vars from iteration 1 | 30min | Audit + remove |
| **Total** | **~13h** | |

---

## 16. Open Questions — UPDATED

*(Carries forward v1.0 questions 1-5, adds new ones)*

6. **Workers AI in Pages Functions**: Must be tested before any embedding work begins. If `env.AI` is unavailable, the REST API adapter adds ~50ms latency per call. At ~200 calls/day per active user, this is ~10 seconds of cumulative latency. Acceptable but not ideal.

7. **Free tier coaching surface**: Should free users see GeScore at all? Option A: show a simplified GeScore widget in Chat sidebar. Option B: show nothing until Pro. Recommend Option A — showing progress creates upgrade desire.

8. **Module UI development ordering**: The Knowledge Flywheel assumes module UIs exist (for source-type tracking, module-context captures, etc.). But module UIs are 40-60h of work not in this spec. Recommend: build the flywheel schema + backend first, surface it in Chat-only initially, add module-specific integration as module UIs ship.

---

*End of spec v1.1. Upload to `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.md` (replace v1.0) after multi-AI review.*
