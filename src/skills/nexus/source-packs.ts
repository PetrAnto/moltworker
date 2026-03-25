/**
 * Nexus — Source Pack Fetchers
 *
 * Each fetcher retrieves data from a specific source type.
 * All return { data, url } or throw on failure.
 * Uses executeSkillTool for policy-enforced tool access.
 */

import type { EvidenceItem, ConfidenceTier } from './types';
import { executeSkillTool, buildSkillToolContext } from '../skill-tools';
import type { ToolCall } from '../../openrouter/tools';
import type { MoltbotEnv } from '../../types';

/** Result from a source fetcher. */
interface FetchResult {
  data: string;
  url?: string;
  source: string;
  confidence: ConfidenceTier;
}

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `nexus-${name}-${Date.now()}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchWebSearch(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('web_search', { query }), ctx);
  if (result.content.startsWith('Error:')) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), source: 'Brave Search', confidence: 'medium' };
}

async function fetchUrl(url: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url }), ctx);
  if (result.content.startsWith('Error:')) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), url, source: 'URL Fetch', confidence: 'high' };
}

async function fetchWikipedia(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: wikiUrl }), ctx);
  if (result.content.startsWith('Error:')) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), url: wikiUrl, source: 'Wikipedia', confidence: 'high' };
}

async function fetchNews(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_news', { query }), ctx);
  if (result.content.startsWith('Error:')) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), source: 'News', confidence: 'medium' };
}

async function fetchHackerNews(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const hnUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: hnUrl }), ctx);
  if (result.content.startsWith('Error:')) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), url: hnUrl, source: 'Hacker News', confidence: 'medium' };
}

async function fetchReddit(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=5`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: redditUrl }), ctx);
  if (result.content.startsWith('Error:')) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), url: redditUrl, source: 'Reddit', confidence: 'low' };
}

async function fetchCrypto(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('get_crypto', { symbol: query }), ctx);
  if (result.content.startsWith('Error:')) throw new Error(result.content);
  return { data: result.content, source: 'Crypto Data', confidence: 'high' };
}

async function fetchFinance(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  // Use web search with finance context
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('web_search', { query: `${query} stock market finance` }), ctx);
  if (result.content.startsWith('Error:')) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), source: 'Finance Search', confidence: 'medium' };
}

// ---------------------------------------------------------------------------
// Source pack registry
// ---------------------------------------------------------------------------

type SourceFetcher = (query: string, env: MoltbotEnv, userId?: string) => Promise<FetchResult>;

const SOURCE_REGISTRY: Record<string, SourceFetcher> = {
  webSearch: fetchWebSearch,
  wikipedia: fetchWikipedia,
  hackerNews: fetchHackerNews,
  reddit: fetchReddit,
  news: fetchNews,
  crypto: fetchCrypto,
  finance: fetchFinance,
};

/** Fetch URL directly (for dossier entity research). */
export { fetchUrl };

/**
 * Fetch from multiple sources in parallel, with graceful degradation.
 * Returns evidence items for all sources that succeeded.
 */
export async function fetchSources(
  query: string,
  sourceNames: string[],
  env: MoltbotEnv,
  userId?: string,
): Promise<{ evidence: EvidenceItem[]; toolCalls: number }> {
  const fetchers = sourceNames
    .map(name => SOURCE_REGISTRY[name])
    .filter((f): f is SourceFetcher => f !== undefined);

  if (fetchers.length === 0) {
    // Fallback: web search
    fetchers.push(fetchWebSearch);
  }

  const results = await Promise.allSettled(
    fetchers.map(f => f(query, env, userId)),
  );

  const evidence: EvidenceItem[] = [];
  let toolCalls = 0;

  for (const result of results) {
    toolCalls++;
    if (result.status === 'fulfilled') {
      evidence.push({
        source: result.value.source,
        url: result.value.url,
        data: result.value.data,
        confidence: result.value.confidence,
      });
    }
    // Rejected sources are silently skipped (graceful degradation)
  }

  return { evidence, toolCalls };
}

/** Get all available source names. */
export function getAvailableSources(): string[] {
  return Object.keys(SOURCE_REGISTRY);
}
