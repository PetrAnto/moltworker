# Upstream OpenClaw Bump — 2026.4.14 (staged for deploy)

**Date opened**: 2026-04-11
**Last updated**: 2026-04-16
**Status**: Stage 3 staged on `claude/openclaw-bump-2026.4.14` at commit `60735b9`, rebased onto current `main` (`2a23d0f`). Ready for staging validation; no PR open yet.
**Current pin**: `openclaw@2026.3.23-2` (Dockerfile:44)
**Target pin**: `openclaw@2026.4.14` + `@openai/codex@0.121.0` (exact pin; see Stage 3 notes below)
**Releases skipped**: 2026.3.28, 2026.4.5, 2026.4.9, 2026.4.10, 2026.4.14 (2026.4.15 is a beta, skipped)

## Why this doc exists

PR 2 (the Codex scaffolding PR) lands all the wiring to support the bundled Codex provider shipped in OpenClaw 2026.4.10 **without** actually bumping the dependency. This doc tracks the bump itself as a discrete, reviewable change so the rollback story stays clean.

PR 2 is a **strict no-op** in production because every Codex code path in `start-openclaw.sh` is hard-gated on `command -v codex` (the `CODEX_STAGE_ACTIVE` flag). Since PR 2 does not install `@openai/codex`, the binary is absent, the flag is `0`, and none of the following run:

- the `.codex` R2 restore
- the `CODEX_AUTH_JSON_BOOTSTRAP` pre-seed (logs "waiting for PR 3 version bump" if the secret is set)
- the `codex/*` primary-model override in the config patch
- the `.codex` entries in the bulk rclone sync loop
- the `fs.watch` helper subprocess

PR 3 (the OpenClaw version bump) installs the binary, which physically flips the gate on — zero additional code changes are needed to activate PR 2's wiring. This gating strategy was added in response to the ChatGPT review of the initial PR 2 draft, which correctly identified that an earlier guard (`if (process.env.CODEX_AUTH_JSON_BOOTSTRAP)`) was operator-discipline-only, not enforced by the code.

## Headline feature (drives the bump)

**Models/Codex**: *"add the bundled Codex provider and plugin-owned app-server harness so `codex/gpt-*` models use Codex-managed auth"*, with native threads and model discovery. Unblocks `cloudflare/moltworker#39`, `#123`, `#277`. Delegates auth lifecycle to the local `codex` CLI binary, which writes `~/.codex/auth.json` and rotates refresh tokens every ~24h.

## Fixes inherited for free (filtered to moltworker's active surface)

### Security
- v2026.4.5: "fail closed when `before_tool_call` hooks crash"
- v2026.4.5: "block browser SSRF redirect bypasses earlier"
- v2026.4.5: "default low-level HTTPS helper TLS verification to on"
- v2026.4.5: "route webhook token comparison through constant-time secret helper"
- v2026.4.9: "re-run blocked-destination safety checks after interaction-driven main-frame navigations"
- v2026.4.9: "block runtime-control env vars from untrusted workspace files"
- v2026.4.9: "force `basic-ftp` to `5.2.1` for CRLF command-injection fix"
- v2026.4.10: "fail closed for paired device records that have no device tokens"
- v2026.4.10: "reject pairing approvals whose requested scopes do not match"

### Gateway / cron reliability
- v2026.4.5: "replay interrupted recurring jobs on first gateway restart"
- v2026.4.5: "send cron failure notifications through the job's primary delivery channel"
- v2026.4.5: "skip wake delivery when target session lane busy"
- v2026.4.10: "Cron/auth: resolve auth profiles consistently for scheduled runs"
- v2026.4.10: "Gateway/run cleanup: fix stale run-context TTL cleanup"

### Model / prompt-cache stability
- v2026.4.5: "normalize system-prompt fingerprints" + "remove duplicate in-band tool inventory"
- v2026.4.5: "preserve full 3-turn prompt-cache image window across tool loops"
- v2026.4.5: "classify `403 Key limit exceeded` as billing for fallback"
- v2026.3.28: "scope rate-limit cooldowns per model" (30s/1min/5min ladder)

### Discord (moltworker's active channel — Telegram is Worker-side and unaffected)
- v2026.3.28: "Discord/reconnect: drain stale gateway sockets, clear cached resume state"
- v2026.4.5: "Discord: honor `@everyone` and `@here` mention gates"
- v2026.4.5: "Discord: strip leaked `[[reply_to_current]]` control tags from preview text"

## Risks the bump introduces

1. **Config schema tightening** — v2026.4.5 surfaces actual offending fields for union failures. R2-restored configs from older runs may fail validation. **Mitigated** by the pre-flight scrub added in the scaffolding PR (`start-openclaw.sh` EOFSCRUB block) and the `openclaw.json.invalid-<ts>` quarantine fallback.
2. **Removed API**: `agents.defaults.cliBackends` was removed in v2026.4.5. Moltworker never referenced it directly, but R2 backups may contain it. **Mitigated** by the scrub.
3. **New subprocess**: the bundled Codex provider spawns `codex app-server` as a child process. May add CPU pressure during gateway startup. Will be measured on staging; if it re-introduces the `/api/status` stall from `cloudflare/moltworker#342`, the mitigation is longer `/api/status` timeout (already tuned) rather than architectural deferral of the subprocess (no config flag known).
4. **`codex` CLI binary not yet in the image**: PR 2 scaffolding does not `npm install -g @openai/codex`. The scaffolding is safe to run without the binary — the bootstrap secret writes `auth.json` but the bundled Codex provider (which needs the binary) is absent in the current OpenClaw version, so nothing tries to read the file. The bump PR must add the `@openai/codex` install to the `npm install -g` line on Dockerfile:44.

## Staged plan

### Stage 1 (this PR, already merged) — PR 1: `fix(startup): stop leaking secrets via argv + add WS allowedOrigins`
- Drop API keys from `openclaw onboard` argv
- Drop `--token` from `openclaw gateway` launch
- Set `gateway.controlUi.allowedOrigins = ['*']`
- Scaffold `/home/openclaw/.codex` + `/root/.codex` symlink in Dockerfile

**Merged**: commit `0682b29`, PR #473

### Stage 2 (this PR) — PR 2: `feat(codex): scaffold bundled Codex provider bootstrap`
- `CODEX_AUTH_JSON_BOOTSTRAP` + `CODEX_MODEL` env vars plumbed through types/env/debug
- `CODEX_STAGE_ACTIVE` hard-gate in `start-openclaw.sh` (`command -v codex`)
- Bootstrap-only pre-seed that never overwrites existing `auth.json`
- R2 restore + sync loop + `fs.watch` helper (`scripts/codex-auth-watcher.mjs`)
- Pre-flight legacy-config scrub with `openclaw.json.invalid-<ts>` fallback
- README section + this doc

**No OpenClaw version bump.** No `@openai/codex` install. **Strict no-op in production** because `command -v codex` returns false — every new code path short-circuits. The gate is physical, not operator-discipline. Setting `CODEX_AUTH_JSON_BOOTSTRAP` today is safely ignored (logged, not applied).

### Stage 3 (staged on `claude/openclaw-bump-2026.4.14` @ `60735b9`) — `chore(deps): bump openclaw to 2026.4.14 + install @openai/codex@0.121.0`

The branch is rebased onto current `main` (`2a23d0f`, which includes the `fix(gateway): backport late-March cloudflare/moltworker reliability fixes` in `a41571f` — HTML containerFetch/body timeouts, `killGateway` port poll, `/api/status` TCP probe). Deploying from this tip ships the reliability fixes and the OpenClaw/Codex bump together.

- Bump `Dockerfile:44` from `openclaw@2026.3.23-2` → `openclaw@2026.4.14` (latest stable — 2026.4.10/4.14 landed while scaffolding was in review; 2026.4.15 is a beta)
- Pin `@openai/codex@0.121.0` exactly on the same global install. OpenClaw 2026.4.14 does not declare `@openai/codex` as a peer dependency, so there is no upstream compatibility range to defer to. Re-verify this pin is still npm `latest` the day the PR opens.
- Add build-time `codex --version` assertion — catches a missing/broken Codex install at image build rather than at first container boot.
- Refresh the `# Build cache bust:` comment (redundant with the install-line change, kept for consistency).
- Zero code changes — all wiring already in place from Stage 2 (PR #473 `0682b29`, PR #475 `2fab562`). `CODEX_STAGE_ACTIVE` in `start-openclaw.sh:47-54` flips from 0 to 1 the moment `command -v codex` succeeds.
- Deploy to staging, run smoke tests:
  - `/debug/env` shows `has_codex_bootstrap_secret: true`
  - `/debug/processes` shows `codex app-server` running under the OpenClaw gateway
  - `/debug/container-config` shows `agents.defaults.model.primary = "codex/gpt-5.4"`
  - Anthropic/OpenRouter fallback path still works via `/simulate/chat`
  - Token rotation: force a refresh via `codex refresh` (or wait past `expires`), verify `r2:${R2_BUCKET}/codex/auth.json` mtime advances within seconds
- Merge only after a clean burn-in on staging + any OpenClaw 2026.4.14-N patch has landed.

**Independence from main**: The Stage 3 diff is `Dockerfile`-only; the reliability fixes in `a41571f` touch only `src/`. No rebase conflicts. Either merge order is safe — rollback stories differ (worker-layer reliability fixes roll back in ~30s; container-layer bump rolls back in ~5min), so separate PRs.

**Validation without the secret**: Operators can deploy this image without setting `CODEX_AUTH_JSON_BOOTSTRAP` to validate the version pin in isolation — the bootstrap pre-seed and the `codex/*` primary-model override (line 562 of `start-openclaw.sh`) both require the secret in addition to `CODEX_STAGE_ACTIVE`. Bot keeps using OpenRouter Auto until the secret lands.

**Timing**: 2026.4.14 has been stable since shipping; no outstanding `.N` patch known at time of staging (2026-04-15). Re-check on the morning of the PR open.

## Out of scope (future follow-ups)

- **Rclone-vs-SandboxSDK reconciliation**: our fork currently runs both persistence mechanisms in parallel (upstream `cloudflare/moltworker` has removed rclone from the container). Deferred until after Codex is proven; consolidation to the Sandbox SDK path alone would eliminate ~400 lines of shell and half the R2 pathways. Tracked here.
- **Claude Max OAuth** (`cloudflare/moltworker#277` also mentions it): separate provider, separate scope. Wait for upstream to ship the equivalent bundled flow.
- **Telegram channel-side fixes** from v2026.4.5/4.9: moltworker's Telegram layer runs Worker-side (`src/gateway/env.ts:45-49` explicitly does not pass `TELEGRAM_BOT_TOKEN` to the container), so container-side Telegram patches have minimal impact for us. Not worth a targeted follow-up.
- **Lazy-load `codex app-server`**: reviewers flagged CPU risk on eager startup. If staging in Stage 3 proves problematic, investigate whether upstream exposes a config flag for deferred spawn. Not worth designing around a hypothetical today.
- **`/debug/codex-status` route**: reviewers downgraded to optional. Current debug surface (`/debug/processes`, `/debug/container-config`) is expected to be sufficient for Stage 3 validation.

## References

- [OpenClaw v2026.4.14 release](https://github.com/openclaw/openclaw/releases/tag/v2026.4.14) — target version for Stage 3
- [OpenClaw v2026.4.10 release](https://github.com/openclaw/openclaw/releases/tag/v2026.4.10) — first release with the bundled Codex provider
- [OpenClaw v2026.4.9 release](https://github.com/openclaw/openclaw/releases/tag/v2026.4.9)
- [OpenClaw v2026.4.5 release](https://github.com/openclaw/openclaw/releases/tag/v2026.4.5)
- [OpenClaw v2026.3.28 release](https://github.com/openclaw/openclaw/releases/tag/v2026.3.28)
- `cloudflare/moltworker#39`, `#123`, `#277` — Codex subscription feature requests
- `openclaw/openclaw#29418` — OAuth identity-scope-only bug (fixed in 4.10)
- `openclaw/openclaw#52037`, `#53317` — Token refresh races (moot after 4.10 bundled provider)
- `pwrdrvr/openclaw-codex-app-server` — pre-bundled reference implementation
- PR #477 (`claude/review-upstream-updates-l3PcZ`) — late-March reliability backport that Stage 3 rebased onto
