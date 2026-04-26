/**
 * Discord Routes
 * Handles Discord bot webhook and announcement checking
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createDiscordHandler } from '../discord/handler';
import { timingSafeEqual } from '../utils/timing-safe-equal';

const discord = new Hono<AppEnv>();

/**
 * Operator-only endpoints under /discord are gated by the same Bearer
 * token used for /simulate (DEBUG_API_KEY). Without this gate the
 * /discord/check endpoint was publicly callable and could be used to
 * spam Discord/Telegram API quotas, since /discord is mounted outside
 * Cloudflare Access by design (so cron and webhook delivery work).
 */
discord.use('/check', async (c, next) => {
  const apiKey = c.env.DEBUG_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'Discord operator endpoints not configured. Set DEBUG_API_KEY secret.' }, 503);
  }

  const authHeader = c.req.header('Authorization');
  const expected = `Bearer ${apiKey}`;
  if (!authHeader || !timingSafeEqual(authHeader, expected)) {
    return c.json({ error: 'Invalid or missing Authorization header' }, 401);
  }
  return next();
});

/**
 * Manually trigger announcement check
 * GET /discord/check
 */
discord.get('/check', async (c) => {
  const env = c.env;

  // Validate required env vars
  if (!env.DISCORD_BOT_TOKEN) {
    return c.json({ error: 'DISCORD_BOT_TOKEN not configured' }, 500);
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return c.json({ error: 'TELEGRAM_BOT_TOKEN not configured' }, 500);
  }

  if (!env.OPENROUTER_API_KEY) {
    return c.json({ error: 'OPENROUTER_API_KEY not configured' }, 500);
  }

  if (!env.DISCORD_ANNOUNCEMENT_CHANNELS) {
    return c.json({ error: 'DISCORD_ANNOUNCEMENT_CHANNELS not configured' }, 500);
  }

  if (!env.DISCORD_FORWARD_TO_TELEGRAM) {
    return c.json({ error: 'DISCORD_FORWARD_TO_TELEGRAM not configured' }, 500);
  }

  try {
    const channelIds = env.DISCORD_ANNOUNCEMENT_CHANNELS.split(',').map(id => id.trim());
    const telegramChatId = parseInt(env.DISCORD_FORWARD_TO_TELEGRAM, 10);

    const handler = createDiscordHandler(
      env.DISCORD_BOT_TOKEN,
      env.TELEGRAM_BOT_TOKEN,
      env.OPENROUTER_API_KEY,
      env.MOLTBOT_BUCKET,
      channelIds,
      telegramChatId
    );

    const results = await handler.checkAllChannels();

    return c.json({
      ok: true,
      results,
      channelsChecked: results.length,
      totalNewMessages: results.reduce((sum, r) => sum + (r.newMessages > 0 ? r.newMessages : 0), 0),
    });
  } catch (error) {
    // Log the full error for the operator, but return a generic message to
    // the caller — interpolating the raw Error can leak internal hostnames,
    // tokens captured in upstream errors, etc.
    console.error('[Discord] Error checking channels:', error);
    return c.json({ error: 'Failed to check channels' }, 500);
  }
});

/**
 * Health check and info
 * GET /discord/info
 */
discord.get('/info', async (c) => {
  const env = c.env;

  const channelIds = env.DISCORD_ANNOUNCEMENT_CHANNELS
    ? env.DISCORD_ANNOUNCEMENT_CHANNELS.split(',').map(id => id.trim())
    : [];

  return c.json({
    discord_configured: !!env.DISCORD_BOT_TOKEN,
    telegram_configured: !!env.TELEGRAM_BOT_TOKEN,
    openrouter_configured: !!env.OPENROUTER_API_KEY,
    channels_configured: channelIds.length,
    forward_to_telegram: env.DISCORD_FORWARD_TO_TELEGRAM || null,
    check_path: '/discord/check',
  });
});

export { discord };
