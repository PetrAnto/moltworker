/**
 * Model Health Check — /ping-models
 *
 * Sends a tiny probe ("Say hi") to active models in parallel and reports
 * latency, failures, and auto-marks degraded/rate-limited models.
 */

import { getModel, getAllModels, type ModelInfo, getModelId, getProvider, PROVIDERS, isDirectApi } from './models';

export interface ModelHealthResult {
  alias: string;
  name: string;
  status: 'healthy' | 'slow' | 'failed';
  latencyMs?: number;
  error?: string;
}

export interface HealthReport {
  results: ModelHealthResult[];
  durationMs: number;
  healthy: ModelHealthResult[];
  slow: ModelHealthResult[];
  failed: ModelHealthResult[];
}

const SLOW_THRESHOLD_MS = 5000;
const PING_TIMEOUT_MS = 15000;

/**
 * Ping a single model with a tiny request.
 */
async function pingModel(model: ModelInfo, openrouterKey: string, env?: Record<string, string | undefined>): Promise<ModelHealthResult> {
  const start = Date.now();
  const modelId = getModelId(model.alias);
  if (!modelId) {
    return { alias: model.alias, name: model.name, status: 'failed', error: 'Unknown model ID' };
  }

  // Determine endpoint and auth
  let url: string;
  let headers: Record<string, string>;

  if (model.provider && model.provider !== 'openrouter') {
    const providerConfig = PROVIDERS[model.provider];
    if (!providerConfig) {
      return { alias: model.alias, name: model.name, status: 'failed', error: `Unknown provider: ${model.provider}` };
    }
    const apiKey = env?.[providerConfig.envKey];
    if (!apiKey) {
      return { alias: model.alias, name: model.name, status: 'failed', error: `Missing ${providerConfig.envKey}` };
    }

    if (model.provider === 'anthropic') {
      url = providerConfig.baseUrl;
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      };
    } else {
      url = providerConfig.baseUrl;
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };
    }
  } else {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterKey}`,
    };
  }

  // Build minimal request body
  let body: string;
  if (model.provider === 'anthropic') {
    body = JSON.stringify({
      model: modelId,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say hi' }],
    });
  } else {
    body = JSON.stringify({
      model: modelId,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say hi' }],
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      const statusText = response.status === 429 ? '429 Rate Limited'
        : response.status === 408 ? '408 Request Timeout'
        : `${response.status} ${response.statusText}`;
      return { alias: model.alias, name: model.name, status: 'failed', latencyMs, error: statusText };
    }

    // Read response to complete the request
    await response.text();

    if (latencyMs > SLOW_THRESHOLD_MS) {
      return { alias: model.alias, name: model.name, status: 'slow', latencyMs };
    }

    return { alias: model.alias, name: model.name, status: 'healthy', latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errMsg = err instanceof Error
      ? (err.name === 'AbortError' ? 'Timeout (15s)' : err.message)
      : String(err);
    return { alias: model.alias, name: model.name, status: 'failed', latencyMs, error: errMsg };
  }
}

/**
 * Ping all active models in parallel and return a health report.
 *
 * @param openrouterKey - OpenRouter API key
 * @param env - Environment variables (for direct API keys)
 * @param modelAliases - Optional list of aliases to ping (defaults to all curated + recent)
 */
export async function pingAllModels(
  openrouterKey: string,
  env?: Record<string, string | undefined>,
  modelAliases?: string[],
): Promise<HealthReport> {
  const start = Date.now();

  // Get models to ping
  let models: ModelInfo[];
  if (modelAliases) {
    models = modelAliases.map(a => getModel(a)).filter((m): m is ModelInfo => !!m);
  } else {
    // Default: all curated chat models (not media-gen)
    models = Object.values(getAllModels()).filter(m =>
      !m.isImageGen && !m.isVideoGen && m.alias !== 'auto'
    );
    // Cap at 20 to stay within time limits
    models = models.slice(0, 20);
  }

  // Ping all in parallel
  const results = await Promise.all(
    models.map(m => pingModel(m, openrouterKey, env))
  );

  const durationMs = Date.now() - start;

  return {
    results,
    durationMs,
    healthy: results.filter(r => r.status === 'healthy'),
    slow: results.filter(r => r.status === 'slow'),
    failed: results.filter(r => r.status === 'failed'),
  };
}

/**
 * Format a health report for Telegram display.
 */
export function formatHealthReport(report: HealthReport): string {
  const lines: string[] = [];
  const total = report.results.length;

  lines.push(`🏓 Model Health (${total} models, ${(report.durationMs / 1000).toFixed(1)}s)\n`);

  if (report.healthy.length > 0) {
    lines.push(`✅ Healthy (${report.healthy.length}):`);
    const healthyLines = report.healthy
      .sort((a, b) => (a.latencyMs || 0) - (b.latencyMs || 0))
      .map(r => `/${r.alias} ${r.latencyMs}ms`);
    // Group into lines of 3 for compactness
    for (let i = 0; i < healthyLines.length; i += 3) {
      lines.push('  ' + healthyLines.slice(i, i + 3).join(' · '));
    }
    lines.push('');
  }

  if (report.slow.length > 0) {
    lines.push(`⚠️ Slow (>${SLOW_THRESHOLD_MS / 1000}s) (${report.slow.length}):`);
    for (const r of report.slow) {
      lines.push(`  /${r.alias} ${((r.latencyMs || 0) / 1000).toFixed(1)}s — works but slow`);
    }
    lines.push('');
  }

  if (report.failed.length > 0) {
    lines.push(`❌ Failed (${report.failed.length}):`);
    for (const r of report.failed) {
      lines.push(`  /${r.alias} — ${r.error || 'unknown error'}`);
    }
    lines.push('');
  }

  if (report.failed.length === 0 && report.slow.length === 0) {
    lines.push('All models responding normally.');
  }

  return lines.join('\n');
}
