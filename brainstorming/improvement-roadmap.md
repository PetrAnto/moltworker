# Moltworker Improvement Roadmap (Phases 0–4)

**Status:** Phase 0 shipped on `claude/research-openclaw-improvements-XEtJT`. Phases 1–4 planned.
**Date:** 2026-04-26
**Provenance:** Codebase audit + cross-checked external patterns from `cloudflare/moltworker` (~9.9k★, real upstream), `miantiao-me/cloud-claw` (~255★, Workers + Containers), `nearai/ironclaw` (~12k★, Rust privacy fork), `ComposioHQ/openclaw-composio` (~29★). Every external pattern referenced below was fetched and verified, not summarized from training data. The "365k stars" figure for `openclaw/openclaw` that came back from Grok could not be independently verified and is ignored — the repo exists, the metric does not matter for our planning.

This doc is the single source of truth for what to ship next. Pre-existing planning docs (`audit-skill-design-v1.md`, `audit-build-improvement-plan.md`, `gecko-specialist-skills-spec-v1.2-FINAL.md`, `code-mode-mcp.md`) remain authoritative for their own scope; this one connects them and adds robustness/security work that none of them cover.

---

## Phase 0 — Security baseline (SHIPPED)

Five atomic commits on this branch. Each is independently revertible.

| # | Commit | Subject | What it fixes |
|---|---|---|---|
| 1 | `2741ba3` | `refactor(security): extract timingSafeEqual into shared utility` | De-dups two identical local copies (cdp.ts, dream/auth.ts) into `src/utils/timing-safe-equal.ts`. No behavior change. |
| 2 | `d1773df` | `fix(security): use constant-time compare for /simulate Bearer auth` | `src/routes/simulate.ts:37` was `!==`. /simulate dispatches DOs and runs real LLM calls — leaking `DEBUG_API_KEY` has direct cost impact. |
| 3 | `f86cea3` | `fix(security): harden Telegram webhook auth` | `src/routes/telegram.ts:26` path-token compare was `!==` (bot-token = full impersonation if leaked). Plus added optional `X-Telegram-Bot-Api-Secret-Token` header check, gated by new `TELEGRAM_WEBHOOK_SECRET` env. `TelegramBot.setWebhook()` now passes `secret_token` when configured. |
| 4 | `5a3216b` | `feat(security): SSRF guard on fetch_url and CDP navigation` | New `src/utils/url-guard.ts` (15 unit tests). Wired into `fetchUrl()` in `src/openrouter/tools.ts:1115`, plus `Page.navigate` and `createTarget` in `src/routes/cdp.ts`. Rejects non-http(s) schemes and any host textually resolving to RFC1918 / link-local / cloud-metadata / loopback. |
| 5 | `d64cd7b` | `fix(security): require auth on /discord/check + sanitize error response` | `/discord/check` was publicly callable (mounted under `publicRoutes`) and could be used to spam Discord/Telegram quotas. Now requires `DEBUG_API_KEY` Bearer. Also stops interpolating raw `Error` into the JSON body, which could leak hostnames/tokens captured upstream. |

**Operator follow-ups required before Phase 0 takes full effect:**
1. Set `TELEGRAM_WEBHOOK_SECRET` via `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, then hit `/telegram/setup` once to re-register the webhook with the secret. Existing deployments stay safe (path-token still validated) but get the second factor only after this step.
2. Anything that polled `/discord/check` externally now needs the `Authorization: Bearer $DEBUG_API_KEY` header. There were no internal callers (verified via `grep`).
3. No env var changes for `/simulate`, `fetch_url`, or CDP — purely defensive code.

**Findings deliberately deferred to Phase 2 (not part of Phase 0):**
- CDP secret echoed back in WebSocket URLs (`src/routes/cdp.ts:231`) — needs short-lived per-session token design.
- CDP session-state maps growing unbounded (`nodeMap`, `objectMap`, `pendingRequests`, `scriptsToEvaluateOnNewDocument`) — needs LRU caps.
- `Page.addScriptToEvaluateOnNewDocument` accepting arbitrary JS — needs a capability gate, not a quick fix.
- Audit-skill prompt-injection sanitization on ingested repo content (`src/skills/audit/scout.ts`) — belongs with Phase 1 audit GA, since that's where it matters.
- Tamper-evident audit log of tool invocations — belongs with Phase 2 robustness work.

---

## Phase 1 — Productionize `/audit` (the in-flight epic)

**Goal:** Close the 6-slice audit epic that's been running since PR #500. The skill is 5,078 LOC and battle-tested by 2,710 LOC of unit tests; what's missing is delivery + visibility, not core capability.

**Prerequisites:** none. Phase 0 is independent.

### Slice A — Scheduled audits (~3h)

Use the existing `0 */6 * * *` cron entry in `wrangler.jsonc`. No new DO, no new alarm config.

- New commands in `src/skills/audit/audit.ts`:
  - `/audit subscribe <repo> [--weekly|--daily] [--lens=<lens>] [--depth=<depth>]`
  - `/audit unsubscribe <repo>`
  - `/audit subs` (list active subscriptions for the user)
- KV schema in `NEXUS_KV` (matches existing audit cache pattern in `src/skills/audit/cache.ts:71`):
  - `audit:sub:<userId>:<repo>` → `{ interval: "weekly"|"daily", lens, depth, lastRunAt, createdAt }`
  - `audit:run:<userId>:<repo>:<timestamp>` (already used by `cacheAuditRun`)
- New cron handler branch in `src/cron/handler.ts`:
  - On the 6h cron, scan `audit:sub:*` keys.
  - For each subscription where `now - lastRunAt >= interval`, dispatch via existing `dispatchToDO` (TaskProcessor) — same path slice 3 wired up.
  - On completion, deliver via existing inline-keyboard renderer.
- **Optional polish:** generalize the cron registry so `lyra subscribe` / `nexus subscribe` etc. can reuse the same scan loop later. Keep this small — single `runDueSubscriptions(skillId, scanPrefix)` helper.

### Slice B — `/_admin/audit` tab (~3h)

- Extend `src/routes/admin-ui.ts` and `src/client/App.tsx` (existing tab pattern).
- Reads only from `NEXUS_KV` — no new persistence layer. Surfaces:
  - Recent runs (`audit:run:*`) — repo, date, score, tokens, duration, cost estimate (from existing TaskProcessor telemetry).
  - Suppression list (existing keys) with one-click remove.
  - Active subscriptions (`audit:sub:*`) with one-click unsubscribe.
  - "Run audit now" button → dispatches the skill via existing route.

### Slice C — Polish (~1h)

- README §Audit updated with subscribe + admin flows.
- One E2E fixture at `test/e2e/audit_subscribe.txt` matching existing `.txt` harness shape (NOT a `.spec.ts`).
- Prompt-injection pre-pass in `src/skills/audit/scout.ts`: lightweight `Block | Sanitize | Warn` on ingested file content (drop content matching `IGNORE PREVIOUS INSTRUCTIONS` / inline `<system>` tags / suspiciously large base64 blobs before tree-sitter parsing). This is the ironclaw pattern, applied where it actually matters — the audit skill ingests untrusted code into LLM context as its job.

### Out of scope for Phase 1

- Making `audit:bench` a CI gate. The harness explicitly opts out — `scripts/audit-bench.mjs:8-12` says *"NOT a CI gate — too slow, too expensive (real LLM spend), too stochastic."* Honor that.
- New DO for audit. The existing `TaskProcessor` dispatch path is fine.
- Switching subscription storage to R2. KV is correct here (small JSON, low write rate, matches existing pattern).

---

## Phase 2 — Robustness pass

**Goal:** Close the structural durability gaps the Phase 0 audit surfaced.

### CDP hardening
- Move `CDP_SECRET` out of returned WebSocket URLs (`src/routes/cdp.ts:231`). Issue short-lived (5-min) per-session tokens stored in KV, return those in `/json/version` instead.
- LRU caps on `CDPSession.nodeMap` / `objectMap` / `pendingRequests` / `scriptsToEvaluateOnNewDocument`. Reject when over budget.
- Capability gate (or removal) on `Page.addScriptToEvaluateOnNewDocument` — current default is "any client can inject any JS into any page".

### TaskProcessor durability
- Per-task wallclock budget (max-iteration cap exists; wallclock cap doesn't).
- Repeat-failure circuit breaker: if the same task fails N times in a row, stop auto-resuming and surface to the operator instead of burning tokens in a loop.
- Operator dead-letter sink (R2 prefix or Acontext) for the swallowed errors in `src/routes/telegram.ts:99` so failures stop disappearing into "Temporary internal error".

### Audit log hash chain (the genuinely useful ironclaw idea)
- Append every tool invocation to an immutable ledger keyed `audit:log:<runId>:<seq>` in `NEXUS_KV` with `hash(prev_entry || canonical(invocation))`. Storing in R2 with object lock is the gold-plated version; KV is the right starting point.
- Self-referential value: `/audit` is itself an auditing product, so making it auditable is a defensible feature, not just defense in depth.

### CSP on admin UI
- Headers in `src/routes/admin-ui.ts`: `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`. Avoid `unsafe-eval`.

---

## Phase 3 — Cold start + cost dashboard

**Goal:** Address the 1–2 minute first-request latency the README acknowledges (line 90), and surface the cost telemetry that already exists but is invisible.

### Eager wake on webhook (cloud-claw pattern, verified)
- At the top of `/telegram/webhook/:token` and the gated `/discord/check`, fire-and-forget `ensureMoltbotGateway()` before doing the actual work.
- Activity-renew pattern: on every successful task, stamp `lastActivity` in KV. Cron handler can reduce the wake-ahead aggressiveness when activity is recent.
- This is where `cloud-claw`'s `renewActivityTimeout` pattern actually pays off.

### Cost dashboard
- Add an Analytics Engine binding in `wrangler.jsonc` (free tier, native).
- Emit one event per task in `src/durable-objects/task-processor.ts` with `{model, durationMs, tokensIn, tokensOut, sourceChannel, userId}`. The fields already exist in TaskProcessor telemetry.
- New `/_admin/usage` tab querying that AE dataset for last-30-day cost estimate, broken down by channel + model.
- Replaces any need for an external dashboard.

### Codex bootstrap finish
- `Dockerfile:50-58` + `scripts/codex-auth-watcher.mjs` are scaffolded. README:440 says "waiting for PR 3 version bump." Pick this up when the upstream version lands. Low effort, high "wow" — but blocked on something out of our control, so it's a Phase 3 follow-on, not a deliverable.

### Out of scope for Phase 3

- TigrisFS or any in-container FS mount. R2 sync is sufficient for personal scale.
- Switching to Cloudflare Containers (vs Sandbox). Different billing model, no clear win for a single-user assistant.
- Multi-tenancy. Adds complexity that isn't justified by current usage.

---

## Phase 4 — Strategic: skills as MCP server

**Goal:** Make moltworker callable *from* Claude Code, Cursor, and other MCP-aware clients — turning the skill catalog (`audit`, `lyra`, `spark`, `nexus`, `orchestra`) into a reusable tool surface, not just a Telegram-bound feature.

### Server-side MCP
- New module `src/mcp/server.ts` that exposes the existing skill registry (`src/skills/registry.ts`) as MCP tools.
- New route `src/routes/mcp.ts` mounting the JSON-RPC handler. Auth via existing `X-Storia-Secret` header pattern from `src/routes/api.ts` or a new dedicated MCP token.
- Each skill registers a tool definition. Skill execution stays exactly as it is — only the front door is new.

### Composio-style tool router (only if needed)
- The `ComposioHQ/openclaw-composio` pattern (Tool Router with runtime OAuth) is interesting but only relevant if skills need to take OAuth-protected external actions they don't take today (post-as-user to Slack, open issues as a specific GitHub user). Skip until a concrete skill requires it.

### Integration with Phase 2 audit log
- Every MCP-served tool invocation flows through the same hash-chain ledger. External consumers calling `audit` over MCP get the same auditability as Telegram users.

---

## What's intentionally NOT in this roadmap

- **Web setup wizard.** `/_admin/` already exists with device pairing, R2 backup, restart. First-run polish is fine; a separate wizard is duplicate scope.
- **Generic security audit modeled on a third-party "guide".** SlowMist's "openclaw security practice guide" referenced in earlier research could not be independently verified. Source security work from real upstream advisories, OWASP, and our own threat model — not from repos we can't confirm exist.
- **`audit:bench` as a CI gate.** The harness author explicitly rejected this. Keep it as a manual operator tool.
- **Migrating off `@cloudflare/workers-types`.** `wrangler types` warns we should, but it's a cross-cutting cleanup unrelated to security/feature work; track separately.
- **Global lint/format-check fix.** Main currently fails both with 439 warnings + 103 errors + 206 format issues. Pre-existing, not from any work in this roadmap, and a different epic.

---

## Estimating

| Phase | Effort | Risk | Status |
|---|---|---|---|
| 0 — Security baseline | ~2h | Low (5 small atomic commits, all tests pass) | **Shipped** |
| 1 — `/audit` GA | ~7h, 3 PRs | Low (extends in-flight epic, all paths exist) | Ready |
| 2 — Robustness pass | ~2 days | Medium (CDP token redesign + TaskProcessor changes) | Blocked on Phase 1 |
| 3 — Cold start + cost dashboard | ~3 days | Low (mostly additive) | Blocked on Phase 1 |
| 4 — Skills as MCP server | ~2 days | Low (additive surface) | Blocked on Phase 2 (uses hash chain) |

Codex finish is open-ended (depends on upstream); track separately.
