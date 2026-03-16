import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess, syncToR2, waitForProcess } from '../gateway';
import { createAcontextClient } from '../acontext/client';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;
const ANALYTICS_CACHE_TTL_MS = 60_000;

interface TaskLearning {
  timestamp: number;
  modelAlias: string;
  category: string;
  toolsUsed: string[];
  durationMs: number;
  success: boolean;
  taskSummary: string;
}

interface LearningHistory {
  learnings?: TaskLearning[];
}

interface OrchestraTask {
  taskId: string;
  timestamp: number;
  modelAlias: string;
  repo: string;
  mode: string;
  durationMs?: number;
  prUrl?: string;
  status: string;
  filesChanged?: string[];
  summary?: string;
}

interface OrchestraHistory {
  tasks?: OrchestraTask[];
}

interface AnalyticsOverview {
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

interface AnalyticsCacheEntry<T> {
  data: T;
  expiresAt: number;
}

let analyticsOverviewCache: AnalyticsCacheEntry<AnalyticsOverview> | null = null;
let analyticsOrchestraCache: AnalyticsCacheEntry<OrchestraAnalytics> | null = null;

/** Build --token arg for openclaw CLI commands (required when gateway uses token auth) */
function tokenArg(env: { MOLTBOT_GATEWAY_TOKEN?: string }): string {
  return env.MOLTBOT_GATEWAY_TOKEN ? ` --token ${env.MOLTBOT_GATEWAY_TOKEN}` : '';
}

function incrementCounter(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] || 0) + 1;
}

async function listR2KeysByPrefix(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await bucket.list({ prefix, cursor });
    keys.push(...result.objects.map((obj) => obj.key));
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return keys;
}

async function readR2Json<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }

  try {
    return (await object.json()) as T;
  } catch {
    return null;
  }
}

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 * 
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run OpenClaw CLI to list devices
    // Must specify --url to connect to the gateway running in the same container
    const proc = await sandbox.startProcess(`openclaw devices list --json --url ws://localhost:18789${tokenArg(c.env)}`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: 'Failed to parse CLI output',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run OpenClaw CLI to approve the device
    const proc = await sandbox.startProcess(`openclaw devices approve ${requestId} --url ws://localhost:18789${tokenArg(c.env)}`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved') || proc.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // First, get the list of pending devices
    const listProc = await sandbox.startProcess(`openclaw devices list --json --url ws://localhost:18789${tokenArg(c.env)}`);
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        const approveProc = await sandbox.startProcess(`openclaw devices approve ${device.requestId} --url ws://localhost:18789${tokenArg(c.env)}`);
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        const approveLogs = await approveProc.getLogs();
        const success = approveLogs.stdout?.toLowerCase().includes('approved') || approveProc.exitCode === 0;

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter(r => r.success).length;
    return c.json({
      approved: results.filter(r => r.success).map(r => r.requestId),
      failed: results.filter(r => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get('/storage', async (c) => {
  const sandbox = c.get('sandbox');
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID && 
    c.env.R2_SECRET_ACCESS_KEY && 
    c.env.CF_ACCOUNT_ID
  );

  // Check which credentials are missing
  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');

  let lastSync: string | null = null;

  // If R2 is configured, check for last sync timestamp
  if (hasCredentials) {
    try {
      const result = await sandbox.exec('cat /tmp/.last-sync 2>/dev/null || echo ""');
      const timestamp = result.stdout?.trim();
      if (timestamp && timestamp !== '') {
        lastSync = timestamp;
      }
    } catch {
      // Ignore errors checking sync status
    }
  }

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastSync,
    message: hasCredentials 
      ? 'R2 storage is configured. Your data will persist across container restarts.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
adminApi.post('/storage/sync', async (c) => {
  const sandbox = c.get('sandbox');
  
  const result = await syncToR2(sandbox, c.env);
  
  if (result.success) {
    return c.json({
      success: true,
      message: 'Sync completed successfully',
      lastSync: result.lastSync,
    });
  } else {
    const status = result.error?.includes('not configured') ? 400 : 500;
    return c.json({
      success: false,
      error: result.error,
      details: result.details,
    }, status);
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Find and kill the existing gateway process
    const existingProcess = await findExistingMoltbotProcess(sandbox);
    
    if (existingProcess) {
      console.log('Killing existing gateway process:', existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error('Error killing process:', killErr);
      }
      // Wait a moment for the process to die
      await new Promise(r => setTimeout(r, 2000));
    }

    // Start a new gateway in the background
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
      console.error('Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: existingProcess 
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: existingProcess?.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/acontext/sessions - List recent Acontext task sessions
adminApi.get('/acontext/sessions', async (c) => {
  const client = createAcontextClient(c.env.ACONTEXT_API_KEY, c.env.ACONTEXT_BASE_URL);

  if (!client) {
    return c.json({
      items: [],
      configured: false,
    });
  }

  try {
    const sessions = await client.listSessions({ limit: 10, timeDesc: true });

    return c.json({
      configured: true,
      items: sessions.items.map((session) => {
        const configs = session.configs || {};
        const model = typeof configs.model === 'string' ? configs.model : 'unknown';
        const prompt = typeof configs.prompt === 'string' ? configs.prompt : '';
        const toolsUsed = typeof configs.toolsUsed === 'number' ? configs.toolsUsed : 0;
        const success = typeof configs.success === 'boolean' ? configs.success : null;

        return {
          id: session.id,
          model,
          prompt,
          toolsUsed,
          success,
          createdAt: session.created_at,
        };
      }),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/models/sync — Trigger a full model catalog sync from OpenRouter
adminApi.post('/models/sync', async (c) => {
  if (!c.env.OPENROUTER_API_KEY) {
    return c.json({ error: 'OPENROUTER_API_KEY not configured' }, 400);
  }

  try {
    const { runFullSync } = await import('../openrouter/model-sync/sync');
    const result = await runFullSync(c.env.MOLTBOT_BUCKET, c.env.OPENROUTER_API_KEY);
    return c.json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/models/check — Compare curated models against live OpenRouter catalog
adminApi.get('/models/check', async (c) => {
  if (!c.env.OPENROUTER_API_KEY) {
    return c.json({ error: 'OPENROUTER_API_KEY not configured' }, 400);
  }

  try {
    const { runSyncCheck } = await import('../openrouter/model-sync/synccheck');
    const result = await runSyncCheck(c.env.OPENROUTER_API_KEY);
    return c.json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/models/catalog — Get the current auto-synced model catalog
adminApi.get('/models/catalog', async (c) => {
  try {
    const { loadCatalog } = await import('../openrouter/model-sync/sync');
    const catalog = await loadCatalog(c.env.MOLTBOT_BUCKET);

    if (!catalog) {
      return c.json({
        synced: false,
        message: 'No auto-sync has been performed yet. Trigger one with POST /api/admin/models/sync',
      });
    }

    const tier = c.req.query('tier'); // 'free', 'paid', 'all' (default)
    const capability = c.req.query('capability'); // 'tools', 'vision', 'reasoning'

    let models = Object.values(catalog.models);

    // Filter by tier
    if (tier === 'free') {
      models = models.filter(m => m.isFree);
    } else if (tier === 'paid') {
      models = models.filter(m => !m.isFree);
    }

    // Filter by capability
    if (capability === 'tools') {
      models = models.filter(m => m.supportsTools);
    } else if (capability === 'vision') {
      models = models.filter(m => m.supportsVision);
    } else if (capability === 'reasoning') {
      models = models.filter(m => m.reasoning && m.reasoning !== 'none');
    }

    const stale = Object.entries(catalog.deprecations)
      .filter(([, d]) => d.state === 'stale' || d.state === 'deprecated')
      .map(([id, d]) => ({ id, ...d }));

    return c.json({
      synced: true,
      syncedAt: new Date(catalog.syncedAt).toISOString(),
      totalFetched: catalog.totalFetched,
      totalSynced: Object.keys(catalog.models).length,
      modelsReturned: models.length,
      staleCount: stale.length,
      models: models.map(m => ({
        alias: m.alias,
        id: m.id,
        name: m.name,
        cost: m.cost,
        tools: !!m.supportsTools,
        vision: !!m.supportsVision,
        reasoning: m.reasoning || 'none',
        maxContext: m.maxContext,
        isFree: !!m.isFree,
      })),
      stale,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/analytics/overview - Aggregate analytics from R2
adminApi.get('/analytics/overview', async (c) => {
  const now = Date.now();
  if (analyticsOverviewCache && now < analyticsOverviewCache.expiresAt) {
    return c.json(analyticsOverviewCache.data);
  }

  try {
    const bucket = c.env.MOLTBOT_BUCKET;
    const learningKeys = (await listR2KeysByPrefix(bucket, 'learnings/'))
      .filter((key) => key.endsWith('/history.json'));

    const allLearnings: TaskLearning[] = [];
    for (const key of learningKeys) {
      const history = await readR2Json<LearningHistory>(bucket, key);
      if (history?.learnings?.length) {
        allLearnings.push(...history.learnings);
      }
    }

    const tasksByCategory: Record<string, number> = {};
    const tasksByModel: Record<string, number> = {};
    const toolUsage: Record<string, number> = {};

    let totalDurationMs = 0;
    let successCount = 0;

    for (const learning of allLearnings) {
      incrementCounter(tasksByCategory, learning.category || 'unknown');
      incrementCounter(tasksByModel, learning.modelAlias || 'unknown');
      totalDurationMs += learning.durationMs || 0;

      if (learning.success) {
        successCount += 1;
      }

      for (const toolName of learning.toolsUsed || []) {
        incrementCounter(toolUsage, toolName || 'unknown');
      }
    }

    const orchestraByRepo: Record<string, number> = {};
    let orchestraTotal = 0;
    let orchestraCompleted = 0;
    let orchestraFailed = 0;

    const orchestraKeys = (await listR2KeysByPrefix(bucket, 'orchestra/'))
      .filter((key) => key.endsWith('/history.json'));

    for (const key of orchestraKeys) {
      const history = await readR2Json<OrchestraHistory>(bucket, key);
      const tasks = history?.tasks || [];

      for (const task of tasks) {
        orchestraTotal += 1;
        incrementCounter(orchestraByRepo, task.repo || 'unknown');

        if (task.status === 'completed') {
          orchestraCompleted += 1;
        } else if (task.status === 'failed') {
          orchestraFailed += 1;
        }
      }
    }

    const recentTasks = allLearnings
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20)
      .map((task) => ({
        timestamp: task.timestamp,
        model: task.modelAlias || 'unknown',
        category: task.category || 'unknown',
        success: !!task.success,
        durationMs: task.durationMs || 0,
        summary: task.taskSummary || '',
      }));

    const data: AnalyticsOverview = {
      totalTasks: allLearnings.length,
      successRate: allLearnings.length > 0 ? (successCount / allLearnings.length) * 100 : 0,
      avgDurationMs: allLearnings.length > 0 ? totalDurationMs / allLearnings.length : 0,
      tasksByCategory,
      tasksByModel,
      toolUsage,
      recentTasks,
      orchestraTasks: {
        total: orchestraTotal,
        completed: orchestraCompleted,
        failed: orchestraFailed,
        byRepo: orchestraByRepo,
      },
    };

    analyticsOverviewCache = { data, expiresAt: now + ANALYTICS_CACHE_TTL_MS };
    return c.json(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/analytics/orchestra - Detailed orchestra task history
adminApi.get('/analytics/orchestra', async (c) => {
  const now = Date.now();
  if (analyticsOrchestraCache && now < analyticsOrchestraCache.expiresAt) {
    return c.json(analyticsOrchestraCache.data);
  }

  try {
    const bucket = c.env.MOLTBOT_BUCKET;
    const orchestraKeys = (await listR2KeysByPrefix(bucket, 'orchestra/'))
      .filter((key) => key.endsWith('/history.json'));

    const tasks: OrchestraAnalytics['tasks'] = [];
    const repoStats: OrchestraAnalytics['repoStats'] = {};

    for (const key of orchestraKeys) {
      const history = await readR2Json<OrchestraHistory>(bucket, key);
      const historyTasks = history?.tasks || [];

      for (const task of historyTasks) {
        const repo = task.repo || 'unknown';
        if (!repoStats[repo]) {
          repoStats[repo] = { total: 0, completed: 0, failed: 0 };
        }

        repoStats[repo].total += 1;
        if (task.status === 'completed') {
          repoStats[repo].completed += 1;
        }
        if (task.status === 'failed') {
          repoStats[repo].failed += 1;
        }

        tasks.push({
          taskId: task.taskId,
          timestamp: task.timestamp,
          repo,
          mode: task.mode,
          status: task.status,
          model: task.modelAlias || 'unknown',
          durationMs: task.durationMs,
          prUrl: task.prUrl,
          summary: task.summary,
          filesChanged: task.filesChanged || [],
        });
      }
    }

    tasks.sort((a, b) => b.timestamp - a.timestamp);

    const data: OrchestraAnalytics = { tasks, repoStats };
    analyticsOrchestraCache = { data, expiresAt: now + ANALYTICS_CACHE_TTL_MS };
    return c.json(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
