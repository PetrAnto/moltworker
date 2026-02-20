# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-02-20 (Phase 2.4 admin dashboard section complete)

---

## Current Task: Audit Phase 2 — P2 guardrails multi-agent review

### Goal

Audit and harden P2 guardrails focused on tool-result validation and anti-hallucination behavior before final response generation.

### Context

- Phase 2.4 is complete (admin dashboard Acontext sessions section)
- Phase 4.1 audit is complete and merged on branch history
- Next high-priority gap is validating P2 guardrails for tool output correctness
- Focus on preventing unsupported completion claims in final responses

### Files to Modify

| File | What to change |
|------|---------------|
| `src/durable-objects/task-processor.ts` | Review/strengthen final-response verification guardrails |
| `src/openrouter/tools.ts` and related helpers | Ensure tool evidence and result checks are surfaced consistently |
| Tests | Add/adjust tests for P2 guardrail behavior and failure cases |

### Queue After This Task

| Priority | Task | Effort | Notes |
|----------|------|--------|-------|
| Current | Audit Phase 2: P2 guardrails | Medium | Multi-agent review, tool result validation |
| Next | 4.2: Replace estimateTokens with actual tokenizer | Medium | Prefer `js-tiktoken` if Worker-compatible |
| Then | 5.x: MCP integrations | High | Depends on P2/P4 stabilization |

---

## Recently Completed

| Date | Task | AI | Session |
|------|------|----|---------|
| 2026-02-20 | Phase 2.4: Acontext dashboard link in admin UI | Codex (GPT-5.2-Codex) | codex-acontext-admin-2p4-001 |
| 2026-02-19 | Phase 4.1 Audit: context-budget hardening + edge-case tests | Codex (GPT-5.2-Codex) | codex-phase-4-1-audit-001 |
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
