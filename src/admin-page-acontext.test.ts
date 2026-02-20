import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

vi.mock('./client/api', () => ({
  listDevices: vi.fn(),
  approveDevice: vi.fn(),
  approveAllDevices: vi.fn(),
  restartGateway: vi.fn(),
  getStorageStatus: vi.fn(),
  triggerSync: vi.fn(),
  getAcontextSessions: vi.fn(),
  AuthError: class extends Error {},
}));

describe('AdminPage Acontext section', () => {
  it('renders Acontext Sessions heading', async () => {
    const module = await import('./client/pages/AdminPage');
    const html = renderToString(createElement(module.default));

    expect(html).toContain('Acontext Sessions');
  });

  it('truncates long prompts for compact session rows', async () => {
    const module = await import('./client/pages/AdminPage');
    const longPrompt = 'a'.repeat(80);

    expect(module.formatPrompt(longPrompt, 60)).toBe(`${'a'.repeat(60)}…`);
    expect(module.formatPrompt('short prompt', 60)).toBe('short prompt');
  });
});
