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

/**
 * Detect a tool error result. The shared executeTool helper formats failures
 * two ways: `Error: ...` (denied tool / invalid args) and `Error executing
 * <tool>: ...` (caught exception, e.g. HTTP 4xx/5xx from fetch_url). Matching
 * only the first form silently treats Reddit's 403 / Wikipedia 404 as
 * successful evidence — see the dossier source-count miscount that surfaced
 * in production.
 */
export function isToolError(content: string): boolean {
  return content.startsWith('Error:') || content.startsWith('Error executing ');
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchWebSearch(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('web_search', { query }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), source: 'Brave Search', confidence: 'medium' };
}

async function fetchUrl(url: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), url, source: 'URL Fetch', confidence: 'high' };
}

async function fetchWikipedia(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: wikiUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), url: wikiUrl, source: 'Wikipedia', confidence: 'high' };
}

async function fetchNews(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_news', { query }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), source: 'News', confidence: 'medium' };
}

async function fetchHackerNews(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const hnUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: hnUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  // Algolia returns 200 with `"hits":[]` for queries that match nothing —
  // treat that as a failed source so it doesn't inflate the source count.
  if (/"nbHits"\s*:\s*0\b/.test(result.content) || /"hits"\s*:\s*\[\s*\]/.test(result.content)) {
    throw new Error('Hacker News: no matching stories');
  }
  return { data: result.content.slice(0, 3000), url: hnUrl, source: 'Hacker News', confidence: 'medium' };
}

async function fetchReddit(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=5`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: redditUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), url: redditUrl, source: 'Reddit', confidence: 'low' };
}

async function fetchCrypto(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('get_crypto', { symbol: query }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  return { data: result.content, source: 'Crypto Data', confidence: 'high' };
}

async function fetchFinance(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  // Use web search with finance context
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('web_search', { query: `${query} stock market finance` }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  return { data: result.content.slice(0, 3000), source: 'Finance Search', confidence: 'medium' };
}

// ---------------------------------------------------------------------------
// Extended sources — added 2026-04-27 to broaden coverage beyond the original
// 7-source set. Each is keyless, JSON-friendly, and graceful-degrades via
// isToolError() so a 4xx/5xx never inflates the final source count.
// ---------------------------------------------------------------------------

async function fetchStackExchange(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  // /search/excerpts returns title + body excerpt + score per hit, which is
  // higher signal for synthesis than just titles. Stack Overflow is the
  // default site; Stack Exchange has 170+ sister sites (cooking, photography,
  // math, writing, etc.) but cross-site search needs site-id and complicates
  // the call — leave that to a future "site picker" pass.
  const seUrl = `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=5`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: seUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  if (/"items"\s*:\s*\[\s*\]/.test(result.content)) {
    throw new Error('Stack Exchange: no matching questions');
  }
  return { data: result.content.slice(0, 3000), url: seUrl, source: 'Stack Exchange', confidence: 'high' };
}

async function fetchGitHub(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  // Goes through github_api so the request carries our PAT and avoids the
  // 60/hr unauth limit shared across all CF egress IPs. Repository search
  // by stars is a reasonable default — relevant projects + descriptions +
  // language for any tool/library/concept query.
  const endpoint = `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=5`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('github_api', { endpoint, method: 'GET' }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  if (/"total_count"\s*:\s*0\b/.test(result.content)) {
    throw new Error('GitHub: no matching repositories');
  }
  const browseUrl = `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`;
  return { data: result.content.slice(0, 3000), url: browseUrl, source: 'GitHub', confidence: 'high' };
}

async function fetchOpenAlex(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  // OpenAlex polite-pool: include `mailto=` for faster service. No API key
  // required for normal use. abstract_inverted_index would need decoding —
  // skip for v1; titles + DOIs + citation counts are enough signal for the
  // synthesis LLM.
  const fields = 'title,doi,publication_year,cited_by_count,authorships,open_access';
  const oaUrl = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=5&select=${fields}&mailto=research@moltworker.dev`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: oaUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  if (/"results"\s*:\s*\[\s*\]/.test(result.content)) {
    throw new Error('OpenAlex: no matching works');
  }
  return { data: result.content.slice(0, 3000), url: oaUrl, source: 'OpenAlex', confidence: 'high' };
}

async function fetchArxiv(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  // arXiv returns Atom XML, not JSON. fetchUrl's HTML stripper checks for
  // <! / <html prefixes and skips raw <?xml documents — so we pass the Atom
  // through as-is and the synthesis LLM parses titles/abstracts inline.
  const arxivUrl = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=5`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: arxivUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  // Atom uses <opensearch:totalResults>0</...> when nothing matches.
  if (/<opensearch:totalResults[^>]*>0<\/opensearch:totalResults>/.test(result.content)) {
    throw new Error('arXiv: no matching papers');
  }
  return { data: result.content.slice(0, 3000), url: arxivUrl, source: 'arXiv', confidence: 'high' };
}

async function fetchWikidata(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  // wbsearchentities is the simplest Wikidata search — returns id+label+
  // description per match. Avoids constructing SPARQL while still giving
  // the synthesis LLM authoritative entity hooks (Q-IDs) it can cite.
  const wdUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&format=json&limit=10&type=item`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: wdUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  if (/"search"\s*:\s*\[\s*\]/.test(result.content)) {
    throw new Error('Wikidata: no matching entities');
  }
  return { data: result.content.slice(0, 3000), url: wdUrl, source: 'Wikidata', confidence: 'high' };
}

async function fetchInternetArchive(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  // advancedsearch covers texts, audio, video, images, web archives —
  // everything IA hosts. fl[]= shapes the response down to the fields the
  // LLM needs (saves tokens vs. the default verbose schema).
  const fields = 'fl[]=identifier&fl[]=title&fl[]=description&fl[]=mediatype&fl[]=date';
  const iaUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&output=json&rows=10&${fields}`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: iaUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  if (/"numFound"\s*:\s*0\b/.test(result.content)) {
    throw new Error('Internet Archive: no matches');
  }
  return { data: result.content.slice(0, 3000), url: iaUrl, source: 'Internet Archive', confidence: 'medium' };
}

async function fetchWorldBank(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  // World Bank's indicator-metadata search — returns indicator codes,
  // names, sources, topics. For actual time-series the LLM would need a
  // follow-up call with a specific indicator code, but for "is there a
  // World Bank dataset on X" research questions the metadata is enough.
  const wbUrl = `https://api.worldbank.org/v2/sources/2/indicators?format=json&search=${encodeURIComponent(query)}&per_page=10`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: wbUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  // WB's v2 response is a 2-element array: [meta, items]. Empty data
  // surfaces as `[ {...meta...}, [] ]` or `"total":0` in the meta.
  if (/"total"\s*:\s*0\b/.test(result.content) || /,\s*\[\s*\]\s*\]\s*$/.test(result.content.trim())) {
    throw new Error('World Bank: no matching indicators');
  }
  return { data: result.content.slice(0, 3000), url: wbUrl, source: 'World Bank', confidence: 'high' };
}

async function fetchSecEdgar(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  // EDGAR's full-text search of EDGAR filings. Heads-up: SEC's fair access
  // policy requires a User-Agent identifying the requester with a contact
  // email; the shared MoltworkerBot UA may get rate-limited or blocked. If
  // this source consistently fails, the fix is to extend fetch_url with
  // per-call header overrides — left as a follow-up.
  const secUrl = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&forms=10-K&hits=5`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: secUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  if (/"total"\s*:\s*\{\s*"value"\s*:\s*0\b/.test(result.content)) {
    throw new Error('SEC EDGAR: no matching filings');
  }
  return { data: result.content.slice(0, 3000), url: secUrl, source: 'SEC EDGAR', confidence: 'high' };
}

async function fetchBluesky(query: string, env: MoltbotEnv, userId?: string): Promise<FetchResult> {
  // Bluesky's public AppView endpoint — no auth needed, generous rate.
  // Picked over Mastodon because Mastodon's status search requires auth
  // and per-instance rate limits are unpredictable from shared cloud IPs.
  const bskyUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=10`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: bskyUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  if (/"posts"\s*:\s*\[\s*\]/.test(result.content)) {
    throw new Error('Bluesky: no matching posts');
  }
  return { data: result.content.slice(0, 3000), url: bskyUrl, source: 'Bluesky', confidence: 'low' };
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
  // Extended sources (2026-04-27)
  stackExchange: fetchStackExchange,
  github: fetchGitHub,
  openalex: fetchOpenAlex,
  arxiv: fetchArxiv,
  wikidata: fetchWikidata,
  internetArchive: fetchInternetArchive,
  worldBank: fetchWorldBank,
  secEdgar: fetchSecEdgar,
  bluesky: fetchBluesky,
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
