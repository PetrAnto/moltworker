/**
 * Telegram Webhook Routes
 * Handles Telegram bot webhook for direct OpenRouter integration
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createTelegramHandler, TelegramBot, type TelegramUpdate } from '../telegram/handler';

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

  if (token !== env.TELEGRAM_BOT_TOKEN) {
    console.error('[Telegram] Invalid webhook token');
    return c.json({ error: 'Invalid token' }, 401);
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
  const success = await bot.setWebhook(webhookUrl);

  // Register bot menu commands
  const commandsSet = await bot.setMyCommands([
    { command: 'start', description: 'Welcome & feature overview' },
    { command: 'help', description: 'Full command reference' },
    { command: 'pick', description: 'Choose a model (buttons)' },
    { command: 'models', description: 'All models with prices' },
    { command: 'new', description: 'Clear conversation' },
    { command: 'img', description: 'Generate an image' },
    { command: 'briefing', description: 'Daily briefing (weather+news)' },
    { command: 'costs', description: 'Token usage summary' },
    { command: 'status', description: 'Bot status & info' },
    { command: 'saves', description: 'List saved checkpoints' },
    { command: 'ar', description: 'Toggle auto-resume' },
    { command: 'resume', description: 'Resume task with optional model override' },
    { command: 'credits', description: 'OpenRouter balance' },
    { command: 'syncall', description: 'Sync full model catalog from OpenRouter' },
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
 * Health check and info — GET /telegram/info
 *
 * Disclosure policy (intentional, reviewed):
 *   - This endpoint is unauthenticated by design: the Telegram routes skip
 *     Cloudflare Access so Telegram itself can hit /webhook without a token.
 *     /info sits under the same route, so it is reachable by anyone who
 *     knows the URL.
 *   - Every field returned is a boolean or a count. Never a secret value,
 *     never a URL, never a user ID.
 *   - Boolean presence flags (e.g. `debug_api_configured`) DO reveal the
 *     functional surface of the deployment (i.e. "which features are
 *     enabled"). That is an accepted trade-off: operators need one
 *     low-friction way to audit configuration without digging through
 *     `wrangler secret list`, and the information is only useful to
 *     someone already aware this worker exists.
 *   - If future fields need to expose anything more structured (URLs,
 *     user IDs, rate limit counters with values), add auth first or put
 *     that data on a separate authenticated route.
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
    // True iff a custom Acontext base URL is configured (the actual URL is
    // NOT exposed — internal staging hosts / partner subdomains would leak
    // infra topology via a public /info response).
    acontext_custom_base_url_configured: !!env.ACONTEXT_BASE_URL,
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
  });
});

export { telegram };
