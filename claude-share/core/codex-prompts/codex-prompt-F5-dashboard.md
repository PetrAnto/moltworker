# Codex Task: F.5 — Observability Dashboard Enhancement

## Goal

Add analytics API endpoints and a metrics dashboard page to the admin UI. The data already exists in R2 (task learnings, orchestra history) — it just needs API endpoints to aggregate it and React components to display it.

## Current State

### Admin Dashboard (React + Vite)

**Files:**
- `src/client/App.tsx` — root SPA component with React Router
- `src/client/pages/AdminPage.tsx` — current dashboard (device pairing, gateway control, R2 status, Acontext sessions)
- `src/client/App.css` — header + layout
- `src/client/pages/AdminPage.css` — section styles (cards, grids, banners)
- `src/client/index.css` — dark theme CSS variables
- `src/client/api.ts` — typed API client functions
- `src/client/main.tsx` — React entry point

**Theme (dark):**
```css
--bg-color: #1a1a2e;
--surface-color: #16213e;
--primary-color: #e94560;
--success-color: #4ade80;
--error-color: #ef4444;
--text-primary: #f8f9fa;
--text-secondary: #a0aec0;
```

**No chart libraries in package.json yet.**

### API Routes (`src/routes/api.ts`)

Protected admin endpoints (behind Cloudflare Access JWT):
- `GET /api/admin/devices` — list pending + paired devices
- `POST /api/admin/gateway/restart` — restart gateway
- `GET /api/admin/storage` — R2 status
- `POST /api/admin/storage/sync` — trigger R2 backup
- `GET /api/admin/acontext/sessions` — recent Acontext sessions
- `POST /api/admin/models/sync` — OpenRouter model sync
- `GET /api/admin/models/check` — compare curated vs live models
- `GET /api/admin/models/catalog` — synced model catalog

### Data Already in R2

**Task Learnings** (`learnings/{userId}/history.json`):
```typescript
interface TaskLearning {
  taskId: string;
  timestamp: number;
  modelAlias: string;
  category: 'web_search' | 'github' | 'data_lookup' | 'chart_gen' | 'code_exec' | 'multi_tool' | 'simple_chat';
  toolsUsed: string[];
  iterations: number;
  durationMs: number;
  success: boolean;
  taskSummary: string;  // first 200 chars of user message
}

interface LearningHistory {
  userId: string;
  learnings: TaskLearning[];  // ring buffer, max 50
  updatedAt: number;
}
```

**Orchestra History** (`orchestra/{userId}/history.json`):
```typescript
interface OrchestraTask {
  taskId: string;
  timestamp: number;
  modelAlias: string;
  repo: string;
  mode: 'init' | 'run' | 'redo';
  prompt: string;
  branchName: string;
  durationMs?: number;
  prUrl?: string;
  status: 'started' | 'completed' | 'failed';
  filesChanged: string[];
  summary?: string;
}
```

**Session Summaries** (`learnings/{userId}/sessions.json`):
```typescript
interface SessionSummary {
  sessionId: string;
  timestamp: number;
  modelAlias: string;
  toolsUsed: string[];
  iterations: number;
  durationMs: number;
  success: boolean;
  taskSummary: string;
  keyDecisions?: string[];
}
```

## Implementation

### Step 1: Add `recharts` dependency

```bash
npm install recharts
```

This is a lightweight, React-native chart library. No other dependencies needed.

### Step 2: Add analytics API endpoints

**File:** `src/routes/api.ts`

Add these new endpoints:

#### `GET /api/admin/analytics/overview`

Aggregates data across all users from R2. Returns:

```typescript
interface AnalyticsOverview {
  totalTasks: number;
  successRate: number;         // 0-100
  avgDurationMs: number;
  tasksByCategory: Record<string, number>;   // { web_search: 12, github: 8, ... }
  tasksByModel: Record<string, number>;      // { deep: 15, flash: 20, ... }
  toolUsage: Record<string, number>;         // { fetch_url: 30, github_read_file: 12, ... }
  recentTasks: Array<{
    timestamp: number;
    model: string;
    category: string;
    success: boolean;
    durationMs: number;
    summary: string;
  }>;
  orchestraTasks: {
    total: number;
    completed: number;
    failed: number;
    byRepo: Record<string, number>;
  };
}
```

**Implementation approach:**
1. List all R2 objects with prefix `learnings/` using `r2.list({ prefix: 'learnings/' })`
2. For each user's `history.json`, aggregate the learnings
3. List all R2 objects with prefix `orchestra/` for orchestra stats
4. Return combined analytics

**Important:** R2 list returns object keys. Use `r2.get(key)` to read each. Cache the result for 60 seconds in a module-level variable to avoid repeated R2 reads on dashboard refresh.

```typescript
let analyticsCache: { data: AnalyticsOverview; expiresAt: number } | null = null;
const ANALYTICS_CACHE_TTL = 60_000; // 60 seconds

app.get('/api/admin/analytics/overview', accessMiddleware, async (c) => {
  const now = Date.now();
  if (analyticsCache && now < analyticsCache.expiresAt) {
    return c.json(analyticsCache.data);
  }

  const r2 = c.env.MOLTBOT_DATA;
  // ... aggregate data ...

  analyticsCache = { data: result, expiresAt: now + ANALYTICS_CACHE_TTL };
  return c.json(result);
});
```

#### `GET /api/admin/analytics/orchestra`

Returns detailed orchestra task history:

```typescript
interface OrchestraAnalytics {
  tasks: Array<{
    taskId: string;
    timestamp: number;
    repo: string;
    mode: string;
    status: string;
    model: string;
    durationMs?: number;
    prUrl?: string;
    summary?: string;
    filesChanged: string[];
  }>;
  repoStats: Record<string, { total: number; completed: number; failed: number }>;
}
```

### Step 3: Add analytics page component

**New file:** `src/client/pages/AnalyticsPage.tsx`

Create a dashboard with these sections:

#### 3a. Summary Cards Row

Four stat cards at the top:
- Total Tasks (number)
- Success Rate (percentage, green/red coloring)
- Avg Duration (formatted as "Xs" or "Xm")
- Orchestra Tasks (completed/total)

```tsx
<div className="stats-row">
  <div className="stat-card">
    <span className="stat-value">{overview.totalTasks}</span>
    <span className="stat-label">Total Tasks</span>
  </div>
  {/* ... */}
</div>
```

#### 3b. Tasks by Category (Bar Chart)

Horizontal bar chart showing task count per category.

```tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const categoryData = Object.entries(overview.tasksByCategory)
  .map(([name, value]) => ({ name, value }))
  .sort((a, b) => b.value - a.value);

<ResponsiveContainer width="100%" height={300}>
  <BarChart data={categoryData} layout="vertical">
    <XAxis type="number" />
    <YAxis type="category" dataKey="name" width={100} />
    <Tooltip />
    <Bar dataKey="value" fill="var(--primary-color)" />
  </BarChart>
</ResponsiveContainer>
```

#### 3c. Model Usage (Pie or Bar Chart)

Show which models are used most.

#### 3d. Tool Usage (Top 10 Bar Chart)

Horizontal bar chart of most-used tools.

#### 3e. Recent Tasks Table

Table with columns: Time, Model, Category, Status (✓/✗), Duration, Summary.

```tsx
<table className="tasks-table">
  <thead>
    <tr><th>Time</th><th>Model</th><th>Category</th><th>Status</th><th>Duration</th><th>Summary</th></tr>
  </thead>
  <tbody>
    {overview.recentTasks.map(task => (
      <tr key={task.timestamp}>
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
```

#### 3f. Orchestra Timeline

List of orchestra tasks with status indicators, repo links, PR links, and duration.

### Step 4: Add CSS

**New file:** `src/client/pages/AnalyticsPage.css`

Use existing CSS variable theme. Key styles needed:

```css
.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.stat-card {
  background: var(--surface-color);
  border-radius: 8px;
  padding: 1.5rem;
  text-align: center;
}

.stat-value {
  font-size: 2rem;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-label {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin-top: 0.25rem;
}

.chart-section {
  background: var(--surface-color);
  border-radius: 8px;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.chart-section h3 {
  color: var(--text-primary);
  margin-bottom: 1rem;
}

.tasks-table {
  width: 100%;
  border-collapse: collapse;
}

.tasks-table th, .tasks-table td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.tasks-table th {
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.85rem;
}
```

### Step 5: Wire into App router

**File:** `src/client/App.tsx`

Add route for the analytics page:

```tsx
import AnalyticsPage from './pages/AnalyticsPage';

// In the router/rendering logic, add:
// Route: /_admin/analytics -> <AnalyticsPage />
```

Add a navigation link/tab in the header or sidebar to navigate between Admin and Analytics pages.

### Step 6: Add API client function

**File:** `src/client/api.ts`

```typescript
export async function fetchAnalyticsOverview(): Promise<AnalyticsOverview> {
  const res = await fetch('/api/admin/analytics/overview');
  if (!res.ok) throw new Error(`Analytics API error: ${res.status}`);
  return res.json();
}

export async function fetchOrchestraAnalytics(): Promise<OrchestraAnalytics> {
  const res = await fetch('/api/admin/analytics/orchestra');
  if (!res.ok) throw new Error(`Orchestra analytics API error: ${res.status}`);
  return res.json();
}
```

## Key Files

| File | Change |
|------|--------|
| `package.json` | Add `recharts` dependency |
| `src/routes/api.ts` | Add `/api/admin/analytics/overview` and `/api/admin/analytics/orchestra` endpoints |
| `src/client/pages/AnalyticsPage.tsx` | **NEW** — analytics dashboard component |
| `src/client/pages/AnalyticsPage.css` | **NEW** — analytics dashboard styles |
| `src/client/api.ts` | Add `fetchAnalyticsOverview()` and `fetchOrchestraAnalytics()` functions |
| `src/client/App.tsx` | Add route + nav link for analytics page |

## Constraints

- **Do NOT modify** existing admin page functionality (device pairing, gateway, etc.)
- **Do NOT add** authentication — Cloudflare Access middleware is already applied to `/api/admin/*` routes
- **Use existing CSS variables** — match the dark theme already defined in `index.css`
- **R2 bucket binding** is `c.env.MOLTBOT_DATA` (type `R2Bucket`)
- **Keep it simple** — no time-series database, no WebSocket live updates, just aggregate data from R2 on request with a 60s cache

## Validation

```bash
npm install                                        # Install recharts
npm run build                                      # Verify client + worker build
npm test -- --reporter=verbose 2>&1 | tail -20     # All tests pass
npm run typecheck                                   # Type check
```

## Definition of Done

- [ ] `GET /api/admin/analytics/overview` returns aggregated task + orchestra stats
- [ ] `GET /api/admin/analytics/orchestra` returns detailed orchestra history
- [ ] Analytics page renders: summary cards, category chart, model chart, tool chart, recent tasks table, orchestra timeline
- [ ] Navigation between Admin and Analytics pages works
- [ ] 60-second cache on analytics endpoints
- [ ] Uses existing dark theme CSS variables
- [ ] Build succeeds, all existing tests pass, typecheck clean
