# Upstream OpenClaw Triage — 2026 Q1

**Date**: 2026-03-29
**Auditor**: Claude Opus 4.6 (automated)
**Scope**: OpenClaw issues #4475, #4470, #4453, #4448, #4446, #2026 + changelog entries + CF platform updates

---

## Issue-by-Issue Assessment

### 1. #4475 — Session Corruption When Tool Call Aborted Mid-Stream

**Verdict**: ADAPT-PATTERN
**Priority**: P1
**Effort**: ~3-4h
**Affected Component**: `src/openrouter/client.ts`, `src/durable-objects/task-processor.ts`

**Current State**: Moltworker has partial handling:
- `parseSSEStream()` filters incomplete tool calls on `stream_split` finish reason
- `onToolCallReady` callback notifies when tool calls complete during streaming
- TaskProcessor tracks `isStreaming` flag for mid-stream DO evictions
- **BUT**: No explicit recovery for reader cancellation — catches `AbortError` only at top level
- **BUT**: If a tool call is interrupted mid-argument, it's silently discarded, not recovered

**Recommendation**: Review upstream fix. If they implement a checkpoint/resume pattern for mid-stream tool calls, adapt it to the TaskProcessor's existing watchdog resume mechanism. Focus on:
- Detecting partial tool call state before stream abort
- Persisting partial tool call to R2 checkpoint (existing checkpoint infra)
- Resuming from last complete tool call on watchdog restart

---

### 2. #4470 — Populate Slack Thread Session with Existing Thread History

**Verdict**: IGNORE
**Priority**: P3
**Effort**: N/A
**Affected Component**: N/A

**Current State**: Moltworker does **not** have Slack support implemented. The `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` env vars are referenced in comments (`src/index.ts`) but no Slack handler, routes, or integration code exists.

**Recommendation**: No action needed. If Slack is implemented later, consider this pattern during design.

---

### 3. #4453 — Discord MessageListener Performance Regression (33-122s delays)

**Verdict**: IGNORE
**Priority**: P3
**Effort**: N/A
**Affected Component**: `src/routes/discord.ts`, `src/discord/handler.ts`

**Current State**: Moltworker uses **REST polling** for Discord, not WebSocket MessageListener. The `checkAllChannels()` method polls the Discord API with an `after` cursor via `GET /channels/{channelId}/messages`. Messages are checked via a `GET /discord/check` endpoint.

**Recommendation**: Not exposed to this regression. The REST polling architecture avoids long-lived listener issues entirely. If Discord is upgraded to WebSocket-based events in the future, reassess.

---

### 4. #4448 — Done Reaction After Reply (`messages.doneReaction`)

**Verdict**: ADAPT-PATTERN
**Priority**: P2
**Effort**: ~1-2h
**Affected Component**: `src/telegram/handler.ts`, `src/discord/handler.ts`

**Current State**: Moltworker uses inline text emojis in message bodies (checkmarks, etc.) but does NOT use the Telegram Bot API `setMessageReaction()` method or Discord reaction APIs.

**Recommendation**: Low-effort UX improvement. Telegram Bot API supports reactions (since API 6.1). After the bot completes a reply:
- Add a checkmark reaction to the user's original message
- For long-running tasks (DO-dispatched), add a clock reaction when starting and replace with checkmark on completion
- Implementation: call `bot.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: 'check' }])` after reply

---

### 5. #4446 — Slash Commands Not Working in Web UI

**Verdict**: IGNORE
**Priority**: P3
**Effort**: N/A
**Affected Component**: `src/client/App.tsx`

**Current State**: Moltworker's web UI is an **admin dashboard** (device management, analytics). It does NOT have a user-facing chat interface or command input. Slash commands are Telegram-only via `src/skills/command-map.ts` and `src/routes/telegram.ts`.

**Recommendation**: Not applicable. If a web chat UI is added later, ensure slash command parsing is included.

---

### 6. #2026 — Telegram Long-Polling AbortError Crash on Node 22+

**Verdict**: IGNORE (already mitigated)
**Priority**: P3
**Effort**: N/A
**Affected Component**: `src/routes/telegram.ts`

**Current State**: Moltworker uses **webhook mode** for Telegram, NOT long-polling.
- `POST /telegram/webhook/:token` receives updates via HTTP
- `bot.setWebhook(webhookUrl)` is called during setup
- Runs on Cloudflare Workers runtime (not Node.js directly)
- `nodejs_compat` flag enables Node.js API compatibility

**Recommendation**: No action needed. Webhook mode is the recommended architecture for Cloudflare Workers and is immune to the AbortError issue. The upstream suggestion of "webhook mode with Cloudflare Tunnel" is essentially what Moltworker already does.

---

## Changelog Entry Assessments

### 7. Agents/Failover: Classify `api_error` as Retryable Only with Transient Signals

**Verdict**: ADAPT-PATTERN
**Priority**: P1
**Effort**: ~4-6h
**Affected Component**: `src/openrouter/client.ts`, `src/durable-objects/task-processor.ts`, `src/guardrails/tool-validator.ts`

**Current State**:
- `classifyError()` in `tool-validator.ts` maps errors to types (`timeout`, `auth_error`, `rate_limit`, `http_error`, `generic_error`)
- TaskProcessor has `buildRotationOrder()` for free model sorting and emergency core model list
- **BUT**: No automatic `api_error`-triggered model fallback — rotation is manual (resume with override) or stall-based
- **BUT**: All `api_error` responses are currently treated uniformly — no distinction between transient (502, 503, timeout) and permanent (401, 403, 422) errors

**Recommendation**: Implement upstream pattern:
1. Add `isTransientError()` classifier: 502/503/504/timeout/rate-limit = transient, 401/403/422/billing = permanent
2. On transient `api_error`: auto-rotate to next model in `buildRotationOrder()` list
3. On permanent `api_error`: fail fast with clear error message, do NOT rotate (avoids burning through all models on auth/billing issues)
4. Track transient vs permanent error counts separately in `ToolErrorTracker`

**Files to modify**:
- `src/guardrails/tool-validator.ts` — add `isTransientError()`
- `src/durable-objects/task-processor.ts` — wire auto-rotation on transient errors
- `src/openrouter/client.ts` — propagate error classification upstream

---

### 8. Commands/Auth: Slash-Command Authorization Fix for Unresolved SecretRef

**Verdict**: MONITOR
**Priority**: P2
**Effort**: ~1h (if needed)
**Affected Component**: N/A currently

**Current State**: Moltworker does not use SecretRef-backed command authorization. Auth is token-based:
- Telegram: webhook token validation (`src/routes/telegram.ts`)
- Discord: token validation (`src/routes/discord.ts`)
- Skills: no secret-backed auth layer

**Recommendation**: Not directly applicable today. However, if BYOK vault integration (from ai-hub Wave 7) is ever ported to moltworker for skill execution, ensure that unresolved vault keys fail closed (403) rather than crash. Monitor upstream for the exact pattern.

---

### 9. Browser/CDP: Reuse Already-Running Loopback Browser

**Verdict**: ALREADY IMPLEMENTED
**Priority**: N/A
**Effort**: N/A
**Affected Component**: `src/openrouter/tools.ts:4240-4290`

**Current State**: Moltworker already implements browser session reuse:
- `getOrCreateSession()` persists session ID in `context.browserSessionId`
- Sessions reused across multiple `browse_url` tool calls within the same task
- Falls back to regular fetch if browser unavailable

**Recommendation**: No action needed. Our implementation predates this upstream change.

---

## Security Awareness

### 10. Phishing Campaign Targeting OpenClaw Developers

**Verdict**: ACKNOWLEDGED
**Priority**: P0 (awareness)
**Action**: Do NOT interact with any GitHub issues offering "$CLAW token" airdrops. Block `token-claw[.]xyz` if any CI/CD has outbound access.

**Checked**: No references to `token-claw` or `$CLAW` found in codebase or CI config. No outbound allowlists in `.github/workflows/deploy.yml` reference external domains beyond Cloudflare APIs.

---

## Cloudflare Platform Updates

### CF-1: Replicate Acquisition + Workers AI Model Expansion

**Verdict**: MONITOR
**Priority**: P2
**Effort**: ~4-8h (when available)
**Affected Component**: `src/openrouter/client.ts` (image generation), `src/skills/types.ts` (SkillResult)

**Current State**:
- Image generation uses OpenRouter's FLUX models via chat/completions API
- 4 FLUX models registered: `fluxklein`, `fluxpro`, `fluxflex`, `fluxmax` (in `src/openrouter/models.ts`)
- `/img` command in Telegram handler directly generates images
- Images served via base64 or URL (`sendPhoto`/`sendPhotoBase64` in `src/telegram/capturing-bot.ts`)
- **No Workers AI binding for image generation** — `wrangler.jsonc` has no `ai` binding
- `SkillResult` types do NOT include `image` or `media` kinds (only text-based: `text`, `draft`, `headlines`, etc.)

**Impact Assessment**: When Replicate models integrate into Workers AI:
1. **SkillResult architecture change needed**: Add `image_brief` and `video_brief` kinds to `SkillResultKind` union (this is exactly what W7-M1 Lyra Media spec defines)
2. **Provider abstraction**: Add a Workers AI image generation path alongside OpenRouter, similar to how LLM proxy has key-based routing
3. **Cost benefit**: Workers AI FLUX calls would use Cloudflare's included neuron budget instead of OpenRouter per-call pricing

**Recommendation**: Track Workers AI model availability. When FLUX.2 models are stable on Workers AI, add as alternative provider for `/img` generation. This aligns with W7-M1 Lyra Media extension work.

---

### CF-2: FLUX.2 [dev] + FLUX.2 [klein] on Workers AI

**Verdict**: ADAPT-PATTERN (future)
**Priority**: P2
**Effort**: ~2-3h (integration once available)
**Affected Component**: `src/openrouter/models.ts`, `src/openrouter/client.ts`, `src/telegram/handler.ts`

**Current State**: FLUX Klein is already registered as `fluxklein` via OpenRouter. The two-tier pipeline concept maps naturally to existing model aliases:

| CF Workers AI Model | Current Moltworker Alias | Use Case |
|---|---|---|
| `@cf/black-forest-labs/flux-1-schnell` | `fluxklein` (via OpenRouter) | Quick generations for `/img` |
| `@cf/black-forest-labs/flux-2-dev` | Not yet available | High-fidelity for `/imagine` (new) |

**Integration Surface for `image_brief` SkillResult**:
1. The Lyra media extension's `image_brief` result kind would need a model routing layer
2. Quick mode (Klein/Schnell) -> 4-step, sub-second generation
3. Detailed mode (Dev) -> high-fidelity, multi-reference support (up to 4 images, 512x512)
4. Workers AI uses multipart form data (different from OpenRouter's chat/completions JSON)

**Recommendation**: When implementing W7-M1 (Lyra Media), design the image generation abstraction to support both OpenRouter (current) and Workers AI (future) backends. Use a provider pattern similar to the LLM proxy's key-based routing.

---

### CF-3: R2 Bucket Clearing Reminder

**Verdict**: ALREADY IMPLEMENTED
**Priority**: N/A

**Current State**: Fully addressed:
- `scripts/predeploy-cleanup.mjs` — dedicated cleanup script (dry-run + execute modes, configurable max-age)
- `.github/workflows/deploy.yml` — CI step runs cleanup before deploy (`continue-on-error: true`)
- `package.json` — `predeploy:cleanup` and `deploy:clean` scripts available

**Recommendation**: No action needed. The infrastructure is solid. Only note: the CI step uses `continue-on-error: true` which means a cleanup failure won't block deploy — this is intentional but should be monitored in deploy logs.

---

## Summary / Priority Matrix

| Item | Verdict | Priority | Effort | Component |
|------|---------|----------|--------|-----------|
| #4475 Tool call abort | ADAPT-PATTERN | P1 | ~3-4h | client.ts, task-processor.ts |
| #4470 Slack thread | IGNORE | P3 | N/A | N/A |
| #4453 Discord MessageListener | IGNORE | P3 | N/A | N/A |
| #4448 Done reaction | ADAPT-PATTERN | P2 | ~1-2h | telegram handler |
| #4446 Web UI slash commands | IGNORE | P3 | N/A | N/A |
| #2026 Telegram long-polling | IGNORE | P3 | N/A | Already webhooks |
| Changelog: api_error failover | ADAPT-PATTERN | **P1** | ~4-6h | client.ts, task-processor.ts, tool-validator.ts |
| Changelog: SecretRef auth | MONITOR | P2 | ~1h | N/A currently |
| Changelog: Browser CDP reuse | ALREADY IMPLEMENTED | N/A | N/A | tools.ts |
| Phishing campaign | ACKNOWLEDGED | P0 | N/A | Awareness only |
| CF: Replicate + Workers AI | MONITOR | P2 | ~4-8h | models.ts, client.ts, skills/types.ts |
| CF: FLUX.2 on Workers AI | ADAPT-PATTERN (future) | P2 | ~2-3h | models.ts, client.ts, handler.ts |
| CF: R2 deploy cleanup | ALREADY IMPLEMENTED | N/A | N/A | predeploy-cleanup.mjs |

### Recommended Action Items (Ordered)

1. **P0**: Acknowledge phishing campaign awareness (done in this document)
2. **P1**: Implement transient vs permanent `api_error` classification + auto-rotation (~4-6h)
3. **P1**: Review upstream tool-call abort fix and adapt checkpoint pattern (~3-4h)
4. **P2**: Add done-reaction after reply for Telegram (~1-2h)
5. **P2**: Design Workers AI image generation provider abstraction during W7-M1 (~included in M1 effort)
6. **Monitor**: SecretRef auth pattern (for future BYOK integration)
7. **Monitor**: Workers AI FLUX.2 model availability (for cost optimization)

### Items to Add to GLOBAL_ROADMAP.md

- **P1 task**: "Implement transient error classifier + auto model rotation in Orchestra/client" (~4-6h)
- **P1 task**: "Review upstream tool-call abort checkpoint pattern" (~3-4h)
- **P2 task**: "Add Telegram done-reaction UX" (~1-2h)

---

*Triage performed against commit `d2591a2` (main branch, 2026-03-29)*
