// API client for admin endpoints
// Authentication is handled by Cloudflare Access (JWT in cookies)

const API_BASE = '/api/admin';

export interface PendingDevice {
  requestId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  ts: number;
}

export interface PairedDevice {
  deviceId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  createdAtMs: number;
  approvedAtMs: number;
}

export interface DeviceListResponse {
  pending: PendingDevice[];
  paired: PairedDevice[];
  raw?: string;
  stderr?: string;
  parseError?: string;
  error?: string;
}

export interface ApproveResponse {
  success: boolean;
  requestId: string;
  message?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface ApproveAllResponse {
  approved: string[];
  failed: Array<{ requestId: string; success: boolean; error?: string }>;
  message?: string;
  error?: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

async function apiRequest<T>(path: string, options: globalThis.RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  } as globalThis.RequestInit);

  if (response.status === 401) {
    throw new AuthError('Unauthorized - please log in via Cloudflare Access');
  }

  const data = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(data.error || `API error: ${response.status}`);
  }

  return data;
}

export async function listDevices(): Promise<DeviceListResponse> {
  return apiRequest<DeviceListResponse>('/devices');
}

export async function approveDevice(requestId: string): Promise<ApproveResponse> {
  return apiRequest<ApproveResponse>(`/devices/${requestId}/approve`, {
    method: 'POST',
  });
}

export async function approveAllDevices(): Promise<ApproveAllResponse> {
  return apiRequest<ApproveAllResponse>('/devices/approve-all', {
    method: 'POST',
  });
}

export interface RestartGatewayResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export async function restartGateway(): Promise<RestartGatewayResponse> {
  return apiRequest<RestartGatewayResponse>('/gateway/restart', {
    method: 'POST',
  });
}

export interface StorageStatusResponse {
  configured: boolean;
  missing?: string[];
  lastSync: string | null;
  message: string;
}

export async function getStorageStatus(): Promise<StorageStatusResponse> {
  return apiRequest<StorageStatusResponse>('/storage');
}

export interface SyncResponse {
  success: boolean;
  message?: string;
  lastSync?: string;
  error?: string;
  details?: string;
}

export async function triggerSync(): Promise<SyncResponse> {
  return apiRequest<SyncResponse>('/storage/sync', {
    method: 'POST',
  });
}

export interface AcontextSessionInfo {
  id: string;
  model: string;
  prompt: string;
  toolsUsed: number;
  success: boolean | null;
  createdAt: string;
}

export interface AcontextSessionsResponse {
  items: AcontextSessionInfo[];
  configured: boolean;
}

export async function getAcontextSessions(): Promise<AcontextSessionsResponse> {
  return apiRequest<AcontextSessionsResponse>('/acontext/sessions');
}

export interface AnalyticsOverview {
  totalTasks: number;
  successRate: number;
  avgDurationMs: number;
  tasksByCategory: Record<string, number>;
  tasksByModel: Record<string, number>;
  toolUsage: Record<string, number>;
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

export interface OrchestraAnalytics {
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

export async function fetchAnalyticsOverview(): Promise<AnalyticsOverview> {
  return apiRequest<AnalyticsOverview>('/analytics/overview');
}

export async function fetchOrchestraAnalytics(): Promise<OrchestraAnalytics> {
  return apiRequest<OrchestraAnalytics>('/analytics/orchestra');
}

// ---------------------------------------------------------------------------
// Audit admin tab (Phase 1, Slice B)
// ---------------------------------------------------------------------------

export interface AuditSubscriptionRow {
  userId: string;
  owner: string;
  repo: string;
  transport: 'telegram';
  chatId: number;
  branch?: string;
  lens?: string;
  depth: 'quick' | 'standard' | 'deep';
  interval: 'daily' | 'weekly';
  createdAt: string;
  lastRunAt: string | null;
  lastTaskId: string | null; // TaskProcessor task id of latest dispatch
  lastRunId: string | null; // AuditRun.runId — populated by completion writeback
  dispatchStartedAt?: string;
}

export interface AuditRunRow {
  userId: string;
  runId: string;
  owner: string;
  repo: string;
  sha: string;
  lenses: string[];
  depth: string;
  findings: number;
  costUsd: number;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  createdAtMs: number | null;
}

export interface AuditSuppressionRow {
  userId: string;
  owner: string;
  repo: string;
  findingId: string;
  at: string | null;
}

export interface AuditOverviewResponse {
  subscriptions: AuditSubscriptionRow[];
  recentRuns: AuditRunRow[];
  suppressions: AuditSuppressionRow[];
  /** Per-section truncation flags. The server caps each scan to keep
   *  admin-endpoint KV reads bounded; when a cap fires the UI can
   *  surface a "showing first N of …" hint to the operator. */
  truncated: {
    subscriptions: boolean;
    recentRuns: boolean;
    suppressions: boolean;
  };
}

export interface FetchAuditOverviewOptions {
  /** Max number of recent runs to materialize. Server clamps to 1-100. */
  limit?: number;
  /** Max number of suppression entries. Server clamps to 1-500. */
  suppressionLimit?: number;
}

export async function fetchAuditOverview(
  optsOrLimit: FetchAuditOverviewOptions | number = {},
): Promise<AuditOverviewResponse> {
  const opts: FetchAuditOverviewOptions =
    typeof optsOrLimit === 'number' ? { limit: optsOrLimit } : optsOrLimit;
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.suppressionLimit !== undefined) {
    params.set('suppressionLimit', String(opts.suppressionLimit));
  }
  const qs = params.toString();
  return apiRequest<AuditOverviewResponse>(`/audit/overview${qs ? `?${qs}` : ''}`);
}

export async function deleteAuditSubscription(
  userId: string,
  owner: string,
  repo: string,
): Promise<{ removed: boolean }> {
  return apiRequest<{ removed: boolean }>(
    `/audit/subscriptions/${encodeURIComponent(userId)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { method: 'DELETE' },
  );
}

export async function deleteAuditSuppression(
  userId: string,
  owner: string,
  repo: string,
  findingId: string,
): Promise<{ removed: boolean; total: number }> {
  return apiRequest<{ removed: boolean; total: number }>(
    `/audit/suppressions/${encodeURIComponent(userId)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(findingId)}`,
    { method: 'DELETE' },
  );
}
