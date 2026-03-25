/**
 * Tests for Lyra draft storage
 */

import { describe, it, expect, vi } from 'vitest';
import { saveDraft, loadDraft, deleteDraft } from './lyra';
import type { StoredDraft } from '../skills/lyra/types';

function createMockBucket() {
  const store = new Map<string, string>();
  return {
    put: vi.fn(async (key: string, body: string) => {
      store.set(key, body);
    }),
    get: vi.fn(async (key: string) => {
      const data = store.get(key);
      if (!data) return null;
      return {
        json: async () => JSON.parse(data),
        text: async () => data,
      };
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    _store: store,
  } as unknown as R2Bucket & { _store: Map<string, string> };
}

describe('lyra storage', () => {
  it('saves and loads a draft', async () => {
    const bucket = createMockBucket();
    const draft: StoredDraft = {
      content: 'Test draft',
      quality: 4,
      platform: 'twitter',
      tone: 'casual',
      createdAt: '2026-03-25T00:00:00.000Z',
      command: 'write',
    };

    await saveDraft(bucket, 'user123', draft);
    const loaded = await loadDraft(bucket, 'user123');

    expect(loaded).toEqual(draft);
  });

  it('returns null when no draft exists', async () => {
    const bucket = createMockBucket();
    const loaded = await loadDraft(bucket, 'user999');
    expect(loaded).toBeNull();
  });

  it('deletes a draft', async () => {
    const bucket = createMockBucket();
    const draft: StoredDraft = {
      content: 'To delete',
      quality: 3,
      createdAt: '2026-03-25T00:00:00.000Z',
      command: 'write',
    };

    await saveDraft(bucket, 'user123', draft);
    expect(await loadDraft(bucket, 'user123')).not.toBeNull();

    await deleteDraft(bucket, 'user123');
    expect(await loadDraft(bucket, 'user123')).toBeNull();
  });

  it('uses correct R2 key pattern', async () => {
    const bucket = createMockBucket();
    const draft: StoredDraft = {
      content: 'Test',
      quality: 3,
      createdAt: '2026-03-25T00:00:00.000Z',
      command: 'write',
    };

    await saveDraft(bucket, 'user456', draft);
    expect(bucket._store.has('lyra/user456/last-draft.json')).toBe(true);
  });
});
