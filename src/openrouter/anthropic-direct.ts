/**
 * Direct Anthropic Messages API adapter.
 *
 * Converts OpenAI-format messages to Anthropic Messages API format and parses
 * the Anthropic SSE stream back into the standard ChatCompletionResponse shape
 * used by the rest of the codebase.
 *
 * Anthropic API differences from OpenAI:
 * - System message is a top-level `system` param, not in `messages[]`
 * - Tool calls use `tool_use` content blocks, not `tool_calls` array
 * - Tool results use `tool_result` content blocks, not `role: 'tool'`
 * - SSE events: `content_block_start`, `content_block_delta`, `message_delta`
 * - Auth header: `x-api-key` instead of `Authorization: Bearer`
 */

import type { ChatMessage, ContentPart } from './client';
import type { ToolCall, ToolDefinition } from './tools';
import type { ReasoningParam } from './models';

// --- Request conversion ---

/**
 * Sanitize a tool ID to match Anthropic's required pattern: ^[a-zA-Z0-9_-]+$
 * OpenRouter and other providers may generate IDs with dots, colons, or other
 * characters that Anthropic rejects. Replace invalid chars with underscores.
 */
function sanitizeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  source?: { type: 'base64'; media_type: string; data: string };
  id?: string;           // tool_use id
  name?: string;         // tool_use function name
  input?: unknown;       // tool_use arguments (parsed JSON)
  tool_use_id?: string;  // tool_result reference
  content?: string | AnthropicContentBlock[];  // tool_result content
  is_error?: boolean;    // tool_result error flag
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'none' | 'any' };
  temperature?: number;
  stream: true;
  // Extended thinking (Anthropic's reasoning mode)
  thinking?: { type: 'enabled'; budget_tokens: number };
}

/**
 * Extract system message from OpenAI messages and return it separately.
 * Anthropic requires system as a top-level param.
 */
function extractSystem(messages: ChatMessage[]): {
  system: string | AnthropicContentBlock[] | undefined;
  remaining: ChatMessage[];
} {
  const remaining: ChatMessage[] = [];
  let system: string | AnthropicContentBlock[] | undefined;

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Support cache_control on content parts
      if (Array.isArray(msg.content)) {
        system = msg.content.map(part => {
          const block: AnthropicContentBlock = { type: 'text', text: part.text || '' };
          if (part.cache_control) {
            block.cache_control = part.cache_control;
          }
          return block;
        });
      } else if (typeof msg.content === 'string') {
        system = msg.content;
      }
    } else {
      remaining.push(msg);
    }
  }

  return { system, remaining };
}

/**
 * Convert OpenAI content parts to Anthropic content blocks.
 */
function convertContentParts(parts: ContentPart[]): AnthropicContentBlock[] {
  return parts.map(part => {
    if (part.type === 'image_url' && part.image_url?.url) {
      // Convert data URLs to Anthropic's base64 format
      const url = part.image_url.url;
      const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (match) {
        return {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: match[1], data: match[2] },
        };
      }
      // For regular URLs, Anthropic requires base64. Fall back to text description.
      return { type: 'text' as const, text: `[Image: ${url}]` };
    }
    const block: AnthropicContentBlock = { type: 'text', text: part.text || '' };
    if (part.cache_control) {
      block.cache_control = part.cache_control;
    }
    return block;
  });
}

/**
 * Convert OpenAI-format messages to Anthropic Messages API format.
 *
 * Key transformations:
 * - assistant messages with tool_calls → assistant messages with tool_use content blocks
 * - tool role messages → user messages with tool_result content blocks
 * - Consecutive same-role messages get merged (Anthropic requires alternating roles)
 */
function convertMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];

      // Add text content
      if (typeof msg.content === 'string' && msg.content.trim()) {
        blocks.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        blocks.push(...convertContentParts(msg.content));
      }

      // Add tool_use blocks for tool_calls
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = { raw: tc.function.arguments };
          }
          blocks.push({
            type: 'tool_use',
            id: sanitizeToolId(tc.id),
            name: tc.function.name,
            input,
          });
        }
      }

      if (blocks.length > 0) {
        result.push({ role: 'assistant', content: blocks });
      } else {
        // Empty assistant message — use minimal text
        result.push({ role: 'assistant', content: [{ type: 'text', text: '(empty)' }] });
      }

    } else if (msg.role === 'tool') {
      // Tool results become user messages with tool_result content blocks
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: sanitizeToolId(msg.tool_call_id || ''),
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      };

      result.push({ role: 'user', content: [block] });

    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        result.push({ role: 'user', content: convertContentParts(msg.content) });
      }
    }
  }

  // Merge consecutive same-role messages (Anthropic requires alternating user/assistant)
  return mergeConsecutiveRoles(result);
}

/**
 * Merge consecutive messages with the same role.
 * Anthropic API requires strictly alternating user/assistant messages.
 */
function mergeConsecutiveRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) return messages;

  const merged: AnthropicMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = messages[i];

    if (prev.role === curr.role) {
      // Merge into previous message
      const prevBlocks = toBlocks(prev.content);
      const currBlocks = toBlocks(curr.content);
      prev.content = [...prevBlocks, ...currBlocks];
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

function toBlocks(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

/**
 * Convert OpenAI tool definitions to Anthropic format.
 */
function convertTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters as Record<string, unknown>,
  }));
}

/**
 * Build a complete Anthropic Messages API request body from OpenAI-format inputs.
 */
export function buildAnthropicRequest(params: {
  modelId: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none';
  reasoning?: ReasoningParam;
}): AnthropicRequestBody {
  const { system, remaining } = extractSystem(params.messages);
  const body: AnthropicRequestBody = {
    model: params.modelId,
    max_tokens: params.maxTokens,
    messages: convertMessages(remaining),
    stream: true,
  };

  if (system !== undefined) {
    body.system = system;
  }

  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }

  if (params.tools && params.tools.length > 0) {
    body.tools = convertTools(params.tools);
    if (params.toolChoice === 'none') {
      body.tool_choice = { type: 'none' };
    } else {
      body.tool_choice = { type: 'auto' };
    }
  }

  // Map reasoning param to Anthropic's extended thinking
  if (params.reasoning) {
    const r = params.reasoning as Record<string, unknown>;
    if (r.enabled === true || r.type === 'enabled') {
      const budgetTokens = typeof r.budget_tokens === 'number' ? r.budget_tokens : 10000;
      body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
      // Extended thinking requires no temperature
      delete body.temperature;
    }
  }

  return body;
}

/**
 * Build Anthropic API headers.
 * Uses x-api-key (not Bearer token) and requires anthropic-version header.
 */
export function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  };
}

// --- SSE Response Parsing ---

/**
 * Parse Anthropic SSE stream into the standard ChatCompletionResponse format.
 *
 * Anthropic SSE event types:
 * - message_start: contains model, usage
 * - content_block_start: new content block (text or tool_use)
 * - content_block_delta: incremental content (text_delta or input_json_delta)
 * - content_block_stop: block complete
 * - message_delta: finish reason, final usage
 * - message_stop: stream complete
 */
export async function parseAnthropicSSEStream(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs = 45000,
  onProgress?: () => void,
  onToolCallReady?: (toolCall: ToolCall) => void,
  onKeepAlive?: () => Promise<boolean>,
): Promise<{
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
      reasoning_content?: string;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model?: string;
  id?: string;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Accumulated state
  let messageId = '';
  let model = '';
  let content = '';
  let reasoningContent = '';
  const toolCalls: ToolCall[] = [];
  let finishReason = '';
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
  let chunksReceived = 0;
  let lastKeepAliveMs = Date.now();

  // Track current content block for streaming
  let currentBlockType: string | null = null;
  let currentBlockIndex = -1;
  let currentToolCallId = '';
  let currentToolCallName = '';
  let currentToolCallArgs = '';

  const readWithTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('STREAM_READ_TIMEOUT')), idleTimeoutMs);
    });
    try {
      return await Promise.race([reader.read(), timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  };

  const finalizeToolCall = (): void => {
    if (currentBlockType === 'tool_use' && currentToolCallId) {
      const tc: ToolCall = {
        id: currentToolCallId,
        type: 'function',
        function: {
          name: currentToolCallName,
          arguments: currentToolCallArgs,
        },
      };
      toolCalls.push(tc);
      if (onToolCallReady) {
        onToolCallReady(tc);
      }
    }
    currentBlockType = null;
    currentToolCallId = '';
    currentToolCallName = '';
    currentToolCallArgs = '';
  };

  try {
    while (true) {
      const { done, value } = await readWithTimeout();
      if (done) break;

      chunksReceived++;
      if (onProgress) onProgress();

      // Periodic keepalive — returns false to signal graceful stream split.
      if (onKeepAlive && Date.now() - lastKeepAliveMs >= 10_000) {
        const shouldContinue = await onKeepAlive();
        lastKeepAliveMs = Date.now();
        if (!shouldContinue) {
          console.log(`[parseAnthropicSSE] Stream split after ${chunksReceived} chunks, content: ${content.length} chars`);
          finishReason = 'stream_split';
          break;
        }
      }

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n');
      buffer = parts.pop() || '';

      let currentEventType = '';

      for (const part of parts) {
        const trimmed = part.trim();

        // Track event type
        if (trimmed.startsWith('event: ')) {
          currentEventType = trimmed.slice(7).trim();
          continue;
        }

        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data);

          // Handle error events
          if (chunk.type === 'error' || chunk.error) {
            const err = chunk.error || chunk;
            const msg = typeof err.message === 'string' ? err.message : JSON.stringify(err);
            throw new Error(`STREAM_PROVIDER_ERROR: ${msg}`);
          }

          switch (chunk.type || currentEventType) {
            case 'message_start': {
              const message = chunk.message;
              if (message?.id) messageId = message.id;
              if (message?.model) model = message.model;
              if (message?.usage) {
                usage = {
                  prompt_tokens: message.usage.input_tokens || 0,
                  completion_tokens: message.usage.output_tokens || 0,
                  total_tokens: (message.usage.input_tokens || 0) + (message.usage.output_tokens || 0),
                };
              }
              break;
            }

            case 'content_block_start': {
              currentBlockIndex = chunk.index ?? -1;
              const block = chunk.content_block;
              if (block?.type === 'tool_use') {
                currentBlockType = 'tool_use';
                currentToolCallId = block.id || '';
                currentToolCallName = block.name || '';
                currentToolCallArgs = '';
              } else if (block?.type === 'thinking') {
                currentBlockType = 'thinking';
              } else {
                currentBlockType = 'text';
              }
              break;
            }

            case 'content_block_delta': {
              const delta = chunk.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                content += delta.text;
              } else if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
                currentToolCallArgs += delta.partial_json;
              } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                reasoningContent += delta.thinking;
              }
              break;
            }

            case 'content_block_stop': {
              finalizeToolCall();
              break;
            }

            case 'message_delta': {
              if (chunk.delta?.stop_reason) {
                // Map Anthropic stop reasons to OpenAI format
                const stopReason = chunk.delta.stop_reason;
                if (stopReason === 'end_turn') {
                  finishReason = 'stop';
                } else if (stopReason === 'tool_use') {
                  finishReason = 'tool_calls';
                } else if (stopReason === 'max_tokens') {
                  finishReason = 'length';
                } else {
                  finishReason = stopReason;
                }
              }
              if (chunk.usage?.output_tokens && usage) {
                usage.completion_tokens = chunk.usage.output_tokens;
                usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
              }
              break;
            }

            case 'message_stop':
              // Stream complete
              break;
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('STREAM_PROVIDER_ERROR:')) throw e;
          console.error('[parseAnthropicSSE] Failed to parse chunk:', data, e);
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'STREAM_READ_TIMEOUT') {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Streaming read timeout (no data for ${idleTimeoutMs / 1000}s after ${chunksReceived} chunks), content_length: ${content.length}`);
    }
    throw err;
  }

  // On stream split, finalize any in-progress tool call and filter
  // tool calls with incomplete JSON arguments (truncated mid-stream).
  let validToolCalls = [...toolCalls];
  if (finishReason === 'stream_split') {
    // Finalize in-progress tool call (may have incomplete args)
    if (currentBlockType === 'tool_use' && currentToolCallId) {
      validToolCalls.push({
        id: currentToolCallId,
        type: 'function',
        function: { name: currentToolCallName, arguments: currentToolCallArgs },
      });
    }
    const before = validToolCalls.length;
    validToolCalls = validToolCalls.filter(tc => {
      if (!tc.id || !tc.function.name) return false;
      try { JSON.parse(tc.function.arguments); return true; } catch { return false; }
    });
    if (validToolCalls.length < before) {
      console.log(`[parseAnthropicSSE] Filtered ${before - validToolCalls.length} incomplete tool calls after stream split`);
    }
  }

  const message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
  } = {
    role: 'assistant',
    content: content || null,
    tool_calls: validToolCalls.length > 0 ? validToolCalls : undefined,
  };

  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  console.log(`[parseAnthropicSSE] Complete: ${chunksReceived} chunks, content: ${content.length} chars, tools: ${validToolCalls.length}${finishReason === 'stream_split' ? ' (split)' : ''}${model ? `, model: ${model}` : ''}`);

  return {
    choices: [{ message, finish_reason: finishReason }],
    usage,
    model,
    id: messageId,
  };
}
