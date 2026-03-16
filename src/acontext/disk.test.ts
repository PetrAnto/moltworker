import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcontextClient } from './client';
import { AVAILABLE_TOOLS, TOOLS_WITHOUT_BROWSER, executeTool } from '../openrouter/tools';
import { readFileSync } from 'node:fs';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AcontextClient disk methods', () => {
  it('writeFile sends expected payload', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, bytesWritten: 12 }));

    const result = await client.writeFile({ sessionId: 's1', name: 'notes.txt', content: 'hello world!' });

    expect(result).toEqual({ success: true, bytesWritten: 12 });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      session_id: 's1',
      name: 'notes.txt',
      content: 'hello world!',
    });
  });

  it('readFile returns content when found', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: 'abc', size: 3 }));

    const result = await client.readFile({ sessionId: 'task-1', name: 'data/out.txt' });

    expect(result).toEqual({ content: 'abc', size: 3 });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files/task-1/data%2Fout.txt');
    expect(options.method).toBe('GET');
  });

  it('readFile returns null on 404', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    const result = await client.readFile({ sessionId: 'task-1', name: 'missing.txt' });

    expect(result).toBeNull();
  });

  it('listFiles supports optional prefix', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse([{ name: 'data/a.txt', size: 2, updatedAt: '2026-01-01T00:00:00Z' }]));

    const result = await client.listFiles({ sessionId: 'task-1', prefix: 'data/' });

    expect(result).toHaveLength(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files?session_id=task-1&prefix=data%2F');
    expect(options.method).toBe('GET');
  });

  it('listFiles works without prefix', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    await client.listFiles({ sessionId: 's1' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files?session_id=s1');
  });

  it('deleteFile returns success=true', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await client.deleteFile({ sessionId: 'task-1', name: 'x.txt' });

    expect(result).toEqual({ success: true });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files/task-1/x.txt');
    expect(options.method).toBe('DELETE');
  });

  it('deleteFile returns success=false on 404', async () => {
    const client = new AcontextClient('test-key', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    const result = await client.deleteFile({ sessionId: 'task-1', name: 'x.txt' });

    expect(result).toEqual({ success: false });
  });
});

describe('saved file tool definitions', () => {
  it('includes all disk tools in AVAILABLE_TOOLS', () => {
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'save_file')).toBe(true);
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'read_saved_file')).toBe(true);
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'list_saved_files')).toBe(true);
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'delete_saved_file')).toBe(true);
  });

  it('includes disk tools in TOOLS_WITHOUT_BROWSER', () => {
    expect(TOOLS_WITHOUT_BROWSER.some(t => t.function.name === 'save_file')).toBe(true);
    expect(TOOLS_WITHOUT_BROWSER.some(t => t.function.name === 'read_saved_file')).toBe(true);
    expect(TOOLS_WITHOUT_BROWSER.some(t => t.function.name === 'list_saved_files')).toBe(true);
    expect(TOOLS_WITHOUT_BROWSER.some(t => t.function.name === 'delete_saved_file')).toBe(true);
  });

  it('puts only read/list in PARALLEL_SAFE_TOOLS', () => {
    const taskProcessorSource = readFileSync('src/durable-objects/task-processor.ts', 'utf-8');
    const parallelSetSource = taskProcessorSource.split('export const PARALLEL_SAFE_TOOLS = new Set([')[1]?.split(']);')[0] || '';

    expect(parallelSetSource).toContain("'read_saved_file'");
    expect(parallelSetSource).toContain("'list_saved_files'");
    expect(parallelSetSource).not.toContain("'save_file'");
    expect(parallelSetSource).not.toContain("'delete_saved_file'");
  });
});

describe('save_file tool', () => {
  it('returns graceful error without acontext client', async () => {
    const result = await executeTool({
      id: '1',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'a.txt', content: 'x' }) },
    });

    expect(result.content).toBe('Error: File storage not available (Acontext not configured)');
  });

  it('saves a file successfully', async () => {
    const listFiles = vi.fn().mockResolvedValue([]);
    const writeFile = vi.fn().mockResolvedValue({ success: true, bytesWritten: 5 });

    const result = await executeTool({
      id: '2',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'a.txt', content: 'hello' }) },
    }, { acontextClient: { listFiles, writeFile } as unknown as AcontextClient, acontextSessionId: 'task-1' });

    expect(result.content).toBe('File saved: a.txt (5 bytes)');
    expect(listFiles).toHaveBeenCalledWith({ sessionId: 'task-1' });
    expect(writeFile).toHaveBeenCalledWith({ sessionId: 'task-1', name: 'a.txt', content: 'hello' });
  });

  it('rejects path traversal and absolute paths', async () => {
    const bad1 = await executeTool({
      id: '3',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: '../secrets.txt', content: 'x' }) },
    }, { acontextClient: { listFiles: vi.fn(), writeFile: vi.fn() } as unknown as AcontextClient });

    const bad2 = await executeTool({
      id: '4',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: '/etc/passwd', content: 'x' }) },
    }, { acontextClient: { listFiles: vi.fn(), writeFile: vi.fn() } as unknown as AcontextClient });

    expect(bad1.content).toContain('Path traversal is not allowed');
    expect(bad2.content).toContain('Use relative paths only');
  });

  it('rejects null bytes in content', async () => {
    const result = await executeTool({
      id: '5',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'a.txt', content: 'abc\u0000def' }) },
    }, { acontextClient: { listFiles: vi.fn().mockResolvedValue([]), writeFile: vi.fn() } as unknown as AcontextClient });

    expect(result.content).toContain('Binary content is not supported');
  });

  it('rejects oversize content', async () => {
    const result = await executeTool({
      id: '6',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'big.txt', content: 'x'.repeat(1_000_001) }) },
    }, { acontextClient: { listFiles: vi.fn().mockResolvedValue([]), writeFile: vi.fn() } as unknown as AcontextClient });

    expect(result.content).toContain('File too large');
  });

  it('rejects new file when session file count limit reached', async () => {
    const listFiles = vi.fn().mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({ name: `${i}.txt`, size: 1, updatedAt: 'now' })));
    const writeFile = vi.fn();

    const result = await executeTool({
      id: '7',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'new.txt', content: 'x' }) },
    }, { acontextClient: { listFiles, writeFile } as unknown as AcontextClient });

    expect(result.content).toContain('File limit reached');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('allows overwrite when file already exists at max count', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ name: `f-${i}.txt`, size: i, updatedAt: 'now' }));
    files[0] = { name: 'existing.txt', size: 1, updatedAt: 'now' };
    const listFiles = vi.fn().mockResolvedValue(files);
    const writeFile = vi.fn().mockResolvedValue({ success: true, bytesWritten: 4 });

    const result = await executeTool({
      id: '8',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'existing.txt', content: 'edit' }) },
    }, { acontextClient: { listFiles, writeFile } as unknown as AcontextClient, acontextSessionId: 'task-1' });

    expect(result.content).toBe('File saved: existing.txt (4 bytes)');
    expect(writeFile).toHaveBeenCalled();
  });
});

describe('read_saved_file tool', () => {
  it('returns content', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'hello', size: 5 });

    const result = await executeTool({
      id: '10',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'a.txt' }) },
    }, { acontextClient: { readFile } as unknown as AcontextClient, acontextSessionId: 'task-1' });

    expect(result.content).toBe('hello');
    expect(readFile).toHaveBeenCalledWith({ sessionId: 'task-1', name: 'a.txt' });
  });

  it('handles not found', async () => {
    const readFile = vi.fn().mockResolvedValue(null);

    const result = await executeTool({
      id: '11',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'missing.txt' }) },
    }, { acontextClient: { readFile } as unknown as AcontextClient });

    expect(result.content).toBe('File not found: missing.txt');
  });

  it('returns graceful error when client is missing', async () => {
    const result = await executeTool({
      id: '12',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'a.txt' }) },
    });

    expect(result.content).toBe('Error: File storage not available (Acontext not configured)');
  });
});

describe('list_saved_files tool', () => {
  it('lists files with prefix and sorts alphabetically', async () => {
    const listFiles = vi.fn().mockResolvedValue([
      { name: 'data/z.txt', size: 1, updatedAt: '2026-01-01T00:00:00Z' },
      { name: 'data/a.txt', size: 2, updatedAt: '2026-01-02T00:00:00Z' },
    ]);

    const result = await executeTool({
      id: '13',
      type: 'function',
      function: { name: 'list_saved_files', arguments: JSON.stringify({ prefix: 'data/' }) },
    }, { acontextClient: { listFiles } as unknown as AcontextClient, acontextSessionId: 'task-1' });

    expect(result.content).toContain('Saved files (2) for prefix "data/"');
    // Should be sorted: a before z
    const lines = result.content.split('\n');
    expect(lines[1]).toContain('data/a.txt');
    expect(lines[2]).toContain('data/z.txt');
  });

  it('lists files without prefix', async () => {
    const listFiles = vi.fn().mockResolvedValue([{ name: 'a.txt', size: 1, updatedAt: '2026-01-01T00:00:00Z' }]);

    const result = await executeTool({
      id: '14',
      type: 'function',
      function: { name: 'list_saved_files', arguments: '{}' },
    }, { acontextClient: { listFiles } as unknown as AcontextClient });

    expect(result.content).toContain('Saved files (1):');
    expect(listFiles).toHaveBeenCalledWith({ sessionId: 'default', prefix: undefined });
  });

  it('returns empty message', async () => {
    const listFiles = vi.fn().mockResolvedValue([]);

    const result = await executeTool({
      id: '15',
      type: 'function',
      function: { name: 'list_saved_files', arguments: '{}' },
    }, { acontextClient: { listFiles } as unknown as AcontextClient });

    expect(result.content).toBe('No saved files found.');
  });

  it('returns graceful error when client is missing', async () => {
    const result = await executeTool({
      id: '16',
      type: 'function',
      function: { name: 'list_saved_files', arguments: '{}' },
    });

    expect(result.content).toBe('Error: File storage not available (Acontext not configured)');
  });
});

describe('delete_saved_file tool', () => {
  it('deletes file successfully', async () => {
    const deleteFile = vi.fn().mockResolvedValue({ success: true });

    const result = await executeTool({
      id: '17',
      type: 'function',
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'old.txt' }) },
    }, { acontextClient: { deleteFile } as unknown as AcontextClient, acontextSessionId: 'task-1' });

    expect(result.content).toBe('File deleted: old.txt');
    expect(deleteFile).toHaveBeenCalledWith({ sessionId: 'task-1', name: 'old.txt' });
  });

  it('returns not found for missing file', async () => {
    const deleteFile = vi.fn().mockResolvedValue({ success: false });

    const result = await executeTool({
      id: '18',
      type: 'function',
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'missing.txt' }) },
    }, { acontextClient: { deleteFile } as unknown as AcontextClient });

    expect(result.content).toBe('File not found: missing.txt');
  });

  it('returns graceful error when client is missing', async () => {
    const result = await executeTool({
      id: '19',
      type: 'function',
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'a.txt' }) },
    });

    expect(result.content).toBe('Error: File storage not available (Acontext not configured)');
  });
});

describe('saved files security', () => {
  it('blocks absolute paths in read', async () => {
    const result = await executeTool({
      id: '20',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: '/etc/passwd' }) },
    }, { acontextClient: { readFile: vi.fn() } as unknown as AcontextClient });

    expect(result.content).toContain('relative paths only');
  });

  it('blocks null bytes in delete name', async () => {
    const result = await executeTool({
      id: '21',
      type: 'function',
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'bad\u0000name.txt' }) },
    }, { acontextClient: { deleteFile: vi.fn() } as unknown as AcontextClient });

    expect(result.content).toContain('Null bytes are not allowed');
  });

  it('sanitizes control characters in file names before save', async () => {
    const listFiles = vi.fn().mockResolvedValue([]);
    const writeFile = vi.fn().mockResolvedValue({ success: true, bytesWritten: 1 });

    const result = await executeTool({
      id: '22',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'bad\x01name.txt', content: 'x' }) },
    }, { acontextClient: { listFiles, writeFile } as unknown as AcontextClient });

    expect(writeFile).toHaveBeenCalledWith({
      sessionId: 'default',
      name: 'badname.txt',
      content: 'x',
    });
    expect(result.content).toContain('File saved: badname.txt');
  });
});
