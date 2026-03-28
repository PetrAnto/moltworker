# W7-S1: Pricing Model Rewrite — Free(€0) / Pro(€5/mo)

> **Target AI**: Claude Code
> **Repo**: PetrAnto/ai-hub
> **Branch**: `claude/w7-s1-pricing-rewrite-<session-id>`
> **Effort**: ~13h
> **Spec**: `claude-share/brainstorming/wave7/pricing-model-v3.md`

---

## Context

The codebase currently implements a 3-tier model: Free($0) / Deep Mode($3/mo) / Pro($9/mo), built in the Feb 21 session. Deep Mode gates premium models (Claude, GPT-4, Gemini Pro) behind a $3/mo paywall using Storia's own API keys — which contradicts the BYOK philosophy.

Decision: Kill Deep Mode. Go 2-tier: Free(€0) / Pro(€5/mo). Free gets all free models via FreeModelRouter. Pro gets BYOK vault integration + full knowledge OS. Revenue comes from knowledge compounding, not model access gating.

## Pre-Read (mandatory)

```bash
cat claude-share/core/AI_CODE_STANDARDS.md
cat src/lib/pricing.ts
cat src/lib/subscription.ts
cat src/lib/stripe.ts
cat src/lib/validations/stripe.ts
cat src/app/api/llm-proxy/route.ts
cat src/app/api/stripe/webhook/route.ts
cat src/components/settings/SubscriptionPanel.tsx
cat src/components/pricing/PricingTable.tsx
cat src/lib/schema.ts
```

## Required Actions

### Step 1: Rewrite `src/lib/pricing.ts`

Replace the entire 3-tier model with 2 tiers:

```typescript
export type Tier = 'free' | 'pro';

export const TIERS = {
  free: {
    name: 'Free',
    price: 0,
    currency: 'EUR',
    features: {
      messagesPerDay: 100,
      projects: 3,
      vaultEntries: 50,
      storage: '1 GB',
      modules: ['chat'] as const,
      geckos: ['zori', 'kai', 'vex', 'razz'] as const,
      byokVault: false,
      morningBrief: false,
      knowledgeGraph: false,
      collectiveIntelligence: false,
      freeModelAccess: true,
    },
  },
  pro: {
    name: 'Pro',
    priceMonthly: 5,
    currency: 'EUR',
    features: {
      messagesPerDay: Infinity,
      projects: Infinity,
      vaultEntries: Infinity,
      storage: '10 GB',
      modules: ['chat', 'creator', 'code', 'sitmon', 'coaching'] as const,
      geckos: ['zori', 'kai', 'vex', 'razz', 'edoc', 'tach', 'omni', 'crex'] as const,
      byokVault: true,
      morningBrief: true,
      knowledgeGraph: true,
      collectiveIntelligence: true,
      freeModelAccess: true,
    },
  },
} as const;
```

### Step 2: Simplify `src/lib/subscription.ts`

- Remove `isDeepModeSubscriber()` function entirely
- Keep `getUserTier()` returning `'free' | 'pro'`
- Keep `isProSubscriber()`
- Remove any references to `'deep'` tier

### Step 3: Update `src/lib/stripe.ts`

- Remove `STRIPE_DEEP_MODE_MONTHLY_PRICE_ID` mapping from `getTierKeyFromPriceId()`
- Keep only `STRIPE_PRO_MONTHLY_PRICE_ID` mapping
- Remove any yearly price ID mappings if still present from iteration 1

### Step 4: Update `src/lib/validations/stripe.ts`

Change tier enum from `['free', 'deep', 'pro']` to `['free', 'pro']`

### Step 5: Update `src/lib/schema.ts`

Update the tier column comment from `'free' | 'deep' | 'pro'` to `'free' | 'pro'`

### Step 6: ARCHITECTURE CHANGE — Rewrite LLM proxy gate in `src/app/api/llm-proxy/route.ts`

**Current logic** (REMOVE):
```typescript
// Premium model prefix check → 402 for free users
const isPremium = model.startsWith('claude-') || model.startsWith('gpt-4') || ...
if (isPremium && userTier === 'free') return 402;
```

**New logic** (REPLACE WITH):
```typescript
// Route based on key availability, not model name
// Free users: FreeModelRouter handles everything
// Pro users with BYOK: route through their key
// Pro users without BYOK key for this provider: FreeModelRouter fallback
```

The key insight: NO user gets blocked with a 402 for trying to use a specific model. Free users get routed to the best free alternative. Pro users with BYOK keys get their key used. The gate is on KEY AVAILABILITY, not model name.

### Step 7: Update `src/app/api/stripe/webhook/route.ts`

Remove deep tier from upgrade/downgrade detection logic.

### Step 8: Update UI components

**`src/components/settings/SubscriptionPanel.tsx`**: 2-tier display. Free → Pro upgrade path only. Single "Upgrade to Pro — €5/mo" CTA button.

**`src/components/pricing/PricingTable.tsx`**: 2 columns. Emphasize:
- Free: "The best free AI chat" — all free models, 4 personality geckos, basic vault
- Pro: "Your personal knowledge OS" — BYOK, full flywheel, all modules, mode geckos, unlimited vault/projects

### Step 9: Cleanup

Search entire `src/` for any remaining references to:
- `'deep'` as a tier value
- `isDeepModeSubscriber`
- `STRIPE_DEEP_MODE`
- `STRIPE_TEAM`
- `STRIPE_PRO_YEARLY`

Remove all of them.

## Files to Update

| File | Action |
|------|--------|
| `src/lib/pricing.ts` | Rewrite |
| `src/lib/subscription.ts` | Simplify |
| `src/lib/stripe.ts` | Remove deep mapping |
| `src/lib/validations/stripe.ts` | Update enum |
| `src/lib/schema.ts` | Update comment |
| `src/app/api/llm-proxy/route.ts` | Architecture rewrite |
| `src/app/api/stripe/webhook/route.ts` | Remove deep logic |
| `src/components/settings/SubscriptionPanel.tsx` | 2-tier UI |
| `src/components/pricing/PricingTable.tsx` | 2-column comparison |

## Verification

```bash
npm run build          # Must pass with zero errors
npm run test           # All tests pass
# Grep for stale references:
grep -r "deep" src/lib/pricing.ts src/lib/subscription.ts src/lib/stripe.ts src/lib/validations/stripe.ts
grep -r "DEEP_MODE" src/
grep -r "isDeepMode" src/
grep -r "TEAM_MONTHLY" src/
grep -r "PRO_YEARLY" src/
# All greps should return zero results
```

## After Completion

Follow `claude-share/core/SYNC_CHECKLIST.md`:
1. Update `GLOBAL_ROADMAP.md` — add Wave 7 section, mark W7-S1 complete
2. Update `claude-log.md` — session entry
3. Rewrite `PROMPT_READY.md` → point to W7-S2 (Feature Gates)

## Queue (Next 3 Tasks)

1. **W7-S2**: Feature Gates (`src/lib/feature-gates.ts`) — module/gecko/vault gating per tier
2. **W7-S3**: Knowledge Flywheel Schema — 4 new D1 tables + Drizzle schema
3. **W7-S5**: Project System Backend — 2 new D1 tables + 7 API endpoints
