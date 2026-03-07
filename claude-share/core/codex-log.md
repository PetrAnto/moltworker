# Codex Session Log

> All Codex sessions logged here. Newest first.

---



## Session: 2026-03-07 | Orchestra stall audit + 499 resilience fix (Session: codex-orch-stall-499-001)

**AI:** Codex (GPT-5.2-Codex)
**Branch:** work
**Status:** Completed

### Summary
Audited `/orch next` failure logs showing repeated auto-resume loops and Anthropic 499 disconnects, then hardened TaskProcessor retry/timeout handling to fail faster and rotate free models on transport disconnects.

### Changes Made
- Added direct-provider hard stream cap timeout (in addition to connect timeout) to prevent very long endless streaming runs
- Added explicit 499/client-disconnect retry branch in API error handling
- Included 499/client disconnected in free-model rotation triggers
- Added regression test to verify free-model rotation on 499 responses

### Files Modified
- `src/durable-objects/task-processor.ts`
- `src/durable-objects/task-processor.test.ts`
- `claude-share/core/codex-log.md`
- `claude-share/core/GLOBAL_ROADMAP.md`
- `claude-share/core/WORK_STATUS.md`
- `claude-share/core/next_prompt.md`

### Tests
- [x] Targeted tests pass (`task-processor.test.ts`)
- [x] Full test suite pass (`npm test`)
- [x] Typecheck pass (`npm run typecheck`)

### Notes for Next Session
Validate in production logs whether 499 rotation reduces stall frequency for `/sonnet` orchestra runs; if long streaming still occurs, add semantic-progress watchdog (e.g., tool/output delta) beyond chunk heartbeat.

---

## Session: 2026-02-20 | Phase 5.5 web_search tool (Session: codex-phase-5-5-web-search-001)

**AI:** Codex (GPT-5.2-Codex)
**Branch:** work
**Status:** Completed

### Summary
Added Brave Search-powered `web_search` tool end-to-end (tool registry, execution, DO/Telegram key plumbing, cache, and tests).

### Changes Made
- Added `web_search` tool definition and execution path with 5-minute cache + 20KB truncation
- Added Brave Search key plumbing via `ToolContext`, `TaskRequest`/`TaskState`, and Telegram DO dispatch
- Added parallel-safety whitelist entry for `web_search`
- Added 8 dedicated `web_search` tests and updated tool count assertions

### Files Modified
- `src/openrouter/tools.ts`
- `src/openrouter/tools.test.ts`
- `src/openrouter/briefing-aggregator.test.ts`
- `src/durable-objects/task-processor.ts`
- `src/telegram/handler.ts`
- `src/routes/telegram.ts`
- `src/types.ts`
- `claude-share/core/codex-log.md`
- `claude-share/core/GLOBAL_ROADMAP.md`
- `claude-share/core/WORK_STATUS.md`
- `claude-share/core/next_prompt.md`

### Tests
- [x] Targeted tests pass (`tools.test.ts`, `briefing-aggregator.test.ts`)
- [ ] Full test suite pass (blocked by missing `gpt-tokenizer/encoding/cl100k_base` module in environment)
- [ ] Typecheck pass (blocked by missing `gpt-tokenizer/encoding/cl100k_base` module in environment)

### Notes for Next Session
Install/fix `gpt-tokenizer` package resolution in this environment, then rerun full `npm test` and `npm run typecheck`.

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

