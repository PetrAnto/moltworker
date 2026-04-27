/**
 * Cron — scheduled audit dispatch
 *
 * Runs on the 6h cron tick. Scans the audit subscription store
 * (audit:sub:*), dispatches every subscription whose cadence has
 * elapsed via the existing TaskProcessor DO path, and stamps the
 * subscription with the new lastRunAt / lastRunId.
 *
 * Re-uses the same SkillTaskRequest shape that interactive
 * /audit … --analyze produces — see src/skills/audit/audit.ts
 * dispatchToDO. The only difference is the SkillRequest comes from
 * buildScheduledAuditRequest(sub), not user input.
 */

import type { MoltbotEnv } from '../types';
import type { SkillTaskRequest } from '../durable-objects/task-processor';
import {
  listAllSubscriptions,
  isSubscriptionDue,
  setAuditSubscription,
  type AuditSubscription,
} from '../skills/audit/cache';
import { buildScheduledAuditRequest } from '../skills/audit/audit';

export interface RunResult {
  inspected: number;
  dispatched: number;
  skippedNotDue: number;
  failed: number;
}

/**
 * Iterate every subscription in NEXUS_KV and dispatch any that are due.
 * Idempotent at the per-subscription level: lastRunAt is updated as
 * soon as the DO accepts the dispatch, so a re-running cron tick
 * (e.g. retried Worker invocation) does not duplicate-fire.
 */
export async function runScheduledAudits(env: MoltbotEnv): Promise<RunResult> {
  const result: RunResult = { inspected: 0, dispatched: 0, skippedNotDue: 0, failed: 0 };

  if (!env.NEXUS_KV) {
    console.warn('[cron-audit-subs] NEXUS_KV not bound — skipping');
    return result;
  }
  if (!env.TASK_PROCESSOR) {
    console.warn('[cron-audit-subs] TASK_PROCESSOR not bound — skipping');
    return result;
  }
  if (!env.TELEGRAM_BOT_TOKEN) {
    // Without a bot token the DO has no way to deliver the report.
    // Bail loudly — running the audit anyway would burn LLM budget for
    // a result the user can't see.
    console.warn('[cron-audit-subs] TELEGRAM_BOT_TOKEN not set — skipping');
    return result;
  }

  const now = Date.now();
  const subs = await listAllSubscriptions(env.NEXUS_KV);
  result.inspected = subs.length;

  for (const sub of subs) {
    if (!isSubscriptionDue(sub, now)) {
      result.skippedNotDue++;
      continue;
    }

    try {
      await dispatchScheduledAudit(env, sub, now);
      result.dispatched++;
    } catch (err) {
      result.failed++;
      console.error(
        `[cron-audit-subs] dispatch failed for ${sub.userId}:${sub.owner}/${sub.repo}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `[cron-audit-subs] inspected=${result.inspected} dispatched=${result.dispatched} ` +
      `notDue=${result.skippedNotDue} failed=${result.failed}`,
  );
  return result;
}

/**
 * Dispatch one due subscription. Stamps lastRunAt eagerly so that a
 * subsequent cron tick (or a manual retry) doesn't re-fire while the
 * first dispatch is still in flight.
 *
 * `lastRunId` is set to the dispatch's taskId so /_admin/audit can
 * link a subscription to its most recent run. The full AuditRun
 * record is persisted by the audit skill itself via cacheAuditRun()
 * once the run completes — keyed by AuditRun.runId, which differs
 * from taskId. We deliberately store the taskId here as the linkage:
 * it's what the user sees in the "🔍 Audit started…" message and
 * what the admin tab will use to fetch the corresponding AuditRun
 * once the skill's keying for run-by-task is wired up in Slice B.
 */
async function dispatchScheduledAudit(
  env: MoltbotEnv,
  sub: AuditSubscription,
  nowMs: number,
): Promise<void> {
  const taskProcessor = env.TASK_PROCESSOR!;
  const telegramToken = env.TELEGRAM_BOT_TOKEN!;

  // The skill request — equivalent to the user typing /audit run <repo> --analyze.
  const skillRequest = buildScheduledAuditRequest(
    sub,
    undefined as unknown as MoltbotEnv,
    undefined,
  );

  const taskId = crypto.randomUUID();

  // DO routing key matches the deterministic key used by interactive
  // dispatch (audit_do_key) shape — same user, same repo coords, but
  // we don't know the SHA at this point so we let the skill compute
  // its own DO key after Scout. Using a fresh DO id per scheduled
  // dispatch is fine: dedupe is opportunistic, not a correctness
  // requirement.
  const doId = taskProcessor.idFromName(
    `audit-sub:${sub.userId}:${sub.owner}/${sub.repo}:${taskId}`,
  );
  const stub = taskProcessor.get(doId);

  const payload: SkillTaskRequest = {
    kind: 'skill',
    taskId,
    chatId: sub.chatId,
    userId: sub.userId,
    telegramToken,
    skillRequest: {
      ...skillRequest,
      // Strip env from the wire payload — bindings don't survive JSON
      // serialization. The DO authoritatively rebuilds env from its own
      // bindings + the secrets in this payload.
      env: undefined as unknown as SkillRequest['env'],
    },
    openrouterKey: env.OPENROUTER_API_KEY,
    githubToken: env.GITHUB_TOKEN,
    braveSearchKey: env.BRAVE_SEARCH_KEY,
    tavilyKey: env.TAVILY_API_KEY,
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
  };

  const resp = await stub.fetch('https://do/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 240);
    } catch {
      /* ignore */
    }
    throw new Error(`DO returned ${resp.status}${detail ? ` — ${detail}` : ''}`);
  }

  // Stamp the subscription so the next cron tick sees it as not-due.
  // Best-effort: a failed update only means the next tick may re-fire,
  // which the audit skill itself will dedupe via its profile cache.
  const updated: AuditSubscription = {
    ...sub,
    lastRunAt: new Date(nowMs).toISOString(),
    lastRunId: taskId,
  };
  await setAuditSubscription(env.NEXUS_KV, updated);
}

// Local re-export so the wire-payload `env` cast above is type-safe
// without dragging the SkillRequest type into the cron module's
// public surface.
type SkillRequest = import('../skills/types').SkillRequest;
