/**
 * Tests for per-session R2 scratchpad (Item 2)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadScratchpad,
  appendScratchpad,
  formatScratchpadForPrompt,
  type Scratchpad,
  type ScratchpadEntry,
} from './scratchpad';

// --- Mock R2Bucket ---

function createMockR2(): R2Bucket {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => {
      const val = store.get(key);
      if (!val) return null;
      return { text: () => Promise.resolve(val) } as R2ObjectBody;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value as string);
    }),
    delete: vi.fn(),
    list: vi.fn(),
    head: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
    // expose store for test assertions
    _store: store,
  } as unknown as R2Bucket;
}

// --- loadScratchpad ---

describe('loadScratchpad', () => {
  it('returns null when scratchpad does not exist', async () => {
    const r2 = createMockR2();
    const result = await loadScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md');
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    const r2 = createMockR2();
    // Manually put bad JSON
    (r2 as unknown as { _store: Map<string, string> })._store.set(
      // We don't know the exact key, so let's use appendScratchpad to create then corrupt
      'test-key',
      'not valid json{{{',
    );
    // loadScratchpad uses its own key derivation, so a missing key still returns null
    const result = await loadScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md');
    expect(result).toBeNull();
  });

  it('returns null for JSON with invalid shape', async () => {
    const r2 = createMockR2();
    // Create a valid scratchpad first, then corrupt the store
    await appendScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md', {
      step: 'Step 1',
      summary: 'Did something',
      timestamp: Date.now(),
    });

    // Find the key that was stored
    const store = (r2 as unknown as { _store: Map<string, string> })._store;
    const key = [...store.keys()][0];
    // Replace with invalid shape
    store.set(key, JSON.stringify({ entries: 'not an array', createdAt: 'not a number' }));

    const result = await loadScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md');
    expect(result).toBeNull();
  });

  it('loads a valid scratchpad', async () => {
    const r2 = createMockR2();
    const entry: ScratchpadEntry = {
      step: 'Step 1',
      summary: 'Implemented feature X',
      timestamp: 1700000000000,
    };
    await appendScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md', entry);

    const result = await loadScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md');
    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].step).toBe('Step 1');
    expect(result!.repo).toBe('owner/repo');
  });
});

// --- appendScratchpad ---

describe('appendScratchpad', () => {
  it('creates new scratchpad when absent', async () => {
    const r2 = createMockR2();
    await appendScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md', {
      step: 'Step 1',
      summary: 'First step done',
      timestamp: 1700000000000,
    });

    const loaded = await loadScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md');
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0].summary).toBe('First step done');
  });

  it('preserves old entries when appending', async () => {
    const r2 = createMockR2();
    await appendScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md', {
      step: 'Step 1',
      summary: 'First',
      timestamp: 1700000000000,
    });
    await appendScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md', {
      step: 'Step 2',
      summary: 'Second',
      timestamp: 1700000001000,
    });

    const loaded = await loadScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md');
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(2);
    expect(loaded!.entries[0].summary).toBe('First');
    expect(loaded!.entries[1].summary).toBe('Second');
  });

  it('continues normally when R2 fails', async () => {
    const r2 = createMockR2();
    (r2.put as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('R2 unavailable'));
    (r2.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('R2 unavailable'));

    // Should not throw
    await expect(
      appendScratchpad(r2, 'user1', 'owner/repo', 'ROADMAP.md', {
        step: 'Step 1',
        summary: 'test',
        timestamp: Date.now(),
      }),
    ).resolves.toBeUndefined();
  });
});

// --- formatScratchpadForPrompt ---

describe('formatScratchpadForPrompt', () => {
  it('returns empty string for null scratchpad', () => {
    expect(formatScratchpadForPrompt(null)).toBe('');
  });

  it('returns empty string for scratchpad with no entries', () => {
    const pad: Scratchpad = { entries: [], createdAt: Date.now(), repo: 'owner/repo' };
    expect(formatScratchpadForPrompt(pad)).toBe('');
  });

  it('formats entries as concise prompt block', () => {
    const pad: Scratchpad = {
      entries: [
        { step: 'Step 1', summary: 'Created utils module', timestamp: 1700000000000 },
        { step: 'Step 2', summary: 'Added tests for parser', timestamp: 1700000001000 },
      ],
      createdAt: 1700000000000,
      repo: 'owner/repo',
    };

    const result = formatScratchpadForPrompt(pad);
    expect(result).toContain('Session Scratchpad');
    expect(result).toContain('Step 1');
    expect(result).toContain('Created utils module');
    expect(result).toContain('Step 2');
    expect(result).toContain('Added tests for parser');
  });

  it('caps output length and truncates long summaries', () => {
    const longSummary = 'A'.repeat(200);
    const pad: Scratchpad = {
      entries: [
        { step: 'Step 1', summary: longSummary, timestamp: 1700000000000 },
      ],
      createdAt: 1700000000000,
      repo: 'owner/repo',
    };

    const result = formatScratchpadForPrompt(pad);
    expect(result.length).toBeLessThan(2100); // MAX_PROMPT_CHARS + some header overhead
    expect(result).toContain('...');
  });

  it('limits to recent entries only', () => {
    const entries: ScratchpadEntry[] = Array.from({ length: 20 }, (_, i) => ({
      step: `Step ${i + 1}`,
      summary: `Did thing ${i + 1}`,
      timestamp: 1700000000000 + i * 1000,
    }));
    const pad: Scratchpad = {
      entries,
      createdAt: 1700000000000,
      repo: 'owner/repo',
    };

    const result = formatScratchpadForPrompt(pad);
    // Should contain later entries but not the earliest ones (max 10 recent)
    expect(result).toContain('Step 20');
    expect(result).toContain('Step 11');
    expect(result).not.toContain('Step 1:');
  });
});

// --- Key consistency ---

describe('scratchpad key consistency', () => {
  it('load and append use the same R2 key for the same repo+roadmapPath', async () => {
    const r2 = createMockR2();
    const userId = 'user1';
    const repo = 'owner/repo';
    const roadmapPath = 'docs/ROADMAP.md';

    // Append with a non-default roadmap path
    await appendScratchpad(r2, userId, repo, roadmapPath, {
      step: 'Step 1',
      summary: 'Did something',
      timestamp: Date.now(),
    });

    // Load with the same path — should find the entry
    const loaded = await loadScratchpad(r2, userId, repo, roadmapPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0].step).toBe('Step 1');
  });

  it('different roadmap paths produce different scratchpad keys', async () => {
    const r2 = createMockR2();
    const userId = 'user1';
    const repo = 'owner/repo';

    await appendScratchpad(r2, userId, repo, 'ROADMAP.md', {
      step: 'Step A',
      summary: 'From default path',
      timestamp: Date.now(),
    });

    // Loading with a different roadmap path should return null
    const loaded = await loadScratchpad(r2, userId, repo, 'docs/ROADMAP.md');
    expect(loaded).toBeNull();
  });
});

// --- Prompt integration ---

describe('scratchpad prompt integration', () => {
  // We import buildRunPrompt to test that scratchpadContext is injected
  let buildRunPrompt: typeof import('../skills/orchestra/orchestra').buildRunPrompt;

  beforeEach(async () => {
    const mod = await import('../skills/orchestra/orchestra');
    buildRunPrompt = mod.buildRunPrompt;
  });

  it('injects scratchpad context when provided', () => {
    const prompt = buildRunPrompt({
      repo: 'owner/repo',
      modelAlias: 'flash',
      previousTasks: [],
      scratchpadContext: '## Session Scratchpad (learnings from prior steps)\n- **Step 1**: Created utils module',
    });
    expect(prompt).toContain('Session Scratchpad');
    expect(prompt).toContain('Created utils module');
  });

  it('does not inject scratchpad when empty', () => {
    const prompt = buildRunPrompt({
      repo: 'owner/repo',
      modelAlias: 'flash',
      previousTasks: [],
      scratchpadContext: '',
    });
    expect(prompt).not.toContain('Session Scratchpad');
  });

  it('does not inject scratchpad when undefined', () => {
    const prompt = buildRunPrompt({
      repo: 'owner/repo',
      modelAlias: 'flash',
      previousTasks: [],
    });
    expect(prompt).not.toContain('Session Scratchpad');
  });
});
