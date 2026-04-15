import { describe, it, expect, vi } from 'vitest';
import { findExistingMoltbotProcess, killGateway, isGatewayPortOpen } from './process';
import type { Sandbox, Process } from '@cloudflare/sandbox';
import { createMockSandbox } from '../test-utils';

// Helper to create a full mock process (with methods needed for process tests)
function createFullMockProcess(overrides: Partial<Process> = {}): Process {
  return {
    id: 'test-id',
    command: 'openclaw gateway',
    status: 'running',
    startTime: new Date(),
    endTime: undefined,
    exitCode: undefined,
    waitForPort: vi.fn(),
    kill: vi.fn(),
    getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    ...overrides,
  } as Process;
}

describe('findExistingMoltbotProcess', () => {
  it('returns null when no processes exist', async () => {
    const { sandbox } = createMockSandbox({ processes: [] });
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('returns null when only CLI commands are running', async () => {
    const processes = [
      createFullMockProcess({ command: 'openclaw devices list --json', status: 'running' }),
      createFullMockProcess({ command: 'openclaw --version', status: 'completed' }),
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('returns gateway process when running', async () => {
    const gatewayProcess = createFullMockProcess({
      id: 'gateway-1',
      command: 'openclaw gateway --port 18789',
      status: 'running',
    });
    const processes = [
      createFullMockProcess({ command: 'openclaw devices list', status: 'completed' }),
      gatewayProcess,
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('returns gateway process when starting', async () => {
    const gatewayProcess = createFullMockProcess({
      id: 'gateway-1',
      command: '/usr/local/bin/start-openclaw.sh',
      status: 'starting',
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('ignores completed gateway processes', async () => {
    const processes = [
      createFullMockProcess({ command: 'openclaw gateway', status: 'completed' }),
      createFullMockProcess({ command: 'start-openclaw.sh', status: 'failed' }),
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('handles listProcesses errors gracefully', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as Sandbox;

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('matches start-openclaw.sh command', async () => {
    const gatewayProcess = createFullMockProcess({
      id: 'gateway-1',
      command: '/usr/local/bin/start-openclaw.sh',
      status: 'running',
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('matches legacy start-moltbot.sh command', async () => {
    const gatewayProcess = createFullMockProcess({
      id: 'gateway-1',
      command: '/usr/local/bin/start-moltbot.sh',
      status: 'running',
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('returns first matching gateway process', async () => {
    const firstGateway = createFullMockProcess({
      id: 'gateway-1',
      command: 'openclaw gateway',
      status: 'running',
    });
    const secondGateway = createFullMockProcess({
      id: 'gateway-2',
      command: 'start-openclaw.sh',
      status: 'starting',
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([firstGateway, secondGateway]);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result?.id).toBe('gateway-1');
  });
});

describe('killGateway', () => {
  it('attempts multiple kill strategies, cleans up lock files, and polls for port closed', async () => {
    const execMock = vi.fn().mockImplementation((cmd: string) => {
      // Port probe reports the port as already closed so the poll returns immediately.
      if (cmd.includes('nc -z')) return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const listProcessesMock = vi.fn().mockResolvedValue([]);
    const sandbox = {
      exec: execMock,
      listProcesses: listProcessesMock,
    } as unknown as Sandbox;

    await killGateway(sandbox);

    const calls = execMock.mock.calls.map((c) => c[0] as string);
    // Multi-strategy kill (pgrep/pkill/ss)
    expect(calls.some((c) => c.includes('pgrep'))).toBe(true);
    // Lockfile cleanup
    expect(calls.some((c) => c.includes('rm -f'))).toBe(true);
    // Port-closed poll — replaces the old fixed 2s sleep
    expect(calls.some((c) => c.includes('nc -z'))).toBe(true);
  });

  it('polls until the gateway port closes rather than sleeping a fixed time', async () => {
    let probeCallsBeforeClose = 0;
    const execMock = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes('nc -z')) {
        probeCallsBeforeClose += 1;
        // Port is still open for the first two probes, then closes.
        return Promise.resolve({
          exitCode: probeCallsBeforeClose <= 2 ? 0 : 1,
          stdout: '',
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const sandbox = {
      exec: execMock,
      listProcesses: vi.fn().mockResolvedValue([]),
    } as unknown as Sandbox;

    await killGateway(sandbox);

    // We should have probed at least 3 times (two "open", one "closed") rather
    // than returning after a single fixed sleep.
    expect(probeCallsBeforeClose).toBeGreaterThanOrEqual(3);
  });

  it('handles exec failures gracefully', async () => {
    const execMock = vi.fn().mockRejectedValue(new Error('exec failed'));
    const listProcessesMock = vi.fn().mockResolvedValue([]);
    const sandbox = {
      exec: execMock,
      listProcesses: listProcessesMock,
    } as unknown as Sandbox;

    // Should not throw even when every exec rejects (including the port probe).
    await killGateway(sandbox);
  });
});

describe('ensureMoltbotGateway with waitForReady: false', () => {
  it('does not call waitForPort when waitForReady is false', async () => {
    const newProcess = createFullMockProcess({ id: 'new-1', status: 'starting' });
    const startProcessMock = vi.fn().mockResolvedValue(newProcess);
    const execMock = vi.fn().mockImplementation((cmd: string) => {
      // nc probe returns exit code 1 (port not open)
      if (cmd.includes('nc -z')) return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
      // rclone configured flag check returns 'no'
      if (cmd.includes('test -f')) return Promise.resolve({ exitCode: 0, stdout: 'no\n', stderr: '', success: true });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', success: true });
    });
    const writeFileMock = vi.fn().mockResolvedValue(undefined);
    const sandbox = {
      listProcesses: vi.fn().mockResolvedValue([]),
      startProcess: startProcessMock,
      exec: execMock,
      writeFile: writeFileMock,
    } as unknown as Sandbox;

    const { ensureMoltbotGateway } = await import('./process');
    const env = {
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      CF_ACCOUNT_ID: 'a',
    } as any;

    const process = await ensureMoltbotGateway(sandbox, env, { waitForReady: false });
    expect(process).not.toBeNull();
    // waitForPort should NOT have been called on the returned process
    expect(newProcess.waitForPort).not.toHaveBeenCalled();
  });
});

describe('isGatewayPortOpen', () => {
  it('returns true when port is open', async () => {
    const execMock = vi.fn().mockResolvedValue({ exitCode: 0 });
    const sandbox = { exec: execMock } as unknown as Sandbox;

    const result = await isGatewayPortOpen(sandbox);
    expect(result).toBe(true);
    expect(execMock).toHaveBeenCalledWith('nc -z localhost 18789');
  });

  it('returns false when port is closed', async () => {
    const execMock = vi.fn().mockResolvedValue({ exitCode: 1 });
    const sandbox = { exec: execMock } as unknown as Sandbox;

    const result = await isGatewayPortOpen(sandbox);
    expect(result).toBe(false);
  });
});
