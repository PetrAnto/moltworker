/**
 * Nexus — Source Pack Fetchers
 *
 * Each fetcher retrieves data from a specific source type.
 * All return { data, url } or throw on failure.
 * Uses executeSkillTool for policy-enforced tool access.
 */

import type { EvidenceItem, ConfidenceTier, SourceAttempt } from './types';
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

/**
 * Per-fetch context. Used to pass distilled keyword tokens (from the LLM
 * classifier) to keyword-strict fetchers that would otherwise stumble on
 * natural-language queries. Optional and additive — fetchers that don't
 * need it ignore it.
 */
export interface SourceFetchContext {
  /**
   * 2-4 distinctive keyword tokens for keyword-strict APIs (GitHub, Stack
   * Exchange, Wikidata, etc.). Provided by the classifier LLM, with the
   * local extractKeywords() heuristic as a fallback.
   */
  keywordQuery?: string;
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

/**
 * Stop-word list for keyword extraction on keyword-strict APIs (GitHub
 * search, Stack Exchange, Wikidata entity search, World Bank indicator
 * search, SEC EDGAR full-text). These APIs treat the query string as an
 * AND of all tokens, so passing a natural-language phrase like "ai models
 * and other fee features in cloudflare workers" returns zero hits because
 * no single repo/question matches every token. Conservative list: only
 * obvious noise/connectives, not domain-meaningful words.
 */
const STOP_WORDS = new Set([
  // articles + prepositions
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'by', 'for', 'to', 'with', 'from',
  'into', 'onto', 'over', 'under', 'between', 'across',
  // conjunctions
  'and', 'or', 'but', 'vs', 'versus', 'so',
  // question + comparison words
  'what', 'where', 'when', 'who', 'why', 'which', 'how', 'whose',
  // generic qualifiers that are noise for repo/QA search
  'best', 'free', 'available', 'other', 'top', 'good', 'better', 'kind', 'kinds',
  'type', 'types', 'this', 'that', 'these', 'those', 'about', 'some', 'any',
  // meta words that aren't usually in repo names / SO question titles
  'features', 'feature', 'thing', 'things', 'stuff', 'way', 'ways', 'list',
  'option', 'options', 'overview', 'introduction', 'guide', 'tutorial',
  'example', 'examples',
  // verbs
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall', 'may',
  'might', 'must',
  // pronouns
  'it', 'its', 'they', 'them', 'their', 'he', 'she', 'his', 'her', 'i', 'me',
  'my', 'we', 'us', 'our', 'you', 'your',
]);

/**
 * Extract up to `max` distinctive keyword tokens from a natural-language
 * query for use with keyword-strict search APIs. Lowercases, strips
 * punctuation, drops stop words and 1-char tokens, preserves order.
 */
export function extractKeywords(query: string, max = 4): string {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
    .slice(0, max)
    .join(' ');
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

async function fetchStackExchange(query: string, env: MoltbotEnv, userId?: string, fctx?: SourceFetchContext): Promise<FetchResult> {
  // /search/excerpts returns title + body excerpt + score per hit, which is
  // higher signal for synthesis than just titles. Stack Overflow is the
  // default site; Stack Exchange has 170+ sister sites (cooking, photography,
  // math, writing, etc.) but cross-site search needs site-id and complicates
  // the call — leave that to a future "site picker" pass.
  // The API treats `q` as AND of all tokens. Prefer the LLM-distilled
  // keywordQuery; fall back to the local extractor; last resort, raw query.
  const keywords = (fctx?.keywordQuery && fctx.keywordQuery.trim()) || extractKeywords(query) || query;
  const seUrl = `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${encodeURIComponent(keywords)}&site=stackoverflow&pagesize=5`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('fetch_url', { url: seUrl }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  if (/"items"\s*:\s*\[\s*\]/.test(result.content)) {
    throw new Error(`Stack Exchange: no matching questions (searched: "${keywords}")`);
  }
  return { data: result.content.slice(0, 3000), url: seUrl, source: 'Stack Exchange', confidence: 'high' };
}

async function fetchGitHub(query: string, env: MoltbotEnv, userId?: string, fctx?: SourceFetchContext): Promise<FetchResult> {
  // Goes through github_api so the request carries our PAT and avoids the
  // 60/hr unauth limit shared across all CF egress IPs. Repository search
  // by stars is a reasonable default — relevant projects + descriptions +
  // language for any tool/library/concept query.
  // GitHub search syntax ANDs tokens. Prefer the LLM-distilled
  // keywordQuery; fall back to the local extractor; last resort, raw query.
  const keywords = (fctx?.keywordQuery && fctx.keywordQuery.trim()) || extractKeywords(query) || query;
  const endpoint = `/search/repositories?q=${encodeURIComponent(keywords)}&sort=stars&order=desc&per_page=5`;
  const ctx = buildSkillToolContext(env, userId);
  const result = await executeSkillTool('nexus', makeToolCall('github_api', { endpoint, method: 'GET' }), ctx);
  if (isToolError(result.content)) throw new Error(result.content);
  if (/"total_count"\s*:\s*0\b/.test(result.content)) {
    throw new Error(`GitHub: no matching repositories (searched: "${keywords}")`);
  }
  const browseUrl = `https://github.com/search?q=${encodeURIComponent(keywords)}&type=repositories`;
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

async function fetchWikidata(query: string, env: MoltbotEnv, userId?: string, fctx?: SourceFetchContext): Promise<FetchResult> {
  // wbsearchentities is the simplest Wikidata search — returns id+label+
  // description per match. Avoids constructing SPARQL while still giving
  // the synthesis LLM authoritative entity hooks (Q-IDs) it can cite.
  // wbsearchentities matches against entity labels — prefer the
  // LLM-distilled keywordQuery; fall back to a 3-token local extraction.
  const keywords = (fctx?.keywordQuery && fctx.keywordQuery.trim()) || extractKeywords(query, 3) || query;
  const wdUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(keywords)}&language=en&format=json&limit=10&type=item`;
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

async function fetchWorldBank(query: string, env: MoltbotEnv, userId?: string, fctx?: SourceFetchContext): Promise<FetchResult> {
  // World Bank's indicator-metadata search — returns indicator codes,
  // names, sources, topics. For actual time-series the LLM would need a
  // follow-up call with a specific indicator code, but for "is there a
  // World Bank dataset on X" research questions the metadata is enough.
  const keywords = (fctx?.keywordQuery && fctx.keywordQuery.trim()) || extractKeywords(query) || query;
  const wbUrl = `https://api.worldbank.org/v2/sources/2/indicators?format=json&search=${encodeURIComponent(keywords)}&per_page=10`;
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

async function fetchSecEdgar(query: string, env: MoltbotEnv, userId?: string, fctx?: SourceFetchContext): Promise<FetchResult> {
  // EDGAR's full-text search of EDGAR filings. Heads-up: SEC's fair access
  // policy requires a User-Agent identifying the requester with a contact
  // email; the shared MoltworkerBot UA may get rate-limited or blocked. If
  // this source consistently fails, the fix is to extend fetch_url with
  // per-call header overrides — left as a follow-up.
  const keywords = (fctx?.keywordQuery && fctx.keywordQuery.trim()) || extractKeywords(query) || query;
  const secUrl = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(keywords)}&forms=10-K&hits=5`;
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

type SourceFetcher = (
  query: string,
  env: MoltbotEnv,
  userId?: string,
  ctx?: SourceFetchContext,
) => Promise<FetchResult>;

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
 * Returns evidence items for all sources that succeeded plus an `attempts`
 * record for every source the classifier asked us to try (success or
 * failure). The attempts list is what the renderer surfaces in the dossier
 * when a fetcher drops — so the next failing dossier reveals its own
 * smoking gun without requiring wrangler tail access.
 */
export async function fetchSources(
  query: string,
  sourceNames: string[],
  env: MoltbotEnv,
  userId?: string,
  fetchContext?: SourceFetchContext,
): Promise<{ evidence: EvidenceItem[]; toolCalls: number; attempts: SourceAttempt[] }> {
  // Track which classifier-named source corresponds to each settled result
  // so failure logs name the actual source (not just an index). Filter out
  // unknown registry names but keep the parallel name list aligned with the
  // fetchers list for the post-settle log.
  const named = sourceNames
    .map(name => ({ name, fn: SOURCE_REGISTRY[name] }))
    .filter((f): f is { name: string; fn: SourceFetcher } => f.fn !== undefined);

  const unknown = sourceNames.filter(n => !SOURCE_REGISTRY[n]);
  if (unknown.length > 0) {
    console.warn(`[Nexus] classifier asked for unknown sources, dropped: ${JSON.stringify(unknown)}`);
  }

  if (named.length === 0) {
    // Fallback: web search
    named.push({ name: 'webSearch', fn: fetchWebSearch });
  }

  // Pre-allocate attempts so each parallel fetch can write its own slot
  // without races; Promise.allSettled preserves order.
  const attempts: SourceAttempt[] = named.map(n => ({
    source: n.name,
    status: 'failed',
    reason: 'pending',
    durationMs: 0,
  }));

  const results = await Promise.allSettled(
    named.map(async (n, i) => {
      const t0 = Date.now();
      try {
        const r = await n.fn(query, env, userId, fetchContext);
        attempts[i] = { source: n.name, status: 'ok', durationMs: Date.now() - t0 };
        return r;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        attempts[i] = { source: n.name, status: 'failed', reason, durationMs: Date.now() - t0 };
        throw err;
      }
    }),
  );

  const evidence: EvidenceItem[] = [];
  let toolCalls = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    toolCalls++;
    if (result.status === 'fulfilled') {
      evidence.push({
        source: result.value.source,
        url: result.value.url,
        data: result.value.data,
        confidence: result.value.confidence,
      });
    } else {
      // Graceful degradation — failed sources don't break the dossier. Log
      // for wrangler tail; the rendered dossier also surfaces this via the
      // attempts list, so the user sees it without log access.
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn(`[Nexus] source "${named[i].name}" failed: ${reason}`);
    }
  }

  return { evidence, toolCalls, attempts };
}

/** Get all available source names. */
export function getAvailableSources(): string[] {
  return Object.keys(SOURCE_REGISTRY);
}

/**
 * Default source backbone per query category. The classifier's picks come
 * first (LLM intent wins), but we backfill from these defaults so a thin
 * pick like ["webSearch"] still fans out to 3+ complementary sources.
 *
 * Webm — every category includes webSearch first, since it's the broadest
 * keyless fallback and works for any query.
 */
export const CATEGORY_DEFAULTS: Record<string, string[]> = {
  entity:     ['webSearch', 'wikipedia', 'wikidata'],
  topic:      ['webSearch', 'wikipedia', 'news'],
  market:     ['webSearch', 'finance', 'news'],
  decision:   ['webSearch', 'stackExchange', 'hackerNews'],
  technical:  ['webSearch', 'stackExchange', 'github'],
  academic:   ['webSearch', 'openalex', 'arxiv'],
  regulatory: ['webSearch', 'secEdgar', 'news'],
  historical: ['webSearch', 'wikipedia', 'internetArchive'],
};

/** Backbone used when category is missing/unknown. */
const FALLBACK_DEFAULTS = ['webSearch', 'wikipedia', 'hackerNews'];

/** Maximum number of sources to fetch in parallel per dossier. */
const MAX_SOURCES = 5;

/**
 * Expand the classifier's picks with category-appropriate defaults so the
 * dossier always fans out to multiple complementary sources, even when the
 * classifier returns a thin list or when individual sources fail at fetch
 * time. Dedup preserves classifier intent (its picks come first), unknown
 * names are dropped, and the result is capped to keep subrequest budget
 * reasonable.
 */
export function expandSourcePicks(category: string | undefined, classifierPicks: string[]): string[] {
  const defaults = (category && CATEGORY_DEFAULTS[category]) || FALLBACK_DEFAULTS;
  const merged = [...classifierPicks, ...defaults];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of merged) {
    if (seen.has(name)) continue;
    if (!SOURCE_REGISTRY[name]) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}
