import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AcontextSessionsSection } from './AcontextSessionsSection';

describe('AcontextSessionsSection', () => {
  it('renders not-configured hint', () => {
    const html = renderToStaticMarkup(
      <AcontextSessionsSection sessions={{ configured: false, items: [] }} />,
    );

    expect(html).toContain('Acontext Sessions');
    expect(html).toContain('Acontext not configured — add ACONTEXT_API_KEY');
  });

  it('renders session rows with dashboard link', () => {
    const html = renderToStaticMarkup(
      <AcontextSessionsSection
        sessions={{
          configured: true,
          items: [
            {
              id: 'sess-abc',
              model: 'openrouter/openai/gpt-5',
              prompt: 'Build a dashboard section and add links to recent sessions',
              toolsUsed: 3,
              success: true,
              createdAt: '2026-02-20T00:00:00.000Z',
            },
          ],
        }}
      />,
    );

    expect(html).toContain('openrouter/openai/gpt-5');
    expect(html).toContain('3 tools');
    expect(html).toContain('https://platform.acontext.com/sessions/sess-abc');
  });
});
