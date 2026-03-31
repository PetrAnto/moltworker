/**
 * Per-Session R2 Scratchpad
 *
 * Persists concise learnings across steps within the same roadmap session
 * so later steps can reuse prior context without depending only on compressed
 * conversation history.
 *
 * Storage: one R2 JSON object per session.
 * Key format: orchestra/scratchpad/{userId}/{scratchpadKey}.json
 */

// --- Types ---

export interface ScratchpadEntry {
  step: string;
  summary: string;
  timestamp: number;
}

export interface Scratchpad {
  entries: ScratchpadEntry[];
  createdAt: number;
  repo: string;
}

// --- Constants ---

/** Maximum number of entries to include in prompt injection. */
const MAX_PROMPT_ENTRIES = 10;

/** Maximum character length for the formatted scratchpad prompt block. */
const MAX_PROMPT_CHARS = 2000;

// --- Helpers ---

/**
 * Deterministic hash for scratchpad key generation.
 * Uses djb2 algorithm — fast, deterministic, no dependencies.
 */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Build the R2 key for a scratchpad object.
 */
function buildScratchpadKey(userId: string, repo: string, roadmapPath: string): string {
  const composite = `${repo}::${roadmapPath}`;
  const hash = djb2Hash(composite);
  return `orchestra/scratchpad/${userId}/${hash}.json`;
}

// --- Public API ---

/**
 * Load an existing scratchpad from R2.
 * Returns null if missing or corrupted — never throws for normal cases.
 */
export async function loadScratchpad(
  r2: R2Bucket,
  userId: string,
  repo: string,
  roadmapPath: string,
): Promise<Scratchpad | null> {
  try {
    const key = buildScratchpadKey(userId, repo, roadmapPath);
    const obj = await r2.get(key);
    if (!obj) return null;

    const text = await obj.text();
    const parsed = JSON.parse(text);

    // Basic shape validation
    if (!parsed || !Array.isArray(parsed.entries) || typeof parsed.createdAt !== 'number') {
      return null;
    }

    return parsed as Scratchpad;
  } catch {
    return null;
  }
}

/**
 * Append a single entry to the scratchpad.
 * Creates the scratchpad if absent. Best-effort: callers can continue if R2 fails.
 */
export async function appendScratchpad(
  r2: R2Bucket,
  userId: string,
  repo: string,
  roadmapPath: string,
  entry: ScratchpadEntry,
): Promise<void> {
  try {
    const key = buildScratchpadKey(userId, repo, roadmapPath);
    const existing = await loadScratchpad(r2, userId, repo, roadmapPath);

    const scratchpad: Scratchpad = existing ?? {
      entries: [],
      createdAt: Date.now(),
      repo,
    };

    scratchpad.entries.push(entry);

    await r2.put(key, JSON.stringify(scratchpad));
  } catch {
    // Best-effort — callers continue normally if R2 fails
  }
}

/**
 * Format the scratchpad for injection into the Orchestra run prompt.
 * Returns a concise, bounded prompt block. Only includes recent entries.
 * Returns empty string if scratchpad is empty or null.
 */
export function formatScratchpadForPrompt(scratchpad: Scratchpad | null): string {
  if (!scratchpad || scratchpad.entries.length === 0) return '';

  // Take only the most recent entries
  const recent = scratchpad.entries.slice(-MAX_PROMPT_ENTRIES);

  const lines: string[] = ['## Session Scratchpad (learnings from prior steps)'];

  let totalLen = lines[0].length;
  for (const entry of recent) {
    // Truncate individual summaries to keep things concise
    const summary = entry.summary.length > 150
      ? entry.summary.slice(0, 147) + '...'
      : entry.summary;
    const line = `- **${entry.step}**: ${summary}`;

    if (totalLen + line.length + 1 > MAX_PROMPT_CHARS) break;
    lines.push(line);
    totalLen += line.length + 1;
  }

  // If we only have the header, nothing was added
  if (lines.length <= 1) return '';

  return lines.join('\n');
}
