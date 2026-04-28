/**
 * Tests for the Telegram dossier renderer.
 *
 * Verifies that source URLs are wrapped in explicit <a href> tags so that
 * Telegram's HTML parser doesn't surface "&amp;" inside auto-linked URLs.
 */

import { describe, it, expect } from 'vitest';
import { renderForTelegram } from '../telegram';
import type { SkillResult, SkillTelemetry } from '../../types';
import type { NexusDossier } from '../../nexus/types';

const telemetry: SkillTelemetry = {
  durationMs: 17_700,
  model: 'kimi26or',
  llmCalls: 2,
  toolCalls: 3,
};

function makeDossierResult(dossier: NexusDossier, body = 'fallback body'): SkillResult {
  return {
    skillId: 'nexus',
    kind: 'dossier',
    body,
    data: dossier,
    telemetry,
  };
}

describe('Telegram dossier renderer', () => {
  it('wraps source URLs in <a href> with entity-escaped query params', () => {
    const dossier: NexusDossier = {
      query: 'Compare Cloudflare Workers vs AWS Lambda for AI workloads',
      mode: 'full',
      synthesis: 'Synthesis body.',
      evidence: [
        {
          source: 'Hacker News',
          url: 'https://hn.algolia.com/api/v1/search?query=foo&tags=story&hitsPerPage=5',
          data: '{}',
          confidence: 'medium',
        },
        {
          source: 'Brave Search',
          data: '...',
          confidence: 'medium',
        },
      ],
      createdAt: new Date().toISOString(),
    };

    const chunks = renderForTelegram(makeDossierResult(dossier));
    const text = chunks.map(c => c.text).join('\n');

    // The href attribute carries entity-escaped ampersands (HTML spec) and
    // Telegram decodes them back to '&' when following the link.
    expect(text).toContain(
      '<a href="https://hn.algolia.com/api/v1/search?query=foo&amp;tags=story&amp;hitsPerPage=5">',
    );
    // The visible anchor text matches the URL — also entity-escaped, but
    // Telegram renders this back to the user as '&'.
    expect(text).toContain(
      'https://hn.algolia.com/api/v1/search?query=foo&amp;tags=story&amp;hitsPerPage=5</a>',
    );
    // Sources block heading present.
    expect(text).toContain('<b>Sources:</b>');
    // No-URL source still listed without an anchor.
    expect(text).toContain('• Brave Search (medium)');
    // HTML parse mode set so Telegram applies the anchor tag.
    expect(chunks[0].parseMode).toBe('HTML');
  });

  it('does not double-escape ampersands inside URLs', () => {
    const dossier: NexusDossier = {
      query: 'q',
      mode: 'quick',
      synthesis: 'body',
      evidence: [
        {
          source: 'Reddit',
          url: 'https://www.reddit.com/search.json?q=foo&sort=relevance&limit=5',
          data: '{}',
          confidence: 'low',
        },
      ],
      createdAt: new Date().toISOString(),
    };

    const chunks = renderForTelegram(makeDossierResult(dossier));
    const text = chunks.map(c => c.text).join('\n');

    // Catch the regression where escapeHtml ran twice and produced &amp;amp;.
    expect(text).not.toContain('&amp;amp;');
    // And catch the regression where the URL was emitted naked into auto-link
    // territory (no <a href> wrapper).
    expect(text).toContain('href="https://www.reddit.com/search.json?q=foo&amp;sort=relevance&amp;limit=5"');
  });

  it('escapes HTML special characters in synthesis', () => {
    const dossier: NexusDossier = {
      query: 'q',
      mode: 'quick',
      synthesis: 'Code: <script>alert(1)</script> & friends',
      evidence: [],
      createdAt: new Date().toISOString(),
    };

    const chunks = renderForTelegram(makeDossierResult(dossier));
    const text = chunks.map(c => c.text).join('\n');

    expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; friends');
    // Header still rendered as bold.
    expect(text).toContain('<b>Research Dossier</b>');
  });

  it('renders decision sections with bold headers', () => {
    const dossier: NexusDossier = {
      query: 'A vs B',
      mode: 'decision',
      synthesis: 'pick A',
      evidence: [
        { source: 'Web', data: 'x', confidence: 'high' },
      ],
      decision: {
        pros: ['fast & cheap'],
        cons: ['less mature'],
        risks: ['vendor lock-in'],
        recommendation: 'choose A',
      },
      createdAt: new Date().toISOString(),
    };

    const chunks = renderForTelegram(makeDossierResult(dossier));
    const text = chunks.map(c => c.text).join('\n');

    expect(text).toContain('<b>--- Decision Analysis ---</b>');
    expect(text).toContain('<b>Pros:</b>');
    // Decision body text gets escaped just like synthesis.
    expect(text).toContain('+ fast &amp; cheap');
    expect(text).toContain('<b>Recommendation:</b> choose A');
  });

  it('renders the attempts diagnostic block when sources failed', () => {
    // Mirrors the production case: classifier asked for 3 sources, only
    // Brave succeeded, the other two dropped — user sees exactly which
    // and why, so the next thin dossier is self-diagnosing.
    const dossier: NexusDossier = {
      query: 'q',
      mode: 'full',
      synthesis: 'body',
      evidence: [
        { source: 'Brave Search', data: 'x', confidence: 'medium' },
      ],
      attempts: [
        { source: 'webSearch', status: 'ok', durationMs: 420 },
        { source: 'stackExchange', status: 'failed', reason: 'Stack Exchange: no matching questions', durationMs: 1800 },
        { source: 'github', status: 'failed', reason: 'Error executing github_api: HTTP 401', durationMs: 250 },
      ],
      createdAt: new Date().toISOString(),
    };

    const chunks = renderForTelegram(makeDossierResult(dossier));
    const text = chunks.map(c => c.text).join('\n');

    expect(text).toContain('<b>Source attempts (1/3 succeeded):</b>');
    expect(text).toContain('✗ stackExchange (1800ms): Stack Exchange: no matching questions');
    expect(text).toContain('✗ github (250ms): Error executing github_api: HTTP 401');
    // Successful sources are not enumerated in the diagnostics block —
    // they're already in the Sources block above.
    expect(text).not.toContain('✗ webSearch');
  });

  it('omits the attempts diagnostic block when every attempt succeeded', () => {
    const dossier: NexusDossier = {
      query: 'q',
      mode: 'full',
      synthesis: 'body',
      evidence: [
        { source: 'Brave Search', data: 'x', confidence: 'medium' },
      ],
      attempts: [
        { source: 'webSearch', status: 'ok', durationMs: 420 },
      ],
      createdAt: new Date().toISOString(),
    };

    const chunks = renderForTelegram(makeDossierResult(dossier));
    const text = chunks.map(c => c.text).join('\n');

    expect(text).not.toContain('Source attempts');
    expect(text).not.toContain('✗');
  });

  it('omits the attempts block when attempts field is missing (legacy cached dossier)', () => {
    const dossier: NexusDossier = {
      query: 'q',
      mode: 'full',
      synthesis: 'body',
      evidence: [{ source: 'Brave Search', data: 'x', confidence: 'medium' }],
      createdAt: new Date().toISOString(),
    };

    const chunks = renderForTelegram(makeDossierResult(dossier));
    const text = chunks.map(c => c.text).join('\n');

    expect(text).not.toContain('Source attempts');
  });

  it('falls back to escaped body when data is missing', () => {
    const result: SkillResult = {
      skillId: 'nexus',
      kind: 'dossier',
      body: 'plain body & stuff',
      telemetry,
    };

    const chunks = renderForTelegram(result);
    const text = chunks.map(c => c.text).join('\n');

    expect(text).toContain('plain body &amp; stuff');
    expect(text).toContain('<b>Research Dossier</b>');
  });
});

// ---------------------------------------------------------------------------
// End-to-end pipeline render checks (audit recommendation: verify full
// Telegram payload shape from a realistic dossier, not just individual parts)
// ---------------------------------------------------------------------------

describe('Dossier full pipeline render', () => {
  const fullDossier: NexusDossier = {
    query: 'open source llm agent frameworks',
    mode: 'full',
    synthesis: 'LangChain & AutoGen lead the space [Brave Search]. GitHub shows 668 repos [GitHub].',
    evidence: [
      {
        source: 'Brave Search',
        data: 'LangChain, AutoGen, CrewAI are popular frameworks.',
        confidence: 'medium',
      },
      {
        source: 'GitHub',
        url: 'https://github.com/search?q=llm+agent&type=repositories',
        data: '{"total_count":668}',
        confidence: 'high',
      },
    ],
    attempts: [
      { source: 'Brave Search', status: 'ok', durationMs: 310 },
      { source: 'GitHub', status: 'ok', durationMs: 289 },
      { source: 'stackExchange', status: 'failed', reason: 'HTTP 400: Bad Request', durationMs: 153 },
    ],
    createdAt: new Date().toISOString(),
  };

  it('contains bold Research Dossier header', () => {
    const text = renderForTelegram(makeDossierResult(fullDossier)).map(c => c.text).join('\n');
    expect(text).toContain('<b>Research Dossier</b>');
  });

  it('contains bold Sources header', () => {
    const text = renderForTelegram(makeDossierResult(fullDossier)).map(c => c.text).join('\n');
    expect(text).toContain('<b>Sources:</b>');
  });

  it('wraps GitHub URL in an anchor tag', () => {
    const text = renderForTelegram(makeDossierResult(fullDossier)).map(c => c.text).join('\n');
    expect(text).toContain('<a href="https://github.com/search?q=llm+agent&amp;type=repositories">');
  });

  it('does not double-escape ampersands in synthesis text', () => {
    const text = renderForTelegram(makeDossierResult(fullDossier)).map(c => c.text).join('\n');
    // Synthesis contains '&' — should be entity-escaped exactly once
    expect(text).toContain('LangChain &amp; AutoGen');
    expect(text).not.toContain('&amp;amp;');
  });

  it('renders Source attempts block listing the failed source', () => {
    const text = renderForTelegram(makeDossierResult(fullDossier)).map(c => c.text).join('\n');
    expect(text).toContain('Source attempts');
    expect(text).toContain('stackExchange');
    expect(text).toContain('HTTP 400');
  });

  it('all chunks carry HTML parse mode', () => {
    const chunks = renderForTelegram(makeDossierResult(fullDossier));
    for (const chunk of chunks) {
      expect(chunk.parseMode).toBe('HTML');
    }
  });
});
