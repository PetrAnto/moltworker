# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-02-18 (Phase 2.3 Acontext observability complete)

---

## Current Task: Phase 2.5.9 — Holiday Awareness (Nager.Date)

### Goal

Add holiday awareness to the daily briefing system. Use the free Nager.Date API to detect holidays and adjust briefing tone/content accordingly (e.g., "Happy New Year!" greeting, holiday-specific recommendations).

### Context

- The briefing system is in `src/openrouter/tools.ts` (`generateDailyBriefing`)
- Nager.Date API: `https://date.nager.at/api/v3/PublicHolidays/{year}/{countryCode}`
- Should be non-blocking — if the API fails, skip holiday info gracefully
- Consider user's country from geolocation or default to US

### Files to Modify

| File | What to change |
|------|---------------|
| `src/openrouter/tools.ts` | Add holiday lookup to briefing generation |
| Tests | Add tests for holiday integration |

### Queue After This Task

| Priority | Task | Effort | Notes |
|----------|------|--------|-------|
| Current | 2.5.9: Holiday awareness (Nager.Date) | Low | Adjust briefing tone on holidays |
| Next | 4.1: Replace compressContext with token-budgeted retrieval | Medium | Better context management |
| Then | 2.4: Acontext dashboard link in admin UI | Low | Read-only integration |
| Then | Audit Phase 2: P2 guardrails | Medium | Multi-agent review, tool result validation |

---

## Recently Completed

| Date | Task | AI | Session |
|------|------|----|---------|
| 2026-02-18 | Phase 2.3: Acontext observability (REST client + /sessions) | Claude Opus 4.6 | 01SE5WrUuc6LWTmZC8WBXKY4 |
| 2026-02-18 | P1 guardrails + /learnings command (Phase 3.3 + audit P1) | Claude Opus 4.6 | 01SE5WrUuc6LWTmZC8WBXKY4 |
| 2026-02-11 | Phase 3.2: Structured task phases (Plan → Work → Review) | Claude Opus 4.6 | 019jH8X9pJabGwP2untYhuYE |
| 2026-02-11 | UX fixes: /start redesign, bot menu, briefing location, news links, crypto fix, Acontext key | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-10 | Fix auto-resume counter + revert GLM free tool flag | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-10 | 6 bot improvements: GLM tools, 402 handling, cross-task ctx, time cap, tool-intent, parallel prompt | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-10 | Phase 3.1+3.4: Compound learning loop + prompt injection | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-09 | Phase 1.5: Structured output support (json: prefix) | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
| 2026-02-09 | Phase 1.4: Vision + tools unified + /help update | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
| 2026-02-08 | Phase 2.5.6+2.5.8: Crypto + Geolocation tools | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
