/**
 * Rate limiter for the `web_search` tool.
 *
 * Defense in depth for multi-user deployments: even with a no-credit-card
 * search provider (Tavily), we don't want a single user or a looping model
 * to drain the shared provider quota.
 *
 * Three independent caps:
 *
 *   - **Per-task cap** — in-memory counter on the limiter instance. Resets
 *     when the task ends (or restarts). Primary defense against loops where
 *     a model keeps calling web_search in the same conversation.
 *
 *   - **Per-user daily cap** — persisted in R2 under
 *     `ratelimit/web_search/users/{userId}/{YYYY-MM-DD}`. Day-scoped keys
 *     auto-expire (the next day's counter starts fresh) so there's no
 *     cleanup job. Primary defense against one user hammering the bot.
 *
 *   - **Global daily cap** — persisted in R2 under
 *     `ratelimit/web_search/global/{YYYY-MM-DD}`. Last-line circuit breaker
 *     across all users.
 *
 * Cached searches (served from the in-memory `webSearchCache` in tools.ts)
 * do NOT count toward any cap — the provider was not hit, so there's no
 * cost to protect.
 *
 * Allowlisted users (e.g. the bot operator for debugging) bypass all caps.
 *
 * R2 is not transactional: two concurrent requests can both read N and
 * both write N+1, losing an increment. That's acceptable here — these are
 * soft caps for cost control, not hard quotas, and the drift is bounded by
 * the number of concurrent searches (typically 1-2).
 */

export interface WebSearchLimiterConfig {
  /** Max searches per user per day. */
  userDailyLimit: number;
  /** Max searches per single task (in-memory, resets on task restart). */
  taskLimit: number;
  /** Max searches across all users per day (circuit breaker). */
  globalDailyLimit: number;
  /** Telegram user IDs that bypass all caps. */
  allowlistUsers: Set<string>;
}

export interface WebSearchLimiterDeps {
  /** R2 bucket for persistent counters. */
  r2: Pick<R2Bucket, 'get' | 'put'>;
  /** Telegram user ID. */
  userId: string;
  /** Task ID (used only for logging). */
  taskId: string;
  /** Current time provider — injected for testability. */
  now?: () => Date;
}

export type WebSearchLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: string; scope: 'task' | 'user' | 'global' };

export interface WebSearchLimiter {
  /**
   * Check and (if allowed) increment the rate limit counters.
   *
   * Call this BEFORE making the provider API call. On `allowed: true`,
   * the counters have already been incremented — callers don't need to
   * decrement on failure (best-effort increment is fine for soft caps).
   *
   * @param opts.cached - True if the result came from cache. Cached hits
   *                      are always allowed and do not increment counters.
   */
  checkAndIncrement(opts: { cached: boolean }): Promise<WebSearchLimitDecision>;
}

/**
 * Build the R2 date suffix (YYYY-MM-DD, UTC).
 * Exported for tests; callers use it via the limiter.
 */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function userKey(userId: string, day: string): string {
  // Sanitize userId to avoid key injection (only digits expected for Telegram IDs)
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `ratelimit/web_search/users/${safe}/${day}`;
}

function globalKey(day: string): string {
  return `ratelimit/web_search/global/${day}`;
}

async function readCount(
  r2: WebSearchLimiterDeps['r2'],
  key: string,
): Promise<number> {
  try {
    const obj = await r2.get(key);
    if (!obj) return 0;
    const text = await obj.text();
    const n = Number.parseInt(text, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    // R2 read failures are non-fatal — default to 0 so the user isn't
    // penalized for our infrastructure blip.
    return 0;
  }
}

async function writeCount(
  r2: WebSearchLimiterDeps['r2'],
  key: string,
  value: number,
): Promise<void> {
  try {
    await r2.put(key, String(value));
  } catch (err) {
    // Non-fatal: if we can't persist the increment, the soft cap drifts
    // slightly but the tool still works. Log for visibility.
    console.error(`[WebSearchLimiter] Failed to write counter ${key}:`, err);
  }
}

export function createWebSearchLimiter(
  deps: WebSearchLimiterDeps,
  config: WebSearchLimiterConfig,
): WebSearchLimiter {
  // In-memory per-task counter — closed over the returned limiter instance.
  // One instance per task processing invocation, so this tracks searches
  // within a single task run and resets naturally on restart.
  let taskCount = 0;

  const now = deps.now ?? (() => new Date());

  return {
    async checkAndIncrement({ cached }): Promise<WebSearchLimitDecision> {
      // Cached results don't hit the provider, so they don't consume quota.
      if (cached) {
        return { allowed: true };
      }

      // Allowlist bypass — operator/debug users can't be rate-limited.
      if (config.allowlistUsers.has(deps.userId)) {
        return { allowed: true };
      }

      // Per-task cap: cheapest check, do it first.
      if (taskCount >= config.taskLimit) {
        return {
          allowed: false,
          scope: 'task',
          reason: `Per-task web_search limit reached (${config.taskLimit} searches in this task). Use the results you already have, or try a different tool.`,
        };
      }

      const today = dayKey(now());
      const uKey = userKey(deps.userId, today);
      const gKey = globalKey(today);

      // Per-user daily cap
      const userCount = await readCount(deps.r2, uKey);
      if (userCount >= config.userDailyLimit) {
        return {
          allowed: false,
          scope: 'user',
          reason: `Daily web_search limit reached for this user (${config.userDailyLimit} searches/day). Resets at 00:00 UTC.`,
        };
      }

      // Global daily cap
      const globalCount = await readCount(deps.r2, gKey);
      if (globalCount >= config.globalDailyLimit) {
        return {
          allowed: false,
          scope: 'global',
          reason: `Global daily web_search limit reached (${config.globalDailyLimit} searches/day across all users). Resets at 00:00 UTC.`,
        };
      }

      // All checks passed — increment all three counters.
      // Per-task is in-memory, per-user and global persist to R2.
      taskCount++;
      await writeCount(deps.r2, uKey, userCount + 1);
      await writeCount(deps.r2, gKey, globalCount + 1);

      return { allowed: true };
    },
  };
}

/**
 * Build a WebSearchLimiterConfig from env vars with sensible defaults.
 * Exported so the TaskProcessor and any other call site use the same
 * parsing logic.
 */
export function parseWebSearchLimiterConfig(env: {
  WEB_SEARCH_USER_DAILY_LIMIT?: string;
  WEB_SEARCH_TASK_LIMIT?: string;
  WEB_SEARCH_GLOBAL_DAILY_LIMIT?: string;
  WEB_SEARCH_ALLOWLIST_USERS?: string;
}): WebSearchLimiterConfig {
  const parseLimit = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const allowlist = new Set<string>(
    (env.WEB_SEARCH_ALLOWLIST_USERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  return {
    userDailyLimit: parseLimit(env.WEB_SEARCH_USER_DAILY_LIMIT, 20),
    taskLimit: parseLimit(env.WEB_SEARCH_TASK_LIMIT, 5),
    globalDailyLimit: parseLimit(env.WEB_SEARCH_GLOBAL_DAILY_LIMIT, 200),
    allowlistUsers: allowlist,
  };
}

/**
 * Convenience factory that builds a WebSearchLimiter in one call.
 *
 * Every code path that constructs a ToolContext should use this (not
 * `createWebSearchLimiter` directly) so the config parsing, R2 dependency
 * check, and fallback-on-missing-r2 behavior stay consistent.
 *
 * Returns `undefined` when R2 is unavailable. Callers treat undefined as
 * "no rate limiting" (the tool still runs but without cap enforcement),
 * which matches the DO's historical behavior when R2 is missing.
 *
 * The config is read from an env-shaped object using the same field names
 * as MoltbotEnv (WEB_SEARCH_USER_DAILY_LIMIT, WEB_SEARCH_TASK_LIMIT, etc).
 * Pass the worker `env` directly — no copy/rename needed.
 */
export function buildWebSearchLimiter(params: {
  r2: Pick<R2Bucket, 'get' | 'put'> | undefined;
  userId: string;
  /** Optional. Used only for logging — safe to default if caller has no task concept. */
  taskId?: string;
  env: {
    WEB_SEARCH_USER_DAILY_LIMIT?: string;
    WEB_SEARCH_TASK_LIMIT?: string;
    WEB_SEARCH_GLOBAL_DAILY_LIMIT?: string;
    WEB_SEARCH_ALLOWLIST_USERS?: string;
  };
}): WebSearchLimiter | undefined {
  if (!params.r2) return undefined;
  return createWebSearchLimiter(
    {
      r2: params.r2,
      userId: params.userId,
      taskId: params.taskId ?? `${params.userId}-${Date.now()}`,
    },
    parseWebSearchLimiterConfig(params.env),
  );
}
