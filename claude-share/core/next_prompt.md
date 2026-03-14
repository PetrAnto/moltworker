# Next Prompt — 2026-03-14 (Post Phase 5.4)

Phase 5.4 (Acontext Disk tools) is complete on branch `work`.

## Next Recommended Task
Continue **Phase 5.6 orchestration polish** with focus on:
1. REDO mode type (`'redo'`) in OrchestraTask
2. Roadmap parsing robustness for non-standard formats
3. Stale task cleanup for RUN tasks
4. `/orch history` UX improvements

Validation: `npm test -- --reporter=verbose 2>&1 | tail -20` and `npm run typecheck`.

---

# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-14 (Orchestra gating fix, roadmap triage)

---

## Current Task: 5.6 — Multi-Agent Orchestration Polish

### Context

Orchestra mode (INIT/RUN/REDO) is fully implemented in `src/orchestra/orchestra.ts` (1,343 lines) with comprehensive tests in `orchestra.test.ts` (1,339 lines). It works but needs polish.

### What Exists

- **INIT mode** — Creates `ROADMAP.md` + `WORK_LOG.md` from project descriptions
- **RUN mode** — Executes next uncompleted task, tiered prompts (minimal/standard/full) based on model capability
- **REDO mode** — Re-executes failed tasks with failure context, stores as `'run'` not `'redo'` in OrchestraTask.mode
- **Gating** — Hard block for non-tool models, soft warning for `orchestraReady !== true` (recently fixed for auto-synced models)
- **Guardrails** — Large file detection, dead code prevention, atomic refactoring, extraction verifier, name-based anchoring, topological extraction order
- **Commands** — `/orch set/unset/init/run/redo/next/advise/roadmap/history/reset`
- **Storage** — OrchestraHistory in R2, max 30 tasks per user

### Polish Tasks

1. **REDO mode type** — `OrchestraTask.mode` only has `'init' | 'run'`, REDO stores as `'run'`. Add `'redo'` to the union type and store correctly.

2. **Roadmap parsing robustness** — Non-standard formats (numbered lists, indented checkboxes, mixed formats) can fail. Add fallback parsing strategies and tests for edge cases.

3. **History UX** — `/orch history` output is plain text. Add model name, duration, and PR link in a compact format. Consider inline keyboard buttons for REDO on failed tasks.

4. **Error recovery** — When a RUN task fails mid-execution (DO timeout, model error), the task stays as "started" forever. Add a cleanup mechanism: mark stale tasks (>30min with no update) as failed, allow retry.

5. **Progress reporting** — Wire orchestra tasks into the Phase 7B.5 streaming feedback system. Show "Orchestra RUN: step 2/5 — Adding JWT validation" style progress.

6. **INIT quality** — INIT mode roadmaps sometimes produce vague tasks like "implement the feature". Add structured output (JSON schema) for the roadmap and validate task descriptions have actionable detail.

7. **Tests** — Add integration-level tests that cover the full handler.ts → orchestra.ts → task-processor.ts flow for each mode.

### Key Files

| File | Purpose |
|------|---------|
| `src/orchestra/orchestra.ts` | Core engine — buildInitPrompt, buildRunPrompt, buildRedoPrompt |
| `src/orchestra/orchestra.test.ts` | Test suite |
| `src/telegram/handler.ts` | Command handling (~lines 1850-2100) |
| `src/durable-objects/task-processor.ts` | Orchestra detection + execution in DO |
| `claude-share/core/prompts/orchestrator.md` | Session start prompt template |

### Run Tests

```bash
npm test -- --reporter=verbose 2>&1 | tail -20   # All tests
npm test -- src/orchestra/orchestra.test.ts       # Orchestra tests only
npm run typecheck                                  # Type check
```

### Definition of Done

- [ ] REDO mode has its own type in OrchestraTask
- [ ] Roadmap parsing handles 3+ non-standard formats with tests
- [ ] Stale task cleanup mechanism
- [ ] At least 10 new tests
- [ ] All existing tests pass, typecheck clean

---

## Parallel Codex Tasks

Two prompts for Codex are ready in `claude-share/core/codex-prompts/`:

| File | Task | Phase |
|------|------|-------|
| `codex-prompt-5.3-sandbox.md` | Acontext Sandbox for code execution | 5.3 |
| `codex-prompt-5.4-disk.md` | Acontext Disk for file management | 5.4 |

---

## Remaining Roadmap (Not Started)

> For the next session after 5.6 is done. Copy this table forward.

| ID | Task | Effort | Notes |
|----|------|--------|-------|
| **F.1** | ai-hub data feeds (RSS, market, proactive notifications) | 6-8h | **BLOCKED** on ai-hub `/api/situation/*` endpoints. Unblock: ask Petr about ai-hub M1 status. When ready: add `fetch_situation()` tool that calls ai-hub REST API, wire into daily briefing aggregator (2.5.7), add proactive notification via Telegram scheduled messages. Key files: `src/openrouter/tools.ts` (add tool), `src/telegram/handler.ts` (add `/situation` command), `src/durable-objects/task-processor.ts` (wire tool context). Needs `AI_HUB_API_KEY` in wrangler secrets. |
| **F.2** | Browser tool enhancement (CDP) — a11y tree, click/fill/scroll | 4-6h | `BROWSER` binding exists, Peekaboo pattern |
| **5.3** | Acontext Sandbox for code execution | 8-12h | See codex-prompt-5.3-sandbox.md |
| **5.4** | Acontext Disk for file management | 4-6h | See codex-prompt-5.4-disk.md |
| **F.5** | Observability dashboard enhancement | 4-6h | Acontext session replay, success rates |
| **F.8** | Long-term memory (MEMORY.md + fact extraction) | 8-12h | Extends Phase 3.1 learnings |
| **6.3** | Voice messages (Whisper + TTS) | High | New capability |
| **6.4** | Calendar/reminder tools | Medium | Cron-based |
| **6.5** | Email integration | Medium | Cloudflare Email Workers |
| **6.6** | WhatsApp integration | High | WhatsApp Business API |

### F.1 Implementation Guide (When Unblocked)

**What:** Connect moltworker to ai-hub's situation awareness endpoints so the bot can proactively surface market moves, news, and portfolio updates.

**Prereqs:**
- ai-hub must have `/api/situation/market`, `/api/situation/news`, `/api/situation/portfolio` endpoints live
- `AI_HUB_API_KEY` secret added to Cloudflare Workers

**Implementation steps:**
1. Add `fetch_situation` tool to `src/openrouter/tools.ts` — calls ai-hub REST API with category filter (market/news/portfolio/all)
2. Add `aiHubApiKey` to `ToolContext` interface, pass through from env in handler.ts and task-processor.ts
3. Wire into daily briefing (`src/openrouter/tools.ts` `executeBriefingTool`) — add situation data as a briefing section
4. Add `/situation` Telegram command in handler.ts — quick access to latest situation data
5. Optional: Add proactive notifications via `scheduled()` handler — check for significant changes every hour, notify user via Telegram if threshold met
6. Tests: mock ai-hub API responses, test tool execution, test briefing integration

**Key decisions:**
- Cache TTL for situation data (suggest 15min for market, 1h for news)
- Notification threshold (what counts as "significant" market move — suggest >5% daily change)
- Whether to use Durable Object for persistent situation tracking or keep it stateless

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-14 | Orchestra gating fix — gate auto-synced models without orchestraReady flag | Claude Opus 4.6 | Commit d28fcb1 |
| 2026-03-10 | Orchestra diffs PR merged | Claude Opus 4.6 | Commit a888455 |
| 2026-03-08 | Post-execution extraction verifier for orchestra | Claude Opus 4.6 | Commit 675ef49 |
| 2026-02-23 | 5.1: Multi-Agent Review (1458 tests) | Claude Opus 4.6 | Phase 5.1 complete |
| 2026-02-23 | Phase 7 ALL 10 tasks complete (1411 tests) | Claude Opus 4.6 | Phase 7 complete |
| 2026-03-01 | Phase 8 Operational Hardening (1526 tests) | Claude Opus 4.6 | 38 tasks |
