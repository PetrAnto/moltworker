# Wave 7 — Follow-Up Tracker

> **Purpose**: Track PetrAnto manual actions and cross-sprint dependencies.
> Upload to: `claude-share/brainstorming/wave7/WAVE7_FOLLOWUP.md`
> Check off items as they're completed.

---

## PetrAnto Manual Actions

### Before W7-S1 starts
- [ ] Create new Stripe product: "Storia Pro" at €5/mo → get `STRIPE_PRO_MONTHLY_PRICE_ID`
- [ ] Archive "Deep Mode" product in Stripe dashboard
- [ ] Delete `STRIPE_DEEP_MODE_MONTHLY_PRICE_ID` from wrangler secrets
- [ ] Delete `STRIPE_PRO_YEARLY_PRICE_ID` from wrangler secrets (if still present)
- [ ] Delete `STRIPE_TEAM_MONTHLY_PRICE_ID` from wrangler secrets (if still present)

### Before W7-M3 deploy
- [ ] Run `wrangler kv:namespace create nexus-cache` (if not done from Sprint 4)
- [ ] Upload Lyra media R2 prompts to `moltbot-data/skills/lyra/image-system.md` and `video-system.md`
- [ ] **DELETE R2 bucket contents**: https://dash.cloudflare.com/5200b896d3dfdb6de35f986ef2d7dc6b/r2/default/buckets/moltbot-data
- [ ] Deploy moltworker
- [ ] Test via Telegram: `/image --for instagram-post sunset in Corsica`
- [ ] Test via Telegram: `/video --for instagram-reel --duration 15 product launch teaser`

### After all sprints
- [ ] Update storia-dashboard-v4.jsx (last updated Feb 23 — very stale)
- [ ] Verify all Stripe webhooks work with new tier mapping
- [ ] Test full flow: free user → hits vault ceiling → upgrade → Pro features unlock

---

## Sprint Completion Tracking

| Sprint | Status | Branch | PR | Merged |
|--------|--------|--------|-----|--------|
| W7-S1 Pricing Rewrite | 🔲 | — | — | — |
| W7-S2 Feature Gates | 🔲 | — | — | — |
| W7-S3 Flywheel Schema | 🔲 | — | — | — |
| W7-S4 Flywheel Logic | 🔲 | — | — | — |
| W7-S5 Project Backend | 🔲 | — | — | — |
| W7-S6 Chat Project UI | 🔲 | — | — | — |
| W7-M1 Lyra Media | 🔲 | — | — | — |
| W7-M2 Integration Tests | 🔲 | — | — | — |
| W7-M3 Deploy Prep | 🔲 | — | — | — |

---

## Cross-Sprint Dependencies

```
W7-S1 ──► W7-S2 (feature gates need new tier definitions)
W7-S3 ──► W7-S4 (flywheel logic needs schema tables)
W7-S5 ──► W7-S6 (chat UI needs backend API)
W7-M1 ──► W7-M2 ──► W7-M3 (sequential in moltworker)

Independent pairs (can run in parallel):
  W7-S1 ∥ W7-S3 ∥ W7-S5 ∥ W7-M1
```

---

## Post-Wave 7 Priority Queue

After all Wave 7 sprints merge, these are next:

| Priority | Task | Repo | Effort | Spec |
|----------|------|------|--------|------|
| 1 | FreeModelRouter Phase 1 MVP | ai-hub | 12h | free-models-integration-spec-v1.4.md |
| 2 | Workers AI binding test + REST adapter | ai-hub | 2-4h | workers-ai-native-provider-spec-v1.1.md |
| 3 | Embedding pipeline (bge-m3) | ai-hub | 6h | flywheel spec F-2 |
| 4 | ST Smoke Tests | moltworker | 3h | Coding_Agent_Smoke_Tests.md |
| 5 | Creator Module UI | ai-hub | 12-16h | Needs new spec |
| 6 | Code Module UI | ai-hub | 12-16h | Needs new spec |
| 7 | SitMon Module UI | ai-hub | 16-24h | situation-monitor-master-spec-v2.md |
| 8 | Coaching Module UI | ai-hub | 8-12h | flywheel spec §8-9 |
| 9 | CIS Knowledge Cards | ai-hub | 8h | flywheel spec F-4 |
| 10 | Morning Brief | ai-hub | 8h | flywheel spec F-10 |

---

## Known Risks

| Risk | Mitigation | Owner |
|------|-----------|-------|
| Stripe webhook may break during tier change | Test in Stripe test mode before switching live | PetrAnto |
| D1 migrations may conflict with existing schema | Run `drizzle-kit generate` to verify before deploy | Claude Code |
| Workers AI `env.AI` binding may not work in Pages Functions | REST API fallback adapter ready (spec v1.1 §4.2) | Claude Code |
| Free model providers could change terms | FreeModelWatcher (spec v1.4 §10) monitors automatically | Future sprint |
| Dashboard is a month stale | Update storia-dashboard-v4.jsx after Wave 7 | PetrAnto/Claude |

---

*Created: 2026-03-28*
