/**
 * Audit Skill — Extractor (zero-LLM, AST-driven)
 *
 * Takes a `RepoProfile` + a set of selected paths + their fetched contents
 * and produces `ExtractedSnippet[]` for the Analyst. The Analyst sees ONLY
 * these snippets (path + lines + verbatim text), never raw files. This is
 * the core token-saving step of the four-role pipeline.
 *
 * Per-language behavior:
 *   - typescript / tsx / javascript / python / go: parsed via web-tree-sitter,
 *     extracts function/class/import/export nodes (queries.ts).
 *   - .github/workflows/*.yml: emitted as a single 'workflow' snippet
 *     (full file, truncated at MAX_SNIPPET_BYTES). YAML lacks a stable
 *     tree-sitter grammar in our MVP set, so verbatim is the right shape
 *     for the security-lens prompts that read it.
 *   - manifests (package.json/tsconfig.json/etc): emitted as a single
 *     'manifest' snippet, verbatim.
 *
 * Telemetry: returned alongside the snippets so the handler can surface
 * "parsed N files in Mms, extracted K snippets" in the audit plan.
 */

import { classifyNode, relevantNodeTypes } from './queries';
import { loadLanguage, newParserForLanguage } from './parser';
import type { GrammarLoaderEnv, LoadResult } from '../grammars/loader';
import {
  type ExtractedSnippet,
  type GrammarLanguage,
  type RepoProfile,
  type SnippetKind,
  MAX_SNIPPET_BYTES,
  isGrammarLanguage,
} from '../types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExtractContext {
  /** Profile from the Scout — provides tree, manifests, alerts, sha. */
  profile: RepoProfile;
  /** Paths the caller wants extracted, in order. Must be a subset of
   *  `profile.tree.path`. The caller is responsible for fetching the
   *  contents (Scout pre-fetches manifests; the Extractor doesn't itself
   *  call GitHub). */
  selections: ReadonlyArray<{ path: string; content: string }>;
  /** Loader for grammar bytes — usually a closure over the loader module's
   *  loadGrammar(env, lang). Indirected for testability. */
  loadGrammar: (lang: GrammarLanguage) => Promise<LoadResult | null>;
}

export interface ExtractResult {
  snippets: ExtractedSnippet[];
  /** Languages that were actually parsed (for telemetry / Analyst routing). */
  languagesUsed: Set<GrammarLanguage | 'yaml' | 'json' | 'plain'>;
  /** Per-language counts, helpful for "extracted 12 functions, 4 classes…". */
  byKind: Record<SnippetKind, number>;
  /** Files that errored during parse. Best-effort: the Extractor never throws. */
  parseErrors: Array<{ path: string; reason: string }>;
  /** Wall-clock duration of the extract pass. */
  durationMs: number;
}

const EMPTY_BY_KIND: Record<SnippetKind, number> = {
  function: 0, class: 0, import: 0, export: 0, workflow: 0, manifest: 0,
};

export async function extractSnippets(ctx: ExtractContext): Promise<ExtractResult> {
  const start = Date.now();
  const snippets: ExtractedSnippet[] = [];
  const languagesUsed = new Set<GrammarLanguage | 'yaml' | 'json' | 'plain'>();
  const byKind = { ...EMPTY_BY_KIND };
  const parseErrors: Array<{ path: string; reason: string }> = [];

  // Manifests come straight from the Scout — emit verbatim before any parse work.
  for (const m of ctx.profile.manifests) {
    if (m.content == null) continue;
    const text = truncate(m.content);
    snippets.push({
      path: m.path,
      kind: 'manifest',
      name: basename(m.path),
      startLine: 1,
      endLine: countLines(m.content),
      text: text.text,
      truncated: text.truncated,
      language: detectManifestLanguage(m.path),
      sha: m.sha,
    });
    byKind.manifest++;
    languagesUsed.add(detectManifestLanguage(m.path));
  }

  // Group selections by language so we load each grammar once.
  const byLang = new Map<GrammarLanguage | 'workflow' | 'unsupported', Array<{ path: string; content: string }>>();
  const treeByPath = new Map(ctx.profile.tree.map(t => [t.path, t]));
  const profilePathSet = new Set(ctx.profile.tree.map(t => t.path));

  for (const sel of ctx.selections) {
    if (!profilePathSet.has(sel.path)) {
      parseErrors.push({ path: sel.path, reason: 'path not in profile.tree (rejected by enum)' });
      continue;
    }
    const lang = pickLanguage(sel.path);
    const bucket = byLang.get(lang) ?? [];
    bucket.push(sel);
    byLang.set(lang, bucket);
  }

  // Workflows: verbatim, no parse.
  for (const w of byLang.get('workflow') ?? []) {
    const text = truncate(w.content);
    snippets.push({
      path: w.path,
      kind: 'workflow',
      name: basename(w.path),
      startLine: 1,
      endLine: countLines(w.content),
      text: text.text,
      truncated: text.truncated,
      language: 'yaml',
      sha: treeByPath.get(w.path)?.sha,
    });
    byKind.workflow++;
    languagesUsed.add('yaml');
  }

  // Unsupported: report so the Analyst knows.
  for (const u of byLang.get('unsupported') ?? []) {
    parseErrors.push({ path: u.path, reason: 'no grammar for this file extension' });
  }

  // Parsed languages.
  for (const [lang, files] of byLang) {
    if (lang === 'workflow' || lang === 'unsupported') continue;
    const grammar = await ctx.loadGrammar(lang);
    if (!grammar) {
      for (const f of files) {
        parseErrors.push({ path: f.path, reason: `grammar "${lang}" unavailable (loader returned null)` });
      }
      continue;
    }

    let language;
    try {
      language = await loadLanguage(lang, grammar.bytes, grammar.entry.sha256);
    } catch (err) {
      for (const f of files) {
        parseErrors.push({ path: f.path, reason: `loadLanguage failed: ${errMsg(err)}` });
      }
      continue;
    }

    const parser = newParserForLanguage(language);
    languagesUsed.add(lang);

    for (const file of files) {
      try {
        const fileSnippets = parseFile(file.path, file.content, parser, lang, treeByPath.get(file.path)?.sha);
        for (const s of fileSnippets) {
          snippets.push(s);
          byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
        }
      } catch (err) {
        parseErrors.push({ path: file.path, reason: `parse failed: ${errMsg(err)}` });
      }
    }
  }

  return {
    snippets,
    languagesUsed,
    byKind,
    parseErrors,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Per-file parse + node walk
// ---------------------------------------------------------------------------

function parseFile(
  path: string,
  source: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parser: any,
  language: GrammarLanguage,
  sha: string | undefined,
): ExtractedSnippet[] {
  const tree = parser.parse(source);
  const wanted = relevantNodeTypes(language);
  const nodes = tree.rootNode.descendantsOfType(wanted);
  const out: ExtractedSnippet[] = [];

  for (const node of nodes) {
    const kind = classifyNode(language, node.type);
    if (!kind) continue;
    // For arrow_function / function_expression: only emit if they have a
    // declarable name (assigned to a const/let/var or method shorthand).
    // Anonymous arrow callbacks are too noisy for an audit overview.
    const name = nodeName(node);
    if ((node.type === 'arrow_function' || node.type === 'function_expression') && !name) {
      continue;
    }
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const slice = source.slice(node.startIndex, node.endIndex);
    const t = truncate(slice);
    out.push({
      path, kind, name, startLine, endLine,
      text: t.text,
      truncated: t.truncated,
      language,
      sha,
    });
  }

  tree.delete();
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickLanguage(path: string): GrammarLanguage | 'workflow' | 'unsupported' {
  if (/\.github\/workflows\/.+\.(ya?ml)$/.test(path)) return 'workflow';
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts')) return 'typescript';
  if (lower.endsWith('.jsx')) return 'tsx'; // tsx grammar handles JSX
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  return 'unsupported';
}

function detectManifestLanguage(path: string): 'json' | 'yaml' | 'plain' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  return 'plain';
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_SNIPPET_BYTES) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_SNIPPET_BYTES) + '\n…[truncated]', truncated: true };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort name extraction. Tree-sitter exposes named children via
 * `childForFieldName`, but field names vary across languages and grammar
 * versions. We probe the most common ones; on miss we return ''.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeName(node: any): string {
  // Most languages: `name` field
  const named = node.childForFieldName?.('name');
  if (named?.text) return named.text;
  // Imports often have no "name" field; use the first string literal child
  if (node.type.startsWith('import')) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cur = node.descendantsOfType?.(['string', 'string_literal']) as any[] | undefined;
    if (cur && cur.length > 0) return cur[0].text;
  }
  // Method definitions in TS sometimes use 'property_identifier' as the name
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < (node.namedChildCount ?? 0); i++) {
    const c = node.namedChild(i);
    if (c?.type === 'property_identifier' || c?.type === 'identifier') {
      return c.text ?? '';
    }
  }
  return '';
}

/** Convenience binding so callers can pass `loaderForEnv(env)` instead of
 *  having to import `loadGrammar` directly + the env separately. */
export function loaderForEnv(
  env: GrammarLoaderEnv,
  loadGrammarImpl: (env: GrammarLoaderEnv, lang: GrammarLanguage) => Promise<LoadResult | null>,
): (lang: GrammarLanguage) => Promise<LoadResult | null> {
  return (lang) => {
    if (!isGrammarLanguage(lang)) return Promise.resolve(null);
    return loadGrammarImpl(env, lang);
  };
}
