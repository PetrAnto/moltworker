import AdminPage from './pages/AdminPage'
import AnalyticsPage from './pages/AnalyticsPage'
import './App.css'

function getCurrentPath(): string {
  return window.location.pathname
}

export default function App() {
  const isAnalytics = getCurrentPath().startsWith('/_admin/analytics')

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-brand">
          <img src="/logo-small.png" alt="Moltworker" className="header-logo" />
          <h1>Moltbot Admin</h1>
        </div>
        <nav className="header-nav" aria-label="Admin navigation">
          <a href="/_admin/" className={!isAnalytics ? 'nav-link active' : 'nav-link'}>Admin</a>
          <a href="/_admin/analytics" className={isAnalytics ? 'nav-link active' : 'nav-link'}>Analytics</a>
        </nav>
      </header>
      <main className="app-main">
        {isAnalytics ? <AnalyticsPage /> : <AdminPage />}
      </main>
    </div>
  )
}
