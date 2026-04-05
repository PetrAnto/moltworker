# Future Integrations & Improvements

This document tracks potential features and integrations for the Moltworker Telegram bot with OpenRouter.

## Current State (updated Mar 2026)

### What We Have
- **30+ AI models** via OpenRouter + automated full-catalog sync (curated + auto-sync)
- **16 tools** including web search, browser automation, code execution, file management
- **Image generation** with FLUX.2 models (klein, pro, flex, max)
- **GitHub tools** (read files, list directories, API calls, create PRs) with auto-auth
- **Durable Objects** for unlimited task time (no timeout)
- **User allowlist** security
- **Skills loading** from R2 storage
- **Status updates** during long operations
- **Long-term memory** (fact extraction + injection per user)
- **Browser automation** (CDP: a11y tree, click, fill, scroll)
- **Orchestra mode** for multi-model competitive task execution

### Architecture
```
Telegram Webhook → Worker → Durable Object (for tool-using models)
                         → OpenRouter API → Any Model
                         → Direct response (for simple models)
```

---

## Priority 1: High Value, Low Effort

### 1.1 Browser Tool (CDP Integration)
**Status:** ✅ Complete (F.2 — Phase 5/7, Mar 2026) — 4 actions (a11y tree, click, fill, scroll) + session persistence
**Effort:** Low (binding already exists)
**Value:** High

The `BROWSER` binding is already configured in wrangler.jsonc. Add a tool that models can call:

```typescript
browse_url({
  url: string,
  action: "screenshot" | "extract_text" | "pdf" | "click" | "fill"
})
```

**Implementation:**
- Create `src/openrouter/tools/browser.ts`
- Add to AVAILABLE_TOOLS
- Use Cloudflare Browser Rendering API

**Use Cases:**
- "Take a screenshot of my website"
- "What does the homepage of X say?"
- "Check if my deployment is working"
- "Get the current price of BTC from coinbase"

### 1.2 Inline Buttons (Telegram)
**Status:** Not started
**Effort:** Low
**Value:** Medium

Add interactive buttons to responses for:
- Confirmations ("Create this PR?" [Yes] [No])
- Quick choices ("Which model?" [GPT] [Claude] [DeepSeek])
- Pagination for long results

**Implementation:**
- Add `sendMessageWithButtons()` to TelegramBot class
- Handle callback queries in `handleCallback()`
- Store pending actions in R2 or DO storage

### 1.3 Draft Streaming (Telegram)
**Status:** Not started
**Effort:** Medium
**Value:** Medium

Show partial responses as they stream in (requires threaded mode in BotFather).

**Implementation:**
- Enable streaming in OpenRouter client
- Use `editMessage` to update content as tokens arrive
- Throttle updates to avoid rate limits

---

## Priority 2: Discord Integration

### 2.1 Discord Read-Only (Announcements)
**Status:** Not started
**Effort:** Medium
**Value:** High (user requested)

Monitor Discord servers for announcements and forward to Telegram.

**Architecture Options:**

**Option A: Discord Bot (Full)**
- Create Discord bot with message read permissions
- Use discord.js or raw API
- Route messages through our OpenRouter handler

**Option B: Webhook Listener**
- Use Discord webhooks to receive specific channel updates
- Lighter weight, no bot needed
- Limited to channels with webhook setup

**Option C: User Account (Not Recommended)**
- Against Discord ToS
- Risk of ban

**Recommended: Option A with minimal permissions**

```typescript
// New env vars needed:
DISCORD_BOT_TOKEN
DISCORD_ANNOUNCEMENT_CHANNELS  // comma-separated channel IDs
DISCORD_FORWARD_TO_TELEGRAM    // telegram chat ID to forward to
```

**Features:**
- Monitor specific channels only
- Forward new messages to Telegram
- Optionally summarize with AI before forwarding
- Filter by keywords or roles

### 2.2 Discord Full Integration
**Status:** Future
**Effort:** High
**Value:** Medium

Full two-way Discord integration like Telegram:
- Respond to DMs
- Respond to mentions in servers
- Use same OpenRouter backend

---

## Priority 3: More Tools

### 3.1 Web Search Tool
**Status:** ✅ Complete (Phase 5.5, Feb 2026) — web_search tool with result formatting
**Effort:** Medium
**Value:** High

Let models search the web for current information.

**Options:**
- Brave Search API (has free tier)
- SearXNG (self-hosted)
- Perplexity API
- Google Custom Search

```typescript
web_search({
  query: string,
  num_results?: number
})
```

### 3.2 Code Execution Tool
**Status:** ✅ Complete (F.3, Phase 5.3, Mar 2026) — sandbox_exec via Cloudflare Containers, 15-call safety limit
**Effort:** High
**Value:** High

Run code snippets safely in a sandbox.

**Options:**
- Use existing Cloudflare Sandbox container
- Piston API (multi-language execution)
- Judge0 API

```typescript
run_code({
  language: "python" | "javascript" | "bash",
  code: string
})
```

### 3.3 File Management Tools
**Status:** ✅ Complete (F.4, Mar 2026) — R2-backed save/read/list/delete, per-user scoping, 10MB quota
**Effort:** Low
**Value:** Medium

Store and retrieve files from R2:

```typescript
save_file({ name: string, content: string })
read_file({ name: string })
list_files({ prefix?: string })
delete_file({ name: string })
```

### 3.4 Calendar/Reminder Tools
**Status:** Not started
**Effort:** Medium
**Value:** Medium

Set reminders that trigger via cron:

```typescript
set_reminder({
  message: string,
  when: string  // "in 2 hours", "tomorrow 9am", etc.
})
list_reminders()
delete_reminder({ id: string })
```

---

## Priority 4: Advanced Features

### 4.1 Proactive Notifications (Cron)
**Status:** Partial (cron exists for R2 backup)
**Effort:** Medium
**Value:** High

Use existing cron trigger for proactive tasks:
- Daily summaries
- Price alerts
- Website monitoring
- GitHub activity digest

### 4.2 Voice Messages
**Status:** Not started
**Effort:** High
**Value:** Medium

Handle Telegram voice messages:
- Transcribe with Whisper API
- Respond with TTS (ElevenLabs, OpenAI TTS)

### 4.3 Multi-User Workspaces
**Status:** Not started
**Effort:** High
**Value:** Low (currently single-user)

Share context between users:
- Team workspaces
- Shared conversation history
- Role-based access

### 4.4 Long-Term Memory
**Status:** ✅ Complete (F.8, Mar 2026) — 100 facts/user, flash extraction, dedup, /memory command, 26 tests
**Effort:** Medium
**Value:** High

Persistent memory across conversations:
- Store facts in R2 (MEMORY.md like OpenClaw)
- Retrieve relevant memories for context
- User can view/edit memories

---

## Priority 5: Platform Integrations

### 5.1 Slack Integration
**Status:** Not started
**Effort:** Medium
**Value:** Low (unless needed)

Same pattern as Telegram but for Slack workspaces.

### 5.2 WhatsApp Integration
**Status:** Not started
**Effort:** High
**Value:** Medium

Via WhatsApp Business API (requires approval).

### 5.3 Email Integration
**Status:** Not started
**Effort:** Medium
**Value:** Medium

- Receive emails via Cloudflare Email Workers
- Send emails via Mailgun/SendGrid
- Summarize inbox, draft replies

---

## Priority 6: OpenClaw Integration (Post-Debug Audit, Apr 2026)

> Identified during the bot-unresponsive debug session. The OpenClaw gateway
> running in the Sandbox container has features worth absorbing into the
> Moltworker Telegram pipeline rather than running two competing bots.

### 6.1 Multi-Agent Sessions (Parallel Sub-Agents)
**Status:** Not started
**Effort:** Medium (1-2 weeks) — reuse OpenClaw gateway as execution backend
**Value:** High — biggest capability gap vs OpenClaw

OpenClaw's multi-agent system is **gateway-coupled** — spawn, registry, session
lifecycle, and parent→child messaging all run inside the `openclaw gateway`
process via WebSocket RPC. It cannot be imported as a standalone library.

**What this enables:**
- "Research X, Y, Z simultaneously" → 3 parallel sub-agents, results merged
- Orchestra parallelism: run non-dependent roadmap tasks concurrently
- Background monitoring: spawn a watcher agent while chatting normally

**Architecture: Delegate to OpenClaw gateway (already running in container)**

The gateway exposes these RPC methods (via WebSocket on port 18789):
- `sessions.create` — create a child session with task + model + label
- `sessions.send` — send a message to a session
- `sessions.abort` — cancel a running session
- `sessions.list` — list active/recent sessions
- `sessions.history` — get session transcript

OpenClaw's own sub-agent system uses exactly these methods internally via
`callGateway()`. We call the same API from the Worker via `containerFetch()`.

```
Telegram "/spawn research AI safety"
  → Worker: parse command
  → containerFetch(sandbox, 'ws://localhost:18789')
    → gateway RPC: sessions.create({ task, model, label })
    → gateway spawns child session internally
    → child session runs with OpenClaw's AI + tools
  → gateway RPC: sessions.subscribe(childKey)
    → completion event arrives
  → Worker: forward result to Telegram
```

**Implementation steps:**
1. Add `src/multiagent/gateway-client.ts` — WebSocket RPC client for gateway
   (reuse `callGateway` protocol: JSON-RPC over WebSocket, method+params)
2. Add `src/multiagent/coordinator.ts` — tracks spawned agents per user,
   merges results, handles timeouts and cleanup
3. Wire into Telegram handler:
   - `/spawn <task>` — spawn a sub-agent via `sessions.create`
   - `/agents` — list active sub-agents via `sessions.list`
   - `/kill <id>` — abort a sub-agent via `sessions.abort`
   - `/steer <id> <msg>` — redirect a sub-agent via `sessions.send`
4. Completion delivery: gateway announces results back to parent session;
   coordinator captures and forwards to Telegram chat
5. Limit: max 3-5 concurrent agents per user (cost control)

**Why this works better than building from scratch:**
- OpenClaw gateway already handles session isolation, tool execution,
  context management, model routing, and result delivery
- We get OpenClaw's full tool set (exec, web, files) inside sub-agents
- Moltworker stays the Telegram interface; gateway stays the AI runtime
- No DO changes needed — coordinator runs in Worker or a dedicated DO

**Key decisions needed:**
- Auth: pass `OPENCLAW_GATEWAY_TOKEN` for RPC calls
- Model routing: let gateway use its own catalog or override with Moltworker's?
- Result format: raw text vs structured summary
- Whether sub-agents can access Moltworker tools (GitHub, Brave) or only
  OpenClaw's built-in tools

### 6.2 NVIDIA NIM Free Models
**Status:** Not started
**Effort:** Low (2-3 hours)
**Value:** Medium — 12 free models expand the free tier significantly

NVIDIA NIM (build.nvidia.com) offers free models via OpenAI-compatible API.
Add as a direct provider alongside DeepSeek/Moonshot/DashScope.

**Models to add:**
- Nemotron Ultra 253B (nvidia/llama-3.3-nemotron-super-49b-v1)
- Qwen 3.5 32B / 72B (qwen/qwen3.5-32b, qwen/qwen3.5-72b)
- DeepSeek R1 (deepseek-ai/deepseek-r1)
- Kimi K2 (moonshotai/kimi-k2)
- Devstral Small (mistralai/devstral-small)
- GLM-5 (THUDM/glm-5-32b-chat)

**Implementation:**
- Add `nvidia` provider in `src/openrouter/models.ts` (baseUrl: `https://integrate.api.nvidia.com/v1`)
- Add model entries with aliases (e.g., `/nemotron`, `/glm5`)
- Add `NVIDIA_NIM_API_KEY` to env types and `src/routes/telegram.ts`
- Wire into TaskProcessor's provider switch (same pattern as DeepSeek/Moonshot)
- No special auth — standard Bearer token, OpenAI-compatible /chat/completions

### 6.3 Web Chat UI (Route Through Moltworker Pipeline)
**Status:** Not started
**Effort:** Medium (1-2 weeks)
**Value:** Medium — provides browser-based access to all Moltworker features

The OpenClaw gateway's WebSocket chat UI is already proxied through the Worker
catch-all route. Currently it uses OpenClaw's own AI handler (separate models,
no tools, no orchestra). Route it through Moltworker's pipeline instead.

**What this enables:**
- Use all 26+ Moltworker models from the browser
- Full tool access (GitHub, web search, sandbox, etc.) from web UI
- Orchestra commands from browser
- Shared conversation history between Telegram and web

**Implementation approach:**
- Add a WebSocket route `/ws/chat` that bypasses the catch-all proxy
- WebSocket handler creates same `TaskRequest` as Telegram handler
- TaskProcessor sends results back via WebSocket instead of Telegram API
- Add a `transport` field to TaskRequest: `'telegram' | 'websocket'`
- Reuse existing system prompt, tools, model selection, memory
- Web UI served from existing `/dist/client` (extend dashboard with chat tab)

**Key decisions needed:**
- Auth: reuse Cloudflare Access JWT or separate session tokens?
- Whether to keep OpenClaw's chat UI or build a minimal custom one
- How to handle long-running tasks (WebSocket keepalive vs polling)

---

## Orchestra Evolution (Post-F.18 Review Backlog)

> Identified by GPT/Grok/Gemini architecture reviews of the ExecutionProfile work.
> Tracked in GLOBAL_ROADMAP.md as F.20–F.24.

### Runtime Risk Classification (F.20)
**Status:** ✅ Complete (2026-03-22, 24 tests, 2006 total)
**Effort:** 2h (actual, vs 8-12h estimated)
**Value:** High — biggest remaining architectural gap per all three reviewers

Currently, task classification happens entirely pre-execution based on the roadmap title. A second-stage profiler would observe runtime behavior:
- Files actually touched (config/build files = higher risk)
- Single-file → multi-file expansion
- Diff size vs title prediction divergence
- Error patterns during execution

This would enable dynamic re-routing mid-task (e.g., escalate model if task turns out harder than predicted).

### Branch-Level Concurrency Mutex (F.23)
**Status:** 🔲 Not started
**Effort:** Medium (4-6h)
**Value:** High — prevents data corruption from parallel tasks

Durable Objects handle internal queuing, but parallel task ingestion from external webhooks can cause branch collisions. Need persistent branch-level lock via KV or R2 to guarantee exclusive write access during active orchestration runs.

### Profile Enforcement Tests (F.22)
**Status:** ✅ Complete (2026-03-22, 14 tests, 2020 total)
**Effort:** 30m (actual, vs 2-3h estimated)
**Value:** Medium — regression safety

Test coverage for:
- `promptTierOverride` overriding `getPromptTier()`
- `sandbox_exec` absent from tool set when `requiresSandbox=false`
- Auto-escalation changing model alias + recomputing profile

---



### Code Quality
- [x] Add unit tests for tools — 1911 tests total (Mar 2026)
- [x] Add integration tests for Telegram handler — partial via /simulate endpoint
- [ ] Add error tracking (Sentry?)
- [x] Add request logging/analytics — partial (Acontext Phase 2.3, Orchestra events F.11)

### Performance
- [x] Cache frequent API responses — tool result cache (Phase 4.3)
- [x] Optimize token usage (shorter system prompts) — smart context loading (7A.2)
- [x] Batch tool calls where possible — parallel execution (Phase 1.1, PARALLEL_SAFE_TOOLS)

### Security
- [ ] Rate limiting per user
- [x] Input sanitization for tools — destructive op guard (7A.3)
- [x] Audit logging for sensitive operations — partial (Acontext sessions, orchestra events)

---

## BYOK / Direct API Lessons Learned

> Critical for byok.cloud and any future BYOK (Bring Your Own Key) feature.

### API Keys Are Region-Locked (DashScope / Alibaba Cloud)
- **Issue:** DashScope API keys are scoped to the region where they were created (Singapore, US Virginia, China Beijing). A Singapore key returns 401 on the Beijing endpoint.
- **Regional endpoints:**
  - Singapore: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
  - US (Virginia): `https://dashscope-us.aliyuncs.com/compatible-mode/v1`
  - China (Beijing): `https://dashscope.aliyuncs.com/compatible-mode/v1`
- **Impact on BYOK:** When users bring their own DashScope keys, we must either:
  1. Ask which region their key belongs to, or
  2. Auto-detect by trying the key against each regional endpoint, or
  3. Let users provide a custom base URL
- **Lesson:** Never assume a single base URL works for all users of a provider. Other providers may have similar region-locking (Azure OpenAI, AWS Bedrock, etc.).

### General BYOK Considerations
- Validate keys at setup time — make a lightweight test call and surface clear errors
- Store per-user provider config (endpoint + key), not just the key
- Some providers require additional config beyond just an API key (region, project ID, deployment name)

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| Feb 2026 | Use OpenRouter instead of direct APIs | Unified access to 26+ models, simpler billing |
| Feb 2026 | Implement Durable Objects | Unlimited task time for complex coding |
| Feb 2026 | Bypass Gateway for Telegram | Custom multi-model support, image gen |
| Feb 2026 | Switch DashScope to `-intl` endpoint | API keys are region-locked; our key is Singapore, not Beijing |

---

## Resources

- [OpenRouter API Docs](https://openrouter.ai/docs)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/)
- [OpenClaw Skills](https://github.com/VoltAgent/awesome-openclaw-skills)
- [Discord API](https://discord.com/developers/docs)
