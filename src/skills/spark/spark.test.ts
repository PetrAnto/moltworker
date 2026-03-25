/**
 * Tests for Spark skill handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSpark, SPARK_META } from './spark';
import type { SkillRequest } from '../types';
import type { MoltbotEnv } from '../../types';

// Mock LLM
vi.mock('../llm', () => ({
  callSkillLLM: vi.fn(),
  selectSkillModel: vi.fn((_req, def) => def),
}));

// Mock skill-tools
vi.mock('../skill-tools', () => ({
  executeSkillTool: vi.fn(),
  buildSkillToolContext: vi.fn(() => ({})),
}));

// Mock storage
vi.mock('../../storage/spark', () => ({
  saveSparkItem: vi.fn(),
  listSparkItems: vi.fn().mockResolvedValue([]),
  getSparkItem: vi.fn(),
  deleteSparkItem: vi.fn(),
  countSparkItems: vi.fn().mockResolvedValue(0),
}));

import { callSkillLLM } from '../llm';
import { executeSkillTool } from '../skill-tools';
import { listSparkItems, saveSparkItem } from '../../storage/spark';

const mockCallLLM = vi.mocked(callSkillLLM);
const mockExecTool = vi.mocked(executeSkillTool);
const mockListItems = vi.mocked(listSparkItems);
const mockSaveItem = vi.mocked(saveSparkItem);

function makeRequest(overrides?: Partial<SkillRequest>): SkillRequest {
  return {
    skillId: 'spark',
    subcommand: 'save',
    text: 'Build an AI writing tool',
    flags: {},
    transport: 'telegram',
    userId: '123',
    env: {
      MOLTBOT_BUCKET: {} as R2Bucket,
      OPENROUTER_API_KEY: 'test-key',
    } as unknown as MoltbotEnv,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListItems.mockResolvedValue([]);
});

describe('handleSpark routing', () => {
  it('returns error for unknown subcommand', async () => {
    const result = await handleSpark(makeRequest({ subcommand: 'unknown' }));
    expect(result.kind).toBe('error');
  });
});

describe('/save', () => {
  it('saves an idea and returns ack', async () => {
    const result = await handleSpark(makeRequest());
    expect(result.kind).toBe('capture_ack');
    expect(result.body).toContain('Saved');
    expect(mockSaveItem).toHaveBeenCalled();
  });

  it('returns error when text is empty', async () => {
    const result = await handleSpark(makeRequest({ text: '' }));
    expect(result.kind).toBe('error');
  });

  it('extracts URL and fetches metadata', async () => {
    mockExecTool.mockResolvedValue({
      tool_call_id: 'test',
      role: 'tool',
      content: 'Title: Great Article | Description: About AI',
    });

    const result = await handleSpark(makeRequest({ text: 'Check this out https://example.com/article' }));
    expect(result.kind).toBe('capture_ack');
    expect(mockExecTool).toHaveBeenCalled();
    expect(result.telemetry.toolCalls).toBe(1);
  });
});

describe('/spark', () => {
  it('returns quick reaction', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify({ reaction: 'Love it!', angle: 'B2B SaaS', nextStep: 'Build MVP' }),
    });

    const result = await handleSpark(makeRequest({ subcommand: 'spark', text: 'AI writing tool' }));
    expect(result.kind).toBe('text');
    expect(result.body).toContain('Love it!');
    expect(result.telemetry.llmCalls).toBe(1);
  });

  it('returns error when text is empty', async () => {
    const result = await handleSpark(makeRequest({ subcommand: 'spark', text: '' }));
    expect(result.kind).toBe('error');
  });
});

describe('/gauntlet', () => {
  it('runs full gauntlet evaluation', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify({
        idea: 'AI writing tool',
        stages: [
          { name: 'Feasibility', score: 4, assessment: 'Very feasible' },
          { name: 'Originality', score: 3, assessment: 'Competitive space' },
          { name: 'Impact', score: 4, assessment: 'High value' },
          { name: 'Market', score: 5, assessment: 'Strong demand' },
          { name: 'Clarity', score: 4, assessment: 'Well defined' },
          { name: 'Timing', score: 4, assessment: 'Perfect timing' },
        ],
        verdict: 'Go — strong across the board',
        overallScore: 4.0,
      }),
    });

    const result = await handleSpark(makeRequest({ subcommand: 'gauntlet', text: 'AI writing tool' }));
    expect(result.kind).toBe('gauntlet');
    expect(result.body).toContain('Feasibility');
    expect(result.body).toContain('4.0/5');
    expect(result.body).toContain('Go');
  });

  it('returns error when text is empty', async () => {
    const result = await handleSpark(makeRequest({ subcommand: 'gauntlet', text: '' }));
    expect(result.kind).toBe('error');
  });
});

describe('/brainstorm', () => {
  it('returns error when inbox is empty', async () => {
    mockListItems.mockResolvedValue([]);
    const result = await handleSpark(makeRequest({ subcommand: 'brainstorm', text: '' }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('empty');
  });

  it('returns error when inbox has < 2 items', async () => {
    mockListItems.mockResolvedValue([
      { id: '1', text: 'Solo idea', createdAt: '2026-03-25' },
    ]);
    const result = await handleSpark(makeRequest({ subcommand: 'brainstorm', text: '' }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('at least 2');
  });

  it('clusters items when inbox has enough', async () => {
    mockListItems.mockResolvedValue([
      { id: '1', text: 'AI writing tool', createdAt: '2026-03-25' },
      { id: '2', text: 'AI code review', createdAt: '2026-03-25' },
      { id: '3', text: 'Fitness tracker app', createdAt: '2026-03-25' },
    ]);
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify({
        clusters: [
          { theme: 'AI Tools', itemIds: ['1', '2'], insight: 'Both leverage AI', challenge: 'Can they combine?' },
          { theme: 'Health', itemIds: ['3'], insight: 'Different domain', challenge: 'Can AI help here too?' },
        ],
        synthesis: 'AI is the common thread',
      }),
    });

    const result = await handleSpark(makeRequest({ subcommand: 'brainstorm', text: '' }));
    expect(result.kind).toBe('digest');
    expect(result.body).toContain('AI Tools');
    expect(result.body).toContain('Synthesis');
  });

});

describe('/ideas (list inbox)', () => {
  it('shows empty inbox message', async () => {
    mockListItems.mockResolvedValue([]);
    const result = await handleSpark(makeRequest({ subcommand: 'list' }));
    expect(result.kind).toBe('digest');
    expect(result.body).toContain('empty');
  });

  it('lists inbox items', async () => {
    mockListItems.mockResolvedValue([
      { id: '1', text: 'Build an AI tool', createdAt: '2026-03-25T10:00:00Z' },
      { id: '2', text: 'Research market', url: 'https://example.com', createdAt: '2026-03-24T10:00:00Z' },
    ]);
    const result = await handleSpark(makeRequest({ subcommand: 'list' }));
    expect(result.kind).toBe('digest');
    expect(result.body).toContain('Ideas Inbox (2)');
    expect(result.body).toContain('Build an AI tool');
    expect(result.body).toContain('[link]');
  });
});
