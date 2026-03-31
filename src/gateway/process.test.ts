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
  it('attempts multiple kill strategies and cleans up lock files', async () => {
    const execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const listProcessesMock = vi.fn().mockResolvedValue([]);
    const sandbox = {
      exec: execMock,
      listProcesses: listProcessesMock,
    } as unknown as Sandbox;

    await killGateway(sandbox);

    // Should call exec at least twice (kill strategies + lock cleanup)
    expect(execMock).toHaveBeenCalledTimes(2);
    // First call includes the kill commands
    expect(execMock.mock.calls[0][0]).toContain('pgrep');
    // Second call cleans up lock files
    expect(execMock.mock.calls[1][0]).toContain('rm -f');
  });

  it('handles exec failures gracefully', async () => {
    const execMock = vi.fn().mockRejectedValue(new Error('exec failed'));
    const listProcessesMock = vi.fn().mockResolvedValue([]);
    const sandbox = {
      exec: execMock,
      listProcesses: listProcessesMock,
    } as unknown as Sandbox;

    // Should not throw
    await killGateway(sandbox);
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
