/**
 * Tests for Prompt Caching (Phase 7A.5)
 */

import { describe, it, expect } from 'vitest';
import { injectCacheControl } from './prompt-cache';
import { isAnthropicModel } from './models';
import type { ChatMessage, ContentPart } from './client';

describe('injectCacheControl', () => {
  describe('string system message content', () => {
    it('should convert string content to content block with cache_control', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      const result = injectCacheControl(messages);

      expect(result[0].role).toBe('system');
      expect(Array.isArray(result[0].content)).toBe(true);
      const blocks = result[0].content as ContentPart[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('text');
      expect(blocks[0].text).toBe('You are a helpful assistant.');
      expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should not modify user messages', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'User message' },
      ];

      const result = injectCacheControl(messages);

      expect(result[1].content).toBe('User message');
      expect(typeof result[1].content).toBe('string');
    });
  });

  describe('array system message content', () => {
    it('should add cache_control to last text block in array content', () => {
      const blocks: ContentPart[] = [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ];
      const messages: ChatMessage[] = [
        { role: 'system', content: blocks },
        { role: 'user', content: 'Hello' },
      ];

      const result = injectCacheControl(messages);

      const resultBlocks = result[0].content as ContentPart[];
      expect(resultBlocks).toHaveLength(2);
      expect(resultBlocks[0].cache_control).toBeUndefined();
      expect(resultBlocks[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should handle single-element array', () => {
      const blocks: ContentPart[] = [
        { type: 'text', text: 'Only block' },
      ];
      const messages: ChatMessage[] = [
        { role: 'system', content: blocks },
      ];

      const result = injectCacheControl(messages);

      const resultBlocks = result[0].content as ContentPart[];
      expect(resultBlocks).toHaveLength(1);
      expect(resultBlocks[0].cache_control).toEqual({ type: 'ephemeral' });
    });
  });

  describe('no system message', () => {
    it('should return messages unchanged if no system message exists', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];

      const result = injectCacheControl(messages);

      expect(result).toEqual(messages);
    });
  });

  describe('multiple system messages', () => {
    it('should only modify the last system message', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'System prompt 1' },
        { role: 'system', content: 'System prompt 2' },
        { role: 'user', content: 'Hello' },
      ];

      const result = injectCacheControl(messages);

      // First system message unchanged
      expect(result[0].content).toBe('System prompt 1');
      expect(typeof result[0].content).toBe('string');

      // Last system message has cache_control
      const blocks = result[1].content as ContentPart[];
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    });
  });

  describe('null/empty content', () => {
    it('should skip null content system message', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: null },
        { role: 'user', content: 'Hello' },
      ];

      const result = injectCacheControl(messages);

      expect(result[0].content).toBeNull();
    });

    it('should skip empty string content system message', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: '' },
        { role: 'user', content: 'Hello' },
      ];

      const result = injectCacheControl(messages);

      expect(result[0].content).toBe('');
    });
  });

  describe('immutability', () => {
    it('should not mutate the original messages array', () => {
      const original: ChatMessage[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Hello' },
      ];
      const originalRef = original[0];

      injectCacheControl(original);

      // Original should be unchanged
      expect(original[0]).toBe(originalRef);
      expect(original[0].content).toBe('System prompt');
      expect(typeof original[0].content).toBe('string');
    });

    it('should not mutate original content blocks', () => {
      const blocks: ContentPart[] = [
        { type: 'text', text: 'Block 1' },
        { type: 'text', text: 'Block 2' },
      ];
      const messages: ChatMessage[] = [
        { role: 'system', content: blocks },
      ];

      injectCacheControl(messages);

      // Original blocks should not have cache_control
      expect(blocks[1].cache_control).toBeUndefined();
    });
  });

  describe('empty messages array', () => {
    it('should handle empty array', () => {
      const result = injectCacheControl([]);
      expect(result).toEqual([]);
    });
  });

  describe('preserves other message fields', () => {
    it('should preserve tool_calls on assistant messages', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'System' },
        { role: 'assistant', content: 'response', tool_calls: [{ id: '1', type: 'function' as const, function: { name: 'test', arguments: '{}' } }] },
        { role: 'user', content: 'Hello' },
      ];

      const result = injectCacheControl(messages);

      expect(result[1].tool_calls).toBeDefined();
      expect(result[1].tool_calls![0].function.name).toBe('test');
    });
  });
});

describe('isAnthropicModel', () => {
  it('should return true for haiku (anthropic/claude-haiku-4.5)', () => {
    expect(isAnthropicModel('haiku')).toBe(true);
  });

  it('should return true for sonnet (anthropic/claude-sonnet-4.5)', () => {
    expect(isAnthropicModel('sonnet')).toBe(true);
  });

  it('should return true for opus (anthropic/claude-opus-4.6)', () => {
    expect(isAnthropicModel('opus')).toBe(true);
  });

  it('should return false for deepseek models', () => {
    expect(isAnthropicModel('dcode')).toBe(false);
  });

  it('should return false for unknown models', () => {
    expect(isAnthropicModel('nonexistent_model_xyz')).toBe(false);
  });
});
