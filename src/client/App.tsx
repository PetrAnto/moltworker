import { useMemo } from 'react'
import AdminPage from './pages/AdminPage'
import AnalyticsPage from './pages/AnalyticsPage'
import './App.css'

type View = 'admin' | 'analytics'

function getViewFromPath(pathname: string): View {
  return pathname.includes('/_admin/analytics') ? 'analytics' : 'admin'
}

export default function App() {
  const view = useMemo(() => getViewFromPath(window.location.pathname), [])

  return (
    <div className="app">
      <header className="app-header">
        <img src="/logo-small.png" alt="Moltworker" className="header-logo" />
        <h1>Moltbot Admin</h1>
        <nav className="app-nav">
          <a className={view === 'admin' ? 'active' : ''} href="/_admin/">Admin</a>
          <a className={view === 'analytics' ? 'active' : ''} href="/_admin/analytics">Analytics</a>
        </nav>
      </header>
      <main className="app-main">
        {view === 'analytics' ? <AnalyticsPage /> : <AdminPage />}
      </main>
    </div>
  )
}
