# Codex Session Log

> All Codex sessions logged here. Newest first.

---



## Session: 2026-02-20 | Phase 5.5 web_search tool (Session: codex-phase-5-5-web-search-001)

**AI:** Codex (GPT-5.2-Codex)
**Branch:** work
**Status:** Completed

### Summary
Added a Brave Search-powered `web_search` tool with caching and wired Brave API key flow through Telegram → TaskProcessor → tool execution.

### Changes Made
- Added `web_search` tool definition and execution with 5-minute cache + 20KB truncation
- Extended task/request context with `braveSearchKey` and enabled `web_search` for parallel-safe execution
- Added Telegram/env plumbing for `BRAVE_SEARCH_KEY`
- Added comprehensive web_search tests and updated tool-count expectations

### Files Modified
- `src/openrouter/tools.ts`
- `src/openrouter/tools.test.ts`
- `src/durable-objects/task-processor.ts`
- `src/telegram/handler.ts`
- `src/routes/telegram.ts`
- `src/types.ts`
- `src/openrouter/briefing-aggregator.test.ts`
- `claude-share/core/codex-log.md`
- `claude-share/core/GLOBAL_ROADMAP.md`
- `claude-share/core/WORK_STATUS.md`
- `claude-share/core/next_prompt.md`

### Tests
- [x] Tests pass
- [x] Typecheck passes

### Notes for Next Session
Proceed with Phase 4.3 cache improvements or add web_search mention to user-facing docs if desired.

---

## Session: 2026-02-19 | Phase 4.1 context-budget audit hardening (Session: codex-phase-4-1-audit-001)

**AI:** Codex (GPT-5.2-Codex)
**Branch:** work
**Status:** Completed

### Summary
Audited and hardened token-budgeted context retrieval with edge-case fixes, model-aware budgets, and expanded tests.

### Changes Made
- Fixed unsafe fallback tool pairing for unknown `tool_call_id` messages
- Added transitive pair-set expansion to keep tool/assistant chains valid during greedy selection
- Increased image token estimate and added JSON-density adjustment in token heuristic
- Switched TaskProcessor compression threshold to per-model context budgets (`getModel(alias)?.maxContext`)
- Added edge-case stress tests and an audit report document

### Files Modified
- `src/durable-objects/context-budget.ts`
- `src/durable-objects/context-budget.edge.test.ts`
- `src/durable-objects/task-processor.ts`
- `brainstorming/phase-4.1-audit.md`
- `claude-share/core/codex-log.md`
- `claude-share/core/GLOBAL_ROADMAP.md`
- `claude-share/core/WORK_STATUS.md`
- `claude-share/core/next_prompt.md`

### Tests
- [x] Tests pass
- [x] Typecheck passes

### Notes for Next Session
Implement Phase 4.2 with a real tokenizer (`js-tiktoken`) if Cloudflare Workers compatibility is acceptable; wire exact counts into final budget validation pass.

---

## Session: 2026-02-16 | Full audit + build improvement plan (Session: codex-audit-plan-001)

**AI:** Codex (GPT-5.2-Codex)
**Branch:** work
**Status:** Completed

### Summary
Created a full audit and staged build-improvement plan focused on `/dcode` resume loops and hallucination reduction.

### Changes Made
- Added `brainstorming/audit-build-improvement-plan.md` with root-cause analysis and 5-phase remediation plan
- Documented immediate quick wins, test/CI gates, and success metrics

### Files Modified
- `brainstorming/audit-build-improvement-plan.md`
- `claude-share/core/codex-log.md`
- `claude-share/core/GLOBAL_ROADMAP.md`
- `claude-share/core/WORK_STATUS.md`
- `claude-share/core/next_prompt.md`

### Tests
- [x] Tests pass
- [x] Typecheck passes

### Notes for Next Session
Implement Phase 1 first: add centralized task router policy and resume model escalation for stalled coding tasks.

---

