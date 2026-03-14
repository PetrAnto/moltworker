import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcontextClient } from './client';
import { AVAILABLE_TOOLS, TOOLS_WITHOUT_BROWSER, executeTool } from '../openrouter/tools';

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
    const client = new AcontextClient('k', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, bytesWritten: 12 }));

    const result = await client.writeFile({
      sessionId: 's1',
      name: 'notes.txt',
      content: 'hello world!',
    });

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

  it('readFile returns file content', async () => {
    const client = new AcontextClient('k', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: 'abc', size: 3 }));

    const result = await client.readFile({ sessionId: 's1', name: 'a/b.txt' });

    expect(result).toEqual({ content: 'abc', size: 3 });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files/a%2Fb.txt?session_id=s1');
    expect(options.method).toBe('GET');
  });

  it('readFile returns null on 404', async () => {
    const client = new AcontextClient('k', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    const result = await client.readFile({ sessionId: 's1', name: 'missing.txt' });

    expect(result).toBeNull();
  });

  it('listFiles sends session and prefix params', async () => {
    const client = new AcontextClient('k', 'https://api.test.com');
    const files = [{ name: 'data/a.json', size: 1, updatedAt: '2026-01-01T00:00:00Z' }];
    mockFetch.mockResolvedValueOnce(jsonResponse(files));

    const result = await client.listFiles({ sessionId: 's1', prefix: 'data/' });

    expect(result).toEqual(files);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files?session_id=s1&prefix=data%2F');
    expect(options.method).toBe('GET');
  });

  it('deleteFile sends encoded path and session', async () => {
    const client = new AcontextClient('k', 'https://api.test.com');
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

    const result = await client.deleteFile({ sessionId: 's1', name: 'data/a b.txt' });

    expect(result).toEqual({ success: true });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/api/v1/disk/files/data%2Fa%20b.txt?session_id=s1');
    expect(options.method).toBe('DELETE');
  });
});

describe('persistent disk tool definitions', () => {
  it('includes new disk tools in AVAILABLE_TOOLS', () => {
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
});

describe('save_file tool', () => {
  it('saves file successfully', async () => {
    const listFiles = vi.fn().mockResolvedValue([]);
    const writeFile = vi.fn().mockResolvedValue({ success: true, bytesWritten: 11 });

    const result = await executeTool({
      id: '1',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'memo.txt', content: 'hello world' }) },
    }, {
      acontextClient: { listFiles, writeFile } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    });

    expect(result.content).toBe('File saved: memo.txt (11 bytes)');
    expect(writeFile).toHaveBeenCalledWith({ sessionId: 'task-1', name: 'memo.txt', content: 'hello world' });
  });

  it('returns graceful error when acontext client is missing', async () => {
    const result = await executeTool({
      id: '2',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'x.txt', content: 'x' }) },
    });

    expect(result.content).toBe('Error: File storage not available (Acontext not configured)');
  });

  it('blocks path traversal in file name', async () => {
    const result = await executeTool({
      id: '3',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: '../secret.txt', content: 'x' }) },
    }, {
      acontextClient: { listFiles: vi.fn(), writeFile: vi.fn() } as unknown as AcontextClient,
    });

    expect(result.content).toContain('Invalid file name');
  });

  it('blocks absolute paths', async () => {
    const result = await executeTool({
      id: '4',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: '/tmp/x.txt', content: 'x' }) },
    }, {
      acontextClient: { listFiles: vi.fn(), writeFile: vi.fn() } as unknown as AcontextClient,
    });

    expect(result.content).toContain('Invalid file name');
  });

  it('blocks null bytes in file name', async () => {
    const result = await executeTool({
      id: '5',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'bad\u0000name.txt', content: 'x' }) },
    }, {
      acontextClient: { listFiles: vi.fn(), writeFile: vi.fn() } as unknown as AcontextClient,
    });

    expect(result.content).toContain('Invalid file name');
  });

  it('blocks null bytes in content', async () => {
    const listFiles = vi.fn().mockResolvedValue([]);
    const result = await executeTool({
      id: '6',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'x.txt', content: 'abc\u0000def' }) },
    }, {
      acontextClient: { listFiles, writeFile: vi.fn() } as unknown as AcontextClient,
    });

    expect(result.content).toBe('Error: File content must be text (null bytes are not allowed)');
  });

  it('enforces max file size', async () => {
    const listFiles = vi.fn().mockResolvedValue([]);
    const result = await executeTool({
      id: '7',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'big.txt', content: 'a'.repeat(1_000_001) }) },
    }, {
      acontextClient: { listFiles, writeFile: vi.fn() } as unknown as AcontextClient,
    });

    expect(result.content).toBe('Error: File too large (max 1000000 bytes)');
  });

  it('enforces max file count for new files', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ name: `f-${i}.txt`, size: i, updatedAt: '2026-01-01T00:00:00Z' }));
    const listFiles = vi.fn().mockResolvedValue(files);

    const result = await executeTool({
      id: '8',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'new.txt', content: 'x' }) },
    }, {
      acontextClient: { listFiles, writeFile: vi.fn() } as unknown as AcontextClient,
    });

    expect(result.content).toBe('Error: File limit reached (max 100 files per session)');
  });

  it('allows overwrite when file already exists at max count', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ name: `f-${i}.txt`, size: i, updatedAt: '2026-01-01T00:00:00Z' }));
    files[0] = { name: 'existing.txt', size: 1, updatedAt: '2026-01-01T00:00:00Z' };
    const listFiles = vi.fn().mockResolvedValue(files);
    const writeFile = vi.fn().mockResolvedValue({ success: true, bytesWritten: 4 });

    const result = await executeTool({
      id: '9',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'existing.txt', content: 'edit' }) },
    }, {
      acontextClient: { listFiles, writeFile } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    });

    expect(result.content).toBe('File saved: existing.txt (4 bytes)');
    expect(writeFile).toHaveBeenCalled();
  });
});

describe('read_saved_file tool', () => {
  it('reads file content', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'hello', size: 5 });

    const result = await executeTool({
      id: '10',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'memo.txt' }) },
    }, {
      acontextClient: { readFile } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    });

    expect(result.content).toBe('hello');
    expect(readFile).toHaveBeenCalledWith({ sessionId: 'task-1', name: 'memo.txt' });
  });

  it('returns not found message', async () => {
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
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'memo.txt' }) },
    });

    expect(result.content).toBe('Error: File storage not available (Acontext not configured)');
  });
});

describe('list_saved_files tool', () => {
  it('lists files with prefix', async () => {
    const listFiles = vi.fn().mockResolvedValue([
      { name: 'data/z.txt', size: 1, updatedAt: '2026-01-01T00:00:00Z' },
      { name: 'data/a.txt', size: 2, updatedAt: '2026-01-02T00:00:00Z' },
    ]);

    const result = await executeTool({
      id: '13',
      type: 'function',
      function: { name: 'list_saved_files', arguments: JSON.stringify({ prefix: 'data/' }) },
    }, {
      acontextClient: { listFiles } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    });

    expect(result.content).toContain('Saved files (2) for prefix "data/"');
    expect(result.content).toContain('data/a.txt');
    expect(result.content).toContain('data/z.txt');
    expect(listFiles).toHaveBeenCalledWith({ sessionId: 'task-1', prefix: 'data/' });
  });

  it('lists files without prefix', async () => {
    const listFiles = vi.fn().mockResolvedValue([
      { name: 'a.txt', size: 1, updatedAt: '2026-01-01T00:00:00Z' },
    ]);

    const result = await executeTool({
      id: '14',
      type: 'function',
      function: { name: 'list_saved_files', arguments: '{}' },
    }, { acontextClient: { listFiles } as unknown as AcontextClient });

    expect(result.content).toContain('Saved files (1):');
    expect(listFiles).toHaveBeenCalledWith({ sessionId: 'default', prefix: undefined });
  });

  it('returns empty message for no files', async () => {
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
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'memo.txt' }) },
    }, {
      acontextClient: { deleteFile } as unknown as AcontextClient,
      acontextSessionId: 'task-1',
    });

    expect(result.content).toBe('File deleted: memo.txt');
    expect(deleteFile).toHaveBeenCalledWith({ sessionId: 'task-1', name: 'memo.txt' });
  });

  it('returns file not found when delete reports false', async () => {
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
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'memo.txt' }) },
    });

    expect(result.content).toBe('Error: File storage not available (Acontext not configured)');
  });
});
