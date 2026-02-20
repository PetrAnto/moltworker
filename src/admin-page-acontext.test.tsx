import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AcontextSessionsSection, formatAcontextAge, truncateAcontextPrompt } from './client/pages/AdminPage';

describe('AdminPage Acontext sessions section', () => {
  it('renders configured session row with dashboard link', () => {
    const html = renderToStaticMarkup(
      <AcontextSessionsSection
        loading={false}
        data={{
          configured: true,
          items: [{
            id: 'sess_abc',
            model: 'openai/gpt-4.1',
            prompt: 'Build a deployment checklist for the migration',
            toolsUsed: 3,
            success: true,
            createdAt: '2026-02-20T09:00:00.000Z',
          }],
        }}
      />
    );

    expect(html).toContain('Acontext Sessions');
    expect(html).toContain('openai/gpt-4.1');
    expect(html).toContain('3 tools');
    expect(html).toContain('https://platform.acontext.com/sessions/sess_abc');
  });

  it('renders unconfigured hint', () => {
    const html = renderToStaticMarkup(
      <AcontextSessionsSection loading={false} data={{ configured: false, items: [] }} />
    );

    expect(html).toContain('Acontext not configured — add ACONTEXT_API_KEY');
  });

  it('formats age and truncates long prompts', () => {
    expect(formatAcontextAge('2026-02-20T11:58:00.000Z', Date.parse('2026-02-20T12:00:00.000Z'))).toBe('2m ago');
    expect(truncateAcontextPrompt('a'.repeat(80), 60)).toHaveLength(60);
  });
});
