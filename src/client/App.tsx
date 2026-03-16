import AdminPage from './pages/AdminPage';
import AnalyticsPage from './pages/AnalyticsPage';
import './App.css';

function getIsAnalyticsRoute(pathname: string): boolean {
  return pathname === '/_admin/analytics' || pathname === '/analytics';
}

export default function App() {
  const isAnalyticsRoute = getIsAnalyticsRoute(window.location.pathname);

  return (
    <div className="app">
      <header className="app-header">
        <img src="/logo-small.png" alt="Moltworker" className="header-logo" />
        <h1>Moltbot Admin</h1>
        <nav className="app-nav">
          <a className={!isAnalyticsRoute ? 'active' : ''} href="/_admin/">
            Admin
          </a>
          <a className={isAnalyticsRoute ? 'active' : ''} href="/_admin/analytics">
            Analytics
          </a>
        </nav>
      </header>
      <main className="app-main">
        {isAnalyticsRoute ? <AnalyticsPage /> : <AdminPage />}
      </main>
    </div>
  );
}
