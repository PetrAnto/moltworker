/**
 * Deterministic alias generation for auto-synced models.
 *
 * Strategy:
 * 1. Strip provider prefix (e.g., "openai/" → "")
 * 2. Remove date suffixes, version tags, "preview", "latest"
 * 3. Collapse to lowercase alphanumeric
 * 4. Smart abbreviation: known model families get readable short forms
 * 5. Truncate to 24 chars (Telegram-safe)
 * 6. Resolve conflicts by appending provider code or counter
 *
 * Uses a stable alias map (modelId → alias) persisted in R2
 * so aliases don't change between syncs.
 */

/**
 * Sanitize an alias to be Telegram bot-command compatible.
 * Telegram commands only support /[a-z0-9_]+, so strip everything else.
 */
function sanitizeAlias(alias: string): string {
  return alias.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Known model family abbreviations for readable aliases */
const FAMILY_ABBREVIATIONS: Record<string, string> = {
  'gemini': 'gem',
  'claude': 'claude',
  'llama': 'llama',
  'mistral': 'mistral',
  'mixtral': 'mixtral',
  'codestral': 'codestral',
  'command': 'cmd',
  'deepseek': 'ds',
  'qwen': 'qwen',
  'phi': 'phi',
  'grok': 'grok',
  'nova': 'nova',
  'titan': 'titan',
  'jamba': 'jamba',
  'dbrx': 'dbrx',
  'internlm': 'intern',
  'yi': 'yi',
  'solar': 'solar',
  'olympiccoder': 'olympcoder',
  'codex': 'codex',
};

/**
 * Generate a stable alias for a model ID.
 * If the model already has an alias in the map, return it (after sanitization).
 * Otherwise generate a new one and add to the map.
 */
export function generateAlias(
  modelId: string,
  existingAliases: Set<string>,
  aliasMap: Record<string, string>,
): string {
  // Return existing stable alias if we've seen this model before
  if (aliasMap[modelId]) {
    // Sanitize cached alias (old R2 maps may contain hyphens/dots)
    const raw = aliasMap[modelId];
    const alias = sanitizeAlias(raw);
    if (alias !== raw) {
      aliasMap[modelId] = alias; // Self-heal: update map for next R2 persist
    }

    if (!existingAliases.has(alias)) {
      existingAliases.add(alias);
      return alias;
    }
    // Alias exists but conflicts — return it anyway (it was assigned first)
    return alias;
  }

  const alias = createNewAlias(modelId, existingAliases);
  aliasMap[modelId] = alias;
  existingAliases.add(alias);
  return alias;
}

/**
 * Create a new alias from a model ID.
 * Produces readable aliases like: gpt51codex, gem25flashlite, claudesonnet46
 */
function createNewAlias(modelId: string, existingAliases: Set<string>): string {
  // Strip provider prefix
  let base = modelId.includes('/') ? modelId.split('/').pop()! : modelId;

  // Remove :free / :nitro / :extended suffixes
  base = base.replace(/:(free|nitro|extended|floor)$/i, '');

  // Remove date suffixes (2024-01-01, 20240101, -01-2025, etc.)
  base = base.replace(/-?\d{4}-\d{2}-\d{2}/g, '');
  base = base.replace(/-?\d{2}-\d{4}/g, '');
  base = base.replace(/-?\d{6,8}/g, '');

  // Remove trailing version/preview tags but KEEP "preview" if it's mid-string
  // e.g. "gemini-3-pro-preview" → "gemini-3-pro" but preserve order
  base = base.replace(/-(preview|latest|beta|alpha|exp|experimental)$/gi, '');
  // Remove -instruct, -chat, -online suffixes (not meaningful for alias)
  base = base.replace(/-(instruct|chat|online)$/gi, '');

  // Split into meaningful parts on hyphens/dots/underscores
  const parts = base.split(/[-._]+/).filter(p => p.length > 0);

  // Identify the model family (first recognizable part)
  let familyPart = '';
  let versionPart = '';
  const qualifierParts: string[] = [];

  for (const part of parts) {
    const lower = part.toLowerCase();

    // Version numbers: "4o", "3.5", "51", "2.5", "r1", etc.
    if (/^\d+(\.\d+)?[a-z]?$/i.test(lower) || /^[rv]\d+/i.test(lower)) {
      if (familyPart) {
        versionPart += lower.replace('.', '');
      } else {
        qualifierParts.push(lower);
      }
      continue;
    }

    // Known family abbreviation
    if (!familyPart && FAMILY_ABBREVIATIONS[lower]) {
      familyPart = FAMILY_ABBREVIATIONS[lower];
      continue;
    }

    // GPT special handling (keep as-is, it's already short)
    if (!familyPart && /^gpt/i.test(lower)) {
      familyPart = 'gpt';
      // Extract version from "gpt4o", "gpt51", etc.
      const ver = lower.slice(3);
      if (ver) versionPart += ver;
      continue;
    }

    // First unrecognized word becomes the family
    if (!familyPart) {
      familyPart = lower.length > 8 ? lower.slice(0, 6) : lower;
      continue;
    }

    // Remaining parts are qualifiers
    qualifierParts.push(lower);
  }

  // Build the alias: family + version + key qualifiers
  let alias = familyPart + versionPart;

  // Add important qualifiers (skip noise words)
  const NOISE_WORDS = new Set(['the', 'a', 'an', 'v1', 'v2', 'base', 'it', 'hf']);
  const KEEP_SHORT: Record<string, string> = {
    'flash': 'flash',
    'lite': 'lite',
    'pro': 'pro',
    'max': 'max',
    'mini': 'mini',
    'nano': 'nano',
    'ultra': 'ultra',
    'plus': 'plus',
    'turbo': 'turbo',
    'large': 'large',
    'small': 'small',
    'medium': 'med',
    'coder': 'coder',
    'code': 'code',
    'vision': 'vis',
    'preview': 'prev',
    'thinking': 'think',
    'reasoning': 'reason',
    'creative': 'creative',
    'fast': 'fast',
    'free': '',  // Skip — handled by isFree flag
    'latest': '', // Skip
    'next': 'next',
    'edge': 'edge',
    'air': 'air',
    'haiku': 'haiku',
    'sonnet': 'sonnet',
    'opus': 'opus',
    'maverick': 'mav',
    'scout': 'scout',
    'open': 'open',
    'nemo': 'nemo',
    'nemotron': 'nemo',
  };

  for (const q of qualifierParts) {
    if (NOISE_WORDS.has(q)) continue;
    const short = KEEP_SHORT[q];
    if (short !== undefined) {
      if (short) alias += short;
      continue;
    }

    // Size indicators: "8b", "70b", "405b" — keep as-is
    if (/^\d+[bBkKmM]$/.test(q)) {
      alias += q.toLowerCase();
      continue;
    }

    // Unknown qualifier: take first 4 chars if long
    if (q.length > 5) {
      alias += q.slice(0, 4);
    } else {
      alias += q;
    }
  }

  // Collapse to alphanumeric
  alias = alias.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Truncate to 24 chars (generous limit — still Telegram-friendly)
  if (alias.length > 24) {
    alias = alias.slice(0, 24);
  }

  // Ensure non-empty
  if (!alias) {
    alias = 'model';
  }

  // Resolve conflicts
  if (existingAliases.has(alias)) {
    // Try appending provider short code
    const provider = modelId.includes('/') ? modelId.split('/')[0].slice(0, 3) : '';
    if (provider) {
      const provAlias = `${alias}${provider}`;
      if (provAlias.length <= 24 && !existingAliases.has(provAlias)) return provAlias;
    }

    // Fall back to counter
    let counter = 2;
    while (existingAliases.has(`${alias}${counter}`)) {
      counter++;
    }
    alias = `${alias}${counter}`;
  }

  return alias;
}

/**
 * Collect all aliases currently in use (curated + dynamic + blocked).
 */
export function collectExistingAliases(
  curatedModels: Record<string, unknown>,
  dynamicModels: Record<string, unknown>,
): Set<string> {
  const aliases = new Set<string>();
  for (const key of Object.keys(curatedModels)) aliases.add(key.toLowerCase());
  for (const key of Object.keys(dynamicModels)) aliases.add(key.toLowerCase());
  return aliases;
}
