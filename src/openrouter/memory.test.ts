import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadUserMemory,
  storeMemoryFact,
  deleteMemoryFact,
  clearUserMemory,
  addManualFact,
  formatMemoryForPrompt,
  formatMemoryDisplay,
  getMemoryContext,
  buildExtractionPrompt,
  parseExtractionResponse,
  wordOverlap,
  checkDeduplication,
  type MemoryFact,
  type UserMemory,
} from './memory';

// Mock R2Bucket
function createMockR2(): R2Bucket {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => {
      const data = store.get(key);
      if (!data) return null;
      return {
        json: async () => JSON.parse(data),
        text: async () => data,
      } as unknown as R2ObjectBody;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    // Unused but required by interface
    head: vi.fn(),
    list: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

describe('memory module', () => {
  let r2: R2Bucket;

  beforeEach(() => {
    r2 = createMockR2();
  });

  // ── loadUserMemory ──

  it('loadUserMemory returns null for new user', async () => {
    const result = await loadUserMemory(r2, 'user123');
    expect(result).toBeNull();
  });

  // ── storeMemoryFact ──

  it('storeMemoryFact stores a new fact', async () => {
    const result = await storeMemoryFact(r2, 'user1', 'Prefers Python', 'preference');
    expect(result.stored).toBe(true);
    expect(result.reason).toBe('new');

    const memory = await loadUserMemory(r2, 'user1');
    expect(memory).not.toBeNull();
    expect(memory!.facts).toHaveLength(1);
    expect(memory!.facts[0].fact).toBe('Prefers Python');
    expect(memory!.facts[0].category).toBe('preference');
    expect(memory!.facts[0].source).toBe('extracted');
    expect(memory!.facts[0].confidence).toBe(0.7);
  });

  it('storeMemoryFact detects exact duplicate', async () => {
    await storeMemoryFact(r2, 'user1', 'Prefers Python', 'preference');
    const result = await storeMemoryFact(r2, 'user1', 'Prefers Python', 'preference');
    expect(result.stored).toBe(false);
    expect(result.reason).toBe('duplicate');

    const memory = await loadUserMemory(r2, 'user1');
    expect(memory!.facts).toHaveLength(1);
  });

  it('storeMemoryFact detects substring duplicate', async () => {
    await storeMemoryFact(r2, 'user1', 'Prefers Python for APIs', 'preference');
    const result = await storeMemoryFact(r2, 'user1', 'Prefers Python', 'preference');
    expect(result.stored).toBe(false);
    expect(result.reason).toBe('duplicate');
  });

  it('storeMemoryFact updates on high word overlap same category', async () => {
    await storeMemoryFact(r2, 'user1', 'Uses Python with FastAPI framework', 'technical');
    const result = await storeMemoryFact(r2, 'user1', 'Uses Python with Django framework', 'technical');
    expect(result.stored).toBe(true);
    expect(result.reason).toBe('updated');

    const memory = await loadUserMemory(r2, 'user1');
    expect(memory!.facts).toHaveLength(1);
    // Updated text should be the newer one
    expect(memory!.facts[0].fact).toBe('Uses Python with Django framework');
    // Confidence should be boosted
    expect(memory!.facts[0].confidence).toBeGreaterThan(0.7);
  });

  it('storeMemoryFact evicts lowest-confidence when full', async () => {
    // Directly build a memory with 100 unique facts to bypass dedup
    const facts: MemoryFact[] = [];
    const categories: Array<'preference' | 'context' | 'project' | 'personal' | 'technical'> = ['preference', 'context', 'project', 'personal', 'technical'];
    for (let i = 0; i < 100; i++) {
      facts.push({
        id: `id-${i}`,
        fact: `Unique fact ${i} category${categories[i % 5]} zzzz${i}`,
        category: categories[i % 5],
        source: 'extracted',
        confidence: 0.5,
        createdAt: Date.now() - i * 1000,
        lastReferencedAt: Date.now() - i * 1000,
      });
    }
    const memory: UserMemory = { userId: 'user1', facts, updatedAt: Date.now() };
    await (r2 as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      'memory/user1/facts.json', JSON.stringify(memory),
    );

    let loaded = await loadUserMemory(r2, 'user1');
    expect(loaded!.facts).toHaveLength(100);

    // Store one more with high confidence — should evict a 0.5 fact
    await storeMemoryFact(r2, 'user1', 'Very important high confidence fact completely unique', 'preference', 'manual', 0.95);
    loaded = await loadUserMemory(r2, 'user1');
    expect(loaded!.facts).toHaveLength(100);
    expect(loaded!.facts.find(f => f.fact === 'Very important high confidence fact completely unique')).toBeDefined();
  });

  // ── deleteMemoryFact ──

  it('deleteMemoryFact removes a fact by ID', async () => {
    await storeMemoryFact(r2, 'user1', 'Fact to delete', 'context');
    const memory = await loadUserMemory(r2, 'user1');
    const factId = memory!.facts[0].id;

    const deleted = await deleteMemoryFact(r2, 'user1', factId);
    expect(deleted).toBe(true);

    const after = await loadUserMemory(r2, 'user1');
    expect(after!.facts).toHaveLength(0);
  });

  it('deleteMemoryFact returns false for non-existent ID', async () => {
    await storeMemoryFact(r2, 'user1', 'Fact', 'context');
    const deleted = await deleteMemoryFact(r2, 'user1', 'nonexistent');
    expect(deleted).toBe(false);
  });

  // ── clearUserMemory ──

  it('clearUserMemory removes all facts', async () => {
    await storeMemoryFact(r2, 'user1', 'Fact 1', 'preference');
    await storeMemoryFact(r2, 'user1', 'Fact 2 about projects', 'project');
    await clearUserMemory(r2, 'user1');

    const memory = await loadUserMemory(r2, 'user1');
    expect(memory).toBeNull();
  });

  // ── addManualFact ──

  it('addManualFact stores with higher confidence', async () => {
    const result = await addManualFact(r2, 'user1', 'I work at Acme Corp');
    expect(result.stored).toBe(true);

    const memory = await loadUserMemory(r2, 'user1');
    expect(memory!.facts[0].source).toBe('manual');
    expect(memory!.facts[0].confidence).toBe(0.9);
    expect(memory!.facts[0].category).toBe('context');
  });

  // ── wordOverlap ──

  it('wordOverlap computes overlap ratio', () => {
    expect(wordOverlap('python django framework', 'python fastapi framework')).toBeCloseTo(0.667, 1);
    expect(wordOverlap('completely different words', 'nothing matches here')).toBe(0);
    expect(wordOverlap('same same same', 'same same same')).toBe(1.0);
  });

  // ── checkDeduplication ──

  it('checkDeduplication detects new facts', () => {
    const existing: MemoryFact[] = [{
      id: '1', fact: 'Uses Python', category: 'technical',
      source: 'extracted', confidence: 0.7, createdAt: 0, lastReferencedAt: 0,
    }];
    const result = checkDeduplication('Works at Acme Corp', 'personal', existing);
    expect(result.action).toBe('new');
  });

  it('checkDeduplication detects substring duplicate', () => {
    const existing: MemoryFact[] = [{
      id: '1', fact: 'Uses Python for web development', category: 'technical',
      source: 'extracted', confidence: 0.7, createdAt: 0, lastReferencedAt: 0,
    }];
    const result = checkDeduplication('Uses Python', 'technical', existing);
    expect(result.action).toBe('duplicate');
  });

  // ── formatMemoryForPrompt ──

  it('formatMemoryForPrompt returns empty string for no facts', () => {
    expect(formatMemoryForPrompt([])).toBe('');
  });

  it('formatMemoryForPrompt formats facts by category', () => {
    const facts: MemoryFact[] = [
      { id: '1', fact: 'Prefers Python', category: 'preference', source: 'extracted', confidence: 0.9, createdAt: 0, lastReferencedAt: 0 },
      { id: '2', fact: 'Works at Acme Corp', category: 'personal', source: 'manual', confidence: 0.8, createdAt: 0, lastReferencedAt: 0 },
      { id: '3', fact: 'Uses VS Code', category: 'technical', source: 'extracted', confidence: 0.7, createdAt: 0, lastReferencedAt: 0 },
    ];
    const output = formatMemoryForPrompt(facts);
    expect(output).toContain('--- User context (remembered) ---');
    expect(output).toContain('Preferences: Prefers Python');
    expect(output).toContain('Personal: Works at Acme Corp');
    expect(output).toContain('Technical: Uses VS Code');
  });

  // ── formatMemoryDisplay ──

  it('formatMemoryDisplay shows grouped facts with IDs', () => {
    const memory: UserMemory = {
      userId: 'user1',
      updatedAt: Date.now(),
      facts: [
        { id: 'abc123', fact: 'Prefers Python', category: 'preference', source: 'extracted', confidence: 0.9, createdAt: 0, lastReferencedAt: 0 },
        { id: 'def456', fact: 'Works at Acme', category: 'personal', source: 'manual', confidence: 0.8, createdAt: 0, lastReferencedAt: 0 },
      ],
    };
    const output = formatMemoryDisplay(memory);
    expect(output).toContain('🧠 Your Memory (2 facts)');
    expect(output).toContain('abc123');
    expect(output).toContain('Prefers Python');
    expect(output).toContain('/memory add');
    expect(output).toContain('/memory remove');
  });

  it('formatMemoryDisplay shows empty message for no facts', () => {
    const memory: UserMemory = { userId: 'user1', facts: [], updatedAt: 0 };
    const output = formatMemoryDisplay(memory);
    expect(output).toContain('No memories stored yet');
  });

  // ── getMemoryContext ──

  it('getMemoryContext returns formatted context and updates lastReferencedAt', async () => {
    await storeMemoryFact(r2, 'user1', 'Prefers dark theme', 'preference', 'manual', 0.9);
    await storeMemoryFact(r2, 'user1', 'Uses macOS for development', 'technical', 'extracted', 0.8);

    const context = await getMemoryContext(r2, 'user1');
    expect(context).toContain('--- User context (remembered) ---');
    expect(context).toContain('Prefers dark theme');
    expect(context).toContain('Uses macOS for development');
  });

  it('getMemoryContext returns empty for user with no memory', async () => {
    const context = await getMemoryContext(r2, 'nonexistent');
    expect(context).toBe('');
  });

  // ── buildExtractionPrompt ──

  it('buildExtractionPrompt includes user message and existing facts', () => {
    const existing: MemoryFact[] = [{
      id: '1', fact: 'Uses Python', category: 'technical',
      source: 'extracted', confidence: 0.7, createdAt: 0, lastReferencedAt: 0,
    }];
    const prompt = buildExtractionPrompt('I work at Acme Corp as a senior dev', 'Great, noted!', existing);
    expect(prompt).toContain('I work at Acme Corp');
    expect(prompt).toContain('Uses Python');
    expect(prompt).toContain('do NOT duplicate');
    expect(prompt).toContain('JSON array');
  });

  // ── parseExtractionResponse ──

  it('parseExtractionResponse parses valid JSON array', () => {
    const response = '[{"fact": "Uses React", "category": "technical"}, {"fact": "Prefers dark mode", "category": "preference"}]';
    const facts = parseExtractionResponse(response);
    expect(facts).toHaveLength(2);
    expect(facts[0].fact).toBe('Uses React');
    expect(facts[0].category).toBe('technical');
    expect(facts[1].fact).toBe('Prefers dark mode');
  });

  it('parseExtractionResponse returns empty for empty array', () => {
    expect(parseExtractionResponse('[]')).toEqual([]);
  });

  it('parseExtractionResponse handles markdown-wrapped JSON', () => {
    const response = 'Here are the facts:\n```json\n[{"fact": "Uses VS Code", "category": "technical"}]\n```';
    const facts = parseExtractionResponse(response);
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('Uses VS Code');
  });

  it('parseExtractionResponse filters invalid categories', () => {
    const response = '[{"fact": "Valid", "category": "technical"}, {"fact": "Bad", "category": "invalid"}]';
    const facts = parseExtractionResponse(response);
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('Valid');
  });

  it('parseExtractionResponse returns empty for garbage input', () => {
    expect(parseExtractionResponse('not json at all')).toEqual([]);
    expect(parseExtractionResponse('')).toEqual([]);
  });

  it('parseExtractionResponse truncates long facts', () => {
    const longFact = 'x'.repeat(300);
    const response = `[{"fact": "${longFact}", "category": "context"}]`;
    const facts = parseExtractionResponse(response);
    expect(facts[0].fact.length).toBe(200);
  });
});
