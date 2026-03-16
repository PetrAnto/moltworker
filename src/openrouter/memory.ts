/**
 * Long-term User Memory (F.8)
 * Stores persistent facts about users that survive across sessions.
 * Facts are extracted from conversations via a fast model (flash)
 * and injected into system prompts for personalized context.
 */

export type MemoryCategory = 'preference' | 'context' | 'project' | 'personal' | 'technical';

export interface MemoryFact {
  id: string;
  fact: string;
  category: MemoryCategory;
  source: 'extracted' | 'manual';
  confidence: number; // 0.0-1.0
  createdAt: number;
  lastReferencedAt: number;
}

export interface UserMemory {
  userId: string;
  facts: MemoryFact[];
  updatedAt: number;
}

// Max facts to keep per user (ring buffer)
const MAX_FACTS = 100;
// Max facts to inject into prompt
const MAX_PROMPT_FACTS = 10;
// Minimum message length for extraction (skip very short messages)
export const MIN_EXTRACTION_LENGTH = 20;
// Minimum seconds between extractions per user (debounce)
export const EXTRACTION_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

// R2 key pattern
function memoryKey(userId: string): string {
  return `memory/${userId}/facts.json`;
}

/**
 * Generate a short ID for a fact (8 chars hex from content hash).
 */
function generateFactId(fact: string): string {
  let hash = 0;
  for (let i = 0; i < fact.length; i++) {
    const char = fact.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
}

/**
 * Load user memory from R2.
 */
export async function loadUserMemory(
  r2: R2Bucket,
  userId: string,
): Promise<UserMemory | null> {
  const key = memoryKey(userId);
  try {
    const obj = await r2.get(key);
    if (!obj) return null;
    return await obj.json() as UserMemory;
  } catch {
    return null;
  }
}

/**
 * Save user memory to R2 (internal helper).
 */
async function saveUserMemory(
  r2: R2Bucket,
  userId: string,
  memory: UserMemory,
): Promise<void> {
  memory.updatedAt = Date.now();
  await r2.put(memoryKey(userId), JSON.stringify(memory));
}

/**
 * Compute word overlap ratio between two strings.
 * Returns value between 0.0 and 1.0.
 */
export function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/**
 * Check if a new fact duplicates or conflicts with existing facts.
 * Returns:
 * - 'duplicate' if exact or near-duplicate
 * - 'update' + the existing fact if same category with high overlap (merge)
 * - 'replace' + the existing fact if contradiction detected
 * - 'new' if no overlap
 */
export function checkDeduplication(
  newFact: string,
  newCategory: MemoryCategory,
  existing: MemoryFact[],
): { action: 'duplicate' | 'update' | 'replace' | 'new'; existingFact?: MemoryFact } {
  const newLower = newFact.toLowerCase();

  for (const fact of existing) {
    const existingLower = fact.fact.toLowerCase();

    // Exact substring match — duplicate
    if (existingLower.includes(newLower) || newLower.includes(existingLower)) {
      return { action: 'duplicate', existingFact: fact };
    }

    // Same category + high word overlap — update/merge
    if (fact.category === newCategory) {
      const overlap = wordOverlap(newFact, fact.fact);
      if (overlap > 0.6) {
        return { action: 'update', existingFact: fact };
      }
    }
  }

  return { action: 'new' };
}

/**
 * Store a new memory fact, handling deduplication and ring buffer eviction.
 */
export async function storeMemoryFact(
  r2: R2Bucket,
  userId: string,
  factText: string,
  category: MemoryCategory,
  source: 'extracted' | 'manual' = 'extracted',
  confidence: number = 0.7,
): Promise<{ stored: boolean; reason?: string }> {
  let memory = await loadUserMemory(r2, userId);
  if (!memory) {
    memory = { userId, facts: [], updatedAt: Date.now() };
  }

  // Check deduplication
  const dedup = checkDeduplication(factText, category, memory.facts);

  switch (dedup.action) {
    case 'duplicate':
      return { stored: false, reason: 'duplicate' };

    case 'update': {
      // Merge: update the existing fact with newer text and boost confidence
      const idx = memory.facts.indexOf(dedup.existingFact!);
      if (idx >= 0) {
        memory.facts[idx].fact = factText; // Use newer text
        memory.facts[idx].confidence = Math.min(1.0, memory.facts[idx].confidence + 0.1);
        memory.facts[idx].lastReferencedAt = Date.now();
      }
      await saveUserMemory(r2, userId, memory);
      return { stored: true, reason: 'updated' };
    }

    case 'replace':
    case 'new':
    default: {
      const newFact: MemoryFact = {
        id: generateFactId(factText + Date.now()),
        fact: factText,
        category,
        source,
        confidence,
        createdAt: Date.now(),
        lastReferencedAt: Date.now(),
      };

      memory.facts.push(newFact);

      // Ring buffer: evict lowest-confidence facts when full
      if (memory.facts.length > MAX_FACTS) {
        memory.facts.sort((a, b) => b.confidence - a.confidence);
        memory.facts = memory.facts.slice(0, MAX_FACTS);
      }

      await saveUserMemory(r2, userId, memory);
      return { stored: true, reason: 'new' };
    }
  }
}

/**
 * Delete a specific fact by ID.
 */
export async function deleteMemoryFact(
  r2: R2Bucket,
  userId: string,
  factId: string,
): Promise<boolean> {
  const memory = await loadUserMemory(r2, userId);
  if (!memory) return false;

  const before = memory.facts.length;
  memory.facts = memory.facts.filter(f => f.id !== factId);
  if (memory.facts.length === before) return false;

  await saveUserMemory(r2, userId, memory);
  return true;
}

/**
 * Clear all facts for a user.
 */
export async function clearUserMemory(
  r2: R2Bucket,
  userId: string,
): Promise<void> {
  await r2.delete(memoryKey(userId));
}

/**
 * Add a manual fact (higher confidence than extracted).
 */
export async function addManualFact(
  r2: R2Bucket,
  userId: string,
  factText: string,
  category: MemoryCategory = 'context',
): Promise<{ stored: boolean; reason?: string }> {
  return storeMemoryFact(r2, userId, factText, category, 'manual', 0.9);
}

/**
 * Format memory facts for system prompt injection.
 * Groups by category, sorted by confidence descending.
 */
export function formatMemoryForPrompt(facts: MemoryFact[]): string {
  if (facts.length === 0) return '';

  // Sort by confidence descending, take top N
  const top = [...facts]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_PROMPT_FACTS);

  // Group by category
  const groups = new Map<MemoryCategory, string[]>();
  for (const fact of top) {
    if (!groups.has(fact.category)) {
      groups.set(fact.category, []);
    }
    groups.get(fact.category)!.push(fact.fact);
  }

  const categoryLabels: Record<MemoryCategory, string> = {
    preference: 'Preferences',
    context: 'Context',
    project: 'Project',
    personal: 'Personal',
    technical: 'Technical',
  };

  const lines: string[] = [];
  for (const [cat, items] of groups) {
    lines.push(`${categoryLabels[cat]}: ${items.join('; ')}`);
  }

  return `\n\n--- User context (remembered) ---\n${lines.join('\n')}`;
}

/**
 * Get formatted memory context for injection into system prompt.
 * Updates lastReferencedAt for injected facts.
 */
export async function getMemoryContext(
  r2: R2Bucket,
  userId: string,
): Promise<string> {
  const memory = await loadUserMemory(r2, userId);
  if (!memory || memory.facts.length === 0) return '';

  // Update lastReferencedAt for top facts
  const top = [...memory.facts]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_PROMPT_FACTS);

  const topIds = new Set(top.map(f => f.id));
  const now = Date.now();
  let changed = false;
  for (const fact of memory.facts) {
    if (topIds.has(fact.id) && now - fact.lastReferencedAt > 60000) {
      fact.lastReferencedAt = now;
      changed = true;
    }
  }
  if (changed) {
    await saveUserMemory(r2, userId, memory);
  }

  return formatMemoryForPrompt(top);
}

/**
 * Format memory facts for the /memory command display.
 */
export function formatMemoryDisplay(memory: UserMemory): string {
  if (memory.facts.length === 0) {
    return '🧠 No memories stored yet. I\'ll learn about you as we chat, or use /memory add <fact> to add manually.';
  }

  const groups = new Map<MemoryCategory, MemoryFact[]>();
  for (const fact of memory.facts) {
    if (!groups.has(fact.category)) {
      groups.set(fact.category, []);
    }
    groups.get(fact.category)!.push(fact);
  }

  const categoryLabels: Record<MemoryCategory, string> = {
    preference: '⚙️ Preferences',
    context: '📋 Context',
    project: '📦 Project',
    personal: '👤 Personal',
    technical: '🔧 Technical',
  };

  const lines: string[] = [`🧠 Your Memory (${memory.facts.length} facts)\n`];
  for (const [cat, facts] of groups) {
    lines.push(`${categoryLabels[cat]}:`);
    for (const fact of facts.sort((a, b) => b.confidence - a.confidence)) {
      const confStr = fact.confidence.toFixed(1);
      lines.push(`  • ${fact.fact} [conf: ${confStr}, id: ${fact.id}]`);
    }
    lines.push('');
  }

  lines.push('/memory add <fact> — Add manually');
  lines.push('/memory remove <id> — Remove a fact');
  lines.push('/memory clear — Clear all');

  return lines.join('\n');
}

/**
 * Build the extraction prompt for the flash model.
 * Given a user message and assistant response, extracts persistent facts.
 */
export function buildExtractionPrompt(
  userMessage: string,
  assistantResponse: string,
  existingFacts: MemoryFact[],
): string {
  const existingList = existingFacts.length > 0
    ? existingFacts.map(f => `- ${f.fact}`).join('\n')
    : '(none)';

  return `Given this conversation between a user and an AI assistant, extract any persistent facts about the user that would be useful to remember across future sessions.

Focus on:
- Preferences (language, framework, style choices)
- Project context (tech stack, repo names, team info)
- Personal details the user voluntarily shared (name, role, timezone)
- Technical environment (OS, editor, deployment targets)

Conversation:
User: ${userMessage.substring(0, 1000)}
Assistant: ${assistantResponse.substring(0, 500)}

Existing facts (do NOT duplicate):
${existingList}

Return a JSON array of new facts only. Return [] if no new facts found.
Format: [{"fact": "...", "category": "preference|context|project|personal|technical"}]
Return ONLY the JSON array, no other text.`;
}

/**
 * Parse the extraction model response into fact objects.
 */
export function parseExtractionResponse(
  response: string,
): Array<{ fact: string; category: MemoryCategory }> {
  try {
    // Try to find JSON array in the response
    const match = response.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]) as Array<{ fact: string; category: string }>;
    if (!Array.isArray(parsed)) return [];

    const validCategories: MemoryCategory[] = ['preference', 'context', 'project', 'personal', 'technical'];

    return parsed
      .filter(item =>
        typeof item.fact === 'string' &&
        item.fact.length > 0 &&
        typeof item.category === 'string' &&
        validCategories.includes(item.category as MemoryCategory),
      )
      .map(item => ({
        fact: item.fact.substring(0, 200), // Limit fact length
        category: item.category as MemoryCategory,
      }));
  } catch {
    return [];
  }
}
