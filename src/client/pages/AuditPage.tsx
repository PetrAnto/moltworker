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

export default function AuditPage() {
  const [data, setData] = useState<AuditOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const overview = await fetchAuditOverview(50);
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
  }, []);

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
        loading={loading}
        actionInProgress={actionInProgress}
        onUnsubscribe={handleUnsubscribe}
      />

      <RecentRunsSection runs={data?.recentRuns ?? []} loading={loading} />

      <SuppressionsSection
        sups={data?.suppressions ?? []}
        loading={loading}
        actionInProgress={actionInProgress}
        onUnsuppress={handleUnsuppress}
      />
    </div>
  );
}

function SubscriptionsSection({
  subs,
  loading,
  actionInProgress,
  onUnsubscribe,
}: {
  subs: AuditSubscriptionRow[];
  loading: boolean;
  actionInProgress: string | null;
  onUnsubscribe: (sub: AuditSubscriptionRow) => void;
}) {
  return (
    <section className="audit-section">
      <div className="section-header">
        <h2>Active Subscriptions ({subs.length})</h2>
      </div>
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
              return (
                <tr key={key}>
                  <td className="audit-repo">
                    {s.owner}/{s.repo}
                    {s.branch ? <span className="audit-meta"> @{s.branch}</span> : null}
                    {s.dispatchStartedAt ? (
                      <span
                        className="audit-flag"
                        title={`Dispatch in flight since ${s.dispatchStartedAt}`}
                      >
                        in flight
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
                    {s.lastRunId ? shortId(s.lastRunId) : <span className="audit-meta">—</span>}
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

function RecentRunsSection({ runs, loading }: { runs: AuditRunRow[]; loading: boolean }) {
  return (
    <section className="audit-section">
      <div className="section-header">
        <h2>Recent Runs ({runs.length})</h2>
      </div>
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
  loading,
  actionInProgress,
  onUnsuppress,
}: {
  sups: AuditSuppressionRow[];
  loading: boolean;
  actionInProgress: string | null;
  onUnsuppress: (sup: AuditSuppressionRow) => void;
}) {
  return (
    <section className="audit-section">
      <div className="section-header">
        <h2>Suppressed Findings ({sups.length})</h2>
      </div>
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
