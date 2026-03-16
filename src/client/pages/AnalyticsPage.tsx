import { useEffect, useMemo, useState } from 'react';
import {
  fetchAnalyticsOverview,
  fetchOrchestraAnalytics,
  type AnalyticsOverview,
  type OrchestraAnalytics,
} from '../api';
import './AnalyticsPage.css';

function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) {
    return 'just now';
  }
  if (diffMs < 3_600_000) {
    return `${Math.floor(diffMs / 60_000)}m ago`;
  }
  if (diffMs < 86_400_000) {
    return `${Math.floor(diffMs / 3_600_000)}h ago`;
  }
  return new Date(timestamp).toLocaleDateString();
}

export default function AnalyticsPage() {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [orchestra, setOrchestra] = useState<OrchestraAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function loadData(): Promise<void> {
      setLoading(true);
      setError(null);

      try {
        const [overviewData, orchestraData] = await Promise.all([
          fetchAnalyticsOverview(),
          fetchOrchestraAnalytics(),
        ]);

        if (!isMounted) {
          return;
        }

        setOverview(overviewData);
        setOrchestra(orchestraData);
      } catch (err) {
        if (!isMounted) {
          return;
        }

        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      isMounted = false;
    };
  }, []);

  const categoryData = useMemo(() => {
    if (!overview) {
      return [];
    }

    return Object.entries(overview.tasksByCategory)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [overview]);

  const modelData = useMemo(() => {
    if (!overview) {
      return [];
    }

    return Object.entries(overview.tasksByModel)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [overview]);

  const topTools = useMemo(() => {
    if (!overview) {
      return [];
    }

    return Object.entries(overview.toolUsage)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [overview]);

  if (loading) {
    return (
      <div className="analytics-page">
        <div className="loading"><div className="spinner" />Loading analytics…</div>
      </div>
    );
  }

  if (error || !overview || !orchestra) {
    return (
      <div className="analytics-page">
        <div className="error-banner">{error || 'No analytics data available.'}</div>
      </div>
    );
  }

  return (
    <div className="analytics-page">
      <section className="stats-row">
        <article className="stat-card">
          <span className="stat-value">{overview.totalTasks}</span>
          <span className="stat-label">Total Tasks</span>
        </article>
        <article className="stat-card">
          <span className={`stat-value ${overview.successRate >= 80 ? 'success' : 'error'}`}>
            {overview.successRate.toFixed(1)}%
          </span>
          <span className="stat-label">Success Rate</span>
        </article>
        <article className="stat-card">
          <span className="stat-value">{formatDuration(overview.avgDurationMs)}</span>
          <span className="stat-label">Avg Duration</span>
        </article>
        <article className="stat-card">
          <span className="stat-value">
            {overview.orchestraTasks.completed}/{overview.orchestraTasks.total}
          </span>
          <span className="stat-label">Orchestra Tasks</span>
        </article>
      </section>

      <section className="chart-section">
        <h3>Tasks by Category</h3>
        <div className="bar-list">
          {categoryData.map((item) => (
            <div key={item.name} className="bar-item">
              <span className="bar-label">{item.name}</span>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${(item.value / Math.max(1, categoryData[0]?.value || 1)) * 100}%` }} />
              </div>
              <span className="bar-value">{item.value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="chart-section">
        <h3>Model Usage</h3>
        <div className="bar-list">
          {modelData.map((item) => (
            <div key={item.name} className="bar-item">
              <span className="bar-label"><code>{item.name}</code></span>
              <div className="bar-track">
                <div className="bar-fill alt" style={{ width: `${(item.value / Math.max(1, modelData[0]?.value || 1)) * 100}%` }} />
              </div>
              <span className="bar-value">{item.value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="chart-section">
        <h3>Tool Usage (Top 10)</h3>
        <div className="bar-list">
          {topTools.map((item) => (
            <div key={item.name} className="bar-item">
              <span className="bar-label"><code>{item.name}</code></span>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${(item.value / Math.max(1, topTools[0]?.value || 1)) * 100}%` }} />
              </div>
              <span className="bar-value">{item.value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="chart-section">
        <h3>Recent Tasks</h3>
        <div className="table-wrap">
          <table className="tasks-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Model</th>
                <th>Category</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {overview.recentTasks.map((task) => (
                <tr key={`${task.timestamp}-${task.summary}`}>
                  <td>{formatRelativeTime(task.timestamp)}</td>
                  <td><code>{task.model}</code></td>
                  <td>{task.category}</td>
                  <td className={task.success ? 'status-success' : 'status-error'}>{task.success ? '✓' : '✗'}</td>
                  <td>{formatDuration(task.durationMs)}</td>
                  <td>{task.summary.substring(0, 80)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="chart-section">
        <h3>Orchestra Timeline</h3>
        <div className="timeline">
          {orchestra.tasks.slice(0, 25).map((task) => (
            <article key={task.taskId} className="timeline-item">
              <div className={`status-dot ${task.status === 'completed' ? 'ok' : task.status === 'failed' ? 'bad' : 'pending'}`} />
              <div>
                <div className="timeline-title">
                  <code>{task.repo}</code> · {task.mode} · {task.status}
                </div>
                <div className="timeline-meta">
                  {formatRelativeTime(task.timestamp)} · <code>{task.model}</code>
                  {typeof task.durationMs === 'number' ? ` · ${formatDuration(task.durationMs)}` : ''}
                  {task.prUrl ? <> · <a href={task.prUrl} target="_blank" rel="noreferrer">PR</a></> : ''}
                </div>
                {task.summary ? <div className="timeline-summary">{task.summary}</div> : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
