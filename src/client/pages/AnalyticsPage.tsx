import { useEffect, useMemo, useState } from 'react';
import {
  fetchAnalyticsOverview,
  fetchOrchestraAnalytics,
  type AnalyticsOverview,
  type OrchestraAnalytics,
} from '../api';
import './AnalyticsPage.css';

function formatDuration(durationMs: number): string {
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1000)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatRelativeTime(timestamp: number): string {
  const deltaSeconds = Math.floor((Date.now() - timestamp) / 1000);
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type ChartDatum = { name: string; value: number };

function HorizontalBarChart({ data, className }: { data: ChartDatum[]; className?: string }) {
  const maxValue = Math.max(1, ...data.map((item) => item.value));
  return (
    <div className={`hbar-chart ${className ?? ''}`}>
      {data.map((item) => (
        <div className="hbar-row" key={item.name}>
          <div className="hbar-label" title={item.name}>{item.name}</div>
          <div className="hbar-track">
            <div
              className="hbar-fill"
              style={{ width: `${(item.value / maxValue) * 100}%` }}
            />
          </div>
          <div className="hbar-value">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [orchestra, setOrchestra] = useState<OrchestraAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [overviewResponse, orchestraResponse] = await Promise.all([
          fetchAnalyticsOverview(),
          fetchOrchestraAnalytics(),
        ]);
        setOverview(overviewResponse);
        setOrchestra(orchestraResponse);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, []);

  const categoryData = useMemo(
    () => Object.entries(overview?.tasksByCategory ?? {}).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    [overview],
  );
  const modelData = useMemo(
    () => Object.entries(overview?.tasksByModel ?? {}).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    [overview],
  );
  const toolData = useMemo(
    () => Object.entries(overview?.toolUsage ?? {}).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 10),
    [overview],
  );

  if (loading) {
    return <div className="loading"><div className="spinner" /><p>Loading analytics…</p></div>;
  }

  if (error || !overview || !orchestra) {
    return <div className="error-banner">{error || 'Analytics data unavailable.'}</div>;
  }

  return (
    <div className="analytics-page">
      <div className="stats-row">
        <div className="stat-card"><span className="stat-value">{overview.totalTasks}</span><span className="stat-label">Total Tasks</span></div>
        <div className="stat-card"><span className={`stat-value ${overview.successRate >= 80 ? 'success' : 'error'}`}>{overview.successRate}%</span><span className="stat-label">Success Rate</span></div>
        <div className="stat-card"><span className="stat-value">{formatDuration(overview.avgDurationMs)}</span><span className="stat-label">Avg Duration</span></div>
        <div className="stat-card"><span className="stat-value">{overview.orchestraTasks.completed}/{overview.orchestraTasks.total}</span><span className="stat-label">Orchestra Tasks</span></div>
      </div>

      <section className="chart-section"><h3>Tasks by Category</h3><HorizontalBarChart data={categoryData} /></section>
      <section className="chart-grid">
        <div className="chart-section"><h3>Model Usage</h3><HorizontalBarChart data={modelData} className="model-chart" /></div>
        <div className="chart-section"><h3>Tool Usage (Top 10)</h3><HorizontalBarChart data={toolData} className="tool-chart" /></div>
      </section>

      <section className="chart-section">
        <h3>Recent Tasks</h3>
        <div className="table-wrap">
          <table className="tasks-table">
            <thead><tr><th>Time</th><th>Model</th><th>Category</th><th>Status</th><th>Duration</th><th>Summary</th></tr></thead>
            <tbody>
              {overview.recentTasks.map((task, idx) => (
                <tr key={`${task.timestamp}-${idx}`}>
                  <td>{formatRelativeTime(task.timestamp)}</td><td><code>{task.model}</code></td><td>{task.category}</td><td>{task.success ? '✓' : '✗'}</td><td>{formatDuration(task.durationMs)}</td><td>{task.summary.substring(0, 60)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="chart-section">
        <h3>Orchestra Timeline</h3>
        <div className="timeline">
          {orchestra.tasks.slice(0, 20).map((task) => (
            <div className="timeline-item" key={task.taskId}>
              <div className={`timeline-status ${task.status}`}>{task.status}</div>
              <div className="timeline-content">
                <div className="timeline-topline"><code>{task.repo}</code><span>{formatRelativeTime(task.timestamp)}</span></div>
                <div className="timeline-meta"><span>Model: {task.model}</span><span>Mode: {task.mode}</span>{task.durationMs !== undefined && <span>Duration: {formatDuration(task.durationMs)}</span>}</div>
                {task.summary && <p>{task.summary}</p>}
                <div className="timeline-links">{task.prUrl && <a href={task.prUrl} target="_blank" rel="noreferrer">PR link</a>}{task.filesChanged.length > 0 && <span>{task.filesChanged.length} file(s) changed</span>}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
