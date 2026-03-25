/**
 * Spark — Capture Service
 *
 * Saves ideas/links to the user's inbox.
 */

import type { SparkItem } from './types';
import type { MoltbotEnv } from '../../types';
import { saveSparkItem, listSparkItems } from '../../storage/spark';
import { executeSkillTool, buildSkillToolContext } from '../skill-tools';
import type { ToolCall } from '../../openrouter/tools';

/**
 * Save an idea or URL to the user's inbox.
 * If the text contains a URL, attempts to fetch metadata for a summary.
 */
export async function captureItem(
  text: string,
  userId: string,
  env: MoltbotEnv,
): Promise<{ item: SparkItem; toolCalls: number }> {
  const url = extractUrl(text);
  let summary: string | undefined;
  let toolCalls = 0;

  // If there's a URL, try to get metadata
  if (url) {
    try {
      const result = await executeSkillTool('spark', {
        id: `spark-meta-${Date.now()}`,
        type: 'function',
        function: {
          name: 'url_metadata',
          arguments: JSON.stringify({ url }),
        },
      } as ToolCall, buildSkillToolContext(env, userId));
      toolCalls++;

      if (!result.content.startsWith('Error:')) {
        // Truncate metadata to a reasonable summary length
        summary = result.content.slice(0, 500);
      }
    } catch {
      // URL fetch failed — save without summary
    }
  }

  const item: SparkItem = {
    id: crypto.randomUUID(),
    text,
    url,
    summary,
    createdAt: new Date().toISOString(),
  };

  await saveSparkItem(env.MOLTBOT_BUCKET, userId, item);
  return { item, toolCalls };
}

/**
 * List all items in the user's inbox.
 */
export async function listInbox(
  userId: string,
  env: MoltbotEnv,
  limit = 50,
): Promise<SparkItem[]> {
  return listSparkItems(env.MOLTBOT_BUCKET, userId, limit);
}

/**
 * Format inbox items for display.
 */
export function formatInbox(items: SparkItem[]): string {
  if (items.length === 0) {
    return 'Your ideas inbox is empty. Use /save to capture ideas.';
  }

  const lines = items.map((item, i) => {
    const num = i + 1;
    const text = item.text.length > 80 ? item.text.slice(0, 77) + '...' : item.text;
    const date = new Date(item.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const urlTag = item.url ? ' [link]' : '';
    return `${num}. ${text}${urlTag} — ${date}`;
  });

  return `Ideas Inbox (${items.length})\n\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/\S+/);
  if (!match) return undefined;
  try {
    new URL(match[0]);
    return match[0];
  } catch {
    return undefined;
  }
}
