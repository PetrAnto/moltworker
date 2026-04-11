#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Restores config/workspace/skills from R2 via rclone (if configured)
# 2. Runs openclaw onboard --non-interactive to configure from env vars
# 3. Patches config for features onboard doesn't cover (channels, gateway auth, models)
# 4. Starts a background sync loop (rclone, watches for file changes)
# 5. Starts the gateway

set -e

if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running, exiting."
    exit 0
fi

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="/root/clawd"
SKILLS_DIR="/root/clawd/skills"
CODEX_DIR="/root/.codex"
CODEX_AUTH_FILE="$CODEX_DIR/auth.json"
RCLONE_CONF="/root/.config/rclone/rclone.conf"
LAST_SYNC_FILE="/tmp/.last-sync"

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"
mkdir -p "$CODEX_DIR"

# ============================================================
# RCLONE SETUP
# ============================================================

r2_configured() {
    [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ] && [ -n "$CF_ACCOUNT_ID" ]
}

R2_BUCKET="${R2_BUCKET_NAME:-moltbot-data}"

setup_rclone() {
    mkdir -p "$(dirname "$RCLONE_CONF")"
    cat > "$RCLONE_CONF" << EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY_ID
secret_access_key = $R2_SECRET_ACCESS_KEY
endpoint = https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
    touch /tmp/.rclone-configured
    echo "Rclone configured for bucket: $R2_BUCKET"
}

RCLONE_FLAGS="--transfers=16 --fast-list --s3-no-check-bucket"

# ============================================================
# RESTORE FROM R2
# ============================================================

if r2_configured; then
    setup_rclone

    echo "Checking R2 for existing backup..."
    # Check if R2 has an openclaw config backup
    if rclone ls "r2:${R2_BUCKET}/openclaw/openclaw.json" $RCLONE_FLAGS 2>/dev/null | grep -q openclaw.json; then
        echo "Restoring config from R2..."
        rclone copy "r2:${R2_BUCKET}/openclaw/" "$CONFIG_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: config restore failed with exit code $?"
        echo "Config restored"
    elif rclone ls "r2:${R2_BUCKET}/clawdbot/clawdbot.json" $RCLONE_FLAGS 2>/dev/null | grep -q clawdbot.json; then
        echo "Restoring from legacy R2 backup..."
        rclone copy "r2:${R2_BUCKET}/clawdbot/" "$CONFIG_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: legacy config restore failed with exit code $?"
        if [ -f "$CONFIG_DIR/clawdbot.json" ] && [ ! -f "$CONFIG_FILE" ]; then
            mv "$CONFIG_DIR/clawdbot.json" "$CONFIG_FILE"
        fi
        echo "Legacy config restored and migrated"
    else
        echo "No backup found in R2, starting fresh"
    fi

    # Restore workspace
    REMOTE_WS_COUNT=$(rclone ls "r2:${R2_BUCKET}/workspace/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_WS_COUNT" -gt 0 ]; then
        echo "Restoring workspace from R2 ($REMOTE_WS_COUNT files)..."
        mkdir -p "$WORKSPACE_DIR"
        rclone copy "r2:${R2_BUCKET}/workspace/" "$WORKSPACE_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: workspace restore failed with exit code $?"
        echo "Workspace restored"
    fi

    # Restore skills
    REMOTE_SK_COUNT=$(rclone ls "r2:${R2_BUCKET}/skills/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_SK_COUNT" -gt 0 ]; then
        echo "Restoring skills from R2 ($REMOTE_SK_COUNT files)..."
        mkdir -p "$SKILLS_DIR"
        rclone copy "r2:${R2_BUCKET}/skills/" "$SKILLS_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: skills restore failed with exit code $?"
        echo "Skills restored"
    fi

    # Restore Codex auth (bundled provider, OpenClaw >= 2026.4.10).
    # This MUST run before the bootstrap-secret path below so a refreshed
    # token from a prior container run always wins over the static secret.
    REMOTE_CODEX_COUNT=$(rclone ls "r2:${R2_BUCKET}/codex/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_CODEX_COUNT" -gt 0 ]; then
        echo "Restoring Codex auth from R2 ($REMOTE_CODEX_COUNT files)..."
        rclone copy "r2:${R2_BUCKET}/codex/" "$CODEX_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: codex restore failed with exit code $?"
        chmod 600 "$CODEX_AUTH_FILE" 2>/dev/null || true
        echo "Codex auth restored"
    fi
else
    echo "R2 not configured, starting fresh"
fi

# ============================================================
# CODEX AUTH BOOTSTRAP (one-shot, non-destructive)
# ============================================================
# Write $CODEX_AUTH_JSON_BOOTSTRAP to ~/.codex/auth.json IF AND ONLY IF no
# existing auth file is present (whether from R2 restore or a prior run).
# NEVER overwrite an existing file — Codex invalidates prior refresh tokens
# on rotation, and a stale static secret would brick the live subscription.
# The secret is a one-shot scaffold; Codex CLI owns the file lifecycle from
# first boot onward, and the fs.watch helper below pushes every rotation to
# R2 immediately.
if [ -n "$CODEX_AUTH_JSON_BOOTSTRAP" ]; then
    if [ -f "$CODEX_AUTH_FILE" ]; then
        echo "Codex auth already present on disk (restored or pre-existing) — bootstrap skipped"
    else
        echo "Writing Codex bootstrap auth from CODEX_AUTH_JSON_BOOTSTRAP..."
        # Validate JSON shape before writing. Fail-soft: log and continue
        # without Codex rather than crash the whole container startup.
        if printf '%s' "$CODEX_AUTH_JSON_BOOTSTRAP" | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' 2>/dev/null; then
            umask 077
            TMP_CODEX_AUTH="$(mktemp "${CODEX_DIR}/.auth.json.XXXXXX")"
            printf '%s' "$CODEX_AUTH_JSON_BOOTSTRAP" > "$TMP_CODEX_AUTH"
            chmod 600 "$TMP_CODEX_AUTH"
            mv "$TMP_CODEX_AUTH" "$CODEX_AUTH_FILE"
            umask 022
            echo "Codex bootstrap auth written to $CODEX_AUTH_FILE"
        else
            echo "WARNING: CODEX_AUTH_JSON_BOOTSTRAP is not valid JSON — ignoring" >&2
        fi
    fi
fi

# ============================================================
# CONFIG PRE-FLIGHT SCRUB (legacy field removal + fallback)
# ============================================================
# Strip known-legacy fields from R2-restored configs before onboard/patch.
# This protects against OpenClaw's increasingly strict config validation
# (v2026.4.5+) rejecting old backups at startup.
#
# Legacy fields removed:
#   - agents.defaults.cliBackends (removed in OpenClaw 2026.4.5)
#   - models.providers.anthropic:claude-cli (deprecated profile)
#   - models.providers.openai-codex (superseded by bundled codex/* provider)
#   - models.providers.* entries missing required `models` array
#
# If the scrub itself fails (malformed JSON, unexpected schema), we
# quarantine the config to openclaw.json.invalid-<ts> and fall through to
# a fresh onboard.
if [ -f "$CONFIG_FILE" ]; then
    if ! node <<'EOFSCRUB'
const fs = require('fs');
const path = '/root/.openclaw/openclaw.json';
const raw = fs.readFileSync(path, 'utf8');
const cfg = JSON.parse(raw);
let changed = false;

// agents.defaults.cliBackends — removed in OpenClaw 2026.4.5
if (cfg.agents?.defaults?.cliBackends !== undefined) {
    delete cfg.agents.defaults.cliBackends;
    console.log('[scrub] removed agents.defaults.cliBackends');
    changed = true;
}

// Legacy claude-cli profile under the anthropic provider.
// Upstream 2026.4.5 removed the Claude CLI backend from new onboarding and
// `openclaw doctor` can repair stale state, but we scrub here as well so
// R2-restored configs boot cleanly on the first run.
if (cfg.models?.providers?.anthropic?.profiles?.['claude-cli']) {
    delete cfg.models.providers.anthropic.profiles['claude-cli'];
    console.log('[scrub] removed models.providers.anthropic.profiles.claude-cli');
    changed = true;
}

// openai-codex provider — superseded by bundled codex/* provider in 2026.4.10.
// Remove stale direct-OAuth entries so the bundled provider can take over
// cleanly. Users with CODEX_AUTH_JSON_BOOTSTRAP get the new flow automatically.
if (cfg.models?.providers?.['openai-codex']) {
    delete cfg.models.providers['openai-codex'];
    console.log('[scrub] removed models.providers.openai-codex (superseded by codex/*)');
    changed = true;
}

// NOTE: we deliberately do NOT do a generic "missing models array" sweep
// over models.providers.*. Valid provider entries can declare profiles or
// baseUrl overrides without a models array. The targeted scrubs above
// cover the known-broken patterns; the existing block below this node
// runner handles two more (broken anthropic model entries, orphan
// openrouter provider). If OpenClaw 2026.4.5+ rejects the result, the
// fallback clause around this heredoc quarantines the config and triggers
// a fresh onboard.

if (changed) {
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
    console.log('[scrub] config rewritten');
} else {
    console.log('[scrub] no legacy fields found, config untouched');
}
EOFSCRUB
    then
        TS="$(date +%s)"
        mv "$CONFIG_FILE" "${CONFIG_FILE}.invalid-${TS}"
        echo "WARNING: config scrub failed, quarantined to ${CONFIG_FILE}.invalid-${TS} — re-running fresh onboard" >&2
    fi
fi

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    # Secrets (ANTHROPIC_API_KEY, OPENAI_API_KEY, CLOUDFLARE_AI_GATEWAY_API_KEY)
    # are read directly from environment variables by `openclaw onboard` and
    # must NEVER be passed on the command line — argv is visible to every
    # process in the container via ps/proc. Only non-sensitive identifiers
    # (account/gateway IDs) are safe to pass as flags.
    # Matches upstream cloudflare/moltworker hardening.
    AUTH_ARGS=""
    if [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
        AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key --cloudflare-ai-gateway-account-id $CF_AI_GATEWAY_ACCOUNT_ID --cloudflare-ai-gateway-gateway-id $CF_AI_GATEWAY_GATEWAY_ID"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        AUTH_ARGS="--auth-choice apiKey"
    elif [ -n "$OPENAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key"
    fi

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        $AUTH_ARGS \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-skills \
        --skip-health

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, models, trusted proxies)
# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, Slack)
# - Gateway token auth
# - Trusted proxies for sandbox networking
# - OpenRouter multi-model catalog
# - AI Gateway model override
node << 'EOFPATCH'
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

// Ensure nested objects exist
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.model = config.agents.defaults.model || {};
config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Clean up any broken anthropic provider config from previous runs
// (older versions didn't include required 'name' field)
if (config.models?.providers?.anthropic?.models) {
    const hasInvalidModels = config.models.providers.anthropic.models.some(m => !m.name);
    if (hasInvalidModels) {
        console.log('Removing broken anthropic provider config (missing model names)');
        delete config.models.providers.anthropic;
    }
}

// Clean up invalid openrouter provider config (OpenRouter uses built-in support, no providers config needed)
if (config.models?.providers?.openrouter) {
    console.log('Removing invalid models.providers.openrouter block');
    delete config.models.providers.openrouter;
    if (config.models.providers && Object.keys(config.models.providers).length === 0) {
        delete config.models.providers;
    }
    if (config.models && Object.keys(config.models).length === 0) {
        delete config.models;
    }
}

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

// Allow any origin to connect to the gateway control UI.
// The gateway runs inside a Cloudflare Container behind the Worker, which
// proxies requests from the public workers.dev domain. Without this,
// openclaw >= 2026.2.26 rejects WebSocket connections because the browser's
// origin (https://....workers.dev) doesn't match the gateway's localhost.
// Security is handled by CF Access + gateway token auth, not origin checks.
// Matches upstream cloudflare/moltworker.
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowedOrigins = ['*'];

// Set gateway token if provided.
// The token is written to the config file rather than passed as a CLI
// argument because argv is visible to every process in the container
// via ps/proc. The gateway reads gateway.auth.token from the config on boot.
if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

// Allow insecure auth for dev mode
if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi.allowInsecureAuth = true;
}

// AI Gateway model override (CF_AI_GATEWAY_MODEL=provider/model-id)
// Adds a provider entry for any AI Gateway provider and sets it as default model.
// Examples:
//   workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
//   openai/gpt-4o
//   anthropic/claude-sonnet-4-5
if (process.env.CF_AI_GATEWAY_MODEL) {
    const raw = process.env.CF_AI_GATEWAY_MODEL;
    const slashIdx = raw.indexOf('/');
    const gwProvider = raw.substring(0, slashIdx);
    const modelId = raw.substring(slashIdx + 1);

    const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
    const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
    const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

    let baseUrl;
    if (accountId && gatewayId) {
        baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
        if (gwProvider === 'workers-ai') baseUrl += '/v1';
    } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
        baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
    }

    if (baseUrl && apiKey) {
        const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
        const providerName = 'cf-ai-gw-' + gwProvider;

        config.models = config.models || {};
        config.models.providers = config.models.providers || {};
        config.models.providers[providerName] = {
            baseUrl: baseUrl,
            apiKey: apiKey,
            api: api,
            models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192 }],
        };
        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        config.agents.defaults.model = { primary: providerName + '/' + modelId };
        console.log('AI Gateway model override: provider=' + providerName + ' model=' + modelId + ' via ' + baseUrl);
    } else {
        console.warn('CF_AI_GATEWAY_MODEL set but missing required config (account ID, gateway ID, or API key)');
    }
}

// Telegram configuration
// Overwrite entire channel object to drop stale keys from old R2 backups
// that would fail OpenClaw's strict config validation (see #47)
if (process.env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
    };
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
        config.channels.telegram.allowFrom = ['*'];
    }
}

// Discord configuration
// Discord uses a nested dm object: dm.policy, dm.allowFrom (per DiscordDmConfig)
if (process.env.DISCORD_BOT_TOKEN) {
    const dmPolicy = process.env.DISCORD_DM_POLICY || 'pairing';
    const dm = { policy: dmPolicy };
    if (dmPolicy === 'open') {
        dm.allowFrom = ['*'];
    }
    config.channels.discord = {
        token: process.env.DISCORD_BOT_TOKEN,
        enabled: true,
        dm: dm,
    };
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
}

// OpenRouter multi-model catalog (when no AI Gateway or direct provider override is active)
if (!process.env.CF_AI_GATEWAY_MODEL && !process.env.AI_GATEWAY_BASE_URL && !process.env.ANTHROPIC_BASE_URL) {
    console.log('Configuring OpenRouter with multiple models...');

    config.agents.defaults.models = config.agents.defaults.models || {};

    // Auto-routing
    config.agents.defaults.models['openrouter/openrouter/auto'] = { alias: 'auto' };

    // General purpose
    config.agents.defaults.models['openrouter/deepseek/deepseek-chat-v3-0324'] = { alias: 'deep' };

    // Coding specialists
    config.agents.defaults.models['openrouter/qwen/qwen-2.5-coder-32b-instruct'] = { alias: 'qwen' };
    config.agents.defaults.models['openrouter/qwen/qwen-2.5-coder-32b-instruct:free'] = { alias: 'qwenfree' };
    config.agents.defaults.models['openrouter/mistralai/devstral-small:free'] = { alias: 'devstral' };
    config.agents.defaults.models['openrouter/xiaomi/mimo-vl-7b:free'] = { alias: 'mimo' };
    config.agents.defaults.models['openrouter/x-ai/grok-code-fast-1'] = { alias: 'grokcode' };

    // Agentic / Tools
    config.agents.defaults.models['openrouter/x-ai/grok-4.1-fast'] = { alias: 'grok' };
    config.agents.defaults.models['openrouter/moonshotai/kimi-k2.5'] = { alias: 'kimi' };

    // Speed / Fast
    config.agents.defaults.models['openrouter/google/gemini-2.0-flash-001'] = { alias: 'flash' };

    // Claude models
    config.agents.defaults.models['openrouter/anthropic/claude-3.5-haiku'] = { alias: 'haiku' };
    config.agents.defaults.models['openrouter/anthropic/claude-sonnet-4'] = { alias: 'sonnet' };

    // OpenAI models
    config.agents.defaults.models['openrouter/openai/gpt-4o-mini'] = { alias: 'mini' };
    config.agents.defaults.models['openrouter/openai/gpt-4o'] = { alias: 'gpt' };

    // Reasoning models
    config.agents.defaults.models['openrouter/deepseek/deepseek-reasoner'] = { alias: 'think' };
    config.agents.defaults.models['openrouter/qwen/qwq-32b-preview'] = { alias: 'qwq' };

    // Set OpenRouter Auto as default for intelligent routing
    if (!config.agents.defaults.model.primary) {
        config.agents.defaults.model.primary = 'openrouter/openrouter/auto';
    }
}

// NVIDIA NIM provider (free models via build.nvidia.com)
// OpenAI-compatible API — bypasses Cloudchamber egress restrictions
if (process.env.NVIDIA_NIM_API_KEY) {
    console.log('Configuring NVIDIA NIM provider with free models...');
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers.nvidia = {
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKey: process.env.NVIDIA_NIM_API_KEY,
        api: 'openai-completions',
        models: [
            { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', name: 'Nemotron Ultra 253B', contextWindow: 131072, maxTokens: 8192 },
            { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', name: 'Nemotron Super 49B v1.5', contextWindow: 131072, maxTokens: 8192 },
            { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', contextWindow: 131072, maxTokens: 8192 },
            { id: 'nvidia/nemotron-3-nano-30b-a3b', name: 'Nemotron 3 Nano 30B', contextWindow: 1048576, maxTokens: 8192 },
            { id: 'nvidia/nvidia-nemotron-nano-9b-v2', name: 'Nemotron Nano 9B v2', contextWindow: 131072, maxTokens: 8192 },
            { id: 'deepseek-ai/deepseek-v3.2', name: 'DeepSeek V3.2 (NIM)', contextWindow: 131072, maxTokens: 8192 },
            { id: 'qwen/qwen3.5-122b-a10b', name: 'Qwen 3.5 122B', contextWindow: 131072, maxTokens: 8192 },
            { id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B', contextWindow: 262144, maxTokens: 8192 },
            { id: 'qwen/qwen3.5-397b-a17b', name: 'Qwen 3.5 397B', contextWindow: 262144, maxTokens: 8192 },
            { id: 'z-ai/glm5', name: 'GLM-5', contextWindow: 131072, maxTokens: 8192 },
            { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 Instruct', contextWindow: 262144, maxTokens: 8192 },
            { id: 'mistralai/devstral-2-123b-instruct-2512', name: 'Devstral 2 123B', contextWindow: 131072, maxTokens: 8192 },
        ],
    };

    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1'] = { alias: 'nemotron' };
    config.agents.defaults.models['nvidia/nvidia/llama-3.3-nemotron-super-49b-v1.5'] = { alias: 'super49' };
    config.agents.defaults.models['nvidia/nvidia/nemotron-3-super-120b-a12b'] = { alias: 'nemo3' };
    config.agents.defaults.models['nvidia/nvidia/nemotron-3-nano-30b-a3b'] = { alias: 'nemonano' };
    config.agents.defaults.models['nvidia/nvidia/nvidia-nemotron-nano-9b-v2'] = { alias: 'nemo9b' };
    config.agents.defaults.models['nvidia/deepseek-ai/deepseek-v3.2'] = { alias: 'dsnv' };
    config.agents.defaults.models['nvidia/qwen/qwen3.5-122b-a10b'] = { alias: 'qwennv' };
    config.agents.defaults.models['nvidia/qwen/qwen3-coder-480b-a35b-instruct'] = { alias: 'qwencodernv' };
    config.agents.defaults.models['nvidia/qwen/qwen3.5-397b-a17b'] = { alias: 'qwen35nv' };
    config.agents.defaults.models['nvidia/z-ai/glm5'] = { alias: 'glm5nv' };
    config.agents.defaults.models['nvidia/moonshotai/kimi-k2-instruct'] = { alias: 'kiminv' };
    config.agents.defaults.models['nvidia/mistralai/devstral-2-123b-instruct-2512'] = { alias: 'devnv' };

    console.log('NVIDIA NIM: 12 free models registered (nemotron, super49, nemo3, nemonano, nemo9b, dsnv, qwennv, qwencodernv, qwen35nv, glm5nv, kiminv, devnv)');
}

// Codex bundled provider (OpenClaw >= 2026.4.10).
// Gated behind CODEX_AUTH_JSON_BOOTSTRAP to avoid setting a primary model
// that doesn't exist on pre-2026.4.10 OpenClaw. Once the version bump
// lands, setting the secret flips the default model without further code
// changes. Safe to run before the bump: the secret will never be set until
// the version also supports the codex/* namespace.
if (process.env.CODEX_AUTH_JSON_BOOTSTRAP) {
    const codexModel = process.env.CODEX_MODEL || 'codex/gpt-5.4';
    config.agents.defaults.model.primary = codexModel;
    console.log('Codex bundled provider active — default model: ' + codexModel);
}

// Write updated config
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# BACKGROUND SYNC LOOP
# ============================================================
if r2_configured; then
    echo "Starting background R2 sync loop..."
    (
        MARKER=/tmp/.last-sync-marker
        LOGFILE=/tmp/r2-sync.log
        touch "$MARKER"

        while true; do
            sleep 30

            CHANGED=/tmp/.changed-files
            {
                find "$CONFIG_DIR" -newer "$MARKER" -type f -printf '%P\n' 2>/dev/null
                find "$CODEX_DIR" -newer "$MARKER" -type f -printf '%P\n' 2>/dev/null
                find "$WORKSPACE_DIR" -newer "$MARKER" \
                    -not -path '*/node_modules/*' \
                    -not -path '*/.git/*' \
                    -type f -printf '%P\n' 2>/dev/null
            } > "$CHANGED"

            COUNT=$(wc -l < "$CHANGED" 2>/dev/null || echo 0)

            if [ "$COUNT" -gt 0 ]; then
                echo "[sync] Uploading changes ($COUNT files) at $(date)" >> "$LOGFILE"
                rclone sync "$CONFIG_DIR/" "r2:${R2_BUCKET}/openclaw/" \
                    $RCLONE_FLAGS --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' --exclude='.git/**' 2>> "$LOGFILE"
                # Codex auth persistence (safety-net path; the fs.watch helper
                # below is the primary fast-path on token rotation).
                if [ -d "$CODEX_DIR" ]; then
                    rclone sync "$CODEX_DIR/" "r2:${R2_BUCKET}/codex/" \
                        $RCLONE_FLAGS --exclude='.auth.json.*' 2>> "$LOGFILE"
                fi
                if [ -d "$WORKSPACE_DIR" ]; then
                    rclone sync "$WORKSPACE_DIR/" "r2:${R2_BUCKET}/workspace/" \
                        $RCLONE_FLAGS --exclude='skills/**' --exclude='.git/**' --exclude='node_modules/**' 2>> "$LOGFILE"
                fi
                if [ -d "$SKILLS_DIR" ]; then
                    rclone sync "$SKILLS_DIR/" "r2:${R2_BUCKET}/skills/" \
                        $RCLONE_FLAGS 2>> "$LOGFILE"
                fi
                date -Iseconds > "$LAST_SYNC_FILE"
                touch "$MARKER"
                echo "[sync] Complete at $(date)" >> "$LOGFILE"
            fi
        done
    ) &
    echo "Background sync loop started (PID: $!)"

    # Codex auth fast-path: fs.watch triggers an immediate rclone push on
    # every modification of ~/.codex/auth.json. Codex invalidates prior
    # refresh tokens on rotation, so losing even one write means a bricked
    # subscription on the next container boot. The bulk sync loop above
    # runs every 30s as a safety net; the watcher catches tokens within
    # milliseconds of being written.
    if [ -x /usr/local/bin/codex-auth-watcher.mjs ] || [ -f /usr/local/bin/codex-auth-watcher.mjs ]; then
        echo "Starting Codex auth fs.watch helper..."
        (
            R2_BUCKET="$R2_BUCKET" \
            CODEX_DIR="$CODEX_DIR" \
            node /usr/local/bin/codex-auth-watcher.mjs >> /tmp/codex-auth-watcher.log 2>&1
        ) &
        echo "Codex auth watcher started (PID: $!)"
    fi
fi

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

# Clean up stale lock files
rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

# The gateway token (if set) is already written to openclaw.json by the
# config patch above (gateway.auth.token). We deliberately avoid passing
# --token on the command line because CLI arguments are visible to every
# process in the container via ps/proc. Matches upstream cloudflare/moltworker.
if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
else
    echo "Starting gateway with device pairing (no token)..."
fi
exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
