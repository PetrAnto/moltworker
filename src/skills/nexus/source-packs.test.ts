/**
 * Tests for nexus source-pack helpers.
 */

import { describe, it, expect } from 'vitest';
import { isToolError, getAvailableSources, expandSourcePicks, CATEGORY_DEFAULTS, extractKeywords, normalizeKeywordQuery } from './source-packs';
import { NEXUS_CLASSIFY_PROMPT, NEXUS_SYNTHESIZE_PROMPT, NEXUS_DECISION_PROMPT } from './prompts';

describe('isToolError', () => {
  it('matches the canonical "Error: ..." prefix', () => {
    expect(isToolError('Error: Tool "fetch_url" is not allowed for skill "nexus".')).toBe(true);
    expect(isToolError('Error: Invalid JSON arguments: {bad}')).toBe(true);
  });

  it('matches the "Error executing <tool>: ..." prefix surfaced by caught exceptions', () => {
    // This is the path that previously slipped through, causing Reddit 403
    // and Wikipedia 404 to be counted as successful evidence sources.
    expect(isToolError('Error executing fetch_url: HTTP 403: Forbidden')).toBe(true);
    expect(isToolError('Error executing web_search: HTTP 500')).toBe(true);
  });

  it('does not flag normal payloads as errors', () => {
    expect(isToolError('{"hits":[]}')).toBe(false);
    expect(isToolError('Some search result text')).toBe(false);
    expect(isToolError('Article about Error handling in Go')).toBe(false);
  });
});

describe('source registry', () => {
  it('exposes the original 7 sources', () => {
    const sources = getAvailableSources();
    for (const name of ['webSearch', 'wikipedia', 'hackerNews', 'reddit', 'news', 'crypto', 'finance']) {
      expect(sources).toContain(name);
    }
  });

  it('exposes the 9 extended sources added 2026-04-27', () => {
    const sources = getAvailableSources();
    for (const name of [
      'stackExchange', 'github', 'openalex', 'arxiv',
      'wikidata', 'internetArchive', 'worldBank', 'secEdgar', 'bluesky',
    ]) {
      expect(sources).toContain(name);
    }
  });

  it('classifier prompt mentions every registered source by name', () => {
    // The classifier picks from this prompt — if a source is in the registry
    // but not in the prompt, the LLM will never select it. Likewise, if the
    // prompt advertises a name that isn't registered, fetchSources silently
    // drops it (filter on line ~298).
    const sources = getAvailableSources();
    for (const name of sources) {
      expect(NEXUS_CLASSIFY_PROMPT).toContain(name);
    }
  });
});

describe('expandSourcePicks', () => {
  it('backfills a thin classifier pick to >=3 sources for technical queries', () => {
    // The bug we keep hitting: classifier returns ["webSearch"], dossier
    // ends up single-source. Expansion must fan out to category defaults.
    const expanded = expandSourcePicks('technical', ['webSearch']);
    expect(expanded.length).toBeGreaterThanOrEqual(3);
    expect(expanded).toContain('webSearch');
    expect(expanded).toContain('stackExchange');
    expect(expanded).toContain('github');
  });

  it('preserves classifier picks first (LLM intent wins)', () => {
    const expanded = expandSourcePicks('technical', ['hackerNews', 'reddit']);
    expect(expanded[0]).toBe('hackerNews');
    expect(expanded[1]).toBe('reddit');
    // Then the technical defaults backfill — webSearch, stackExchange, github
    expect(expanded).toContain('webSearch');
  });

  it('dedups when classifier picks overlap with category defaults', () => {
    const expanded = expandSourcePicks('technical', ['webSearch', 'stackExchange']);
    const counts = expanded.reduce<Record<string, number>>((acc, n) => {
      acc[n] = (acc[n] ?? 0) + 1;
      return acc;
    }, {});
    for (const [name, count] of Object.entries(counts)) {
      expect(count, `source ${name} appears ${count} times`).toBe(1);
    }
  });

  it('caps the result at 5 sources', () => {
    // Even with 8 classifier picks the cap should hold so we don't blow
    // the subrequest budget.
    const expanded = expandSourcePicks('topic', [
      'webSearch', 'wikipedia', 'wikidata', 'news', 'hackerNews', 'reddit', 'bluesky', 'github',
    ]);
    expect(expanded.length).toBeLessThanOrEqual(5);
  });

  it('drops unknown source names from classifier output', () => {
    const expanded = expandSourcePicks('technical', ['webSearch', 'fakeSource', 'github']);
    expect(expanded).not.toContain('fakeSource');
    expect(expanded).toContain('webSearch');
    expect(expanded).toContain('github');
  });

  it('uses the fallback backbone when category is missing or unknown', () => {
    const expandedUnknown = expandSourcePicks('mystery-category', []);
    expect(expandedUnknown).toContain('webSearch');
    expect(expandedUnknown.length).toBeGreaterThanOrEqual(3);

    const expandedMissing = expandSourcePicks(undefined, []);
    expect(expandedMissing).toContain('webSearch');
    expect(expandedMissing.length).toBeGreaterThanOrEqual(3);
  });

  it('defines defaults for every category the classifier prompt advertises', () => {
    // Cross-check: the classifier prompt advertises 8 categories. If we add
    // a category there but forget defaults here, expansion silently falls
    // back to the generic backbone.
    for (const cat of ['entity', 'topic', 'market', 'decision', 'technical', 'academic', 'regulatory', 'historical']) {
      expect(CATEGORY_DEFAULTS[cat], `missing defaults for category ${cat}`).toBeDefined();
    }
  });
});

describe('extractKeywords', () => {
  // The smoking gun from the "ai models and other fee features in cloudflare
  // workers" dossier: GitHub returned 0 hits because the API ANDed all 8
  // tokens. extractKeywords pre-processes natural-language queries before
  // hitting keyword-strict APIs. Note: this is a fallback path — the
  // primary route is the LLM classifier's `keywordQuery` output, which is
  // expected to do better on cap selection than this local heuristic.
  it('drops stop words and meta words from natural-language queries', () => {
    // "and", "other", "in" are stop words; "features" is a meta word.
    // After cap=4: ai, models, fee, cloudflare ("workers" cut off — known
    // limitation of the heuristic; the LLM-driven keywordQuery is the
    // robust path).
    expect(extractKeywords('ai models and other fee features in cloudflare workers'))
      .toBe('ai models fee cloudflare');
  });

  it('caps at 4 tokens by default to keep keyword search loose enough', () => {
    const out = extractKeywords('compare bun vs deno for serverless edge runtimes');
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(4);
    // "vs" and "for" are stop words; "compare" stays — distinctive enough
    expect(out).toContain('bun');
    expect(out).toContain('deno');
  });

  it('respects an explicit max', () => {
    const out = extractKeywords('cloudflare workers ai pricing tier limits', 2);
    expect(out.split(/\s+/).length).toBe(2);
  });

  it('strips punctuation', () => {
    const out = extractKeywords('what are the best free AI models, available?');
    expect(out).not.toMatch(/[?,]/);
    // "what", "are", "the", "best", "free", "available" are all stop words
    // — leaves: ai, models
    expect(out).toBe('ai models');
  });

  it('lowercases tokens', () => {
    const out = extractKeywords('Cloudflare Workers AI Models');
    expect(out).toBe('cloudflare workers ai models');
  });

  it('returns empty string when every token is a stop word or too short', () => {
    expect(extractKeywords('what is it about?')).toBe('');
  });

  it('does not drop domain-meaningful short words like "ai"', () => {
    // Two-letter tokens pass; only single-letter and stop words are dropped.
    expect(extractKeywords('ai models')).toBe('ai models');
  });
});

describe('synthesis prompts', () => {
  // Both synth prompts must teach name-based citations. The previous
  // [Source N] index format caused a single-source dossier to cite a
  // hallucinated [Source 2] in production, and an over-strict rewrite
  // ("Do NOT...") then made kimi26or return an empty synthesis. The
  // current prompts use positive guidance only and rely on the user-prompt
  // "Available sources: ..." line to anchor the LLM.
  it('synthesize prompt teaches name-based citations', () => {
    expect(NEXUS_SYNTHESIZE_PROMPT).toMatch(/Cite sources by name/);
    expect(NEXUS_SYNTHESIZE_PROMPT).toMatch(/\[Brave Search\]/);
    // Should NOT carry the prior over-strict "Do NOT" form that triggered
    // empty completions; positive guidance is the contract now.
    expect(NEXUS_SYNTHESIZE_PROMPT).not.toMatch(/Do NOT use index-style/);
  });

  it('decision prompt teaches name-based citations', () => {
    expect(NEXUS_DECISION_PROMPT).toMatch(/Cite sources by name/);
    expect(NEXUS_DECISION_PROMPT).toMatch(/\[Brave Search\]/);
    expect(NEXUS_DECISION_PROMPT).not.toMatch(/Do NOT use index-style/);
  });
});

describe('normalizeKeywordQuery', () => {
  it('lowercases and strips punctuation', () => {
    // C++ → "c" after punctuation strip → single-char, filtered (same as C#)
    expect(normalizeKeywordQuery('C++, Rust & Go!')).toBe('rust go');
  });

  it('clamps to 4 tokens by default', () => {
    const out = normalizeKeywordQuery('llm tool use prompt engineering vision websearch');
    expect(out.split(' ').length).toBeLessThanOrEqual(4);
    expect(out).toBe('llm tool use prompt');
  });

  it('respects explicit max', () => {
    const out = normalizeKeywordQuery('cloudflare workers ai models pricing', 3);
    expect(out.split(' ').length).toBe(3);
  });

  it('drops single-char tokens (e.g. stripped C# → c)', () => {
    // C# becomes "c" after punctuation strip — too short, filtered
    expect(normalizeKeywordQuery('C# async patterns')).toBe('async patterns');
  });

  it('does NOT apply stop-word filtering (trusts LLM selection)', () => {
    // "the" and "and" are stop words in extractKeywords but not here
    expect(normalizeKeywordQuery('the llm and tools')).toContain('the');
  });
});

