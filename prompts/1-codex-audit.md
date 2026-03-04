# Codex Prompt: Audit and Improve Moltworker

## Context

Moltworker is a multi-platform AI assistant bot running on Cloudflare Workers + Durable Objects. It connects to Telegram/Discord/Slack, routes prompts to 26+ AI models (via OpenRouter + direct APIs to DeepSeek, Moonshot/Kimi, DashScope/Qwen), and provides tool-calling capabilities (GitHub file ops, web search, browser rendering, sandbox code execution).

The critical feature is **Orchestra Mode** (`/orch init` and `/orch run`): a structured workflow where the bot analyzes a GitHub repo, creates a ROADMAP.md + WORK_LOG.md, and opens a PR — all autonomously using tool calls within a Durable Object that supports up to 100 iterations with auto-resume on timeout.

## The Problem

The bot's orchestra init command keeps failing across different models and different error types. Recent failures:

1. **gpt5nano**: `"Reasoning is mandatory for this endpoint and cannot be disabled."` — 400 error from OpenRouter because the model requires reasoning but the bot sent `{ enabled: false }`. Fixed: added `mandatory` reasoning type + reactive retry. But the fix exposed...

2. **gpt5nano (after fix)**: `"You have exceeded the number of active timeouts you may set. max active timeouts: 10000"` — Cloudflare DO limit. Root cause: `Promise.race([toolPromise, timeoutPromise])` in tool execution created `setTimeout` callbacks that were never `clearTimeout()`-ed. Over 100 iterations with multiple tools per iteration, orphaned timers accumulate to 10,000+. Fixed: added `clearTimeout()` in `finally` blocks.

3. **kimidirect (Kimi K2.5 via Moonshot direct API)**: After 5 auto-resumes spanning 1910 seconds, "Task stopped unexpectedly" with only 12 tool calls completed. The bot keeps timing out and resuming but makes very little progress per cycle — only 1-6 iterations per resume before the watchdog fires again. This suggests the Moonshot direct API streaming is too slow or stalling, causing the DO to hit the stuck threshold (240s for paid models) and evict.

These are symptoms of a deeper reliability problem: the Durable Object task execution pipeline is fragile across different model providers, error conditions, and execution timelines.

## Your Task

Audit the entire task execution pipeline and fix reliability issues. Focus on these files:

### Critical Path (read and audit these first)
1. **`src/durable-objects/task-processor.ts`** (~3200 lines) — The main Durable Object. Contains the entire task lifecycle: init, processTask loop (up to 100 iterations), streaming API calls, tool execution, R2 checkpoints, watchdog alarm, auto-resume, context compression. This is the heart of the system.

2. **`src/openrouter/client.ts`** (~900 lines) — OpenRouter API client. Three methods: `chatCompletion`, `chatCompletionWithTools`, `chatCompletionStreamingWithTools`. Handles SSE parsing, tool-calling loop, error retry.

3. **`src/openrouter/models.ts`** (~1300 lines) — Model catalog with 26+ models. Defines aliases, providers, reasoning capabilities, direct API configs. Recently added `mandatory` reasoning type and `buildFallbackReasoningParam`/`isReasoningMandatoryError`.

4. **`src/orchestra/orchestra.ts`** (~450 lines) — Orchestra prompt builder. Generates system prompts for init/run modes with step-by-step instructions for the AI model.

### Supporting Files
5. **`src/openrouter/tools.ts`** (~1900 lines) — 15 tool definitions + execution. Tool result truncation at 50KB.
6. **`src/durable-objects/speculative-tools.ts`** — Speculative tool execution during streaming.
7. **`src/durable-objects/context-budget.ts`** — Context compression logic.
8. **`src/durable-objects/phase-budget.ts`** — Phase time budgets (plan/work/review).
9. **`src/utils/do-retry.ts`** — Durable Object fetch retry logic.
10. **`src/telegram/handler.ts`** — Telegram command handler, dispatches `/orch` commands.

## Specific Issues to Investigate

### 1. Streaming Reliability for Direct APIs
The task processor handles 4 different API providers:
- **OpenRouter** — SSE streaming via `chatCompletionStreamingWithTools()` in client.ts
- **DeepSeek** — Direct API, custom streaming in task-processor.ts (~line 1680-1810)
- **Moonshot/Kimi** — Direct API, same streaming path
- **DashScope/Qwen** — Direct API, same streaming path

Questions:
- Is the streaming parser robust against partial chunks, connection resets, slow drips?
- What happens when a direct API stream stalls for 30+ seconds between chunks?
- Is the heartbeat mechanism (`lastHeartbeatMs`) properly preventing false stuck detection during slow streams?
- Why does kimidirect exhaust 5 auto-resumes with only 12 tool calls? Is the stuck threshold (240s) too aggressive for slow models?

### 2. Watchdog and Auto-Resume Logic
- Watchdog fires every 90s. Stuck threshold: 150s (free) / 240s (paid).
- Max auto-resumes: 5 for both free and paid.
- Stall detection: if no new tool calls across MAX_NO_PROGRESS_RESUMES (3) consecutive resumes.
- Phase budget: throws `PhaseBudgetExceededError` which backdates `lastUpdate` for fast re-trigger.

Questions:
- Is the watchdog correctly distinguishing "stuck DO that needs resume" from "slow API call that's still making progress"?
- When a resume happens, does the context correctly continue from where it left off? (R2 checkpoint restore)
- Is there a race condition between the watchdog alarm and the running processTask?

### 3. Tool Execution Timeout Pattern
Recently fixed the `Promise.race` timeout leak, but verify:
- Are there any remaining places where `setTimeout` is created without cleanup?
- Could tool execution itself hang indefinitely (e.g., `github_create_pr` calling GitHub API that never responds)?
- The tool result cache — does it properly handle concurrent tool calls?

### 4. Error Classification and Recovery
The task processor classifies errors:
- 402 (payment) → break immediately
- 400 content filter → break
- 400 reasoning mandatory → retry with reasoning (new)
- 400 input validation → compress context and retry
- 429 rate limit → backoff and retry
- 5xx / network → retry up to 3 times

Questions:
- Are all provider-specific error formats handled? (OpenRouter vs DeepSeek vs Moonshot vs DashScope)
- When a direct API returns an error in its streaming response, is it caught?
- What happens when the error is in the SSE stream itself (malformed JSON, unexpected EOF)?

### 5. Context Window Management
- Context compression triggers every 6 tool calls
- Tool results truncated per-call based on batch size
- R2 checkpoints save every 3 tool calls

Questions:
- Can context grow unbounded between compression cycles?
- On resume from checkpoint, is the context size validated?
- Are old tool results properly pruned when approaching the model's context limit?

## Expected Deliverables

1. **Bug fixes** for any issues found (with tests)
2. **Improved error handling** — especially for direct API streaming failures
3. **Better stuck detection** — distinguish slow-but-progressing from truly stuck
4. **Monitoring improvements** — better logging for diagnosing failures in production
5. Run `npm test` (vitest) and `npm run typecheck` before committing

## Commands
```bash
npm test              # Run 1564 tests (vitest)
npm run typecheck     # TypeScript strict check
npm run build         # Build worker + client
```

## Rules
- No `any` types — use proper typing or `unknown` with type guards
- Max 500 lines per file — split if exceeding (task-processor.ts is already over this)
- Test edge cases — empty inputs, error responses, timeouts
- Mock external APIs in tests — never call real APIs
- Commit format: `<type>(<scope>): <description>`
