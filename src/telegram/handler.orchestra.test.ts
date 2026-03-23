import { describe, it, expect, vi, beforeEach } from 'vitest';

const cleanupStaleTasksMock = vi.fn().mockResolvedValue(0);

vi.mock('../orchestra/orchestra', async (importOriginal) => {
  const original = await importOriginal<typeof import('../orchestra/orchestra')>();
  return {
    ...original,
    cleanupStaleTasks: cleanupStaleTasksMock,
  };
});

describe('TelegramHandler executeOrchestra stale cleanup', () => {
  beforeEach(() => {
    cleanupStaleTasksMock.mockClear();
  });

  it('runs cleanupStaleTasks before /orch run prerequisites', async () => {
    const { TelegramHandler } = await import('./handler');
    const bucket = { get: vi.fn(), put: vi.fn() } as unknown as R2Bucket;
    const handler = new TelegramHandler('tg-token', 'or-key', bucket);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    handler._setBot({ sendMessage } as unknown as never);

    await (handler as unknown as {
      executeOrchestra: (chatId: number, userId: string, mode: 'init' | 'run' | 'redo' | 'do', repo: string, prompt: string) => Promise<void>;
    }).executeOrchestra(123, 'user-1', 'run', 'owner/repo', 'Implement auth');

    expect(cleanupStaleTasksMock).toHaveBeenCalledWith(bucket, 'user-1');
    // Without github token, it should fail at prerequisites — but cleanup runs first
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('GitHub token not configured'));
  });

  it('runs cleanupStaleTasks for init mode too', async () => {
    const { TelegramHandler } = await import('./handler');
    const bucket = { get: vi.fn(), put: vi.fn() } as unknown as R2Bucket;
    const handler = new TelegramHandler('tg-token', 'or-key', bucket);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    handler._setBot({ sendMessage } as unknown as never);

    await (handler as unknown as {
      executeOrchestra: (chatId: number, userId: string, mode: 'init' | 'run' | 'redo' | 'do', repo: string, prompt: string) => Promise<void>;
    }).executeOrchestra(456, 'user-2', 'init', 'owner/repo', 'init project');

    expect(cleanupStaleTasksMock).toHaveBeenCalledWith(bucket, 'user-2');
  });
});
