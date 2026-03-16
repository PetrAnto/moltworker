import { describe, it, expect, vi, beforeEach } from 'vitest';

const cleanupStaleTasksMock = vi.fn().mockResolvedValue(0);

vi.mock('../orchestra/orchestra', async (importOriginal) => {
  const original = await importOriginal<typeof import('../orchestra/orchestra')>();
  return {
    ...original,
    cleanupStaleTasks: cleanupStaleTasksMock,
  };
});

vi.mock('../openrouter/client', () => ({
  createOpenRouterClient: vi.fn(() => ({ chat: vi.fn() })),
  extractTextResponse: vi.fn(),
}));

vi.mock('../openrouter/storage', () => ({
  createUserStorage: vi.fn(() => ({
    loadDynamicModels: vi.fn().mockResolvedValue(null),
  })),
  createSkillStorage: vi.fn(() => ({})),
}));

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
      executeOrchestra: (chatId: number, userId: string, mode: 'init' | 'run' | 'redo', repo: string, prompt: string) => Promise<void>;
    }).executeOrchestra(123, 'user-1', 'run', 'owner/repo', 'Implement auth');

    expect(cleanupStaleTasksMock).toHaveBeenCalledWith(bucket, 'user-1');
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('GitHub token not configured'));
  });

  it('runs cleanupStaleTasks before /orch run when task processor is missing', async () => {
    const { TelegramHandler } = await import('./handler');
    const bucket = { get: vi.fn(), put: vi.fn() } as unknown as R2Bucket;
    const handler = new TelegramHandler('tg-token', 'or-key', bucket, undefined, 'storia-orchestrator', undefined, 'gh-token');
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    handler._setBot({ sendMessage } as unknown as never);

    await (handler as unknown as {
      executeOrchestra: (chatId: number, userId: string, mode: 'init' | 'run' | 'redo', repo: string, prompt: string) => Promise<void>;
    }).executeOrchestra(123, 'user-2', 'run', 'owner/repo', 'Implement auth');

    expect(cleanupStaleTasksMock).toHaveBeenCalledWith(bucket, 'user-2');
    expect(sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Task processor not available'));
  });
});
