/**
 * Tests for Gecko Skills — Runtime
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSkill } from './runtime';
import { registerSkill, getSkillHandler } from './registry';
import type { SkillRequest, SkillResult, SkillMeta, SkillHandler } from './types';
import type { MoltbotEnv } from '../types';

// Mock env
const mockEnv = {
  MOLTBOT_BUCKET: {
    get: vi.fn().mockResolvedValue(null),
  },
  OPENROUTER_API_KEY: 'test-key',
} as unknown as MoltbotEnv;

function makeRequest(overrides?: Partial<SkillRequest>): SkillRequest {
  return {
    skillId: 'orchestra',
    subcommand: 'status',
    text: '',
    flags: {},
    transport: 'telegram',
    userId: '123',
    env: mockEnv,
    ...overrides,
  };
}

describe('runSkill', () => {
  beforeEach(() => {
    // Register a test handler
    const testMeta: SkillMeta = {
      id: 'orchestra',
      name: 'Test Orchestra',
      description: 'Test',
      defaultModel: 'flash',
      subcommands: ['status'],
    };
    const testHandler: SkillHandler = async (req) => ({
      skillId: req.skillId,
      kind: 'text',
      body: `Handled: ${req.subcommand}`,
      telemetry: { durationMs: 0, model: 'flash', llmCalls: 0, toolCalls: 0 },
    });
    registerSkill(testMeta, testHandler);
  });

  it('executes registered handler', async () => {
    const result = await runSkill(makeRequest());
    expect(result.kind).toBe('text');
    expect(result.body).toBe('Handled: status');
    expect(result.telemetry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns error for unknown skill', async () => {
    const result = await runSkill(makeRequest({ skillId: 'nexus' as 'orchestra' }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Unknown skill');
  });

  it('catches handler errors and returns error result', async () => {
    const errorMeta: SkillMeta = {
      id: 'lyra',
      name: 'Error Lyra',
      description: 'Test',
      defaultModel: 'flash',
      subcommands: ['write'],
    };
    registerSkill(errorMeta, async () => {
      throw new Error('LLM timeout');
    });

    const result = await runSkill(makeRequest({ skillId: 'lyra' }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('LLM timeout');
    expect(result.telemetry.durationMs).toBeGreaterThanOrEqual(0);
  });
});
