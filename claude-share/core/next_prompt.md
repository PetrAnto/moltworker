# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-02-19 (Phase 4.1 audit hardening complete)

---

## Current Task: Phase 2.4 — Acontext Dashboard Link in Admin UI

### Goal

Add an Acontext dashboard link/widget to the React admin UI so operators can quickly jump to Acontext session replays from the admin panel.

### Context

- Acontext integration (Phase 2.3) is complete — REST client in `src/acontext/client.ts`
- Admin dashboard is in `src/client/App.tsx`
- This is a low-risk, read-only integration (just a link/iframe)
- Assigned to Codex but any AI can pick it up

### Files to Modify

| File | What to change |
|------|---------------|
| `src/client/App.tsx` | Add Acontext dashboard link/section |
| Tests | Add any necessary tests |

### Queue After This Task

| Priority | Task | Effort | Notes |
|----------|------|--------|-------|
| Current | 2.4: Acontext dashboard link in admin UI | Low | Read-only integration |
| Next | 4.2: Replace estimateTokens with actual tokenizer | Medium | Use tiktoken or similar |
| Then | Audit Phase 2: P2 guardrails | Medium | Multi-agent review, tool result validation |

---

## Recently Completed

| Date | Task | AI | Session |
|------|------|----|---------|
| 2026-02-19 | Phase 4.1 Audit: Review & harden token-budgeted context retrieval | Codex (GPT-5.2-Codex) | codex-phase41-audit-001 |
| 2026-02-18 | Phase 4.1: Token-budgeted context retrieval | Claude Opus 4.6 | 018M5goT7Vhaymuo8AxXhUCg |
| 2026-02-18 | Phase 2.5.9: Holiday awareness (Nager.Date) | Claude Opus 4.6 | 01SE5WrUuc6LWTmZC8WBXKY4 |
| 2026-02-18 | Phase 2.3: Acontext observability (REST client + /sessions) | Claude Opus 4.6 | 01SE5WrUuc6LWTmZC8WBXKY4 |
| 2026-02-18 | P1 guardrails + /learnings command (Phase 3.3 + audit P1) | Claude Opus 4.6 | 01SE5WrUuc6LWTmZC8WBXKY4 |
| 2026-02-11 | Phase 3.2: Structured task phases (Plan → Work → Review) | Claude Opus 4.6 | 019jH8X9pJabGwP2untYhuYE |
| 2026-02-11 | UX fixes: /start redesign, bot menu, briefing location, news links, crypto fix, Acontext key | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-10 | Fix auto-resume counter + revert GLM free tool flag | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-10 | 6 bot improvements: GLM tools, 402 handling, cross-task ctx, time cap, tool-intent, parallel prompt | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-10 | Phase 3.1+3.4: Compound learning loop + prompt injection | Claude Opus 4.6 | 018gmCDcuBJqs9ffrrDHHBBd |
| 2026-02-09 | Phase 1.5: Structured output support (json: prefix) | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
| 2026-02-09 | Phase 1.4: Vision + tools unified + /help update | Claude Opus 4.6 | 013wvC2kun5Mbr3J81KUPn99 |
