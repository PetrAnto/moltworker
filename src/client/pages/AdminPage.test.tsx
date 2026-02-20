import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AcontextSessionsSection } from './AdminPage'

describe('AcontextSessionsSection', () => {
  it('renders configuration hint when Acontext is not configured', () => {
    const html = renderToStaticMarkup(
      <AcontextSessionsSection loading={false} configured={false} items={[]} />,
    )

    expect(html).toContain('Acontext Sessions')
    expect(html).toContain('Acontext not configured — add ACONTEXT_API_KEY')
  })

  it('renders recent sessions with dashboard links', () => {
    const html = renderToStaticMarkup(
      <AcontextSessionsSection
        loading={false}
        configured={true}
        items={[
          {
            id: 'sess_abc',
            model: 'openrouter/anthropic/claude-sonnet-4',
            prompt: 'Review repository and prepare deployment checklist for production.',
            toolsUsed: 4,
            success: true,
            createdAt: '2026-02-20T10:00:00.000Z',
          },
        ]}
      />,
    )

    expect(html).toContain('openrouter/anthropic/claude-sonnet-4')
    expect(html).toContain('4 tools')
    expect(html).toContain('https://platform.acontext.com/sessions/sess_abc')
    expect(html).toContain('Review repository and prepare deployment checklist for productio...')
    expect(html).toContain('✓')
  })
})
