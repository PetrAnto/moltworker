/**
 * Prompt Caching for Anthropic models (Phase 7A.5)
 *
 * Injects `cache_control: { type: 'ephemeral' }` on the last content block
 * of system messages when using Anthropic models (via OpenRouter or direct).
 * This enables Anthropic's prompt caching, saving ~90% on repeated system prompts.
 *
 * Works with OpenRouter: they pass cache_control through to Anthropic's API.
 */

import type { ChatMessage, ContentPart } from './client';

/**
 * Inject cache_control on the last system message's final content block.
 *
 * - If system message content is a string, converts to a single text content block
 *   with cache_control attached.
 * - If system message content is already an array, attaches cache_control to the
 *   last text block.
 * - Returns a new array (does not mutate the input).
 */
export function injectCacheControl(messages: ChatMessage[]): ChatMessage[] {
  // Find the last system message index
  let lastSystemIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system') {
      lastSystemIdx = i;
      break;
    }
  }

  if (lastSystemIdx === -1) return messages;

  const systemMsg = messages[lastSystemIdx];
  const content = systemMsg.content;

  // Skip null/empty
  if (content === null || content === undefined || content === '') {
    return messages;
  }

  let newContent: ContentPart[];

  if (typeof content === 'string') {
    // Convert string to content block array with cache_control
    newContent = [{
      type: 'text',
      text: content,
      cache_control: { type: 'ephemeral' },
    }];
  } else if (Array.isArray(content)) {
    // Find the last text block and attach cache_control
    newContent = content.map((part, idx) => {
      if (idx === content.length - 1 && part.type === 'text') {
        return { ...part, cache_control: { type: 'ephemeral' } };
      }
      return part;
    });
  } else {
    return messages;
  }

  // Return new array with modified system message
  const result = [...messages];
  result[lastSystemIdx] = { ...systemMsg, content: newContent };
  return result;
}
