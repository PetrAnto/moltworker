import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcontextClient } from './client';
import { AVAILABLE_TOOLS, executeTool } from '../openrouter/tools';
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

describe('AcontextClient Disk API', () => {
  const client = new AcontextClient('test-key', 'https://api.test.com');

  it('writeFile uses disk endpoint and payload', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, bytesWritten: 11 }));

    const result = await client.writeFile({ sessionId: 's1', name: 'notes/todo.txt', content: 'hello world' });

    expect(result).toEqual({ success: true, bytesWritten: 11 });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/sessions/s1/disk/files');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ name: 'notes/todo.txt', content: 'hello world' });
  });

  it('readFile uses encoded path', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: 'abc', size: 3 }));

    const result = await client.readFile({ sessionId: 's1', name: 'dir/file name.txt' });

    expect(result).toEqual({ content: 'abc', size: 3 });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/sessions/s1/disk/files/dir%2Ffile%20name.txt');
    expect(options.method).toBe('GET');
  });

  it('readFile returns null on 404', async () => {
    mockFetch.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    await expect(client.readFile({ sessionId: 's1', name: 'missing.txt' })).resolves.toBeNull();
  });

  it('listFiles works without prefix', async () => {
    const files = [{ name: 'a.txt', size: 1, updatedAt: '2026-01-01T00:00:00Z' }];
    mockFetch.mockResolvedValueOnce(jsonResponse(files));

    const result = await client.listFiles({ sessionId: 's1' });

    expect(result).toEqual(files);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/sessions/s1/disk/files');
  });

  it('listFiles works with prefix', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    await client.listFiles({ sessionId: 's1', prefix: 'data/' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/sessions/s1/disk/files?prefix=data%2F');
  });

  it('deleteFile sends DELETE and returns success true', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await client.deleteFile({ sessionId: 's1', name: 'old.txt' });

    expect(result).toEqual({ success: true });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/sessions/s1/disk/files/old.txt');
    expect(options.method).toBe('DELETE');
  });

  it('deleteFile returns success false on 404', async () => {
    mockFetch.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    await expect(client.deleteFile({ sessionId: 's1', name: 'missing.txt' })).resolves.toEqual({ success: false });
  });
});

describe('saved file tool definitions', () => {
  it('registers all file tools', () => {
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'save_file')).toBe(true);
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'read_saved_file')).toBe(true);
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'list_saved_files')).toBe(true);
    expect(AVAILABLE_TOOLS.some(t => t.function.name === 'delete_saved_file')).toBe(true);
  });

  it('puts only read/list in parallel-safe set', () => {
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

  it('saves a file', async () => {
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

  it('rejects null bytes and oversize content', async () => {
    const withNull = await executeTool({
      id: '5',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'a.txt', content: 'abc\u0000def' }) },
    }, { acontextClient: { listFiles: vi.fn(), writeFile: vi.fn() } as unknown as AcontextClient });

    const tooLarge = await executeTool({
      id: '6',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'big.txt', content: 'x'.repeat(1_000_001) }) },
    }, { acontextClient: { listFiles: vi.fn(), writeFile: vi.fn() } as unknown as AcontextClient });

    expect(withNull.content).toContain('Binary data is not supported');
    expect(tooLarge.content).toContain('File too large');
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
});

describe('read/list/delete saved file tools', () => {
  it('read_saved_file returns content', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'hello', size: 5 });

    const result = await executeTool({
      id: '8',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'a.txt' }) },
    }, { acontextClient: { readFile } as unknown as AcontextClient });

    expect(result.content).toBe('hello');
  });

  it('read_saved_file handles not found', async () => {
    const readFile = vi.fn().mockResolvedValue(null);

    const result = await executeTool({
      id: '9',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'missing.txt' }) },
    }, { acontextClient: { readFile } as unknown as AcontextClient });

    expect(result.content).toBe('File not found: missing.txt');
  });

  it('list_saved_files supports prefix and empty results', async () => {
    const listFiles = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: 'data/a.json', size: 12, updatedAt: '2026-01-01T00:00:00Z' }]);

    const empty = await executeTool({
      id: '10',
      type: 'function',
      function: { name: 'list_saved_files', arguments: JSON.stringify({ prefix: 'data/' }) },
    }, { acontextClient: { listFiles } as unknown as AcontextClient });

    const listed = await executeTool({
      id: '11',
      type: 'function',
      function: { name: 'list_saved_files', arguments: JSON.stringify({ prefix: 'data/' }) },
    }, { acontextClient: { listFiles } as unknown as AcontextClient });

    expect(empty.content).toBe('No saved files found with prefix: data/');
    expect(listed.content).toContain('Saved files (1):');
    expect(listed.content).toContain('data/a.json (12 bytes');
  });

  it('delete_saved_file reports success and not found', async () => {
    const deleteFile = vi.fn().mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });

    const ok = await executeTool({
      id: '12',
      type: 'function',
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'a.txt' }) },
    }, { acontextClient: { deleteFile } as unknown as AcontextClient });

    const miss = await executeTool({
      id: '13',
      type: 'function',
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'missing.txt' }) },
    }, { acontextClient: { deleteFile } as unknown as AcontextClient });

    expect(ok.content).toBe('File deleted: a.txt');
    expect(miss.content).toBe('File not found: missing.txt');
  });

  it('all saved file tools return unavailable error without client', async () => {
    const read = await executeTool({
      id: '14',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'a.txt' }) },
    });
    const list = await executeTool({
      id: '15',
      type: 'function',
      function: { name: 'list_saved_files', arguments: JSON.stringify({}) },
    });
    const del = await executeTool({
      id: '16',
      type: 'function',
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'a.txt' }) },
    });

    expect(read.content).toBe('Error: File storage not available (Acontext not configured)');
    expect(list.content).toBe('Error: File storage not available (Acontext not configured)');
    expect(del.content).toBe('Error: File storage not available (Acontext not configured)');
  });
});
