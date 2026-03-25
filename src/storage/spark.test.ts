/**
 * Tests for Spark storage
 */

import { describe, it, expect, vi } from 'vitest';
import { saveSparkItem, listSparkItems, deleteSparkItem, countSparkItems } from './spark';
import type { SparkItem } from '../skills/spark/types';

function createMockBucket() {
  const store = new Map<string, string>();
  return {
    put: vi.fn(async (key: string, body: string) => {
      store.set(key, body);
    }),
    get: vi.fn(async (key: string) => {
      const data = store.get(key);
      if (!data) return null;
      return { json: async () => JSON.parse(data), text: async () => data };
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string; limit?: number }) => {
      const objects = Array.from(store.keys())
        .filter(k => k.startsWith(prefix))
        .sort()
        .map(key => ({ key }));
      return { objects };
    }),
    _store: store,
  } as unknown as R2Bucket & { _store: Map<string, string> };
}

describe('spark storage', () => {
  it('saves and lists items', async () => {
    const bucket = createMockBucket();
    const item: SparkItem = {
      id: 'abc-123',
      text: 'Build AI tool',
      createdAt: '2026-03-25T10:00:00.000Z',
    };

    await saveSparkItem(bucket, 'user1', item);
    const items = await listSparkItems(bucket, 'user1');

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('abc-123');
    expect(items[0].text).toBe('Build AI tool');
  });

  it('lists items newest first', async () => {
    const bucket = createMockBucket();
    const item1: SparkItem = { id: 'a', text: 'First', createdAt: '2026-03-24T10:00:00.000Z' };
    const item2: SparkItem = { id: 'b', text: 'Second', createdAt: '2026-03-25T10:00:00.000Z' };

    await saveSparkItem(bucket, 'user1', item1);
    await saveSparkItem(bucket, 'user1', item2);
    const items = await listSparkItems(bucket, 'user1');

    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('b'); // Newer first
    expect(items[1].id).toBe('a');
  });

  it('deletes items', async () => {
    const bucket = createMockBucket();
    const item: SparkItem = { id: 'to-delete', text: 'Remove me', createdAt: '2026-03-25T10:00:00.000Z' };

    await saveSparkItem(bucket, 'user1', item);
    expect(await countSparkItems(bucket, 'user1')).toBe(1);

    const deleted = await deleteSparkItem(bucket, 'user1', 'to-delete');
    expect(deleted).toBe(true);
    expect(await countSparkItems(bucket, 'user1')).toBe(0);
  });

  it('returns false when deleting non-existent item', async () => {
    const bucket = createMockBucket();
    const deleted = await deleteSparkItem(bucket, 'user1', 'nonexistent');
    expect(deleted).toBe(false);
  });

  it('uses correct R2 key pattern', async () => {
    const bucket = createMockBucket();
    const item: SparkItem = { id: 'key-test', text: 'Test', createdAt: '2026-03-25T10:00:00.000Z' };

    await saveSparkItem(bucket, 'user42', item);
    const keys = Array.from(bucket._store.keys());
    expect(keys[0]).toMatch(/^spark\/user42\/items\/\d+-key-test\.json$/);
  });
});
