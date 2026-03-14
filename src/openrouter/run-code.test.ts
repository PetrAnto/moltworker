import { describe, expect, it, vi } from 'vitest';
import { AVAILABLE_TOOLS, TOOLS_WITHOUT_BROWSER, executeTool, type ToolContext } from './tools';
import type { AcontextClient } from '../acontext/client';

describe('run_code tool definition', () => {
  it('is included in AVAILABLE_TOOLS and TOOLS_WITHOUT_BROWSER', () => {
    expect(AVAILABLE_TOOLS.find(t => t.function.name === 'run_code')).toBeDefined();
    expect(TOOLS_WITHOUT_BROWSER.find(t => t.function.name === 'run_code')).toBeDefined();
  });
});

describe('run_code tool execution', () => {
  function buildToolCall(args: Record<string, unknown>) {
    return {
      id: 'call-1',
      type: 'function' as const,
      function: {
        name: 'run_code',
        arguments: JSON.stringify(args),
      },
    };
  }

  it('returns graceful error when Acontext client missing', async () => {
    const result = await executeTool(buildToolCall({ language: 'bash', code: 'echo hi' }));
    expect(result.content).toBe('Error: Code execution not available (Acontext not configured)');
  });

  it('dispatches to acontextClient.executeCode and returns stdout', async () => {
    const executeCode = vi.fn().mockResolvedValue({
      stdout: '42\n',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 10,
    });

    const context: ToolContext = {
      acontextClient: { executeCode } as unknown as AcontextClient,
      acontextSessionId: 'task-123',
    };

    const result = await executeTool(buildToolCall({ language: 'python', code: 'print(42)', timeout: 60 }), context);

    expect(executeCode).toHaveBeenCalledWith({
      sessionId: 'task-123',
      language: 'python',
      code: 'print(42)',
      timeout: 60,
    });
    expect(result.content).toBe('42\n');
  });

  it('uses default session id when missing', async () => {
    const executeCode = vi.fn().mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 10,
    });

    const context: ToolContext = {
      acontextClient: { executeCode } as unknown as AcontextClient,
    };

    await executeTool(buildToolCall({ language: 'bash', code: 'echo ok' }), context);

    expect(executeCode).toHaveBeenCalledWith({
      sessionId: 'default',
      language: 'bash',
      code: 'echo ok',
      timeout: 30,
    });
  });

  it('clamps timeout to min 5 and max 120', async () => {
    const executeCode = vi.fn().mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 10,
    });
    const context: ToolContext = {
      acontextClient: { executeCode } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    };

    await executeTool(buildToolCall({ language: 'bash', code: 'echo ok', timeout: 1 }), context);
    await executeTool(buildToolCall({ language: 'bash', code: 'echo ok', timeout: 200 }), context);

    expect(executeCode.mock.calls[0][0].timeout).toBe(5);
    expect(executeCode.mock.calls[1][0].timeout).toBe(120);
  });

  it('includes stderr section when present', async () => {
    const executeCode = vi.fn().mockResolvedValue({
      stdout: 'out',
      stderr: 'err',
      exitCode: 1,
      executionTimeMs: 10,
    });
    const context: ToolContext = {
      acontextClient: { executeCode } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    };

    const result = await executeTool(buildToolCall({ language: 'javascript', code: 'throw new Error()' }), context);
    expect(result.content).toContain('out');
    expect(result.content).toContain('STDERR:\nerr');
  });

  it('returns exit code message when no output', async () => {
    const executeCode = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 7,
      executionTimeMs: 10,
    });
    const context: ToolContext = {
      acontextClient: { executeCode } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    };

    const result = await executeTool(buildToolCall({ language: 'bash', code: 'exit 7' }), context);
    expect(result.content).toBe('(no output, exit code: 7)');
  });

  it('truncates output to 50KB', async () => {
    const longStdout = 'a'.repeat(60000);
    const executeCode = vi.fn().mockResolvedValue({
      stdout: longStdout,
      stderr: '',
      exitCode: 0,
      executionTimeMs: 10,
    });
    const context: ToolContext = {
      acontextClient: { executeCode } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    };

    const result = await executeTool(buildToolCall({ language: 'python', code: 'print("x")' }), context);
    expect(result.content.length).toBeLessThanOrEqual(50016);
    expect(result.content.endsWith('\n... (truncated)')).toBe(true);
  });

  it('returns execution error for invalid language', async () => {
    const executeCode = vi.fn();
    const context: ToolContext = {
      acontextClient: { executeCode } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    };

    const result = await executeTool(buildToolCall({ language: 'ruby', code: 'puts 1' }), context);
    expect(result.content).toContain('Error executing run_code: Invalid language: ruby');
  });

  it('returns execution error for empty code', async () => {
    const executeCode = vi.fn();
    const context: ToolContext = {
      acontextClient: { executeCode } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    };

    const result = await executeTool(buildToolCall({ language: 'python', code: '' }), context);
    expect(result.content).toContain('Error executing run_code: Code must be a non-empty string.');
  });

  it('propagates network/API errors from acontext client', async () => {
    const executeCode = vi.fn().mockRejectedValue(new Error('network down'));
    const context: ToolContext = {
      acontextClient: { executeCode } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    };

    const result = await executeTool(buildToolCall({ language: 'bash', code: 'echo hi' }), context);
    expect(result.content).toBe('Error executing run_code: network down');
  });
});
