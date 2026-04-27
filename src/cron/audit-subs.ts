/**
 * Cron — scheduled audit dispatch
 *
 * Runs on the 6h cron tick. Scans the audit subscription store
 * (audit:sub:*), dispatches every subscription whose cadence has
 * elapsed via the existing TaskProcessor DO path, and stamps the
 * subscription with the new lastRunAt / lastTaskId.
 *
 * Re-uses the same SkillTaskRequest shape that interactive
 * /audit … --analyze produces — see src/skills/audit/audit.ts
 * dispatchToDO. The only difference is the SkillRequest comes from
 * buildScheduledAuditRequest(sub), not user input.
 *
 * Idempotency is BEST-EFFORT, not strict. Two cron invocations that
 * scan the same sub before either has written its dispatchStartedAt
 * marker can both fire — KV is not CAS. The marker handles the more
 * common "scheduled handler retried after a transient failure" case;
 * strict once-only scheduling would require a Durable Object keyed
 * per subscription, which is overkill for v1.
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
 *
 * Best-effort idempotent at the per-subscription level: each due sub is
 * stamped with `dispatchStartedAt` *before* the DO fetch (so a parallel
 * cron tick scanning the same sub after the marker write will see it as
 * not-due via isSubscriptionDue), and `lastRunAt`/`lastTaskId` are
 * written on accept. A truly concurrent pre-marker scan can still race
 * — see the file header.
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
  const subsResult = await listAllSubscriptions(env.NEXUS_KV);
  if (subsResult.truncated) {
    // Defensive log: the page-cap kicked in, so some subs won't be
    // dispatched on this tick. Realistic-load deployments never hit
    // this; if they do, the operator should split workloads or raise
    // MAX_PAGES in cache.ts (currently 5 × 1000 = 5000 subs).
    console.warn(
      '[cron-audit-subs] subscription scan truncated — some subs may not have been dispatched this tick',
    );
  }
  const subs = subsResult.entries;
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
 * Dispatch one due subscription.
 *
 * Sequence:
 *   1. Write dispatchStartedAt = now      (in-flight marker)
 *   2. Fetch the DO with the SkillTaskRequest
 *   3. On accept: write lastRunAt + lastTaskId, clear the marker
 *   4. On failure: clear the marker so the next cron tick can retry
 *
 * Stores the dispatched `taskId` in `lastTaskId`, NOT `lastRunId`.
 * `taskId` identifies a TaskProcessor run; `AuditRun.runId` identifies
 * the persisted audit artefact and is minted inside the skill once
 * Scout has resolved the SHA. The audit skill will write back
 * `lastRunId` separately in Slice B once the completion path is wired
 * up — until then `lastRunId` stays null and `lastTaskId` is the
 * primary linkage for the admin tab.
 */
async function dispatchScheduledAudit(
  env: MoltbotEnv,
  sub: AuditSubscription,
  nowMs: number,
): Promise<void> {
  const taskProcessor = env.TASK_PROCESSOR!;
  const telegramToken = env.TELEGRAM_BOT_TOKEN!;

  // 1. In-flight marker — written *before* the DO fetch so a parallel
  // cron invocation scanning this sub after the put will see it as
  // not-due. Doesn't help against a perfectly-concurrent scan that
  // happens before either marker write lands; that race is documented
  // in the file header.
  const inFlight: AuditSubscription = {
    ...sub,
    dispatchStartedAt: new Date(nowMs).toISOString(),
  };
  await setAuditSubscription(env.NEXUS_KV, inFlight);

  // The skill request — equivalent to the user typing /audit run <repo> --analyze.
  const skillRequest = buildScheduledAuditRequest(
    sub,
    undefined as unknown as MoltbotEnv,
    undefined,
  );

  const taskId = crypto.randomUUID();

  // DO routing key: scheduled dispatches use a fresh id per task.
  // Interactive dispatch uses a deterministic key that includes the SHA
  // (audit_do_key in audit.ts), but the cron path doesn't know the SHA
  // yet — Scout resolves it inside the skill. The audit skill's own
  // profile cache + content-addressed Scout dedupes redundant work
  // across runs, so a fresh DO id per scheduled tick is acceptable.
  // Future improvement (tracked in roadmap): deterministic DO key per
  // (user, repo, intervalWindowStart) so two cron ticks in the same
  // 6h window land on the same DO.
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

  let resp: Response;
  try {
    resp = await stub.fetch('https://do/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Clear the marker so a later tick can retry — leaving it set would
    // freeze this sub for the full grace window.
    await clearInFlightMarker(env, sub);
    throw err;
  }

  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 240);
    } catch {
      /* ignore */
    }
    await clearInFlightMarker(env, sub);
    throw new Error(`DO returned ${resp.status}${detail ? ` — ${detail}` : ''}`);
  }

  // Stamp the subscription on success: lastRunAt + lastTaskId, clear marker.
  // Note: lastRunId stays null. The audit skill's completion path will
  // populate it once Slice B wires the run-id writeback.
  const updated: AuditSubscription = {
    ...sub,
    lastRunAt: new Date(nowMs).toISOString(),
    lastTaskId: taskId,
    dispatchStartedAt: undefined,
  };
  await setAuditSubscription(env.NEXUS_KV, updated);
}

async function clearInFlightMarker(env: MoltbotEnv, sub: AuditSubscription): Promise<void> {
  try {
    await setAuditSubscription(env.NEXUS_KV, { ...sub, dispatchStartedAt: undefined });
  } catch (err) {
    // Stale marker is recoverable (grace window expires); just log.
    console.warn(
      `[cron-audit-subs] failed to clear in-flight marker for ${sub.userId}:${sub.owner}/${sub.repo}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// Local re-export so the wire-payload `env` cast above is type-safe
// without dragging the SkillRequest type into the cron module's
// public surface.
type SkillRequest = import('../skills/types').SkillRequest;
