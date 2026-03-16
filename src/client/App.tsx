import AdminPage from './pages/AdminPage';
import AnalyticsPage from './pages/AnalyticsPage';
import './App.css';

function getCurrentPage(pathname: string): 'admin' | 'analytics' {
  return pathname.startsWith('/_admin/analytics') ? 'analytics' : 'admin';
}

export default function App() {
  const page = getCurrentPage(window.location.pathname);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-wrap">
          <img src="/logo-small.png" alt="Moltworker" className="header-logo" />
          <h1>Moltbot Admin</h1>
        </div>
        <nav className="app-nav" aria-label="Admin navigation">
          <a className={page === 'admin' ? 'nav-link active' : 'nav-link'} href="/_admin/">
            Dashboard
          </a>
          <a className={page === 'analytics' ? 'nav-link active' : 'nav-link'} href="/_admin/analytics">
            Analytics
          </a>
        </nav>
      </header>
      <main className="app-main">
        {page === 'analytics' ? <AnalyticsPage /> : <AdminPage />}
      </main>
    </div>
  );
}
