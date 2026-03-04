# Gemini Prompt: Audit and Improve Moltworker

## What is Moltworker?

Moltworker is a Telegram/Discord/Slack AI bot built on **Cloudflare Workers + Durable Objects**. It routes user messages to 26+ AI models via OpenRouter and direct APIs (DeepSeek, Moonshot/Kimi, DashScope/Qwen), supports tool calling (GitHub ops, web search, browser rendering, sandbox execution), and runs long tasks in Durable Objects with auto-resume.

**Tech stack**: Hono 4.11, TypeScript 5.9 strict, React 19 + Vite 6, Cloudflare R2, Vitest 4.0.

## The Core Feature That's Broken

**Orchestra Mode** (`/orch init <repo> <description>`) is a structured workflow where the bot:
1. Analyzes a GitHub repository (lists files, reads key files)
2. Creates a ROADMAP.md with phased tasks
3. Creates a WORK_LOG.md
4. Opens a PR with both files
5. Reports back to Telegram

This runs inside a **Durable Object (TaskProcessor)** that supports up to 100 iterations of model API calls + tool execution, with R2 checkpointing every 3 tool calls and auto-resume (up to 5 times) when the DO times out.

## Recent Failures (All on PetrAnto/wagmi repo)

| Model | Error | Root Cause |
|-------|-------|------------|
| gpt5nano | `"Reasoning is mandatory for this endpoint and cannot be disabled."` (400) | Bot sent `reasoning: { enabled: false }` to a model that requires reasoning. Fixed: added `mandatory` reasoning type. |
| gpt5nano | `"exceeded active timeouts: 10000"` | `Promise.race([tool, timeout])` leaked setTimeout callbacks — never cleared. Over 100 iterations × 5 tools = 500+ orphaned timers. Fixed: added `clearTimeout()` in finally blocks. |
| kimidirect (Kimi K2.5) | 5 auto-resumes, 1910s elapsed, only 12 tools completed. "Task stopped unexpectedly." | Unknown. The Moonshot direct API streaming appears too slow. The DO keeps hitting the stuck threshold (240s) and resuming, but makes minimal progress per cycle (1-6 iterations). |

The pattern is clear: **every model we try hits a different failure mode**. The system is not robust.

## Architecture Overview

### Key Files (in order of importance)

```
src/durable-objects/task-processor.ts  (~3200 lines) — THE critical file
  ├── TaskProcessor class (Durable Object)
  ├── processTask() — main execution loop (up to 100 iterations)
  ├── Direct API streaming (DeepSeek, Moonshot, DashScope) — lines ~1680-1810
  ├── Tool execution with Promise.race timeout — lines ~2055-2130
  ├── Watchdog alarm() — stuck detection + auto-resume — lines ~560-740
  ├── R2 checkpoint save/restore — lines ~800-900
  └── Context compression — triggered every 6 tool calls

src/openrouter/client.ts              (~900 lines) — OpenRouter API client
  ├── chatCompletion() — non-streaming, no tools
  ├── chatCompletionWithTools() — non-streaming, with tool loop
  └── chatCompletionStreamingWithTools() — SSE streaming + tool loop

src/openrouter/models.ts              (~1300 lines) — 26+ model definitions
  ├── Model catalog with aliases, providers, capabilities
  ├── getReasoningParam() — reasoning parameter injection
  └── Direct API provider configs (baseUrl, envKey)

src/orchestra/orchestra.ts            (~450 lines) — Prompt builder
  ├── buildInitPrompt() — system prompt for /orch init
  └── buildRunPrompt() — system prompt for /orch run

src/openrouter/tools.ts               (~1900 lines) — 15 tool definitions
  ├── github_read_file, github_list_files, github_api, github_create_pr
  ├── fetch_url, browse_url, web_search, url_metadata
  ├── sandbox_exec — code execution in container
  └── Tool result truncation at 50KB
```

### Task Lifecycle

```
User sends /orch init → Telegram handler → creates TaskProcessor DO
  → processTask() starts main loop
    → Build messages with orchestra system prompt
    → Call model API (OpenRouter or direct provider)
    → If response has tool_calls → execute tools → add results → loop
    → If no tool_calls → check for ORCHESTRA_RESULT → done
    → Every 3 tools: save R2 checkpoint
    → Every 6 tools: compress context
    → Watchdog alarm every 90s checks if stuck
    → If stuck (no heartbeat for 240s): auto-resume from checkpoint
    → Max 5 auto-resumes before giving up
```

### Direct API Streaming (the likely source of kimidirect failure)

The task processor handles direct APIs differently from OpenRouter. For Moonshot/DeepSeek/DashScope, it builds the HTTP request manually and parses the SSE stream in a custom loop (~line 1680-1810 in task-processor.ts):

```
1. Build request body with model-specific adjustments
2. Fetch with AbortController + timeout (idleTimeout + 30s)
3. Parse SSE stream line by line
4. Track chunks, update heartbeat every chunk
5. Handle tool_calls in streamed response
6. On stream error: retry up to 3 times with 2s backoff
```

**Potential issues:**
- If the stream delivers chunks very slowly (e.g., one chunk every 30-60s), does the heartbeat update fast enough to prevent watchdog intervention?
- If the stream stalls completely (no chunks), does the fetch timeout fire before the stuck threshold? (fetch timeout = idleTimeout + 30s, stuck threshold = 240s)
- What if the connection is alive but no data flows for exactly the stuck threshold?

### Timeouts and Thresholds

| Parameter | Value | Description |
|-----------|-------|-------------|
| Watchdog interval | 90s | Alarm fires every 90s |
| Stuck threshold (free) | 150s | No heartbeat → consider stuck |
| Stuck threshold (paid) | 240s | More patience for paid models |
| Max auto-resumes | 5 | Then gives up |
| Tool timeout | 60s | Per-tool execution limit |
| Fetch timeout | idleTimeout + 30s | HTTP request timeout |
| Phase budget | varies | Plan/work/review time limits |
| Max iterations | 100 | Per DO execution cycle |
| Checkpoint interval | 3 tools | Save to R2 |
| Context compression | 6 tools | Compress old messages |

## What I Need You to Do

### 1. Audit the Streaming Pipeline
Read `src/durable-objects/task-processor.ts` lines 1600-1850 (direct API streaming) and:
- Trace exactly what happens when Moonshot's API streams slowly
- Identify where the heartbeat can fall behind the stuck threshold
- Check if the streaming parser handles all edge cases (empty chunks, partial JSON, connection drops)
- Propose fixes for streaming reliability

### 2. Audit the Watchdog / Auto-Resume
Read lines 560-740 (alarm handler) and:
- Check for race conditions between watchdog and running processTask
- Verify the `isRunning` flag prevents double execution
- Check if checkpoint restore on resume produces valid conversation state
- Evaluate whether 5 auto-resumes is appropriate or if we need smarter stopping

### 3. Audit Error Handling Across Providers
Read the error classification in processTask catch blocks (~lines 1770-1830) and:
- Verify each provider's error format is handled (OpenRouter JSON vs direct API errors)
- Check if streaming errors (mid-stream failures) are caught and retried
- Look for silent failures where errors are swallowed

### 4. Audit Context Window Management
Read `src/durable-objects/context-budget.ts` and the compression calls in task-processor.ts:
- Can context grow beyond the model's window between compressions?
- On resume, does compressed context + new messages fit the model?
- Are tool results properly sized for the model's context?

### 5. Propose Architectural Improvements
Based on your audit, suggest:
- Better timeout/threshold values
- More granular stuck detection (stream progress vs truly stuck)
- Better error recovery patterns
- Any design flaws in the DO lifecycle

## How to Run

```bash
npm test              # 1564 tests via vitest
npm run typecheck     # TypeScript strict mode check
npm run build         # Build the worker
```

## Rules
- No `any` types
- Max 500 lines per file (task-processor.ts already violates this)
- Mock all external APIs in tests
- Commit format: `type(scope): description`
- Run tests before committing
