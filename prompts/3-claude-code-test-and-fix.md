# Claude Code Prompt: Test the Telegram Bot, Analyze Logs, Fix Until Orchestra Works

## Mission

You are in a GitHub Codespace with the full Moltworker codebase. Your job is to **make the bot's `/orch init` command work reliably** on the PetrAnto/wagmi repository. This is an iterative process: test, read logs, fix, deploy, test again — until it actually succeeds.

## What is Moltworker?

A Telegram AI bot on Cloudflare Workers + Durable Objects. It routes prompts to 26+ AI models, supports tool calling (GitHub ops, web search, browser, sandbox), and runs long tasks in Durable Objects with auto-resume.

**The critical feature**: `/orch init <repo> <description>` — analyzes a GitHub repo, creates ROADMAP.md + WORK_LOG.md, opens a PR. Runs in a Durable Object with up to 100 iterations, auto-resuming up to 5 times on timeout.

## Current State

The bot is deployed at `https://moltbot-sandbox.petrantonft.workers.dev`. Recent `/orch init` attempts keep failing:

- **gpt5nano**: Fixed "reasoning is mandatory" 400 error (added mandatory reasoning support)
- **gpt5nano**: Fixed "exceeded active timeouts: 10000" (clearTimeout leak in Promise.race)
- **kimidirect**: Still failing — 5 auto-resumes, 1910s elapsed, only 12 tool calls. The Moonshot API streams too slowly, causing the DO to keep hitting the stuck threshold and resuming with minimal progress.

## Your Iterative Workflow

### Phase 1: Understand the System
```bash
# Read the key files
cat src/durable-objects/task-processor.ts | head -100   # Task lifecycle
cat src/orchestra/orchestra.ts                           # Orchestra prompt
cat src/openrouter/models.ts | head -200                # Model catalog
cat CLAUDE.md                                            # Project rules
```

### Phase 2: Test via /simulate Endpoint

The `/simulate` endpoint lets you test the bot without Telegram. It uses the same DO pipeline with real models.

**You need the DEBUG_API_KEY secret.** Check if it's set:
```bash
# The key should be in .dev.vars for local testing
cat .dev.vars 2>/dev/null | grep DEBUG_API_KEY
```

**Test a simple chat first** (verify the pipeline works at all):
```bash
curl -X POST https://moltbot-sandbox.petrantonft.workers.dev/simulate/chat \
  -H "Authorization: Bearer $DEBUG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "What is 2+2?", "model": "flash", "timeout": 30000}'
```

**Test orchestra init** (the actual failing command):
```bash
curl -X POST https://moltbot-sandbox.petrantonft.workers.dev/simulate/command \
  -H "Authorization: Bearer $DEBUG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "/orch init PetrAnto/wagmi audit and improve", "timeout": 120000}'
```

This will likely time out at 120s. The response includes a `taskId`. Use it to check progress:
```bash
curl https://moltbot-sandbox.petrantonft.workers.dev/simulate/status/$TASK_ID \
  -H "Authorization: Bearer $DEBUG_API_KEY"
```

### Phase 3: Read Cloudflare Worker Logs

```bash
# Stream real-time logs from the deployed worker
npx wrangler tail --format pretty 2>&1 | tee /tmp/worker-logs.txt

# In another terminal, trigger the test
# Then analyze the logs for errors, timeouts, slow streaming
```

Key log patterns to watch for:
- `[TaskProcessor] Iteration N START` — each loop iteration
- `[TaskProcessor] Starting API call` — model API request
- `[TaskProcessor] streaming complete: N chunks` — streaming finished
- `[TaskProcessor] Tool X completed in Nms` — tool execution timing
- `[TaskProcessor] Task stalled` — stall detection fired
- `[TaskProcessor] Phase budget exceeded` — phase timeout
- `[TaskProcessor] Watchdog alarm set` — watchdog fire
- Any `Error`, `error`, `failed`, `timeout` messages

### Phase 4: Identify and Fix Issues

Based on the logs, fix the issues you find. Common areas:

#### A. Streaming Reliability (task-processor.ts ~lines 1680-1810)
The direct API streaming path handles DeepSeek, Moonshot, and DashScope. Issues:
- Slow chunk delivery (30-60s between chunks) → watchdog thinks it's stuck
- The heartbeat (`lastHeartbeatMs`) only updates when a chunk arrives
- If chunks stop, the fetch timeout (idleTimeout + 30s) may fire after the watchdog

**Potential fix**: Add a secondary heartbeat based on TCP connection being alive, not just data arriving. Or increase stuck thresholds for known-slow providers.

#### B. Stuck Detection (task-processor.ts ~lines 560-740)
The watchdog alarm fires every 90s and checks `timeSinceUpdate > stuckThreshold`:
- Free models: 150s threshold
- Paid models: 240s threshold

**Problem**: Moonshot can legitimately take 240+ seconds for a single response. The stuck detection can't distinguish "slow API" from "dead DO".

**Potential fix**: Track whether a fetch is in progress (not just heartbeat time). If we're actively waiting on an API call, extend the threshold.

#### C. Auto-Resume Efficiency (task-processor.ts ~lines 620-740)
When auto-resuming:
1. Loads checkpoint from R2
2. Rebuilds conversation messages
3. Starts a new API call

**Problem**: Each resume loses context because the checkpoint only stores tool call history, not the model's in-progress reasoning. The model has to re-plan from scratch each resume, wasting iterations.

#### D. Model Selection for Orchestra
Not all models handle orchestra well. Models that work need:
- Good tool calling support
- Fast enough streaming (< 120s per response)
- Large context window (orchestr produces long conversations)

**Check which models are most reliable**: flash (Gemini), gpt (GPT-4o), sonnet (Claude), deep (DeepSeek).

### Phase 5: Deploy and Re-test

```bash
# Run tests first
npm test
npm run typecheck

# Deploy
npm run deploy

# Or if deploy needs wrangler:
npx wrangler deploy

# Test again with simulate
curl -X POST https://moltbot-sandbox.petrantonft.workers.dev/simulate/command \
  -H "Authorization: Bearer $DEBUG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "/orch init PetrAnto/wagmi audit and improve", "timeout": 120000}'
```

### Phase 6: Repeat Until Success

Keep iterating: test → logs → fix → deploy → test. The task is complete when `/orch init PetrAnto/wagmi audit and improve` produces a PR with ROADMAP.md + WORK_LOG.md.

**Test with multiple models** to ensure robustness:
```bash
# Test with Gemini Flash (fastest, most reliable)
curl -X POST .../simulate/command \
  -d '{"command": "/use flash"}'
curl -X POST .../simulate/command \
  -d '{"command": "/orch init PetrAnto/wagmi audit and improve", "timeout": 120000}'

# Test with DeepSeek (direct API)
curl -X POST .../simulate/command \
  -d '{"command": "/use deep"}'
curl -X POST .../simulate/command \
  -d '{"command": "/orch init PetrAnto/wagmi audit and improve", "timeout": 120000}'
```

## Key Architecture Details

### Durable Object Lifecycle
```
processTask() {
  for (iteration = 0; iteration < maxIterations; iteration++) {
    // 1. Build request (model-specific adjustments)
    // 2. Call API (OpenRouter SSE or direct provider streaming)
    // 3. Parse response
    // 4. If tool_calls: execute tools → add results → continue
    // 5. If no tool_calls: check for completion → break
    // 6. Every 3 tools: R2 checkpoint
    // 7. Every 6 tools: context compression
  }
}

alarm() {  // Watchdog - fires every 90s
  // If task still running and heartbeat recent: reschedule
  // If no heartbeat for 240s: auto-resume from checkpoint
  // If 5 auto-resumes exhausted: mark failed
}
```

### Tools Available to the Bot
| Tool | Purpose | Risk |
|------|---------|------|
| `github_list_files` | List directory in a repo | Safe, fast |
| `github_read_file` | Read a file (30KB limit) | ~7K tokens per call |
| `github_api` | Generic GitHub API call | Powerful, watch auth |
| `github_create_pr` | Create PR with file changes | Can fail on large changes |
| `fetch_url` | Fetch URL content | Network dependent |
| `web_search` | Brave Search | API key required |
| `browse_url` | Browser rendering | Slow, resource heavy |
| `sandbox_exec` | Shell in container | For complex operations |

### Environment Secrets (in wrangler.jsonc / .dev.vars)
- `OPENROUTER_API_KEY` — Main AI gateway
- `TELEGRAM_BOT_TOKEN` — Telegram bot
- `GITHUB_TOKEN` — GitHub operations
- `DEBUG_API_KEY` — /simulate endpoint auth
- `DEEPSEEK_API_KEY` — DeepSeek direct
- `MOONSHOT_API_KEY` — Kimi/Moonshot direct
- `DASHSCOPE_API_KEY` — Qwen direct
- `BRAVE_SEARCH_KEY` — Web search

## Success Criteria

1. `/orch init PetrAnto/wagmi audit and improve` completes successfully and creates a PR
2. Works with at least 2 different models (e.g., flash + deep)
3. All 1564+ existing tests still pass
4. No new timeout leaks or error regressions
5. Changes committed with descriptive messages

## Rules
- No `any` types — TypeScript strict mode
- Max 500 lines per file
- Mock external APIs in tests
- Commit format: `type(scope): description`
- Branch: create from current HEAD, push to your feature branch
