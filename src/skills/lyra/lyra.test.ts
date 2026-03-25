/**
 * Tests for Lyra skill handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLyra, LYRA_META } from './lyra';
import type { SkillRequest } from '../types';
import type { MoltbotEnv } from '../../types';

// Mock the LLM helper
vi.mock('../llm', () => ({
  callSkillLLM: vi.fn(),
  selectSkillModel: vi.fn((_req, def) => def),
}));

// Mock the skill-tools helper
vi.mock('../skill-tools', () => ({
  executeSkillTool: vi.fn(),
  buildSkillToolContext: vi.fn(() => ({})),
}));

// Mock storage
vi.mock('../../storage/lyra', () => ({
  saveDraft: vi.fn(),
  loadDraft: vi.fn(),
}));

import { callSkillLLM } from '../llm';
import { executeSkillTool } from '../skill-tools';
import { loadDraft } from '../../storage/lyra';

const mockCallLLM = vi.mocked(callSkillLLM);
const mockExecTool = vi.mocked(executeSkillTool);
const mockLoadDraft = vi.mocked(loadDraft);

function makeRequest(overrides?: Partial<SkillRequest>): SkillRequest {
  return {
    skillId: 'lyra',
    subcommand: 'write',
    text: 'AI and productivity',
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
});

describe('handleLyra', () => {
  it('returns error for unknown subcommand', async () => {
    const result = await handleLyra(makeRequest({ subcommand: 'unknown' }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Unknown Lyra subcommand');
  });
});

describe('/write', () => {
  it('generates a draft and returns it', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify({ content: 'Great draft about AI', quality: 4, tone: 'professional' }),
      tokens: { prompt: 100, completion: 50 },
    });

    const result = await handleLyra(makeRequest());
    expect(result.kind).toBe('draft');
    expect(result.body).toBe('Great draft about AI');
    expect(result.telemetry.llmCalls).toBe(1);
    expect(result.telemetry.model).toBe('flash');
  });

  it('returns error when text is empty', async () => {
    const result = await handleLyra(makeRequest({ text: '' }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Please provide a topic');
  });

  it('passes --for flag as platform to LLM', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify({ content: 'Twitter post', quality: 4 }),
    });

    await handleLyra(makeRequest({ flags: { for: 'twitter' } }));
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining('Target platform: twitter'),
      }),
    );
  });

  it('triggers revision pass when quality < 3', async () => {
    mockCallLLM
      .mockResolvedValueOnce({
        text: JSON.stringify({ content: 'Weak draft', quality: 2, qualityNote: 'needs work' }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ content: 'Improved draft', quality: 4 }),
      });

    const result = await handleLyra(makeRequest());
    expect(result.body).toBe('Improved draft');
    expect(result.telemetry.llmCalls).toBe(2);
  });

  it('handles non-JSON LLM response gracefully', async () => {
    mockCallLLM.mockResolvedValue({ text: 'Just plain text response' });

    const result = await handleLyra(makeRequest());
    expect(result.kind).toBe('draft');
    expect(result.body).toBe('Just plain text response');
  });
});

describe('/rewrite', () => {
  it('rewrites the last draft', async () => {
    mockLoadDraft.mockResolvedValue({
      content: 'Original draft',
      quality: 3,
      createdAt: new Date().toISOString(),
      command: 'write',
    });
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify({ content: 'Rewritten draft', quality: 4 }),
    });

    const result = await handleLyra(makeRequest({ subcommand: 'rewrite', text: 'make it shorter' }));
    expect(result.kind).toBe('draft');
    expect(result.body).toBe('Rewritten draft');
  });

  it('returns error when no previous draft exists', async () => {
    mockLoadDraft.mockResolvedValue(null);

    const result = await handleLyra(makeRequest({ subcommand: 'rewrite', text: '' }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('No previous draft');
  });

  it('builds instruction from flags', async () => {
    mockLoadDraft.mockResolvedValue({
      content: 'Original',
      quality: 3,
      createdAt: new Date().toISOString(),
      command: 'write',
    });
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify({ content: 'Shorter draft', quality: 4 }),
    });

    await handleLyra(makeRequest({ subcommand: 'rewrite', text: '', flags: { shorter: 'true', formal: 'true' } }));
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining('shorter and more concise'),
      }),
    );
  });
});

describe('/headline', () => {
  it('generates 5 headline variants', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify({
        variants: [
          { headline: 'H1', commentary: 'C1' },
          { headline: 'H2', commentary: 'C2' },
          { headline: 'H3', commentary: 'C3' },
          { headline: 'H4', commentary: 'C4' },
          { headline: 'H5', commentary: 'C5' },
        ],
      }),
    });

    const result = await handleLyra(makeRequest({ subcommand: 'headline', text: 'AI trends' }));
    expect(result.kind).toBe('headlines');
    expect(result.body).toContain('H1');
    expect(result.body).toContain('C1');
    expect(result.body).toContain('H5');
  });

  it('returns error when text is empty', async () => {
    const result = await handleLyra(makeRequest({ subcommand: 'headline', text: '' }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Please provide a topic');
  });
});

describe('/repurpose', () => {
  it('fetches URL and adapts content', async () => {
    mockExecTool.mockResolvedValue({
      tool_call_id: 'test',
      role: 'tool',
      content: 'Article about AI productivity in the workplace...',
    });
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify({ content: 'AI is changing how we work! #AI #productivity', quality: 4, platform: 'twitter' }),
    });

    const result = await handleLyra(makeRequest({
      subcommand: 'repurpose',
      text: 'https://example.com/article',
      flags: { for: 'twitter' },
    }));
    expect(result.kind).toBe('repurpose');
    expect(result.body).toContain('AI');
    expect(result.telemetry.toolCalls).toBe(1);
  });

  it('returns error when no platform specified', async () => {
    const result = await handleLyra(makeRequest({ subcommand: 'repurpose', text: 'https://example.com', flags: {} }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Please specify a target platform');
  });

  it('returns error when no URL/content provided', async () => {
    const result = await handleLyra(makeRequest({ subcommand: 'repurpose', text: '', flags: { for: 'twitter' } }));
    expect(result.kind).toBe('error');
    expect(result.body).toContain('Please provide a URL');
  });

  it('works with plain text input (no URL fetch)', async () => {
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify({ content: 'Adapted content', quality: 4, platform: 'linkedin' }),
    });

    const result = await handleLyra(makeRequest({
      subcommand: 'repurpose',
      text: 'Here is my blog post about AI...',
      flags: { for: 'linkedin' },
    }));
    expect(result.kind).toBe('repurpose');
    expect(mockExecTool).not.toHaveBeenCalled(); // No URL fetch
    expect(result.telemetry.toolCalls).toBe(0);
  });
});

describe('/write headline ideas (parser regression)', () => {
  it('does not misparse "headline" as a subcommand', async () => {
    // This tests that the command-map parser sends "headline ideas for X"
    // as text to /write, not as subcommand "headline".
    // The actual parser test is in command-map.test.ts.
    // Here we verify the handler receives and processes it correctly.
    mockCallLLM.mockResolvedValue({
      text: JSON.stringify({ content: 'Draft about headline ideas', quality: 4 }),
    });

    const result = await handleLyra(makeRequest({ subcommand: 'write', text: 'headline ideas for my blog' }));
    expect(result.kind).toBe('draft');
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining('headline ideas for my blog'),
      }),
    );
  });
});
