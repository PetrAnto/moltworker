/**
 * Telegram Webhook Routes
 * Handles Telegram bot webhook for direct OpenRouter integration
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createTelegramHandler, TelegramBot, type TelegramUpdate } from '../telegram/handler';
import { timingSafeEqual } from '../utils/timing-safe-equal';

const telegram = new Hono<AppEnv>();

/**
 * Telegram webhook endpoint
 * POST /telegram/webhook/:token
 */
telegram.post('/webhook/:token', async (c) => {
  const token = c.req.param('token');
  const env = c.env;

  // Validate token matches configured bot token
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error('[Telegram] TELEGRAM_BOT_TOKEN not configured');
    return c.json({ error: 'Bot not configured' }, 500);
  }

  // Constant-time compare: a plain `!==` would leak the matching prefix
  // length of the bot token, which (since this token = full bot impersonation)
  // is not acceptable.
  if (!timingSafeEqual(token, env.TELEGRAM_BOT_TOKEN)) {
    console.error('[Telegram] Invalid webhook token');
    return c.json({ error: 'Invalid token' }, 401);
  }

  // Optional second factor: validate Telegram's X-Telegram-Bot-Api-Secret-Token
  // header. Only enforced when TELEGRAM_WEBHOOK_SECRET is configured, so
  // existing deployments keep working until they re-run /telegram/setup.
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const provided = c.req.header('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!timingSafeEqual(provided, env.TELEGRAM_WEBHOOK_SECRET)) {
      console.error('[Telegram] Invalid webhook secret-token header');
      return c.json({ error: 'Invalid secret token' }, 401);
    }
  }

  // Check for OpenRouter API key
  if (!env.OPENROUTER_API_KEY) {
    console.error('[Telegram] OPENROUTER_API_KEY not configured');
    return c.json({ error: 'OpenRouter not configured' }, 500);
  }

  // Check for R2 bucket
  if (!env.MOLTBOT_BUCKET) {
    console.error('[Telegram] MOLTBOT_BUCKET not configured');
    return c.json({ error: 'Storage not configured' }, 500);
  }

  try {
    const update = await c.req.json() as TelegramUpdate;
    console.log('[Telegram] Received update:', update.update_id);

    // Create handler and process update
    const workerUrl = new URL(c.req.url).origin;

    // Parse allowed users from env (comma-separated list of Telegram user IDs)
    const allowedUsers = env.TELEGRAM_ALLOWED_USERS
      ? env.TELEGRAM_ALLOWED_USERS.split(',').map((id: string) => id.trim())
      : undefined;

    // Get sandbox from Hono context if available (set by middleware in index.ts)
    const sandbox = c.get('sandbox' as never) as import('../openrouter/tools').SandboxLike | undefined;

    const handler = createTelegramHandler(
      env.TELEGRAM_BOT_TOKEN,
      env.OPENROUTER_API_KEY,
      env.MOLTBOT_BUCKET,
      workerUrl,
      'storia-orchestrator',
      allowedUsers,
      env.GITHUB_TOKEN, // Pass GitHub token for tool authentication
      env.BRAVE_SEARCH_KEY, // Brave Search key for web_search tool
      env.TASK_PROCESSOR, // Pass TaskProcessor DO for long-running tasks
      env.BROWSER, // Pass browser binding for browse_url tool
      env.DASHSCOPE_API_KEY, // DashScope for Qwen
      env.MOONSHOT_API_KEY, // Moonshot for Kimi
      env.DEEPSEEK_API_KEY, // DeepSeek for DeepSeek Coder
      env.ANTHROPIC_API_KEY, // Anthropic for Claude direct
      env.NVIDIA_NIM_API_KEY, // NVIDIA NIM free models
      sandbox, // Sandbox container for sandbox_exec tool
      env.ACONTEXT_API_KEY, // Acontext observability
      env.ACONTEXT_BASE_URL, // Acontext API base URL
      env.CLOUDFLARE_API_TOKEN, // Cloudflare API token for Code Mode MCP
      env.ARTIFICIAL_ANALYSIS_KEY, // AA benchmark data
      env.NEXUS_KV, // KV namespace for Nexus research cache
      env.TAVILY_API_KEY, // Tavily Search API key (preferred for web_search — no credit card)
    );

    // Process update asynchronously.
    // Wrap in error handler so failures are logged — waitUntil silently
    // swallows rejected promises, making the bot appear completely dead.
    c.executionCtx.waitUntil(
      handler.handleUpdate(update).catch((err) => {
        console.error('[Telegram] Unhandled error in handleUpdate:', err);
        // Last-resort attempt to notify user
        const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
        if (chatId && env.TELEGRAM_BOT_TOKEN) {
          return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: '⚠️ Temporary internal error. Please try again in a moment.',
            }),
          }).catch(() => { /* truly nothing we can do */ });
        }
      })
    );

    // Return immediately to Telegram
    return c.json({ ok: true });
  } catch (error) {
    console.error('[Telegram] Error processing webhook:', error);
    return c.json({ error: 'Internal error' }, 500);
  }
});

/**
 * Set webhook URL
 * GET /telegram/setup
 */
telegram.get('/setup', async (c) => {
  const env = c.env;

  if (!env.TELEGRAM_BOT_TOKEN) {
    return c.json({ error: 'TELEGRAM_BOT_TOKEN not configured' }, 500);
  }

  const workerUrl = new URL(c.req.url).origin;
  const webhookUrl = `${workerUrl}/telegram/webhook/${env.TELEGRAM_BOT_TOKEN}`;

  const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN);
  const success = await bot.setWebhook(webhookUrl, env.TELEGRAM_WEBHOOK_SECRET);

  // Register bot menu commands.
  //
  // Telegram renders this list in the `/` autocomplete menu, so it's the
  // first-contact surface for most users. Keep it focused on high-signal
  // top-level entry points — not every implemented command. The full
  // reference lives in /help; power-user commands (syncall, curate,
  // test, etc.) stay out of the menu to avoid noise.
  const commandsSet = await bot.setMyCommands([
    { command: 'start', description: 'Welcome & feature overview' },
    { command: 'help', description: 'Full command reference' },
    { command: 'orch', description: 'Orchestra: plan & build projects as PRs' },
    { command: 'write', description: 'Lyra: draft content' },
    { command: 'research', description: 'Nexus: multi-source research' },
    { command: 'save', description: 'Spark: capture ideas to your inbox' },
    { command: 'cf', description: 'Cloudflare API search / execute' },
    { command: 'pick', description: 'Choose a model by intent' },
    { command: 'models', description: 'Browse models with prices' },
    { command: 'img', description: 'Generate an image' },
    { command: 'video', description: 'Generate a video' },
    { command: 'briefing', description: 'Daily briefing (weather + news)' },
    { command: 'new', description: 'Reset conversation' },
    { command: 'resume', description: 'Resume the last task' },
    { command: 'costs', description: 'Token usage summary' },
    { command: 'status', description: 'Bot status & info' },
  ]);

  if (success) {
    return c.json({
      ok: true,
      message: 'Webhook set successfully',
      webhook_url: webhookUrl.replace(env.TELEGRAM_BOT_TOKEN, '***'),
      commands_registered: commandsSet,
    });
  } else {
    return c.json({ error: 'Failed to set webhook' }, 500);
  }
});

/**
 * Health check and info
 * GET /telegram/info
 */
telegram.get('/info', async (c) => {
  const env = c.env;

  // Parse web_search rate limit config the same way the DO does, so /info
  // reflects the effective limits (including env overrides) not the defaults.
  const { parseWebSearchLimiterConfig } = await import('../rate-limit/web-search-limiter');
  const webSearchConfig = parseWebSearchLimiterConfig({
    WEB_SEARCH_USER_DAILY_LIMIT: env.WEB_SEARCH_USER_DAILY_LIMIT,
    WEB_SEARCH_TASK_LIMIT: env.WEB_SEARCH_TASK_LIMIT,
    WEB_SEARCH_GLOBAL_DAILY_LIMIT: env.WEB_SEARCH_GLOBAL_DAILY_LIMIT,
    WEB_SEARCH_ALLOWLIST_USERS: env.WEB_SEARCH_ALLOWLIST_USERS,
  });

  // Surface webhook registration state so operators can verify that
  // /telegram/setup has been re-run after enabling TELEGRAM_WEBHOOK_SECRET.
  // Telegram doesn't echo the secret back, so we can only confirm a webhook
  // is registered (with which URL) and whether our local secret is set —
  // a successful real message delivery is the only end-to-end check.
  let webhook: {
    secret_configured: boolean;
    registered_url: string | null;
    pending_updates: number | null;
    last_error_date: number | null;
    last_error_message: string | null;
  } = {
    secret_configured: !!env.TELEGRAM_WEBHOOK_SECRET,
    registered_url: null,
    pending_updates: null,
    last_error_date: null,
    last_error_message: null,
  };
  if (env.TELEGRAM_BOT_TOKEN) {
    const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN);
    const info = await bot.getWebhookInfo();
    if (info) {
      // Redact the bot-token segment from the URL before returning it —
      // /info has the same trust class as /telegram/setup so it's not
      // public, but we still don't want the token in admin UI screenshots.
      const redactedUrl = info.url.replace(env.TELEGRAM_BOT_TOKEN, '***');
      webhook = {
        secret_configured: !!env.TELEGRAM_WEBHOOK_SECRET,
        registered_url: redactedUrl,
        pending_updates: info.pending_update_count,
        last_error_date: info.last_error_date ?? null,
        last_error_message: info.last_error_message ?? null,
      };
    }
  }

  return c.json({
    telegram_configured: !!env.TELEGRAM_BOT_TOKEN,
    openrouter_configured: !!env.OPENROUTER_API_KEY,
    storage_configured: !!env.MOLTBOT_BUCKET,
    github_configured: !!env.GITHUB_TOKEN,
    task_processor_configured: !!env.TASK_PROCESSOR,
    browser_configured: !!env.BROWSER,
    // Direct API providers
    dashscope_configured: !!env.DASHSCOPE_API_KEY,
    moonshot_configured: !!env.MOONSHOT_API_KEY,
    deepseek_configured: !!env.DEEPSEEK_API_KEY,
    anthropic_configured: !!env.ANTHROPIC_API_KEY,
    nvidia_nim_configured: !!env.NVIDIA_NIM_API_KEY,
    acontext_configured: !!env.ACONTEXT_API_KEY,
    // Effective Acontext base URL (null when default "https://api.acontext.io"
    // is in use — lets operators spot misconfigured overrides at a glance).
    acontext_base_url: env.ACONTEXT_BASE_URL || null,
    cloudflare_api_configured: !!env.CLOUDFLARE_API_TOKEN,
    // Model intelligence data (gates benchmark/ranking features)
    artificial_analysis_configured: !!env.ARTIFICIAL_ANALYSIS_KEY,
    // Auth for the /simulate endpoint (required for HTTP-based bot testing)
    debug_api_configured: !!env.DEBUG_API_KEY,
    // Shared secret for Storia → Moltworker integration
    storia_integration_configured: !!env.STORIA_MOLTWORKER_SECRET,
    // Telegram access control — 0 means "allow all" (no allowlist set)
    telegram_allowed_user_count: env.TELEGRAM_ALLOWED_USERS
      ? env.TELEGRAM_ALLOWED_USERS.split(',').map((s) => s.trim()).filter(Boolean).length
      : 0,
    // web_search providers — Tavily preferred (no credit card), Brave fallback
    tavily_configured: !!env.TAVILY_API_KEY,
    brave_search_configured: !!env.BRAVE_SEARCH_KEY,
    // web_search rate limits (effective values, defaults applied)
    web_search_rate_limits: {
      user_daily_limit: webSearchConfig.userDailyLimit,
      task_limit: webSearchConfig.taskLimit,
      global_daily_limit: webSearchConfig.globalDailyLimit,
      allowlist_user_count: webSearchConfig.allowlistUsers.size,
    },
    webhook_path: '/telegram/webhook/:token',
    setup_path: '/telegram/setup',
    webhook,
  });
});

export { telegram };
