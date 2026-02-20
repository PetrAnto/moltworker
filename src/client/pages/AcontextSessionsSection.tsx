import type { AcontextSessionsResponse } from '../api';

interface AcontextSessionsSectionProps {
  sessions: AcontextSessionsResponse | null;
}

function formatTimeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSessionAge(isoString: string): string {
  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) return 'Unknown';
  return formatTimeAgo(timestamp);
}

function truncatePrompt(prompt: string): string {
  if (prompt.length <= 60) return prompt;
  return `${prompt.slice(0, 57)}...`;
}

function getStatusIcon(success: boolean | null): string {
  if (success === true) return '✓';
  if (success === false) return '✗';
  return '?';
}

function getStatusClass(success: boolean | null): string {
  if (success === true) return 'success';
  if (success === false) return 'failure';
  return 'unknown';
}

export function AcontextSessionsSection({ sessions }: AcontextSessionsSectionProps) {
  return (
    <section className="devices-section acontext-section">
      <div className="section-header">
        <h2>Acontext Sessions</h2>
      </div>

      {!sessions ? (
        <div className="empty-state">
          <p>Loading recent sessions...</p>
        </div>
      ) : !sessions.configured ? (
        <p className="hint">Acontext not configured — add ACONTEXT_API_KEY</p>
      ) : sessions.items.length === 0 ? (
        <div className="empty-state">
          <p>No recent Acontext sessions</p>
        </div>
      ) : (
        <div className="acontext-list">
          {sessions.items.map((session) => (
            <div key={session.id} className="acontext-item">
              <span
                className={`session-status ${getStatusClass(session.success)}`}
                title={`Task status: ${session.success === null ? 'unknown' : session.success ? 'success' : 'failed'}`}
              >
                {getStatusIcon(session.success)}
              </span>
              <span className="session-age" title={new Date(session.createdAt).toLocaleString()}>
                {formatSessionAge(session.createdAt)}
              </span>
              <span className="session-model" title={session.model}>
                {session.model}
              </span>
              <span className="session-prompt" title={session.prompt || 'No prompt captured'}>
                {session.prompt ? truncatePrompt(session.prompt) : 'No prompt captured'}
              </span>
              <span className="session-tools">{session.toolsUsed} tools</span>
              <a
                className="session-link"
                href={`https://platform.acontext.com/sessions/${session.id}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open
              </a>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
