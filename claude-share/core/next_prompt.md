# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-02-08

---

## Current Task: Phase 2.5.6 — Crypto Expansion

### Phase 2.5.6: Crypto Expansion (CoinCap + DEX Screener + CoinPaprika)

Expand crypto capabilities beyond the existing CoinGecko integration with DeFi pairs and richer metadata. All APIs are free/no-auth.

#### APIs to Integrate
1. **CoinCap** — Real-time crypto pricing (`api.coincap.io/v2/assets`)
2. **DEX Screener** — DeFi pair data (`api.dexscreener.com/latest/dex/tokens/{address}`)
3. **CoinPaprika** — Detailed coin metadata (`api.coinpaprika.com/v1/tickers/{coin_id}`)

#### Implementation Notes
- Add as a new tool `get_crypto` or expand existing tool
- Support queries like: price of BTC, top gainers, ETH trading pairs
- Cache responses (5-10 min TTL)
- No auth required for any API

#### Files to Create/Modify
1. **`src/openrouter/tools.ts`** — Add `get_crypto` tool definition and handler
2. **`src/openrouter/tools.test.ts`** — Tests with mocked API responses

#### Success Criteria
- [ ] Tool queries crypto prices/metadata from multiple sources
- [ ] Graceful fallback if one API is down
- [ ] Tests added with mocked responses
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes (pre-existing errors OK)

---

## Queue After This Task

| Priority | Task | Effort |
|----------|------|--------|
| Next | 2.5.6: Crypto expansion (CoinCap + DEX Screener) | 4h |
| Then | 2.5.8: Geolocation from IP (ipapi) | 1h |
| Then | 1.4: Combine vision + tools into unified method | Medium |
| Then | 1.5: Structured output support | Medium |

---

## Recently Completed

| Date | Task | AI | Session |
|------|------|----|---------|
| 2026-02-08 | BUG-1, BUG-2, BUG-5 fixes (all 5 bugs resolved) | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
| 2026-02-08 | Phase 2.1+2.2: Token/cost tracking + /costs command | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
| 2026-02-08 | Phase 2.5.4: Currency conversion tool | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
| 2026-02-08 | Phase 2.5.7: Daily briefing aggregator + BUG-3/BUG-4 fixes | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
| 2026-02-08 | Phase 1.3: Configurable reasoning per model | Claude Opus 4.6 | 01Wjud3VHKMfSRbvMTzFohGS |
| 2026-02-08 | Phase 2.5.5: News feeds (HN/Reddit/arXiv) | Claude Opus 4.6 | 01Wjud3VHKMfSRbvMTzFohGS |
| 2026-02-08 | Phase 2.5.3: Weather tool (Open-Meteo) | Claude Opus 4.6 | 01Wjud3VHKMfSRbvMTzFohGS |
| 2026-02-08 | Phase 2.5.2: Chart image generation (QuickChart) | Claude Opus 4.6 | 01Wjud3VHKMfSRbvMTzFohGS |
| 2026-02-08 | Phase 2.5.1: URL metadata tool (Microlink) | Claude Opus 4.6 | 01Wjud3VHKMfSRbvMTzFohGS |
| 2026-02-08 | Phase 1.1: Parallel tool execution | Claude Opus 4.6 | 01Lg3st5TTU3gXnMqPxfCPpW |
| 2026-02-08 | Phase 1.2: Model capability metadata | Claude Opus 4.6 | 01Lg3st5TTU3gXnMqPxfCPpW |
| 2026-02-08 | Phase 1.5: Upstream sync (7 cherry-picks) | Claude Opus 4.6 | 01Lg3st5TTU3gXnMqPxfCPpW |
| 2026-02-07 | Phase 0: Add Pony Alpha, GPT-OSS-120B, GLM 4.7 | Claude Opus 4.6 | 011qMKSadt2zPFgn2GdTTyxH |
