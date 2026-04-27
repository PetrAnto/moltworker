import AdminPage from './pages/AdminPage';
import AnalyticsPage from './pages/AnalyticsPage';
import AuditPage from './pages/AuditPage';
import CockpitPage from './pages/CockpitPage';
import './App.css';

type Page = 'admin' | 'analytics' | 'audit' | 'cockpit';

function getCurrentPage(pathname: string): Page {
  if (pathname.startsWith('/_admin/cockpit')) return 'cockpit';
  if (pathname.startsWith('/_admin/analytics')) return 'analytics';
  if (pathname.startsWith('/_admin/audit')) return 'audit';
  return 'admin';
}

export default function App() {
  const page = getCurrentPage(window.location.pathname);

  // Cockpit gets its own full-bleed shell (no admin header)
  if (page === 'cockpit') {
    return <CockpitPage />;
  }

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
          <a
            className={page === 'analytics' ? 'nav-link active' : 'nav-link'}
            href="/_admin/analytics"
          >
            Analytics
          </a>
          <a className={page === 'audit' ? 'nav-link active' : 'nav-link'} href="/_admin/audit">
            Audit
          </a>
          <a className="nav-link" href="/_admin/cockpit">
            Cockpit
          </a>
        </nav>
      </header>
      <main className="app-main">
        {page === 'analytics' ? (
          <AnalyticsPage />
        ) : page === 'audit' ? (
          <AuditPage />
        ) : (
          <AdminPage />
        )}
      </main>
    </div>
  );
}
