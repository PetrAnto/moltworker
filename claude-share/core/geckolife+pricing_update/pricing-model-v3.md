# Storia Digital — Pricing Model v3.0

**Date**: 2026-03-28
**Author**: Claude Opus 4.6 + PetrAnto
**Status**: APPROVED — Ready for implementation
**Upload to**: `claude-share/brainstorming/wave7/pricing-model-v3.md`
**Supersedes**: Free/Deep($3)/Pro($9) model (pricing.ts, Feb 21 2026)

---

## Decision

Kill Deep Mode. Go 2-tier: **Free (€0) / Pro (€5/mo).**

Revenue comes from knowledge OS compounding value, not model access gating.

---

## Rationale

1. **Free models in 2026 are genuinely good.** DeepSeek R1, Qwen3 235B, Llama 70B, Qwen3 Coder — frontier-quality reasoning and coding available at zero cost via Groq, OpenRouter :free, Cerebras, and Workers AI. Gating model access behind a paywall is obsolete when free models cover 80%+ of use cases.

2. **Deep Mode's philosophical contradiction.** It either serves premium models via Storia's keys (= token markup, violating BYOK identity) or requires BYOK keys (= hollow value vs Pro). Neither works.

3. **Three tiers = two decision points = more funnel leakage.** One clear free→pro decision is stronger than free→deep→pro.

4. **The knowledge flywheel is the actual moat.** Users don't upgrade for better models. They upgrade because their accumulated intelligence — vault entries, knowledge graph, gecko coaching, cross-module workflow — compounds monthly. No competitor offers this.

---

## Tier Definitions

### Free (€0)

| Feature | Limit |
|---------|-------|
| AI Chat | All free models via FreeModelRouter (Groq, OpenRouter :free, Cerebras, Workers AI edge) |
| Archetype-aware routing | Yes — fast for casual, smart for coding, deep for reasoning |
| Personality Geckos | All 4: Zori Halley, Kai Polaris, Vex Sirius, Razz Io (gold border) |
| Mode Geckos | None (Pro only) |
| Modules | Chat only |
| Vault entries | 50 |
| Projects | 3 |
| Knowledge capture | Basic — embedding + tagging on save (Workers AI, ~80 neurons/day) |
| GeScore | Lite widget in Chat sidebar (activity tracking only) |
| Morning brief | No |
| Knowledge graph UI | No |
| Collective intelligence | No |
| BYOK vault | No |
| Moltworker Telegram | Basic chat with free models |
| Coaching dashboard | No |

**Platform cost per free user**: ~€0.07/month (Workers AI neurons for basic embeddings)

### Pro (€5/mo)

| Feature | Limit |
|---------|-------|
| AI Chat | All free models + BYOK keys for any provider via byok.cloud |
| Archetype-aware routing | Yes + priority queue for free models |
| Personality Geckos | All 4 (same as free) |
| Mode Geckos | All 4: Edoc Rigel, Tach Cygnus, Omni Vega, Crex Lyrae (blue border) |
| Modules | All: Chat, Creator, Code/IDE, Situation Monitor, Coaching |
| Vault entries | Unlimited |
| Projects | Unlimited |
| Knowledge capture | Full flywheel — embedding, tagging, pattern detection, cross-domain discovery |
| GeScore | v2 with knowledge growth metrics |
| Morning brief | Yes (opt-in, ~33 neurons/day) |
| Knowledge graph UI | Yes — full visualization + edge creation |
| Collective intelligence | Yes (Phase 3+, anonymized shared patterns) |
| BYOK vault | Yes — full byok.cloud integration, any provider key |
| Moltworker Telegram | Full skills: /write, /research, /orch, /spark, /gauntlet, etc. |
| Coaching dashboard | Yes — full Gecko Life / Knowledge Flywheel dashboard |

**Platform cost per Pro user**: ~€0.60/month (Workers AI neurons for full flywheel at 200 neurons/day)
**Gross margin**: ~88% (€5 revenue - €0.60 cost)

---

## Files to Change

### Priority 1 — Core pricing logic (~6h)

| File | Current | Change |
|------|---------|--------|
| `src/lib/pricing.ts` | 3 tiers: free/deep/pro | Rewrite: 2 tiers free/pro at €5. New feature definitions. |
| `src/lib/subscription.ts` | `getUserTier()`, `isDeepModeSubscriber()`, `isProSubscriber()` | Remove `isDeepModeSubscriber()`. Simplify. |
| `src/lib/stripe.ts` | `getTierKeyFromPriceId()` maps DEEP+PRO | Remove DEEP mapping. Single PRO price ID. |
| `src/lib/validations/stripe.ts` | Enum: `['free', 'deep', 'pro']` | Change to `['free', 'pro']` |
| `src/lib/schema.ts` | Tier comment: `'free' \| 'deep' \| 'pro'` | Update to `'free' \| 'pro'` |

### Priority 2 — LLM proxy architecture change (~3h)

| File | Current | Change |
|------|---------|--------|
| `src/app/api/llm-proxy/route.ts` | Premium model prefix check → 402 for free | **Remove model gating entirely.** Route based on BYOK key availability. Free → FreeModelRouter. BYOK key present → proxy through user's key. |

### Priority 3 — Webhook + UI (~4h)

| File | Current | Change |
|------|---------|--------|
| `src/app/api/stripe/webhook/route.ts` | deep/pro tier mapping | Remove deep. |
| `src/components/settings/SubscriptionPanel.tsx` | 3-tier path: free→deep→pro | 2-tier: free→pro. Single upgrade CTA. |
| `src/components/pricing/PricingTable.tsx` | 3 columns | 2 columns. Emphasize knowledge OS, not models. |

### Priority 4 — New files (~2h)

| File | Purpose |
|------|---------|
| `src/lib/feature-gates.ts` | Module access, gecko access, vault limits, project limits per tier |

### Cleanup

| Item | Action |
|------|--------|
| `STRIPE_DEEP_MODE_MONTHLY_PRICE_ID` env var | Remove from wrangler secrets |
| `STRIPE_PRO_YEARLY_PRICE_ID` env var | Remove if still present (from iteration 1) |
| `STRIPE_TEAM_MONTHLY_PRICE_ID` env var | Remove if still present (from iteration 1) |
| Stripe dashboard | Create new Pro product at €5/mo. Archive Deep Mode product. |

**Total estimated effort: ~13h**

---

## Conversion Triggers

How free users discover they want Pro:

| Trigger | Mechanism | Gecko |
|---------|-----------|-------|
| Vault ceiling (50 entries) | "Your vault is full. Upgrade to keep building your knowledge graph." | Kai Polaris |
| Mode gecko tease | Click Creator/Code/SitMon tab → "Meet Crex Lyrae — your creative director. Unlock with Pro." | The mode gecko itself |
| GeScore plateau | Score stalls because capture-to-reuse loop can't fully function on free tier | Vex Sirius |
| Project overflow | 3 projects full → "Unlock unlimited projects with Pro." | Razz Io |
| BYOK curiosity | Cost transparency: "This chat would have cost $0.18 on Claude. You got it free." → eventually they want Claude | Widget |
| Module cross-sell | Personality geckos occasionally say "Research this with Situation Monitor" | Zori Halley |

---

## Revenue Projections (Conservative)

| Active Users | Free | Pro (at 2%) | Revenue/mo | Cost/mo | Net |
|---|---|---|---|---|---|
| 100 | 98 | 2 | €10 | €8 | €2 |
| 500 | 490 | 10 | €50 | €37 | €13 |
| 1,000 | 980 | 20 | €100 | €69 | €31 |
| 5,000 | 4,900 | 100 | €500 | €337 | €163 |
| 10,000 | 9,800 | 200 | €1,000 | €660 | €340 |

| Active Users | Free | Pro (at 5%) | Revenue/mo | Cost/mo | Net |
|---|---|---|---|---|---|
| 1,000 | 950 | 50 | €250 | €97 | €153 |
| 5,000 | 4,750 | 250 | €1,250 | €383 | €867 |
| 10,000 | 9,500 | 500 | €2,500 | €707 | €1,793 |

**Note**: 2% is realistic for beta launch with no brand recognition. 5% is achievable once the knowledge flywheel proves compounding value (requires 2-3 months of user data).

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Free model providers cut free tiers | Medium | High | FreeModelWatcher auto-discovers alternatives; Workers AI as zero-dependency fallback |
| 2% conversion doesn't cover costs | High (early) | Low | Platform cost is ~$0/mo. Revenue goal is growth, not profit, in Phase 1. |
| €5/mo too low for perceived value | Medium | Medium | Start at €5, raise to €7-9 once flywheel value is proven to users |
| Existing Deep Mode subscribers | Low (no users yet) | Low | No migration needed — Deep Mode never launched to public |
| BYOK vault (byok.cloud) not stable enough | Medium | High | byok.cloud has pending DNS/npm tasks. Must complete before Pro launch. |

---

*End of pricing spec v3.0.*
