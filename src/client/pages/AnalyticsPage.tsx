import { useEffect, useMemo, useState } from 'react';
import {
  fetchAnalyticsOverview,
  fetchOrchestraAnalytics,
  type AnalyticsOverview,
  type OrchestraAnalytics,
} from '../api';
import './AnalyticsPage.css';

function formatDuration(durationMs: number): string {
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`;
  return `${Math.round(durationMs / 60_000)}m`;
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface ChartBar {
  name: string;
  value: number;
}

function BarList({ data, max = 10 }: { data: ChartBar[]; max?: number }) {
  const rows = data.slice(0, max);
  const maxValue = Math.max(1, ...rows.map((item) => item.value));

  return (
    <div className="bar-list">
      {rows.map((item) => (
        <div key={item.name} className="bar-row">
          <span className="bar-label" title={item.name}>{item.name}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(item.value / maxValue) * 100}%` }} />
          </div>
          <span className="bar-value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [orchestra, setOrchestra] = useState<OrchestraAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData(): Promise<void> {
      try {
        setLoading(true);
        setError(null);
        const [overviewData, orchestraData] = await Promise.all([
          fetchAnalyticsOverview(),
          fetchOrchestraAnalytics(),
        ]);
        setOverview(overviewData);
        setOrchestra(orchestraData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
      } finally {
        setLoading(false);
      }
    }

    void loadData();
  }, []);

  const categoryData = useMemo(() => {
    if (!overview) return [];
    return Object.entries(overview.tasksByCategory)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [overview]);

  const modelData = useMemo(() => {
    if (!overview) return [];
    return Object.entries(overview.tasksByModel)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [overview]);

  const toolData = useMemo(() => {
    if (!overview) return [];
    return Object.entries(overview.toolUsage)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [overview]);

  if (loading) return <div className="analytics-loading">Loading analytics...</div>;
  if (error || !overview || !orchestra) return <div className="analytics-error">{error || 'Analytics unavailable'}</div>;

  const successColor = overview.successRate >= 70 ? 'var(--success-color)' : 'var(--error-color)';

  return (
    <section className="analytics-page">
      <div className="stats-row">
        <div className="stat-card"><span className="stat-value">{overview.totalTasks}</span><span className="stat-label">Total Tasks</span></div>
        <div className="stat-card"><span className="stat-value" style={{ color: successColor }}>{overview.successRate}%</span><span className="stat-label">Success Rate</span></div>
        <div className="stat-card"><span className="stat-value">{formatDuration(overview.avgDurationMs)}</span><span className="stat-label">Avg Duration</span></div>
        <div className="stat-card"><span className="stat-value">{overview.orchestraTasks.completed}/{overview.orchestraTasks.total}</span><span className="stat-label">Orchestra Tasks</span></div>
      </div>

      <div className="chart-section"><h3>Tasks by Category</h3><BarList data={categoryData} /></div>
      <div className="chart-grid">
        <div className="chart-section"><h3>Model Usage</h3><BarList data={modelData} /></div>
        <div className="chart-section"><h3>Tool Usage (Top 10)</h3><BarList data={toolData} /></div>
      </div>

      <div className="chart-section">
        <h3>Recent Tasks</h3>
        <div className="table-wrapper">
          <table className="tasks-table">
            <thead><tr><th>Time</th><th>Model</th><th>Category</th><th>Status</th><th>Duration</th><th>Summary</th></tr></thead>
            <tbody>
              {overview.recentTasks.map((task) => (
                <tr key={`${task.timestamp}-${task.model}-${task.summary}`}>
                  <td>{formatRelativeTime(task.timestamp)}</td><td><code>{task.model}</code></td><td>{task.category}</td><td>{task.success ? '✓' : '✗'}</td><td>{formatDuration(task.durationMs)}</td><td>{task.summary.substring(0, 60)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="chart-section">
        <h3>Orchestra Timeline</h3>
        <div className="timeline-list">
          {orchestra.tasks.slice(0, 30).map((task) => (
            <div key={task.taskId} className="timeline-item">
              <div className="timeline-header"><span className={`status-badge status-${task.status}`}>{task.status}</span><code>{task.repo}</code><span>{task.mode}</span><span>{formatRelativeTime(task.timestamp)}</span>{task.durationMs ? <span>{formatDuration(task.durationMs)}</span> : null}</div>
              <div className="timeline-body"><span>/{task.model}</span>{task.prUrl ? <a href={task.prUrl} target="_blank" rel="noopener noreferrer">PR</a> : null}{task.summary ? <span>{task.summary.substring(0, 140)}</span> : null}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
