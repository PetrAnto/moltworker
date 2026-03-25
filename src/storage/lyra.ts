/**
 * Lyra — Draft Persistence
 *
 * Stores and retrieves the user's last draft in R2
 * so /rewrite can access the previous output.
 */

import type { StoredDraft } from '../skills/lyra/types';

const DRAFT_PREFIX = 'lyra';

function draftKey(userId: string): string {
  return `${DRAFT_PREFIX}/${userId}/last-draft.json`;
}

/** Save a draft to R2. */
export async function saveDraft(
  bucket: R2Bucket,
  userId: string,
  draft: StoredDraft,
): Promise<void> {
  await bucket.put(draftKey(userId), JSON.stringify(draft), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/** Load the user's last draft from R2. Returns null if none exists. */
export async function loadDraft(
  bucket: R2Bucket,
  userId: string,
): Promise<StoredDraft | null> {
  try {
    const obj = await bucket.get(draftKey(userId));
    if (!obj) return null;
    return await obj.json() as StoredDraft;
  } catch {
    return null;
  }
}

/** Delete the user's last draft. */
export async function deleteDraft(
  bucket: R2Bucket,
  userId: string,
): Promise<void> {
  await bucket.delete(draftKey(userId));
}
