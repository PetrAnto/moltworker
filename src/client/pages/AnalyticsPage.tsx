import { useEffect, useMemo, useState } from 'react'
import { fetchAnalyticsOverview, fetchOrchestraAnalytics, type AnalyticsOverview, type OrchestraAnalytics } from '../api'
import './AnalyticsPage.css'

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '0s'
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`
  return `${Math.round(ms / 1000)}s`
}

function formatRelativeTime(timestamp: number): string {
  const deltaSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (deltaSec < 60) return `${deltaSec}s ago`
  const min = Math.floor(deltaSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function TopBars({ data }: { data: Array<{ name: string; value: number }> }) {
  const max = data.length === 0 ? 1 : Math.max(...data.map((item) => item.value))

  return (
    <div className="bars-list">
      {data.map((item) => (
        <div key={item.name} className="bar-row">
          <span className="bar-label" title={item.name}>{item.name}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(item.value / max) * 100}%` }} />
          </div>
          <span className="bar-value">{item.value}</span>
        </div>
      ))}
    </div>
  )
}

export default function AnalyticsPage() {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null)
  const [orchestra, setOrchestra] = useState<OrchestraAnalytics | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    Promise.all([fetchAnalyticsOverview(), fetchOrchestraAnalytics()])
      .then(([overviewData, orchestraData]) => {
        if (!active) return
        setOverview(overviewData)
        setOrchestra(orchestraData)
      })
      .catch((err: unknown) => {
        if (!active) return
        const message = err instanceof Error ? err.message : 'Failed to load analytics'
        setError(message)
      })

    return () => {
      active = false
    }
  }, [])

  const categoryData = useMemo(
    () => Object.entries(overview?.tasksByCategory || {}).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    [overview],
  )
  const modelData = useMemo(
    () => Object.entries(overview?.tasksByModel || {}).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    [overview],
  )
  const toolData = useMemo(
    () => Object.entries(overview?.toolUsage || {}).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 10),
    [overview],
  )

  if (error) {
    return <div className="error-banner">Analytics error: {error}</div>
  }

  if (!overview || !orchestra) {
    return <div className="loading"><div className="spinner" /><p>Loading analytics...</p></div>
  }

  return (
    <div className="analytics-page">
      <div className="stats-row">
        <div className="stat-card"><span className="stat-value">{overview.totalTasks}</span><span className="stat-label">Total Tasks</span></div>
        <div className="stat-card"><span className={`stat-value ${overview.successRate >= 80 ? 'success' : 'error'}`}>{overview.successRate.toFixed(1)}%</span><span className="stat-label">Success Rate</span></div>
        <div className="stat-card"><span className="stat-value">{formatDuration(overview.avgDurationMs)}</span><span className="stat-label">Avg Duration</span></div>
        <div className="stat-card"><span className="stat-value">{overview.orchestraTasks.completed}/{overview.orchestraTasks.total}</span><span className="stat-label">Orchestra Completed</span></div>
      </div>

      <section className="chart-section"><h3>Tasks by Category</h3><TopBars data={categoryData} /></section>
      <section className="chart-section"><h3>Model Usage</h3><TopBars data={modelData} /></section>
      <section className="chart-section"><h3>Tool Usage (Top 10)</h3><TopBars data={toolData} /></section>

      <section className="chart-section">
        <h3>Recent Tasks</h3>
        <div className="table-wrap">
          <table className="tasks-table">
            <thead><tr><th>Time</th><th>Model</th><th>Category</th><th>Status</th><th>Duration</th><th>Summary</th></tr></thead>
            <tbody>
              {overview.recentTasks.map((task) => (
                <tr key={`${task.timestamp}-${task.model}`}>
                  <td>{formatRelativeTime(task.timestamp)}</td>
                  <td><code>{task.model}</code></td>
                  <td>{task.category}</td>
                  <td>{task.success ? '✓' : '✗'}</td>
                  <td>{formatDuration(task.durationMs)}</td>
                  <td>{task.summary.substring(0, 60)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="chart-section">
        <h3>Orchestra Timeline</h3>
        <div className="timeline-list">
          {orchestra.tasks.slice(0, 20).map((task) => (
            <div className="timeline-item" key={`${task.taskId}-${task.timestamp}`}>
              <div className={`timeline-status ${task.status === 'completed' ? 'is-success' : task.status === 'failed' ? 'is-failure' : ''}`}>
                {task.status === 'completed' ? '✓' : task.status === 'failed' ? '✗' : '…'}
              </div>
              <div className="timeline-content">
                <div><strong>{task.repo}</strong> · {task.mode} · <code>{task.model}</code></div>
                <div className="timeline-meta">{formatRelativeTime(task.timestamp)} · {formatDuration(task.durationMs || 0)} {task.prUrl ? <>· <a href={task.prUrl} target="_blank" rel="noreferrer">PR</a></> : null}</div>
                {task.summary ? <div className="timeline-summary">{task.summary}</div> : null}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
