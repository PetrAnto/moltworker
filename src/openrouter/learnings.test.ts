/**
 * Tests for compound learning loop
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  categorizeTask,
  extractLearning,
  storeLearning,
  loadLearnings,
  getRelevantLearnings,
  formatLearningsForPrompt,
  type TaskLearning,
  type LearningHistory,
  type TaskCategory,
} from './learnings';

// --- categorizeTask ---

describe('categorizeTask', () => {
  it('returns simple_chat when no tools used', () => {
    expect(categorizeTask([])).toBe('simple_chat');
  });

  it('categorizes web_search tools', () => {
    expect(categorizeTask(['fetch_url'])).toBe('web_search');
    expect(categorizeTask(['browse_url'])).toBe('web_search');
    expect(categorizeTask(['url_metadata'])).toBe('web_search');
    expect(categorizeTask(['fetch_url', 'browse_url'])).toBe('web_search');
  });

  it('categorizes github tools', () => {
    expect(categorizeTask(['github_read_file'])).toBe('github');
    expect(categorizeTask(['github_list_files', 'github_api'])).toBe('github');
    expect(categorizeTask(['github_create_pr'])).toBe('github');
  });

  it('categorizes data_lookup tools', () => {
    expect(categorizeTask(['get_weather'])).toBe('data_lookup');
    expect(categorizeTask(['get_crypto'])).toBe('data_lookup');
    expect(categorizeTask(['convert_currency'])).toBe('data_lookup');
    expect(categorizeTask(['fetch_news'])).toBe('data_lookup');
    expect(categorizeTask(['geolocate_ip'])).toBe('data_lookup');
  });

  it('categorizes chart_gen tools', () => {
    expect(categorizeTask(['generate_chart'])).toBe('chart_gen');
  });

  it('categorizes code_exec tools', () => {
    expect(categorizeTask(['sandbox_exec'])).toBe('code_exec');
  });

  it('returns dominant category for 2 categories', () => {
    // github used more than web_search
    const result = categorizeTask(['github_read_file', 'github_list_files', 'fetch_url']);
    expect(result).toBe('github');
  });

  it('returns multi_tool for 3+ categories', () => {
    const result = categorizeTask([
      'fetch_url',        // web_search
      'github_read_file', // github
      'get_weather',      // data_lookup
    ]);
    expect(result).toBe('multi_tool');
  });

  it('handles unknown tools gracefully', () => {
    expect(categorizeTask(['unknown_tool'])).toBe('simple_chat');
  });

  it('handles mix of known and unknown tools', () => {
    expect(categorizeTask(['unknown_tool', 'fetch_url'])).toBe('web_search');
  });
});

// --- extractLearning ---

describe('extractLearning', () => {
  it('extracts learning with correct fields', () => {
    const learning = extractLearning({
      taskId: 'user1-12345',
      modelAlias: 'deep',
      toolsUsed: ['fetch_url', 'fetch_url', 'github_read_file'],
      iterations: 5,
      durationMs: 30000,
      success: true,
      userMessage: 'Check the README on github and fetch the homepage',
    });

    expect(learning.taskId).toBe('user1-12345');
    expect(learning.modelAlias).toBe('deep');
    expect(learning.category).toBe('web_search'); // fetch_url used twice
    expect(learning.toolsUsed).toEqual(['fetch_url', 'fetch_url', 'github_read_file']);
    expect(learning.uniqueTools).toEqual(['fetch_url', 'github_read_file']);
    expect(learning.iterations).toBe(5);
    expect(learning.durationMs).toBe(30000);
    expect(learning.success).toBe(true);
    expect(learning.taskSummary).toBe('Check the README on github and fetch the homepage');
    expect(learning.timestamp).toBeGreaterThan(0);
  });

  it('truncates taskSummary to 200 chars', () => {
    const longMessage = 'a'.repeat(300);
    const learning = extractLearning({
      taskId: 'test',
      modelAlias: 'gpt',
      toolsUsed: [],
      iterations: 1,
      durationMs: 1000,
      success: true,
      userMessage: longMessage,
    });

    expect(learning.taskSummary.length).toBe(200);
  });

  it('handles simple chat (no tools)', () => {
    const learning = extractLearning({
      taskId: 'test',
      modelAlias: 'sonnet',
      toolsUsed: [],
      iterations: 1,
      durationMs: 2000,
      success: true,
      userMessage: 'Hello, how are you?',
    });

    expect(learning.category).toBe('simple_chat');
    expect(learning.uniqueTools).toEqual([]);
  });

  it('handles failed task', () => {
    const learning = extractLearning({
      taskId: 'test',
      modelAlias: 'deep',
      toolsUsed: ['fetch_url'],
      iterations: 3,
      durationMs: 45000,
      success: false,
      userMessage: 'Fetch https://example.com',
    });

    expect(learning.success).toBe(false);
    expect(learning.category).toBe('web_search');
  });
});

// --- storeLearning & loadLearnings ---

describe('storeLearning', () => {
  let mockBucket: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockBucket = {
      get: vi.fn(),
      put: vi.fn().mockResolvedValue(undefined),
    };
  });

  const makeLearning = (taskId: string, success: boolean = true): TaskLearning => ({
    taskId,
    timestamp: Date.now(),
    modelAlias: 'deep',
    category: 'web_search',
    toolsUsed: ['fetch_url'],
    uniqueTools: ['fetch_url'],
    iterations: 2,
    durationMs: 5000,
    success,
    taskSummary: `Task ${taskId}`,
  });

  it('creates new history when none exists', async () => {
    mockBucket.get.mockResolvedValue(null);

    await storeLearning(mockBucket as unknown as R2Bucket, 'user1', makeLearning('t1'));

    expect(mockBucket.put).toHaveBeenCalledOnce();
    const [key, data] = mockBucket.put.mock.calls[0];
    expect(key).toBe('learnings/user1/history.json');

    const parsed = JSON.parse(data as string);
    expect(parsed.userId).toBe('user1');
    expect(parsed.learnings).toHaveLength(1);
    expect(parsed.learnings[0].taskId).toBe('t1');
  });

  it('appends to existing history', async () => {
    const existingHistory: LearningHistory = {
      userId: 'user1',
      learnings: [makeLearning('t1')],
      updatedAt: Date.now(),
    };

    mockBucket.get.mockResolvedValue({
      json: () => Promise.resolve(existingHistory),
    });

    await storeLearning(mockBucket as unknown as R2Bucket, 'user1', makeLearning('t2'));

    const [, data] = mockBucket.put.mock.calls[0];
    const parsed = JSON.parse(data as string);
    expect(parsed.learnings).toHaveLength(2);
    expect(parsed.learnings[1].taskId).toBe('t2');
  });

  it('caps history at 50 entries', async () => {
    const existingHistory: LearningHistory = {
      userId: 'user1',
      learnings: Array.from({ length: 50 }, (_, i) => makeLearning(`t${i}`)),
      updatedAt: Date.now(),
    };

    mockBucket.get.mockResolvedValue({
      json: () => Promise.resolve(existingHistory),
    });

    await storeLearning(mockBucket as unknown as R2Bucket, 'user1', makeLearning('t50'));

    const [, data] = mockBucket.put.mock.calls[0];
    const parsed = JSON.parse(data as string);
    expect(parsed.learnings).toHaveLength(50);
    // Oldest should be dropped, newest should be last
    expect(parsed.learnings[49].taskId).toBe('t50');
    expect(parsed.learnings[0].taskId).toBe('t1'); // t0 was dropped
  });

  it('handles R2 read error gracefully', async () => {
    mockBucket.get.mockRejectedValue(new Error('R2 read failed'));

    // Should not throw, should create new history
    await storeLearning(mockBucket as unknown as R2Bucket, 'user1', makeLearning('t1'));

    expect(mockBucket.put).toHaveBeenCalledOnce();
    const [, data] = mockBucket.put.mock.calls[0];
    const parsed = JSON.parse(data as string);
    expect(parsed.learnings).toHaveLength(1);
  });
});

describe('loadLearnings', () => {
  it('returns null when no history exists', async () => {
    const mockBucket = { get: vi.fn().mockResolvedValue(null) };

    const result = await loadLearnings(mockBucket as unknown as R2Bucket, 'user1');
    expect(result).toBeNull();
  });

  it('returns parsed history', async () => {
    const history: LearningHistory = {
      userId: 'user1',
      learnings: [{
        taskId: 't1',
        timestamp: Date.now(),
        modelAlias: 'deep',
        category: 'github',
        toolsUsed: ['github_read_file'],
        uniqueTools: ['github_read_file'],
        iterations: 3,
        durationMs: 10000,
        success: true,
        taskSummary: 'Read the repo',
      }],
      updatedAt: Date.now(),
    };

    const mockBucket = {
      get: vi.fn().mockResolvedValue({
        json: () => Promise.resolve(history),
      }),
    };

    const result = await loadLearnings(mockBucket as unknown as R2Bucket, 'user1');
    expect(result).not.toBeNull();
    expect(result!.learnings).toHaveLength(1);
    expect(result!.learnings[0].taskId).toBe('t1');
  });

  it('handles JSON parse error gracefully', async () => {
    const mockBucket = {
      get: vi.fn().mockResolvedValue({
        json: () => Promise.reject(new Error('Invalid JSON')),
      }),
    };

    const result = await loadLearnings(mockBucket as unknown as R2Bucket, 'user1');
    expect(result).toBeNull();
  });
});

// --- getRelevantLearnings ---

describe('getRelevantLearnings', () => {
  const now = Date.now();

  const makeHistory = (learnings: Partial<TaskLearning>[]): LearningHistory => ({
    userId: 'user1',
    learnings: learnings.map((l, i) => ({
      taskId: `t${i}`,
      timestamp: l.timestamp ?? now - 3600000, // 1 hour ago default
      modelAlias: l.modelAlias ?? 'deep',
      category: l.category ?? 'simple_chat',
      toolsUsed: l.toolsUsed ?? [],
      uniqueTools: l.uniqueTools ?? [],
      iterations: l.iterations ?? 1,
      durationMs: l.durationMs ?? 5000,
      success: l.success ?? true,
      taskSummary: l.taskSummary ?? 'test task',
    })),
    updatedAt: now,
  });

  it('returns empty array for empty history', () => {
    const history = makeHistory([]);
    expect(getRelevantLearnings(history, 'any message')).toEqual([]);
  });

  it('matches by keyword overlap', () => {
    const history = makeHistory([
      { taskSummary: 'check bitcoin price today', category: 'data_lookup' },
      { taskSummary: 'write hello world code', category: 'simple_chat' },
    ]);

    const result = getRelevantLearnings(history, 'what is the bitcoin price');
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].taskSummary).toContain('bitcoin');
  });

  it('matches by category hints', () => {
    const history = makeHistory([
      { taskSummary: 'some weather task', category: 'data_lookup', uniqueTools: ['get_weather'] },
      { taskSummary: 'unrelated task', category: 'simple_chat' },
    ]);

    const result = getRelevantLearnings(history, 'weather forecast for Prague');
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].category).toBe('data_lookup');
  });

  it('prefers recent learnings', () => {
    const history = makeHistory([
      { taskSummary: 'check weather old', category: 'data_lookup', timestamp: now - 7 * 86400000 }, // 7 days ago
      { taskSummary: 'check weather new', category: 'data_lookup', timestamp: now - 3600000 }, // 1 hour ago
    ]);

    const result = getRelevantLearnings(history, 'weather forecast');
    expect(result.length).toBe(2);
    // More recent should rank higher
    expect(result[0].taskSummary).toContain('new');
  });

  it('prefers successful learnings', () => {
    const history = makeHistory([
      { taskSummary: 'fetch github readme', category: 'github', success: false },
      { taskSummary: 'fetch github readme', category: 'github', success: true },
    ]);

    const result = getRelevantLearnings(history, 'read github readme');
    expect(result.length).toBe(2);
    expect(result[0].success).toBe(true);
  });

  it('filters out irrelevant learnings (score = 0)', () => {
    const history = makeHistory([
      { taskSummary: 'analyze quantum physics paper', category: 'simple_chat' },
    ]);

    const result = getRelevantLearnings(history, 'weather in Paris');
    expect(result).toEqual([]);
  });

  it('limits results to specified count', () => {
    const history = makeHistory(
      Array.from({ length: 20 }, (_, i) => ({
        taskSummary: `weather task number ${i}`,
        category: 'data_lookup' as TaskCategory,
      }))
    );

    const result = getRelevantLearnings(history, 'weather forecast', 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('handles github keyword matching', () => {
    const history = makeHistory([
      { taskSummary: 'read the github repo files', category: 'github', uniqueTools: ['github_read_file'] },
    ]);

    const result = getRelevantLearnings(history, 'show me the github repository structure');
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].category).toBe('github');
  });
});

// --- formatLearningsForPrompt ---

describe('formatLearningsForPrompt', () => {
  it('returns empty string for no learnings', () => {
    expect(formatLearningsForPrompt([])).toBe('');
  });

  it('formats single learning correctly', () => {
    const learnings: TaskLearning[] = [{
      taskId: 't1',
      timestamp: Date.now(),
      modelAlias: 'deep',
      category: 'web_search',
      toolsUsed: ['fetch_url'],
      uniqueTools: ['fetch_url'],
      iterations: 3,
      durationMs: 12000,
      success: true,
      taskSummary: 'Fetch the homepage of example.com',
    }];

    const result = formatLearningsForPrompt(learnings);
    expect(result).toContain('Past task patterns');
    expect(result).toContain('Fetch the homepage');
    expect(result).toContain('OK');
    expect(result).toContain('3 iters');
    expect(result).toContain('fetch_url');
    expect(result).toContain('12s');
  });

  it('formats failed learning with FAILED label', () => {
    const learnings: TaskLearning[] = [{
      taskId: 't1',
      timestamp: Date.now(),
      modelAlias: 'gpt',
      category: 'github',
      toolsUsed: ['github_read_file'],
      uniqueTools: ['github_read_file'],
      iterations: 5,
      durationMs: 90000,
      success: false,
      taskSummary: 'Read large repository',
    }];

    const result = formatLearningsForPrompt(learnings);
    expect(result).toContain('FAILED');
    expect(result).toContain('2min'); // 90000ms = 1.5min, rounds to 2
  });

  it('formats multiple learnings', () => {
    const learnings: TaskLearning[] = [
      {
        taskId: 't1',
        timestamp: Date.now(),
        modelAlias: 'deep',
        category: 'data_lookup',
        toolsUsed: ['get_weather'],
        uniqueTools: ['get_weather'],
        iterations: 2,
        durationMs: 8000,
        success: true,
        taskSummary: 'Weather in Prague',
      },
      {
        taskId: 't2',
        timestamp: Date.now(),
        modelAlias: 'gpt',
        category: 'github',
        toolsUsed: ['github_read_file', 'github_list_files'],
        uniqueTools: ['github_read_file', 'github_list_files'],
        iterations: 4,
        durationMs: 20000,
        success: true,
        taskSummary: 'Analyze repo structure',
      },
    ];

    const result = formatLearningsForPrompt(learnings);
    const lines = result.split('\n').filter(l => l.startsWith('- "'));
    expect(lines).toHaveLength(2);
  });

  it('truncates long task summaries to 80 chars', () => {
    const learnings: TaskLearning[] = [{
      taskId: 't1',
      timestamp: Date.now(),
      modelAlias: 'deep',
      category: 'simple_chat',
      toolsUsed: [],
      uniqueTools: [],
      iterations: 1,
      durationMs: 2000,
      success: true,
      taskSummary: 'A'.repeat(200),
    }];

    const result = formatLearningsForPrompt(learnings);
    // The summary in the prompt line should be truncated
    const summaryMatch = result.match(/"(A+)"/);
    expect(summaryMatch).toBeTruthy();
    expect(summaryMatch![1].length).toBe(80);
  });

  it('shows "none" for tools when no tools used', () => {
    const learnings: TaskLearning[] = [{
      taskId: 't1',
      timestamp: Date.now(),
      modelAlias: 'gpt',
      category: 'simple_chat',
      toolsUsed: [],
      uniqueTools: [],
      iterations: 1,
      durationMs: 3000,
      success: true,
      taskSummary: 'Hello world',
    }];

    const result = formatLearningsForPrompt(learnings);
    expect(result).toContain('tools:[none]');
  });

  it('includes strategy hint at the end', () => {
    const learnings: TaskLearning[] = [{
      taskId: 't1',
      timestamp: Date.now(),
      modelAlias: 'deep',
      category: 'web_search',
      toolsUsed: ['fetch_url'],
      uniqueTools: ['fetch_url'],
      iterations: 2,
      durationMs: 5000,
      success: true,
      taskSummary: 'Fetch page',
    }];

    const result = formatLearningsForPrompt(learnings);
    expect(result).toContain('Use similar tool strategies');
  });
});
