import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postStatusUpdate, createCallbackHelper } from './callbacks';

describe('postStatusUpdate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should POST status update to callback URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const result = await postStatusUpdate('https://storia.ai/callback', {
      jobId: 'job-1',
      status: 'started',
      message: 'Build started',
    });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://storia.ai/callback');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      jobId: 'job-1',
      status: 'started',
      message: 'Build started',
    });
  });

  it('should include Authorization header when secret provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await postStatusUpdate(
      'https://storia.ai/callback',
      { jobId: 'job-1', status: 'started' },
      'my-secret'
    );

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer my-secret');
  });

  it('should retry on failure', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const result = await postStatusUpdate('https://storia.ai/callback', {
      jobId: 'job-1',
      status: 'failed',
      error: 'Something broke',
    });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should return false after all retries fail', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', mockFetch);

    const result = await postStatusUpdate('https://storia.ai/callback', {
      jobId: 'job-1',
      status: 'failed',
    });

    expect(result).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('should handle network errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await postStatusUpdate('https://storia.ai/callback', {
      jobId: 'job-1',
      status: 'started',
    });

    expect(result).toBe(false);
  });
});

describe('createCallbackHelper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  it('should send started status', async () => {
    const helper = createCallbackHelper('https://storia.ai/cb', 'job-1');
    await helper.started();

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.status).toBe('started');
    expect(body.jobId).toBe('job-1');
  });

  it('should send planning status', async () => {
    const helper = createCallbackHelper('https://storia.ai/cb', 'job-1');
    await helper.planning();

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.status).toBe('planning');
  });

  it('should send writing status with step', async () => {
    const helper = createCallbackHelper('https://storia.ai/cb', 'job-1');
    await helper.writing('src/routes/api.ts');

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.status).toBe('writing');
    expect(body.step).toBe('src/routes/api.ts');
  });

  it('should send complete status with PR URL', async () => {
    const helper = createCallbackHelper('https://storia.ai/cb', 'job-1');
    await helper.complete('https://github.com/PetrAnto/test/pull/42');

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.status).toBe('complete');
    expect(body.prUrl).toBe('https://github.com/PetrAnto/test/pull/42');
  });

  it('should send failed status with error', async () => {
    const helper = createCallbackHelper('https://storia.ai/cb', 'job-1');
    await helper.failed('Budget exceeded');

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.status).toBe('failed');
    expect(body.error).toBe('Budget exceeded');
  });

  it('should include secret in auth header', async () => {
    const helper = createCallbackHelper('https://storia.ai/cb', 'job-1', 'secret-123');
    await helper.started();

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer secret-123');
  });
});
