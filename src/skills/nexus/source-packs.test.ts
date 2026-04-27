/**
 * Tests for nexus source-pack helpers.
 */

import { describe, it, expect } from 'vitest';
import { isToolError, getAvailableSources } from './source-packs';
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

