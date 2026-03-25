/**
 * Spark — Per-item R2 CRUD
 *
 * Stores ideas in R2 at: spark/{userId}/items/{timestamp}-{id}.json
 */

import type { SparkItem } from '../skills/spark/types';

const PREFIX = 'spark';

function itemKey(userId: string, item: SparkItem): string {
  // Timestamp prefix enables chronological R2 listing
  const ts = new Date(item.createdAt).getTime();
  return `${PREFIX}/${userId}/items/${ts}-${item.id}.json`;
}

function itemsPrefix(userId: string): string {
  return `${PREFIX}/${userId}/items/`;
}

/** Save a new spark item to R2. */
export async function saveSparkItem(
  bucket: R2Bucket,
  userId: string,
  item: SparkItem,
): Promise<void> {
  await bucket.put(itemKey(userId, item), JSON.stringify(item), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/** List all spark items for a user, newest first. */
export async function listSparkItems(
  bucket: R2Bucket,
  userId: string,
  limit = 50,
): Promise<SparkItem[]> {
  const prefix = itemsPrefix(userId);
  // Fetch all keys (not limited) so we can reverse and take the newest.
  // R2 lists alphabetically — timestamp prefix means chronological order.
  // If we applied limit here, we'd get the oldest N instead of newest N.
  const listed = await bucket.list({ prefix });

  const keys = listed.objects.map(o => o.key);

  // Take the last `limit` keys (newest by timestamp prefix), then reverse
  // so the result is newest-first.
  const newestKeys = keys.slice(-limit).reverse();

  const items: SparkItem[] = [];
  for (const key of newestKeys) {
    try {
      const data = await bucket.get(key);
      if (data) {
        items.push(await data.json() as SparkItem);
      }
    } catch {
      // Skip corrupted items
    }
  }

  return items;
}

/** Get a specific spark item by ID. */
export async function getSparkItem(
  bucket: R2Bucket,
  userId: string,
  itemId: string,
): Promise<SparkItem | null> {
  // We need to find the item by listing since the key includes timestamp
  const prefix = itemsPrefix(userId);
  const listed = await bucket.list({ prefix });

  for (const obj of listed.objects) {
    if (obj.key.includes(itemId)) {
      try {
        const data = await bucket.get(obj.key);
        if (data) return await data.json() as SparkItem;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Delete a spark item by ID. */
export async function deleteSparkItem(
  bucket: R2Bucket,
  userId: string,
  itemId: string,
): Promise<boolean> {
  const prefix = itemsPrefix(userId);
  const listed = await bucket.list({ prefix });

  for (const obj of listed.objects) {
    if (obj.key.includes(itemId)) {
      await bucket.delete(obj.key);
      return true;
    }
  }
  return false;
}

/** Count items in a user's inbox. */
export async function countSparkItems(
  bucket: R2Bucket,
  userId: string,
): Promise<number> {
  const prefix = itemsPrefix(userId);
  const listed = await bucket.list({ prefix });
  return listed.objects.length;
}
