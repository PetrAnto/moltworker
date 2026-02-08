/**
 * Tests for token/cost tracking
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseModelPricing,
  calculateCost,
  recordUsage,
  getUsage,
  getUsageRange,
  formatUsageSummary,
  formatWeekSummary,
  formatCostFooter,
  clearUsageStore,
  type TokenUsage,
  type UsageRecord,
} from './costs';

describe('parseModelPricing', () => {
  it('parses FREE as zero pricing', () => {
    const pricing = parseModelPricing('FREE');
    expect(pricing).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
  });

  it('parses cost strings with FREE anywhere', () => {
    const pricing = parseModelPricing('FREE (limited)');
    expect(pricing).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
  });

  it('parses standard input/output pricing', () => {
    const pricing = parseModelPricing('$0.25/$0.38');
    expect(pricing).toEqual({ inputPerMillion: 0.25, outputPerMillion: 0.38 });
  });

  it('parses higher-cost model pricing', () => {
    const pricing = parseModelPricing('$3.00/$15.00');
    expect(pricing).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });

  it('returns null for image gen pricing', () => {
    const pricing = parseModelPricing('$0.014/megapixel');
    expect(pricing).toBeNull();
  });

  it('returns null for empty string', () => {
    const pricing = parseModelPricing('');
    expect(pricing).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
  });

  it('returns null for unknown format', () => {
    const pricing = parseModelPricing('custom pricing');
    expect(pricing).toBeNull();
  });
});

describe('calculateCost', () => {
  it('calculates cost for a known model', () => {
    // 'gpt' model exists — cost depends on model catalog
    const usage = calculateCost('gpt', 1000, 500);
    expect(usage.promptTokens).toBe(1000);
    expect(usage.completionTokens).toBe(500);
    expect(usage.totalTokens).toBe(1500);
    expect(typeof usage.costUsd).toBe('number');
  });

  it('returns zero cost for free models', () => {
    // 'deepfree' is a free model
    const usage = calculateCost('deepfree', 5000, 3000);
    expect(usage.promptTokens).toBe(5000);
    expect(usage.completionTokens).toBe(3000);
    expect(usage.totalTokens).toBe(8000);
    expect(usage.costUsd).toBe(0);
  });

  it('returns zero cost for unknown models', () => {
    const usage = calculateCost('nonexistent-model-xyz', 1000, 500);
    expect(usage.costUsd).toBe(0);
    expect(usage.totalTokens).toBe(1500);
  });

  it('handles zero tokens', () => {
    const usage = calculateCost('gpt', 0, 0);
    expect(usage.costUsd).toBe(0);
    expect(usage.totalTokens).toBe(0);
  });
});

describe('recordUsage and getUsage', () => {
  beforeEach(() => {
    clearUsageStore();
  });

  it('records and retrieves usage for a user', () => {
    recordUsage('user1', 'gpt', 1000, 500);
    const record = getUsage('user1');
    expect(record).not.toBeNull();
    expect(record!.userId).toBe('user1');
    expect(record!.requestCount).toBe(1);
    expect(record!.totalPromptTokens).toBe(1000);
    expect(record!.totalCompletionTokens).toBe(500);
  });

  it('accumulates multiple requests', () => {
    recordUsage('user1', 'gpt', 1000, 500);
    recordUsage('user1', 'gpt', 2000, 1000);
    const record = getUsage('user1');
    expect(record!.requestCount).toBe(2);
    expect(record!.totalPromptTokens).toBe(3000);
    expect(record!.totalCompletionTokens).toBe(1500);
  });

  it('tracks by-model breakdown', () => {
    recordUsage('user1', 'gpt', 1000, 500);
    recordUsage('user1', 'sonnet', 2000, 1000);
    const record = getUsage('user1');
    expect(record!.byModel['gpt']).toBeDefined();
    expect(record!.byModel['gpt'].requestCount).toBe(1);
    expect(record!.byModel['sonnet']).toBeDefined();
    expect(record!.byModel['sonnet'].requestCount).toBe(1);
  });

  it('returns null for users with no usage', () => {
    const record = getUsage('unknown-user');
    expect(record).toBeNull();
  });

  it('separates different users', () => {
    recordUsage('user1', 'gpt', 1000, 500);
    recordUsage('user2', 'gpt', 2000, 1000);
    const r1 = getUsage('user1');
    const r2 = getUsage('user2');
    expect(r1!.totalPromptTokens).toBe(1000);
    expect(r2!.totalPromptTokens).toBe(2000);
  });
});

describe('getUsageRange', () => {
  beforeEach(() => {
    clearUsageStore();
  });

  it('returns empty array when no usage exists', () => {
    const records = getUsageRange('user1', 7);
    expect(records).toEqual([]);
  });

  it('includes today in the range', () => {
    recordUsage('user1', 'gpt', 1000, 500);
    const records = getUsageRange('user1', 7);
    expect(records.length).toBe(1);
    expect(records[0].userId).toBe('user1');
  });
});

describe('formatUsageSummary', () => {
  it('shows no usage message for null record', () => {
    const output = formatUsageSummary(null);
    expect(output).toBe('No usage recorded today.');
  });

  it('shows no usage message for zero-request record', () => {
    const record: UsageRecord = {
      userId: 'user1',
      date: '2026-02-08',
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCostUsd: 0,
      requestCount: 0,
      byModel: {},
    };
    const output = formatUsageSummary(record);
    expect(output).toBe('No usage recorded today.');
  });

  it('formats a valid usage record', () => {
    clearUsageStore();
    recordUsage('user1', 'gpt', 1000, 500);
    const record = getUsage('user1');
    const output = formatUsageSummary(record);
    expect(output).toContain('Usage for');
    expect(output).toContain('Requests: 1');
    expect(output).toContain('Tokens:');
    expect(output).toContain('Cost:');
    expect(output).toContain('gpt');
  });
});

describe('formatWeekSummary', () => {
  it('shows no usage message for empty records', () => {
    const output = formatWeekSummary([]);
    expect(output).toBe('No usage recorded in the last 7 days.');
  });

  it('formats multi-day summary', () => {
    const records: UsageRecord[] = [
      {
        userId: 'user1',
        date: '2026-02-08',
        totalPromptTokens: 5000,
        totalCompletionTokens: 2000,
        totalCostUsd: 0.005,
        requestCount: 3,
        byModel: {},
      },
      {
        userId: 'user1',
        date: '2026-02-07',
        totalPromptTokens: 3000,
        totalCompletionTokens: 1000,
        totalCostUsd: 0.003,
        requestCount: 2,
        byModel: {},
      },
    ];
    const output = formatWeekSummary(records);
    expect(output).toContain('Usage (last 7 days)');
    expect(output).toContain('2026-02-08');
    expect(output).toContain('2026-02-07');
    expect(output).toContain('Total: 5 req');
  });
});

describe('formatCostFooter', () => {
  it('shows free for zero-cost usage', () => {
    const usage: TokenUsage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, costUsd: 0 };
    const footer = formatCostFooter(usage, 'deepfree');
    expect(footer).toContain('free');
    expect(footer).toContain('1,500');
  });

  it('shows cost for paid usage', () => {
    const usage: TokenUsage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, costUsd: 0.0025 };
    const footer = formatCostFooter(usage, 'gpt');
    expect(footer).toContain('$0.0025');
    expect(footer).toContain('1,500');
  });
});

describe('clearUsageStore', () => {
  it('clears all usage data', () => {
    recordUsage('user1', 'gpt', 1000, 500);
    expect(getUsage('user1')).not.toBeNull();
    clearUsageStore();
    expect(getUsage('user1')).toBeNull();
  });
});
