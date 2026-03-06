import { describe, it, expect } from 'vitest';
import { buildAnthropicRequest, buildAnthropicHeaders, parseAnthropicSSEStream } from './anthropic-direct';
import type { ChatMessage } from './client';
import type { ToolDefinition } from './tools';

describe('buildAnthropicHeaders', () => {
  it('uses x-api-key instead of Bearer auth', () => {
    const headers = buildAnthropicHeaders('sk-ant-test123');
    expect(headers['x-api-key']).toBe('sk-ant-test123');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBeUndefined();
  });
});

describe('buildAnthropicRequest', () => {
  const baseMessages: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
  ];

  it('extracts system message to top-level param', () => {
    const req = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-6-20250514',
      messages: baseMessages,
      maxTokens: 4096,
    });

    expect(req.system).toBe('You are a helpful assistant.');
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe('user');
    expect(req.messages[0].content).toBe('Hello!');
  });

  it('sets stream to true', () => {
    const req = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-6-20250514',
      messages: baseMessages,
      maxTokens: 4096,
    });
    expect(req.stream).toBe(true);
  });

  it('converts tool_calls to tool_use content blocks', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search for X' },
      {
        role: 'assistant',
        content: 'Let me search.',
        tool_calls: [{
          id: 'tc_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"X"}' },
        }],
      },
      {
        role: 'tool',
        content: 'Search results for X...',
        tool_call_id: 'tc_1',
      },
    ];

    const req = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-6-20250514',
      messages,
      maxTokens: 4096,
    });

    // Assistant message should have tool_use blocks
    const assistantMsg = req.messages.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    const blocks = assistantMsg!.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>;
    expect(blocks).toHaveLength(2); // text + tool_use
    expect(blocks[0].type).toBe('text');
    expect(blocks[1].type).toBe('tool_use');
    expect(blocks[1].id).toBe('tc_1');
    expect(blocks[1].name).toBe('web_search');
    expect(blocks[1].input).toEqual({ query: 'X' });
  });

  it('converts tool results to user messages with tool_result blocks', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search for X' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"X"}' },
        }],
      },
      {
        role: 'tool',
        content: 'Found results',
        tool_call_id: 'tc_1',
      },
    ];

    const req = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-6-20250514',
      messages,
      maxTokens: 4096,
    });

    // Tool result should become a user message with tool_result block
    const userMsgs = req.messages.filter(m => m.role === 'user');
    // First user + tool result merged (both are 'user' role)
    // Actually: user "Search for X" + tool_result should be separate user messages
    // but they get merged because they're both 'user' role with an assistant in between
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    const lastUser = userMsgs[userMsgs.length - 1];
    const blocks = lastUser.content as Array<{ type: string; tool_use_id?: string }>;
    expect(blocks.some(b => b.type === 'tool_result')).toBe(true);
  });

  it('merges consecutive same-role messages', () => {
    // Two consecutive user messages (e.g. user prompt + injected system notice as 'user')
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'World' },
    ];

    const req = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-6-20250514',
      messages,
      maxTokens: 4096,
    });

    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe('user');
    // Content merged into blocks
    const blocks = req.messages[0].content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe('Hello');
    expect(blocks[1].text).toBe('World');
  });

  it('converts tools to Anthropic format', () => {
    const tools: ToolDefinition[] = [{
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search query' } },
          required: ['query'],
        },
      },
    }];

    const req = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-6-20250514',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 4096,
      tools,
      toolChoice: 'auto',
    });

    expect(req.tools).toHaveLength(1);
    expect(req.tools![0].name).toBe('web_search');
    expect(req.tools![0].input_schema).toEqual(tools[0].function.parameters);
    expect(req.tool_choice).toEqual({ type: 'auto' });
  });

  it('preserves cache_control on system message content parts', () => {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [{
          type: 'text',
          text: 'System prompt',
          cache_control: { type: 'ephemeral' },
        }],
      },
      { role: 'user', content: 'Hello' },
    ];

    const req = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-6-20250514',
      messages,
      maxTokens: 4096,
    });

    const system = req.system as Array<{ type: string; cache_control?: { type: string } }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('parseAnthropicSSEStream', () => {
  function createSSEStream(events: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const chunks = events.map(e => encoder.encode(e + '\n\n'));
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    });
  }

  it('parses text response', async () => {
    const stream = createSSEStream([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","model":"claude-sonnet-4-6-20250514","usage":{"input_tokens":100,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world!"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);

    const result = await parseAnthropicSSEStream(stream);
    expect(result.choices[0].message.content).toBe('Hello world!');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage?.prompt_tokens).toBe(100);
    expect(result.usage?.completion_tokens).toBe(10);
  });

  it('parses tool_use response', async () => {
    const stream = createSSEStream([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_456","model":"claude-sonnet-4-6-20250514","usage":{"input_tokens":200,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me search."}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_123","name":"web_search"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":\\"test\\"}"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":50}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);

    const result = await parseAnthropicSSEStream(stream);
    expect(result.choices[0].message.content).toBe('Let me search.');
    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].message.tool_calls![0].id).toBe('toolu_123');
    expect(result.choices[0].message.tool_calls![0].function.name).toBe('web_search');
    expect(result.choices[0].message.tool_calls![0].function.arguments).toBe('{"query":"test"}');
  });

  it('maps stop_reason correctly', async () => {
    const stream = createSSEStream([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_789","model":"test","usage":{"input_tokens":10,"output_tokens":0}}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":100}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);

    const result = await parseAnthropicSSEStream(stream);
    expect(result.choices[0].finish_reason).toBe('length');
  });

  it('fires onToolCallReady callback', async () => {
    const stream = createSSEStream([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_cb","model":"test","usage":{"input_tokens":10,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_cb","name":"github_read_file"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"test.ts\\"}"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);

    const readyCalls: string[] = [];
    await parseAnthropicSSEStream(stream, 30000, undefined, (tc) => {
      readyCalls.push(tc.function.name);
    });

    expect(readyCalls).toEqual(['github_read_file']);
  });

  it('handles stream errors', async () => {
    const stream = createSSEStream([
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    ]);

    await expect(parseAnthropicSSEStream(stream)).rejects.toThrow('STREAM_PROVIDER_ERROR');
  });
});
