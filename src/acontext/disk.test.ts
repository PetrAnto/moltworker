import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcontextClient } from './client';
import { AVAILABLE_TOOLS, TOOLS_WITHOUT_BROWSER, executeTool, r2SaveFile, r2ReadFile, r2ListFiles, r2DeleteFile, validateSavedFileName, sanitizeSavedFileName } from '../openrouter/tools';
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

    expect(result.content).toBe('Error: File storage not available (no R2 bucket or Acontext configured)');
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

    expect(result.content).toBe('Error: File storage not available (no R2 bucket or Acontext configured)');
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

    expect(result.content).toBe('Error: File storage not available (no R2 bucket or Acontext configured)');
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

    expect(result.content).toBe('Error: File storage not available (no R2 bucket or Acontext configured)');
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

  it('blocks null bytes in file names', async () => {
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

    expect(result.content).toBe('File saved: badname.txt (1 bytes)');
    expect(writeFile).toHaveBeenCalledWith({ sessionId: 'default', name: 'badname.txt', content: 'x' });
  });
});

// --- R2-backed file storage tests ---

function createMockR2(): R2Bucket & { _store: Map<string, { content: string; metadata: Record<string, string> }> } {
  const store = new Map<string, { content: string; metadata: Record<string, string> }>();
  return {
    _store: store,
    put: vi.fn(async (key: string, value: string | ArrayBuffer | ReadableStream, opts?: { customMetadata?: Record<string, string> }) => {
      const content = typeof value === 'string' ? value : '';
      store.set(key, { content, metadata: opts?.customMetadata || {} });
      return {} as R2Object;
    }),
    get: vi.fn(async (key: string) => {
      const item = store.get(key);
      if (!item) return null;
      return {
        text: async () => item.content,
        key,
        size: item.content.length,
        uploaded: new Date(),
        customMetadata: item.metadata,
      } as unknown as R2ObjectBody;
    }),
    head: vi.fn(async (key: string) => {
      const item = store.get(key);
      if (!item) return null;
      return { key, size: item.content.length, uploaded: new Date() } as unknown as R2Object;
    }),
    list: vi.fn(async (opts?: { prefix?: string; limit?: number }) => {
      const prefix = opts?.prefix || '';
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, val]) => ({ key, size: val.content.length, uploaded: new Date('2026-03-19T00:00:00Z') }));
      return { objects, truncated: false } as unknown as R2Objects;
    }),
    delete: vi.fn(async (key: string | string[]) => {
      if (typeof key === 'string') store.delete(key);
    }),
  } as unknown as R2Bucket & { _store: Map<string, { content: string; metadata: Record<string, string> }> };
}

describe('R2 file storage: r2SaveFile / r2ReadFile', () => {
  it('saves and reads a file', async () => {
    const bucket = createMockR2();
    const prefix = 'files/user1/';

    const saveResult = await r2SaveFile(bucket, prefix, 'notes.txt', 'hello world');
    expect(saveResult).toBe('File saved: notes.txt (11 bytes)');

    const readResult = await r2ReadFile(bucket, prefix, 'notes.txt');
    expect(readResult).toBe('hello world');
  });

  it('returns not found for missing file', async () => {
    const bucket = createMockR2();
    const result = await r2ReadFile(bucket, 'files/user1/', 'missing.txt');
    expect(result).toBe('File not found: missing.txt');
  });

  it('overwrites existing file', async () => {
    const bucket = createMockR2();
    const prefix = 'files/user1/';

    await r2SaveFile(bucket, prefix, 'a.txt', 'v1');
    await r2SaveFile(bucket, prefix, 'a.txt', 'v2');

    const result = await r2ReadFile(bucket, prefix, 'a.txt');
    expect(result).toBe('v2');
  });
});

describe('R2 file storage: r2ListFiles', () => {
  it('lists files with per-user prefix stripping', async () => {
    const bucket = createMockR2();
    const prefix = 'files/user1/';

    await r2SaveFile(bucket, prefix, 'a.txt', 'x');
    await r2SaveFile(bucket, prefix, 'dir/b.txt', 'y');

    const files = await r2ListFiles(bucket, prefix);
    expect(files).toHaveLength(2);
    expect(files.map(f => f.name).sort()).toEqual(['a.txt', 'dir/b.txt']);
    // Names should NOT include the prefix
    expect(files.every(f => !f.name.startsWith('files/'))).toBe(true);
  });

  it('filters by sub-prefix', async () => {
    const bucket = createMockR2();
    const prefix = 'files/user1/';

    await r2SaveFile(bucket, prefix, 'a.txt', 'x');
    await r2SaveFile(bucket, prefix, 'data/b.txt', 'y');
    await r2SaveFile(bucket, prefix, 'data/c.txt', 'z');

    const files = await r2ListFiles(bucket, prefix, 'data/');
    expect(files).toHaveLength(2);
    expect(files.map(f => f.name).sort()).toEqual(['data/b.txt', 'data/c.txt']);
  });

  it('returns empty array for no files', async () => {
    const bucket = createMockR2();
    const files = await r2ListFiles(bucket, 'files/user1/');
    expect(files).toEqual([]);
  });
});

describe('R2 file storage: r2DeleteFile', () => {
  it('deletes existing file', async () => {
    const bucket = createMockR2();
    const prefix = 'files/user1/';

    await r2SaveFile(bucket, prefix, 'a.txt', 'x');
    const deleted = await r2DeleteFile(bucket, prefix, 'a.txt');
    expect(deleted).toBe(true);

    const result = await r2ReadFile(bucket, prefix, 'a.txt');
    expect(result).toBe('File not found: a.txt');
  });

  it('returns false for missing file', async () => {
    const bucket = createMockR2();
    const deleted = await r2DeleteFile(bucket, 'files/user1/', 'missing.txt');
    expect(deleted).toBe(false);
  });
});

describe('R2 file tools via executeTool', () => {
  it('save_file uses R2 when r2Bucket is available', async () => {
    const bucket = createMockR2();
    const result = await executeTool({
      id: 'r2-1',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'test.txt', content: 'R2 content' }) },
    }, { r2Bucket: bucket, r2FilePrefix: 'files/user1/' });

    expect(result.content).toBe('File saved: test.txt (10 bytes)');
    expect(bucket._store.has('files/user1/test.txt')).toBe(true);
  });

  it('read_saved_file uses R2 when r2Bucket is available', async () => {
    const bucket = createMockR2();
    await r2SaveFile(bucket, 'files/user1/', 'test.txt', 'R2 content');

    const result = await executeTool({
      id: 'r2-2',
      type: 'function',
      function: { name: 'read_saved_file', arguments: JSON.stringify({ name: 'test.txt' }) },
    }, { r2Bucket: bucket, r2FilePrefix: 'files/user1/' });

    expect(result.content).toBe('R2 content');
  });

  it('list_saved_files uses R2 when r2Bucket is available', async () => {
    const bucket = createMockR2();
    await r2SaveFile(bucket, 'files/user1/', 'a.txt', 'x');
    await r2SaveFile(bucket, 'files/user1/', 'b.txt', 'yy');

    const result = await executeTool({
      id: 'r2-3',
      type: 'function',
      function: { name: 'list_saved_files', arguments: '{}' },
    }, { r2Bucket: bucket, r2FilePrefix: 'files/user1/' });

    expect(result.content).toContain('Saved files (2');
    expect(result.content).toContain('a.txt');
    expect(result.content).toContain('b.txt');
  });

  it('delete_saved_file uses R2 when r2Bucket is available', async () => {
    const bucket = createMockR2();
    await r2SaveFile(bucket, 'files/user1/', 'doomed.txt', 'bye');

    const result = await executeTool({
      id: 'r2-4',
      type: 'function',
      function: { name: 'delete_saved_file', arguments: JSON.stringify({ name: 'doomed.txt' }) },
    }, { r2Bucket: bucket, r2FilePrefix: 'files/user1/' });

    expect(result.content).toBe('File deleted: doomed.txt');
    expect(bucket._store.has('files/user1/doomed.txt')).toBe(false);
  });

  it('enforces file count limit via R2', async () => {
    const bucket = createMockR2();
    const prefix = 'files/user1/';
    // Fill up to 100 files
    for (let i = 0; i < 100; i++) {
      await r2SaveFile(bucket, prefix, `f${i}.txt`, 'x');
    }

    const result = await executeTool({
      id: 'r2-5',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'overflow.txt', content: 'x' }) },
    }, { r2Bucket: bucket, r2FilePrefix: prefix });

    expect(result.content).toContain('File limit reached');
  });

  it('enforces per-file size limit via R2', async () => {
    const bucket = createMockR2();
    const prefix = 'files/user1/';
    const result = await executeTool({
      id: 'r2-6a',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'huge.txt', content: 'x'.repeat(1_000_001) }) },
    }, { r2Bucket: bucket, r2FilePrefix: prefix });

    expect(result.content).toContain('File too large');
  });

  it('enforces total storage quota via R2', async () => {
    const bucket = createMockR2();
    const prefix = 'files/user1/';
    // Save a 9.5MB file first (under 10MB total, under 1MB per-file... wait, 9.5MB > 1MB per file)
    // We need multiple files to approach the quota
    // Save 10 files of 950KB each = 9.5MB
    for (let i = 0; i < 10; i++) {
      await r2SaveFile(bucket, prefix, `chunk${i}.txt`, 'x'.repeat(950_000));
    }

    // Now try to save a 600KB file → total would be ~10.1MB, exceeding 10MB quota
    const result = await executeTool({
      id: 'r2-6b',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'overflow.txt', content: 'x'.repeat(600_000) }) },
    }, { r2Bucket: bucket, r2FilePrefix: prefix });

    expect(result.content).toContain('Storage quota exceeded');
  });

  it('allows overwrite at file count limit via R2', async () => {
    const bucket = createMockR2();
    const prefix = 'files/user1/';
    for (let i = 0; i < 100; i++) {
      await r2SaveFile(bucket, prefix, `f${i}.txt`, 'x');
    }

    // Overwriting existing file should succeed
    const result = await executeTool({
      id: 'r2-7',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'f0.txt', content: 'updated' }) },
    }, { r2Bucket: bucket, r2FilePrefix: prefix });

    expect(result.content).toBe('File saved: f0.txt (7 bytes)');
  });

  it('prefers R2 over Acontext when both are available', async () => {
    const bucket = createMockR2();
    const acontextWrite = vi.fn();

    const result = await executeTool({
      id: 'r2-8',
      type: 'function',
      function: { name: 'save_file', arguments: JSON.stringify({ name: 'test.txt', content: 'hello' }) },
    }, {
      r2Bucket: bucket,
      r2FilePrefix: 'files/user1/',
      acontextClient: { listFiles: vi.fn(), writeFile: acontextWrite } as unknown as AcontextClient,
    });

    expect(result.content).toBe('File saved: test.txt (5 bytes)');
    expect(acontextWrite).not.toHaveBeenCalled(); // R2 should be used, not Acontext
  });
});

describe('validateSavedFileName', () => {
  it('rejects empty names', () => {
    expect(validateSavedFileName('')).toContain('non-empty');
    expect(validateSavedFileName('   ')).toContain('non-empty');
  });

  it('rejects null bytes', () => {
    expect(validateSavedFileName('a\0b')).toContain('Null bytes');
  });

  it('rejects path traversal', () => {
    expect(validateSavedFileName('../etc/passwd')).toContain('Path traversal');
  });

  it('rejects absolute paths', () => {
    expect(validateSavedFileName('/etc/passwd')).toContain('relative paths');
    expect(validateSavedFileName('\\windows\\system')).toContain('relative paths');
  });

  it('accepts valid names', () => {
    expect(validateSavedFileName('notes.txt')).toBeNull();
    expect(validateSavedFileName('data/output.csv')).toBeNull();
    expect(validateSavedFileName('a')).toBeNull();
  });

  it('rejects names exceeding max length', () => {
    expect(validateSavedFileName('x'.repeat(256))).toContain('Maximum length');
  });
});

describe('sanitizeSavedFileName', () => {
  it('strips control characters', () => {
    expect(sanitizeSavedFileName('bad\x01name.txt')).toBe('badname.txt');
  });

  it('trims whitespace', () => {
    expect(sanitizeSavedFileName('  hello.txt  ')).toBe('hello.txt');
  });

  it('preserves valid names', () => {
    expect(sanitizeSavedFileName('data/file.json')).toBe('data/file.json');
  });
});
