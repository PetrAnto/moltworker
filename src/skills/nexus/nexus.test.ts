/**
 * Tests for Nexus skill handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleNexus, NEXUS_META } from './nexus';
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

// Mock cache
vi.mock('./cache', () => ({
  getCachedDossier: vi.fn().mockResolvedValue(null),
  cacheDossier: vi.fn().mockResolvedValue(undefined),
}));

import { callSkillLLM } from '../llm';
import { executeSkillTool } from '../skill-tools';
import { getCachedDossier } from './cache';

const mockCallLLM = vi.mocked(callSkillLLM);
const mockExecTool = vi.mocked(executeSkillTool);
const mockGetCached = vi.mocked(getCachedDossier);

function makeRequest(overrides?: Partial<SkillRequest>): SkillRequest {
  return {
    skillId: 'nexus',
    subcommand: 'research',
    text: 'AI trends 2026',
    flags: {},
    transport: 'telegram',
    userId: '123',
    env: {
      MOLTBOT_BUCKET: {} as R2Bucket,
      OPENROUTER_API_KEY: 'test-key',
      NEXUS_KV: {} as KVNamespace,
    } as unknown as MoltbotEnv,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCached.mockResolvedValue(null);
});

// Setup standard LLM responses for the 2-call flow (classify + synthesize)
function setupStandardMocks() {
  // Call 1: classify
  mockCallLLM.mockResolvedValueOnce({
    text: JSON.stringify({ category: 'topic', sources: ['webSearch', 'wikipedia'] }),
  });
  // Source fetches succeed
  mockExecTool.mockResolvedValue({
    tool_call_id: 'test',
    role: 'tool',
    content: 'Source data about AI trends...',
  });
  // Call 2: synthesize
  mockCallLLM.mockResolvedValueOnce({
    text: JSON.stringify({ synthesis: 'AI is evolving rapidly across multiple fronts.' }),
    tokens: { prompt: 500, completion: 200 },
  });
}

describe('handleNexus routing', () => {
  it('returns error for empty query', async () => {
    const result = await handleNexus(makeRequest({ text: '' }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Please provide a topic');
  });
});

describe('/research (quick mode)', () => {
  it('classifies, fetches sources, and synthesizes', async () => {
    setupStandardMocks();

    const result = await handleNexus(makeRequest());
    expect(result.kind).toBe('dossier');
    expect(result.body).toContain('AI is evolving');
    expect(result.telemetry.llmCalls).toBe(2); // classify + synthesize
    expect(result.telemetry.toolCalls).toBeGreaterThan(0);
  });

  it('returns cached dossier on cache hit', async () => {
    mockGetCached.mockResolvedValue({
      query: 'AI trends 2026',
      mode: 'quick',
      synthesis: 'Cached analysis',
      evidence: [{ source: 'Web', data: 'stuff', confidence: 'high' }],
      createdAt: '2026-03-25',
    });

    const result = await handleNexus(makeRequest());
    expect(result.kind).toBe('dossier');
    expect(result.body).toContain('Cached analysis');
    expect(result.telemetry.llmCalls).toBe(0); // No LLM calls on cache hit
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('falls back to webSearch when classification fails', async () => {
    mockCallLLM
      .mockResolvedValueOnce({ text: 'invalid json' })
      .mockResolvedValueOnce({
        text: JSON.stringify({ synthesis: 'Fallback synthesis' }),
      });
    mockExecTool.mockResolvedValue({
      tool_call_id: 'test',
      role: 'tool',
      content: 'Web search results...',
    });

    const result = await handleNexus(makeRequest());
    expect(result.kind).toBe('dossier');
    expect(result.body).toContain('Fallback synthesis');
  });
});

describe('/research --decision', () => {
  it('produces decision analysis with pros/cons/risks', async () => {
    mockCallLLM
      .mockResolvedValueOnce({
        text: JSON.stringify({ category: 'decision', sources: ['webSearch'] }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          synthesis: 'Balanced analysis',
          decision: {
            pros: ['Fast to market'],
            cons: ['High competition'],
            risks: ['Regulatory changes'],
            recommendation: 'Proceed with caution',
          },
        }),
      });
    mockExecTool.mockResolvedValue({
      tool_call_id: 'test', role: 'tool', content: 'Decision data...',
    });

    const result = await handleNexus(makeRequest({ flags: { decision: 'true' } }));
    expect(result.kind).toBe('dossier');
    expect(result.body).toContain('Pros:');
    expect(result.body).toContain('Fast to market');
    expect(result.body).toContain('Cons:');
    expect(result.body).toContain('Risks:');
    expect(result.body).toContain('Proceed with caution');
  });

  it('skips cache for decision mode (always fresh)', async () => {
    setupStandardMocks();

    await handleNexus(makeRequest({ flags: { decision: 'true' } }));
    expect(mockGetCached).not.toHaveBeenCalled();
  });
});

describe('/dossier', () => {
  it('runs as enhanced research mode', async () => {
    setupStandardMocks();

    const result = await handleNexus(makeRequest({ subcommand: 'dossier', text: 'OpenAI' }));
    expect(result.kind).toBe('dossier');
    expect(result.telemetry.llmCalls).toBe(2);
  });
});

describe('graceful degradation', () => {
  it('returns error when all sources fail', async () => {
    mockCallLLM.mockResolvedValueOnce({
      text: JSON.stringify({ category: 'topic', sources: ['webSearch'] }),
    });
    mockExecTool.mockResolvedValue({
      tool_call_id: 'test', role: 'tool', content: 'Error: source unavailable',
    });

    const result = await handleNexus(makeRequest());
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Could not retrieve');
  });
});

describe('/dossier DO dispatch (S3.7)', () => {
  it('dispatches to DO when Telegram + TASK_PROCESSOR available', async () => {
    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'started', taskId: 'test-id' }))),
    };
    const mockTaskProcessor = {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(mockStub),
    };

    const result = await handleNexus(makeRequest({
      subcommand: 'dossier',
      text: 'OpenAI company',
      transport: 'telegram',
      chatId: 123,
      context: { telegramToken: 'tg-token' },
      env: {
        MOLTBOT_BUCKET: {} as R2Bucket,
        OPENROUTER_API_KEY: 'test-key',
        NEXUS_KV: {} as KVNamespace,
        TASK_PROCESSOR: mockTaskProcessor,
      } as unknown as MoltbotEnv,
    }));

    // Should return "in progress" immediately
    expect(result.kind).toBe('text');
    expect(result.body).toContain('Deep research started');
    expect(result.body).toContain('OpenAI company');
    expect((result.data as Record<string, unknown>).async).toBe(true);

    // Should have dispatched to the DO
    expect(mockTaskProcessor.idFromName).toHaveBeenCalled();
    expect(mockStub.fetch).toHaveBeenCalledWith(
      'https://do/process',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('falls back to inline when TASK_PROCESSOR missing', async () => {
    setupStandardMocks();

    const result = await handleNexus(makeRequest({
      subcommand: 'dossier',
      text: 'OpenAI',
      transport: 'telegram',
      env: {
        MOLTBOT_BUCKET: {} as R2Bucket,
        OPENROUTER_API_KEY: 'test-key',
        NEXUS_KV: {} as KVNamespace,
        // No TASK_PROCESSOR
      } as unknown as MoltbotEnv,
    }));

    // Should run inline (not "in progress")
    expect(result.kind).toBe('dossier');
    expect(result.telemetry.llmCalls).toBe(2);
  });

  it('falls back to inline when transport is not telegram', async () => {
    setupStandardMocks();

    const result = await handleNexus(makeRequest({
      subcommand: 'dossier',
      text: 'OpenAI',
      transport: 'api',
      env: {
        MOLTBOT_BUCKET: {} as R2Bucket,
        OPENROUTER_API_KEY: 'test-key',
        NEXUS_KV: {} as KVNamespace,
        TASK_PROCESSOR: { idFromName: vi.fn(), get: vi.fn() },
      } as unknown as MoltbotEnv,
    }));

    // Should run inline
    expect(result.kind).toBe('dossier');
  });

  it('falls back to inline when DO dispatch fails', async () => {
    setupStandardMocks();

    const mockStub = {
      fetch: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    };

    const result = await handleNexus(makeRequest({
      subcommand: 'dossier',
      text: 'OpenAI',
      transport: 'telegram',
      chatId: 123,
      env: {
        MOLTBOT_BUCKET: {} as R2Bucket,
        OPENROUTER_API_KEY: 'test-key',
        NEXUS_KV: {} as KVNamespace,
        TASK_PROCESSOR: {
          idFromName: vi.fn().mockReturnValue('do-id'),
          get: vi.fn().mockReturnValue(mockStub),
        },
      } as unknown as MoltbotEnv,
    }));

    // Should fall back to inline
    expect(result.kind).toBe('dossier');
    expect(result.telemetry.llmCalls).toBe(2);
  });
});
