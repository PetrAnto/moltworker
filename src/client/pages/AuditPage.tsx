import { useCallback, useEffect, useState } from 'react';
import {
  fetchAuditOverview,
  deleteAuditSubscription,
  deleteAuditSuppression,
  AuthError,
  type AuditOverviewResponse,
  type AuditRunRow,
  type AuditSubscriptionRow,
  type AuditSuppressionRow,
} from '../api';
import './AuditPage.css';

function formatAge(epochMs: number | null, nowMs: number = Date.now()): string {
  if (epochMs === null) return 'unknown';
  const seconds = Math.max(0, Math.floor((nowMs - epochMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatIsoAge(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return formatAge(t, nowMs);
}

function shortId(id: string | null | undefined, len = 8): string {
  if (!id) return '—';
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

/**
 * Mirrors the server-side DISPATCH_IN_FLIGHT_GRACE_MS in cache.ts. If a
 * dispatchStartedAt marker is older than this, the dispatcher is
 * presumed crashed and the next cron tick will retry — surface that
 * to the operator so a stuck-looking sub is visibly distinguishable
 * from a normal in-flight one. Slight staleness here is fine; the
 * cron path is the source of truth.
 */
const STALE_DISPATCH_MS = 10 * 60 * 1000;

function dispatchBadge(
  iso: string | undefined,
  nowMs: number = Date.now(),
): {
  label: string;
  cls: string;
  title: string;
} | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return { label: 'in flight', cls: 'audit-flag', title: `Dispatch in flight since ${iso}` };
  }
  const ageMs = nowMs - t;
  if (ageMs >= STALE_DISPATCH_MS) {
    return {
      label: 'stale dispatch',
      cls: 'audit-flag stale',
      title: `Dispatcher hasn’t reported back since ${iso} (>${Math.round(STALE_DISPATCH_MS / 60000)}m). Next cron tick will retry.`,
    };
  }
  return { label: 'in flight', cls: 'audit-flag', title: `Dispatch in flight since ${iso}` };
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/**
 * Fallback caps used before the first overview response lands. Once
 * `data.caps` is available, all UI uses the server-defined values so
 * we don't hard-code thresholds that could drift from cache.ts. These
 * fallbacks just need to be reasonable defaults for the loading state.
 */
const FALLBACK_SUPPRESSION_DEFAULT = 100;
const FALLBACK_SUPPRESSION_MAX = 500;

export default function AuditPage() {
  const [data, setData] = useState<AuditOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [suppressionLimit, setSuppressionLimit] = useState<number>(FALLBACK_SUPPRESSION_DEFAULT);

  const refresh = useCallback(async () => {
    try {
      const overview = await fetchAuditOverview({ limit: 50, suppressionLimit });
      setData(overview);
      setError(null);
    } catch (err) {
      if (err instanceof AuthError) {
        setError('Unauthorized — please sign in via Cloudflare Access.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load audit data');
      }
    } finally {
      setLoading(false);
    }
  }, [suppressionLimit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleUnsubscribe = async (sub: AuditSubscriptionRow) => {
    const key = `sub:${sub.userId}:${sub.owner}/${sub.repo}`;
    setActionInProgress(key);
    try {
      await deleteAuditSubscription(sub.userId, sub.owner, sub.repo);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unsubscribe');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUnsuppress = async (sup: AuditSuppressionRow) => {
    const key = `sup:${sup.userId}:${sup.owner}/${sup.repo}:${sup.findingId}`;
    setActionInProgress(key);
    try {
      await deleteAuditSuppression(sup.userId, sup.owner, sup.repo, sup.findingId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove suppression');
    } finally {
      setActionInProgress(null);
    }
  };

  return (
    <div className="audit-page">
      {error && (
        <div className="audit-error" role="alert">
          {error}
        </div>
      )}

      <SubscriptionsSection
        subs={data?.subscriptions ?? []}
        recentRuns={data?.recentRuns ?? []}
        truncated={data?.truncated.subscriptions ?? false}
        loading={loading}
        actionInProgress={actionInProgress}
        onUnsubscribe={handleUnsubscribe}
      />

      <RecentRunsSection
        runs={data?.recentRuns ?? []}
        truncated={data?.truncated.recentRuns ?? false}
        loading={loading}
      />

      <SuppressionsSection
        sups={data?.suppressions ?? []}
        truncated={data?.truncated.suppressions ?? false}
        loading={loading}
        actionInProgress={actionInProgress}
        onUnsuppress={handleUnsuppress}
        currentLimit={suppressionLimit}
        // Server-defined ceiling. Falls back to a sane default for the
        // first render before the overview response lands.
        maxLimit={data?.caps.suppressionsMax ?? FALLBACK_SUPPRESSION_MAX}
        canExpand={suppressionLimit < (data?.caps.suppressionsMax ?? FALLBACK_SUPPRESSION_MAX)}
        onExpand={() => setSuppressionLimit(data?.caps.suppressionsMax ?? FALLBACK_SUPPRESSION_MAX)}
      />
    </div>
  );
}

function SubscriptionsSection({
  subs,
  recentRuns,
  truncated,
  loading,
  actionInProgress,
  onUnsubscribe,
}: {
  subs: AuditSubscriptionRow[];
  recentRuns: AuditRunRow[];
  truncated: boolean;
  loading: boolean;
  actionInProgress: string | null;
  onUnsubscribe: (sub: AuditSubscriptionRow) => void;
}) {
  // GPT review #1: only display lastRunId when we can resolve it — the
  // run may have aged out of the 7-day TTL since the writeback. The
  // overview already returns recent runs, so we can answer this without
  // a second KV round-trip.
  const knownRunIds = new Set(recentRuns.map((r) => r.runId));
  return (
    <section className="audit-section">
      <div className="section-header">
        <h2>
          Active Subscriptions ({subs.length}
          {truncated ? '+' : ''})
        </h2>
      </div>
      {truncated ? (
        <p className="hint">
          ⚠️ Subscription scan hit the per-page cap — some subs may be missing from this view and
          would also be skipped on the cron tick. Investigate via <code>wrangler kv:key list</code>{' '}
          on prefix <code>audit:sub:</code>.
        </p>
      ) : null}
      {loading ? (
        <p className="hint">Loading…</p>
      ) : subs.length === 0 ? (
        <p className="hint">
          No subscriptions yet. Users create one via /audit subscribe in Telegram.
        </p>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>Repo</th>
              <th>User</th>
              <th>Cadence</th>
              <th>Lens</th>
              <th>Depth</th>
              <th>Last run</th>
              <th>Last task</th>
              <th>Last runId</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => {
              const key = `sub:${s.userId}:${s.owner}/${s.repo}`;
              const busy = actionInProgress === key;
              const badge = dispatchBadge(s.dispatchStartedAt);
              const runResolved = s.lastRunId !== null && knownRunIds.has(s.lastRunId);
              return (
                <tr key={key}>
                  <td className="audit-repo">
                    {s.owner}/{s.repo}
                    {s.branch ? <span className="audit-meta"> @{s.branch}</span> : null}
                    {badge ? (
                      <span className={badge.cls} title={badge.title}>
                        {badge.label}
                      </span>
                    ) : null}
                  </td>
                  <td>{s.userId}</td>
                  <td>{s.interval}</td>
                  <td>{s.lens ?? 'all'}</td>
                  <td>{s.depth}</td>
                  <td title={s.lastRunAt ?? ''}>{formatIsoAge(s.lastRunAt)}</td>
                  <td title={s.lastTaskId ?? ''}>{shortId(s.lastTaskId)}</td>
                  <td title={s.lastRunId ?? ''}>
                    {s.lastRunId === null ? (
                      <span className="audit-meta">—</span>
                    ) : runResolved ? (
                      shortId(s.lastRunId)
                    ) : (
                      <span
                        className="audit-meta"
                        title={`Run ${s.lastRunId} is no longer in the recent runs window (TTL ~7d)`}
                      >
                        expired
                      </span>
                    )}
                  </td>
                  <td>
                    <button
                      className="audit-action danger"
                      disabled={busy}
                      onClick={() => onUnsubscribe(s)}
                    >
                      {busy ? '…' : 'Unsubscribe'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RecentRunsSection({
  runs,
  truncated,
  loading,
}: {
  runs: AuditRunRow[];
  truncated: boolean;
  loading: boolean;
}) {
  return (
    <section className="audit-section">
      <div className="section-header">
        <h2>
          Recent Runs ({runs.length}
          {truncated ? '+' : ''})
        </h2>
      </div>
      {truncated ? (
        <p className="hint">
          ⚠️ More runs exist than the recency cap allows. Pass <code>?limit=N</code> on the API call
          (max 100) to widen the view.
        </p>
      ) : null}
      {loading ? (
        <p className="hint">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="hint">No audit runs in the last 7 days (run TTL).</p>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Repo @ SHA</th>
              <th>User</th>
              <th>Lenses</th>
              <th>Depth</th>
              <th>Findings</th>
              <th>LLM calls</th>
              <th>Tokens</th>
              <th>Duration</th>
              <th>Cost</th>
              <th>Run id</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={`${r.userId}:${r.runId}`}>
                <td title={r.createdAtMs ? new Date(r.createdAtMs).toISOString() : 'unknown'}>
                  {formatAge(r.createdAtMs)}
                </td>
                <td className="audit-repo">
                  {r.owner}/{r.repo}
                  <span className="audit-meta"> @{r.sha.slice(0, 7)}</span>
                </td>
                <td>{r.userId}</td>
                <td>{r.lenses.join(', ')}</td>
                <td>{r.depth}</td>
                <td>{r.findings}</td>
                <td>{r.llmCalls}</td>
                <td>
                  {r.tokensIn.toLocaleString()} → {r.tokensOut.toLocaleString()}
                </td>
                <td>{formatDurationMs(r.durationMs)}</td>
                <td>{formatCost(r.costUsd)}</td>
                <td title={r.runId}>{shortId(r.runId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SuppressionsSection({
  sups,
  truncated,
  loading,
  actionInProgress,
  onUnsuppress,
  currentLimit,
  maxLimit,
  canExpand,
  onExpand,
}: {
  sups: AuditSuppressionRow[];
  truncated: boolean;
  loading: boolean;
  actionInProgress: string | null;
  onUnsuppress: (sup: AuditSuppressionRow) => void;
  currentLimit: number;
  maxLimit: number;
  canExpand: boolean;
  onExpand: () => void;
}) {
  return (
    <section className="audit-section">
      <div className="section-header">
        <h2>
          Suppressed Findings ({sups.length}
          {truncated ? '+' : ''})
        </h2>
      </div>
      {truncated ? (
        <div className="audit-truncated-banner">
          <p className="hint">
            ⚠️ Showing first {sups.length} entries (cap = {currentLimit}). The suppression keyspace
            has more.
          </p>
          {canExpand ? (
            <button className="audit-action" onClick={onExpand}>
              Show up to {maxLimit}
            </button>
          ) : (
            <p className="hint">
              At the hard cap of {maxLimit}. Further entries require a server-side widening (raise{' '}
              <code>MAX_SUPPRESSIONS_LIMIT</code>).
            </p>
          )}
        </div>
      ) : null}
      {loading ? (
        <p className="hint">Loading…</p>
      ) : sups.length === 0 ? (
        <p className="hint">No suppressions. Users add them via the 🔇 button on audit reports.</p>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>Repo</th>
              <th>User</th>
              <th>Finding</th>
              <th>Suppressed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sups.map((s) => {
              const key = `sup:${s.userId}:${s.owner}/${s.repo}:${s.findingId}`;
              const busy = actionInProgress === key;
              return (
                <tr key={key}>
                  <td className="audit-repo">
                    {s.owner}/{s.repo}
                  </td>
                  <td>{s.userId}</td>
                  <td>
                    <code>{s.findingId}</code>
                  </td>
                  <td title={s.at ?? ''}>{formatIsoAge(s.at)}</td>
                  <td>
                    <button
                      className="audit-action"
                      disabled={busy}
                      onClick={() => onUnsuppress(s)}
                    >
                      {busy ? '…' : 'Un-suppress'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
