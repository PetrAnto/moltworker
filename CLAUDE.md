# Moltworker — Claude Code Project Instructions

> This file is automatically read by Claude Code. It contains critical rules and context.

**Last Updated:** 2026-02-28

---

## Documentation Sync

If `claude-share/` exists (via symlink or local copy from the private companion repo):
1. Follow `claude-share/core/SYNC_CHECKLIST.md` after every task
2. Update `claude-share/core/GLOBAL_ROADMAP.md` — task status + changelog
3. Update `claude-share/core/WORK_STATUS.md` — sprint state
4. Update `claude-share/core/next_prompt.md` — point to next task
5. Append to `claude-share/core/claude-log.md` — session entry

If not available, commit with standard format and document changes in PR description.

### Deferred Monitor Items (check each session)

Before starting work, scan `claude-share/core/WORK_STATUS.md` → **Deferred / Monitor Items** table.
If a trigger condition is now met (e.g. a platform release, upstream change), prioritize that item.

---

## Project Overview

**Moltworker** is a multi-platform AI assistant gateway on Cloudflare Workers.

| Component | Tech |
|-----------|------|
| Runtime | Cloudflare Workers + Sandbox Containers |
| Framework | Hono 4.11 |
| Language | TypeScript 5.9 (strict) |
| Frontend | React 19 + Vite 6 |
| AI Models | 26+ via OpenRouter + Direct APIs |
| Storage | Cloudflare R2 (S3-compatible) |
| Long Tasks | Durable Objects (TaskProcessor) |
| Chat | Telegram, Discord, Slack |
| Testing | Vitest 4.0 |
| Browser | Cloudflare Browser Rendering |

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entrypoint |
| `src/openrouter/models.ts` | Model catalog (26+ models) |
| `src/openrouter/tools.ts` | Tool definitions and execution (5 tools) |
| `src/openrouter/client.ts` | OpenRouter API client with tool-calling loop |
| `src/durable-objects/task-processor.ts` | Long-running task engine |
| `src/telegram/handler.ts` | Telegram bot handler |
| `src/routes/telegram.ts` | Telegram webhook route |
| `src/routes/discord.ts` | Discord integration |
| `src/gateway/process.ts` | Sandbox container management |
| `src/client/App.tsx` | Admin dashboard UI |
| `src/routes/simulate.ts` | Simulation/testing endpoint (no Telegram needed) |
| `src/telegram/capturing-bot.ts` | CapturingBot for command simulation |
| `brainstorming/future-integrations.md` | Feature roadmap |

---

## Rules

### Security-First
- **Never commit secrets** — API keys, tokens, `.dev.vars` are gitignored
- **Validate all inputs** — Tool arguments, URL parameters, request bodies
- **Redact logs** — Use `src/utils/logging.ts` for any user data
- **No eval()** — Ever

### Bug Fix Policy
- **Fix bugs when you find them** — Never defer to "future work" or "noted for later". If you can see it's broken, fix it now.
- **Don't trust repeated code patterns** — Copy-pasted code can repeat the same mistake. Trace the actual data flow instead of assuming existing code is correct.
- **Think about realistic inputs** — Mentally test with nested paths, special characters, multibyte strings, empty values, and other edge cases before moving on.

### Code Quality
- **Run tests before committing** — `npm test`
- **Run typecheck** — `npm run typecheck`
- **No `any` types** — Use proper typing or `unknown` with type guards
- **Keep functions focused** — One responsibility per function
- **Max 500 lines per file** — Split if exceeding

### Git Workflow
- **Never push to `main`** — PRs only
- **Branch naming:** `claude/<task-slug>-<id>`
- **Commit format:** `<type>(<scope>): <description>`
- **Atomic commits** — One logical change per commit

### Testing
- **Vitest** — Test files colocated: `foo.ts` → `foo.test.ts`
- **Mock external APIs** — Never call real APIs in tests
- **Test edge cases** — Empty inputs, error responses, timeouts

---

## Commands

```bash
npm test              # Run tests (vitest)
npm run test:watch    # Watch mode
npm run build         # Build worker + client
npm run deploy        # Deploy to Cloudflare
npm run dev           # Vite dev server
npm run start         # Local worker (wrangler dev)
npm run typecheck     # TypeScript check
```

---

## Bot Testing (via /simulate)

The `/simulate` endpoint lets Claude Code test the bot via HTTP — no Telegram needed.
**After making changes to the bot, use these endpoints to verify behavior before committing.**

**Base URL:** `https://moltbot-sandbox.petrantonft.workers.dev`
**Auth:** `Authorization: Bearer $DEBUG_API_KEY` (set via `wrangler secret put DEBUG_API_KEY`)

### Test a chat prompt (full DO pipeline with real models + tools)

```bash
curl -X POST https://moltbot-sandbox.petrantonft.workers.dev/simulate/chat \
  -H "Authorization: Bearer $DEBUG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "What is 2+2?", "model": "flash", "timeout": 60000}'
```

Returns: `{ status, result, toolsUsed, iterations, model: {requested, resolved}, durationMs, timedOut }`

Options: `text` (required), `model` (default: "flash"), `timeout` (default: 60000, max: 120000), `systemPrompt` (optional)

### Test a /command (captures all bot messages via CapturingBot)

```bash
curl -X POST https://moltbot-sandbox.petrantonft.workers.dev/simulate/command \
  -H "Authorization: Bearer $DEBUG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "/models"}'
```

Returns: `{ command, messages[], allCaptured[], durationMs }`

Options: `command` (required), `timeout` (optional, max: 120000 — when set, polls the Durable Object for orchestra commands that dispatch async tasks, returning `doResult` with the full task status)

### Check status of a timed-out chat simulation

```bash
curl https://moltbot-sandbox.petrantonft.workers.dev/simulate/status/$TASK_ID \
  -H "Authorization: Bearer $DEBUG_API_KEY"
```

### Health check

```bash
curl https://moltbot-sandbox.petrantonft.workers.dev/simulate/health \
  -H "Authorization: Bearer $DEBUG_API_KEY"
```

### When to use

- **After changing model resolution** — simulate `/models`, `/use`, `/pick` to verify
- **After changing tool execution** — simulate a prompt that triggers tools (e.g. "search the web for X")
- **After changing the DO pipeline** — simulate a chat to verify end-to-end
- **Before committing** — run a quick simulation to sanity-check
- **Debugging user-reported issues** — reproduce the exact prompt to see what happens

---

## Technical Reference

### OpenRouter Tool-Calling Loop
1. Build `ChatCompletionRequest` with `tools` and `tool_choice: 'auto'`
2. Send to OpenRouter API
3. If response has `tool_calls` → execute tools → add results → loop back to step 2
4. If no `tool_calls` → return final text response
5. Max iterations: 10 (Worker), 100 (Durable Object)

### Model Selection
- Models defined in `src/openrouter/models.ts`
- Aliases map to OpenRouter model IDs
- `supportsTools` flag controls tool injection
- Direct APIs (DashScope, Moonshot, DeepSeek) bypass OpenRouter

### Tool Execution
- Tools defined in `src/openrouter/tools.ts`
- `ToolContext` carries secrets (GitHub token, browser binding)
- Tool results truncated at 50KB (tools.ts) or 8KB (task-processor.ts)
- Errors returned as tool results, not thrown

### Durable Objects (TaskProcessor)
- Handles tasks exceeding Worker timeout (10s)
- Watchdog alarm every 90s, stuck threshold 60s
- Auto-resume up to 10 times
- R2 checkpoints every 3 tool calls
- Context compression every 6 tool calls

### Validation Patterns
- URL validation: Use `URL` constructor
- GitHub paths: Validate owner/repo format
- Tool arguments: JSON.parse with try/catch
- API responses: Check `.ok` before reading body

### Logging
- Use `console.log`/`console.error` with `[ComponentName]` prefix
- Redact secrets using `src/utils/logging.ts`
- Include timing info for performance-sensitive operations
