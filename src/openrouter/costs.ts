/**
 * Token/cost tracking for OpenRouter API usage
 *
 * Parses model pricing from cost strings, calculates per-request costs,
 * and maintains per-user daily usage accumulation.
 */

import { getModel, type ModelInfo } from './models';

/**
 * Parsed pricing for a model (per million tokens)
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Token usage from a single API call
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** DeepSeek prefix cache hit tokens (charged at ~10% of input rate) */
  cacheHitTokens?: number;
  /** DeepSeek prefix cache miss tokens (charged at full input rate) */
  cacheMissTokens?: number;
}

/**
 * Accumulated usage record for a user
 */
export interface UsageRecord {
  userId: string;
  date: string; // YYYY-MM-DD
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  requestCount: number;
  byModel: Record<string, {
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    requestCount: number;
  }>;
}

/**
 * Parse a model's cost string into numeric pricing
 *
 * Formats:
 * - "FREE" → { inputPerMillion: 0, outputPerMillion: 0 }
 * - "$0.25/$0.38" → { inputPerMillion: 0.25, outputPerMillion: 0.38 }
 * - "$0.014/megapixel" → null (image gen, not token-based)
 */
export function parseModelPricing(costString: string): ModelPricing | null {
  if (!costString || costString === 'FREE' || costString.includes('FREE')) {
    return { inputPerMillion: 0, outputPerMillion: 0 };
  }

  if (costString.includes('/megapixel')) {
    return null; // Image generation pricing, not token-based
  }

  const match = costString.match(/\$([0-9.]+)\/\$([0-9.]+)/);
  if (match) {
    return {
      inputPerMillion: parseFloat(match[1]),
      outputPerMillion: parseFloat(match[2]),
    };
  }

  return null; // Unknown format
}

/**
 * Calculate cost for a single API call.
 *
 * For DeepSeek direct models, pass cacheHitTokens and cacheMissTokens
 * to get accurate pricing (cache hits are ~10% of input rate).
 */
export function calculateCost(
  modelAlias: string,
  promptTokens: number,
  completionTokens: number,
  cacheInfo?: { cacheHitTokens: number; cacheMissTokens: number }
): TokenUsage {
  const model = getModel(modelAlias);
  const pricing = model ? parseModelPricing(model.cost) : null;

  let costUsd = 0;
  if (pricing) {
    if (cacheInfo && model?.provider === 'deepseek') {
      // DeepSeek prefix caching: cache hits cost ~10% of input rate
      const cacheHitRate = pricing.inputPerMillion * 0.1;
      costUsd = (
        cacheInfo.cacheHitTokens * cacheHitRate +
        cacheInfo.cacheMissTokens * pricing.inputPerMillion +
        completionTokens * pricing.outputPerMillion
      ) / 1_000_000;
    } else {
      costUsd = (promptTokens * pricing.inputPerMillion + completionTokens * pricing.outputPerMillion) / 1_000_000;
    }
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd,
    cacheHitTokens: cacheInfo?.cacheHitTokens,
    cacheMissTokens: cacheInfo?.cacheMissTokens,
  };
}

/**
 * In-memory per-user daily usage store
 * Key: `${userId}:${date}` where date is YYYY-MM-DD
 */
const usageStore: Map<string, UsageRecord> = new Map();

/**
 * Get today's date as YYYY-MM-DD
 */
function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Record token usage for a user
 */
export function recordUsage(
  userId: string,
  modelAlias: string,
  promptTokens: number,
  completionTokens: number,
  cacheInfo?: { cacheHitTokens: number; cacheMissTokens: number }
): TokenUsage {
  const usage = calculateCost(modelAlias, promptTokens, completionTokens, cacheInfo);
  const date = getTodayDate();
  const key = `${userId}:${date}`;

  let record = usageStore.get(key);
  if (!record) {
    record = {
      userId,
      date,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCostUsd: 0,
      requestCount: 0,
      byModel: {},
    };
    usageStore.set(key, record);
  }

  record.totalPromptTokens += usage.promptTokens;
  record.totalCompletionTokens += usage.completionTokens;
  record.totalCostUsd += usage.costUsd;
  record.requestCount += 1;

  if (!record.byModel[modelAlias]) {
    record.byModel[modelAlias] = {
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      requestCount: 0,
    };
  }
  record.byModel[modelAlias].promptTokens += usage.promptTokens;
  record.byModel[modelAlias].completionTokens += usage.completionTokens;
  record.byModel[modelAlias].costUsd += usage.costUsd;
  record.byModel[modelAlias].requestCount += 1;

  return usage;
}

/**
 * Get usage record for a user on a given date
 */
export function getUsage(userId: string, date?: string): UsageRecord | null {
  const d = date || getTodayDate();
  return usageStore.get(`${userId}:${d}`) || null;
}

/**
 * Get usage for multiple days (for /costs week)
 */
export function getUsageRange(userId: string, days: number): UsageRecord[] {
  const records: UsageRecord[] = [];
  const now = new Date();

  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const record = usageStore.get(`${userId}:${dateStr}`);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

/**
 * Format a usage record for display in Telegram
 */
export function formatUsageSummary(record: UsageRecord | null): string {
  if (!record || record.requestCount === 0) {
    return 'No usage recorded today.';
  }

  let output = `📊 Usage for ${record.date}\n`;
  output += `━━━━━━━━━━━━━━━━━━━━\n`;
  output += `Requests: ${record.requestCount}\n`;
  output += `Tokens: ${record.totalPromptTokens.toLocaleString()} in / ${record.totalCompletionTokens.toLocaleString()} out\n`;
  output += `Cost: $${record.totalCostUsd.toFixed(4)}\n`;

  const models = Object.entries(record.byModel)
    .sort((a, b) => b[1].costUsd - a[1].costUsd);

  if (models.length > 0) {
    output += `\nBy model:\n`;
    for (const [alias, data] of models) {
      const tokens = data.promptTokens + data.completionTokens;
      output += `  ${alias}: ${data.requestCount} req, ${tokens.toLocaleString()} tokens, $${data.costUsd.toFixed(4)}\n`;
    }
  }

  return output;
}

/**
 * Format a multi-day usage summary
 */
export function formatWeekSummary(records: UsageRecord[]): string {
  if (records.length === 0) {
    return 'No usage recorded in the last 7 days.';
  }

  let totalCost = 0;
  let totalRequests = 0;
  let totalTokens = 0;

  let output = '📊 Usage (last 7 days)\n';
  output += '━━━━━━━━━━━━━━━━━━━━\n';

  for (const record of records) {
    const tokens = record.totalPromptTokens + record.totalCompletionTokens;
    output += `${record.date}: ${record.requestCount} req, ${tokens.toLocaleString()} tokens, $${record.totalCostUsd.toFixed(4)}\n`;
    totalCost += record.totalCostUsd;
    totalRequests += record.requestCount;
    totalTokens += tokens;
  }

  output += `━━━━━━━━━━━━━━━━━━━━\n`;
  output += `Total: ${totalRequests} req, ${totalTokens.toLocaleString()} tokens, $${totalCost.toFixed(4)}`;

  return output;
}

/**
 * Format cost as a compact footer string for task responses
 */
export function formatCostFooter(usage: TokenUsage, _modelAlias: string): string {
  const tokens = usage.totalTokens.toLocaleString();
  if (usage.costUsd === 0) {
    return `💰 ${tokens} tokens (free)`;
  }
  // Show cache hit savings when available
  if (usage.cacheHitTokens && usage.cacheHitTokens > 0) {
    const cachePercent = Math.round((usage.cacheHitTokens / (usage.cacheHitTokens + (usage.cacheMissTokens || 0))) * 100);
    return `💰 ${tokens} tokens (~$${usage.costUsd.toFixed(4)}, ${cachePercent}% cache hit)`;
  }
  return `💰 ${tokens} tokens (~$${usage.costUsd.toFixed(4)})`;
}

/**
 * Clear usage store (for testing)
 */
export function clearUsageStore(): void {
  usageStore.clear();
}
