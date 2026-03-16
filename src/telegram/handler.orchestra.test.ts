import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramHandler } from './handler';
import * as orchestra from '../orchestra/orchestra';

describe('TelegramHandler orchestra cleanup integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs cleanupStaleTasks before /orch run execution path continues', async () => {
    const cleanupSpy = vi.spyOn(orchestra, 'cleanupStaleTasks').mockResolvedValue(1);

    const fakeR2 = { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;
    const handler = new TelegramHandler('tg', 'or', fakeR2, undefined, 'storia-orchestrator', undefined, 'gh', undefined, {} as DurableObjectNamespace<import('../durable-objects/task-processor').TaskProcessor>);

    // Prevent outbound calls and keep execution on the early "model not tool-capable" branch.
    (handler as unknown as { storage: { getUserModel: () => Promise<string>; setPendingOrchestra: () => Promise<void> } }).storage = {
      getUserModel: vi.fn().mockResolvedValue('definitely-unknown-model'),
      setPendingOrchestra: vi.fn().mockResolvedValue(undefined),
    };
    (handler as unknown as { bot: { sendMessage: (...args: unknown[]) => Promise<unknown> } }).bot = {
      sendMessage: vi.fn().mockResolvedValue({}),
    };

    await (handler as unknown as {
      executeOrchestra: (chatId: number, userId: string, mode: 'init' | 'run' | 'redo', repo: string, prompt: string) => Promise<void>;
    }).executeOrchestra(123, 'user-42', 'run', 'owner/repo', 'implement api');

    expect(cleanupSpy).toHaveBeenCalledWith(fakeR2, 'user-42');
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});
