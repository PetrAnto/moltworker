import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramHandler } from './handler';
import * as orchestra from '../orchestra/orchestra';

function createMockR2(): R2Bucket {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false, delimitedPrefixes: [] }),
    head: vi.fn().mockResolvedValue(null),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

describe('TelegramHandler orchestra stale cleanup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls cleanupStaleTasks before model validation during executeOrchestra', async () => {
    const r2 = createMockR2();
    const handler = new TelegramHandler(
      'telegram-token',
      'openrouter-key',
      r2,
      undefined,
      'storia-orchestrator',
      undefined,
      'github-token',
      undefined,
      {} as DurableObjectNamespace<import('../durable-objects/task-processor').TaskProcessor>,
    );

    const cleanupSpy = vi.spyOn(orchestra, 'cleanupStaleTasks').mockResolvedValue(1);

    (handler as any)._setBot({
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1, chat: { id: 123 } }),
    });

    const setPendingOrchestra = vi.fn().mockResolvedValue(undefined);
    (handler as any).storage = {
      getUserModel: vi.fn().mockResolvedValue('non-existent-model-alias'),
      setPendingOrchestra,
    };

    await (handler as any).executeOrchestra(123, 'user-1', 'run', 'owner/repo', 'test prompt');

    expect(cleanupSpy).toHaveBeenCalledWith(r2, 'user-1');
    expect(setPendingOrchestra).toHaveBeenCalled();
  });

  it('calls cleanupStaleTasks before model validation in init mode', async () => {
    const r2 = createMockR2();
    const handler = new TelegramHandler(
      'telegram-token',
      'openrouter-key',
      r2,
      undefined,
      'storia-orchestrator',
      undefined,
      'github-token',
      undefined,
      {} as DurableObjectNamespace<import('../durable-objects/task-processor').TaskProcessor>,
    );

    const cleanupSpy = vi.spyOn(orchestra, 'cleanupStaleTasks').mockResolvedValue(0);

    (handler as any)._setBot({
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1, chat: { id: 456 } }),
    });

    (handler as any).storage = {
      getUserModel: vi.fn().mockResolvedValue('non-existent-model-alias'),
      setPendingOrchestra: vi.fn().mockResolvedValue(undefined),
    };

    await (handler as any).executeOrchestra(456, 'user-2', 'init', 'owner/repo', 'init prompt');

    expect(cleanupSpy).toHaveBeenCalledWith(r2, 'user-2');
  });
});
