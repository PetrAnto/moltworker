# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-16 (F.8 COMPLETE — long-term memory with fact extraction, injection, /memory command)

---

## Current Task: F.8 — Long-term Memory (Fact Extraction + Injection)

### Why

The bot currently remembers *what tools worked* (50 learnings) and *what sessions happened* (20 sessions), but not *what the user cares about*. A user who says "I prefer Python" or "my project uses Next.js" or "I work at Acme Corp" must repeat this every session. Memory fixes this.

### What Exists (DO NOT rebuild)

The learning system is mature (628 lines, extensive tests). It has 3 storage layers:

| Layer | R2 Key | Max | Injected | Purpose |
|-------|--------|-----|----------|---------|
| Learnings | `learnings/{userId}/history.json` | 50 | Top 5 by relevance | Tool usage patterns |
| Last Task | `learnings/{userId}/last-task.json` | 1 (24h TTL) | Always if fresh | Immediate context |
| Sessions | `learnings/{userId}/sessions.json` | 20 | Top 3 by relevance | Cross-session continuity |

**Extraction happens at:** `task-processor.ts:3869-3893` (success) and `4255-4283` (failure)

**Injection happens at:** `handler.ts:668-705` (3 helper functions) → concatenated into system prompt at `handler.ts:2074` (orchestra) and `handler.ts:2674` (normal chat)

**Smart context:** Simple queries (weather, greetings) skip all R2 loads via `classifyTaskComplexity()`. Complex queries load all 3 layers.

### What to Build

Add a 4th layer: **User Memory** — persistent facts about the user that never expire.

#### 1. Memory Data Model

**New file:** `src/openrouter/memory.ts`

```typescript
interface MemoryFact {
  id: string;           // nanoid or hash
  fact: string;         // "Prefers Python over JavaScript"
  category: 'preference' | 'context' | 'project' | 'personal' | 'technical';
  source: 'extracted' | 'manual';  // extracted from conversation or manually added
  confidence: number;   // 0.0-1.0, extracted facts start at 0.7
  createdAt: number;
  lastReferencedAt: number;  // updated when fact is injected into prompt
}

interface UserMemory {
  userId: string;
  facts: MemoryFact[];  // Max 100
  updatedAt: number;
}
```

**R2 key:** `memory/{userId}/facts.json`

#### 2. Fact Extraction (Post-task)

After task completion, use a fast/cheap model (flash) to extract facts from the conversation. This runs alongside the existing learning extraction in `task-processor.ts:3869-3893`.

**Extraction prompt approach:**

```
Given this conversation between a user and an AI assistant, extract any persistent facts about the user that would be useful to remember across future sessions.

Focus on:
- Preferences (language, framework, style choices)
- Project context (tech stack, repo names, team info)
- Personal details the user voluntarily shared (name, role, timezone)
- Technical environment (OS, editor, deployment targets)

Conversation:
{user_message}
{assistant_response (first 500 chars)}

Existing facts (do NOT duplicate):
{existing_facts formatted as bullet list}

Return JSON array of new facts only. Return [] if no new facts.
[{"fact": "...", "category": "preference|context|project|personal|technical"}]
```

**Key design decisions:**
- Use `flash` model (cheap, fast) for extraction — NOT the task model
- Only extract from COMPLEX tasks (skip simple weather/greeting queries)
- Rate limit: max 1 extraction per 5 minutes per user (debounce)
- Don't block task response — extraction runs after response is sent
- Skip extraction if user message is <20 chars (too short for facts)
- Deduplicate: check semantic similarity with existing facts before adding

#### 3. Memory Storage Functions

In `src/openrouter/memory.ts`:

```typescript
export async function storeMemoryFact(r2: R2Bucket, userId: string, fact: MemoryFact): Promise<void>
export async function loadUserMemory(r2: R2Bucket, userId: string): Promise<UserMemory | null>
export async function deleteMemoryFact(r2: R2Bucket, userId: string, factId: string): Promise<boolean>
export async function clearUserMemory(r2: R2Bucket, userId: string): Promise<void>
export async function addManualFact(r2: R2Bucket, userId: string, factText: string): Promise<MemoryFact>
```

Ring buffer: max 100 facts. When full, evict lowest-confidence facts first (not oldest — high-confidence old facts are more valuable than low-confidence recent ones).

#### 4. Memory Injection into System Prompt

Add `getMemoryContext()` in `handler.ts` alongside the existing 3 helpers:

```typescript
private async getMemoryContext(userId: string): Promise<string> {
  const memory = await loadUserMemory(this.r2Bucket, userId);
  if (!memory || memory.facts.length === 0) return '';
  // Format top-K facts (max 10) sorted by confidence desc
  // Update lastReferencedAt for injected facts
  return formatMemoryForPrompt(memory.facts);
}
```

**Format:** Compact, before learnings in the system prompt:

```
--- User context (remembered) ---
- Prefers Python, uses FastAPI for APIs
- Project: Next.js app deployed on Vercel, repo: acme/dashboard
- Timezone: EST, works at Acme Corp as senior engineer
- Uses VS Code, macOS, PostgreSQL
```

**Injection order in system prompt:**
1. Base system prompt
2. Tool hint
3. **Memory context** (NEW — persistent facts)
4. Learnings hint (task patterns)
5. Last task hint
6. Session context

Memory comes FIRST among context layers because it's the most stable and broadly relevant.

**Skip injection for simple queries** — follow the existing `classifyTaskComplexity()` pattern.

#### 5. `/memory` Command

Add to `handler.ts` command handling:

```
/memory             — Show all remembered facts
/memory add <fact>  — Manually add a fact
/memory remove <id> — Remove a specific fact
/memory clear       — Clear all memories (with confirmation)
```

**Display format:**
```
🧠 Your Memory (12 facts)

Preferences:
  • Prefers Python over JavaScript [conf: 0.9]
  • Likes minimal UI, dark theme [conf: 0.7]

Project Context:
  • Working on acme/dashboard (Next.js + Vercel) [conf: 0.8]

Technical:
  • Uses macOS, VS Code, PostgreSQL [conf: 0.8]

Personal:
  • Senior engineer at Acme Corp [conf: 0.7]

/memory add <fact> — Add manually
/memory remove <id> — Remove a fact
/memory clear — Clear all
```

#### 6. Deduplication / Conflict Resolution

Before adding a new fact, check for semantic overlap with existing facts:
- Exact substring match → skip (duplicate)
- Same category + >60% word overlap → update existing fact (merge), boost confidence
- Contradicts existing fact (e.g., "prefers JavaScript" vs "prefers Python") → replace old with new, log the change

Simple word-overlap is sufficient — no need for embeddings. The extraction prompt already sees existing facts and is instructed not to duplicate.

### Key Files to Modify

| File | Change |
|------|--------|
| `src/openrouter/memory.ts` | **NEW** — MemoryFact/UserMemory types, store/load/delete/format functions |
| `src/openrouter/memory.test.ts` | **NEW** — Tests for all memory functions |
| `src/durable-objects/task-processor.ts` | Add memory extraction call after learning extraction (~line 3893) |
| `src/telegram/handler.ts` | Add `getMemoryContext()` helper, inject into prompts, add `/memory` command |
| `src/openrouter/learnings.ts` | No changes needed — memory is a separate module |

### What NOT to Build

- No vector/embedding search — word overlap scoring is sufficient for 100 facts
- No memory sharing between users
- No automatic memory expiry — facts persist until manually removed or evicted by ring buffer
- No complex NLP — the extraction model (flash) handles the intelligence
- No UI in the admin dashboard (can add later via F.5 analytics page)

### Testing

```bash
npm test -- src/openrouter/memory.test.ts --reporter=verbose
npm test -- --reporter=verbose 2>&1 | tail -20
npm run typecheck
```

Mock the flash model call in tests — return fake JSON fact arrays. Mock R2 as usual.

### Definition of Done

- [ ] `MemoryFact` / `UserMemory` types defined
- [ ] `storeMemoryFact`, `loadUserMemory`, `deleteMemoryFact`, `clearUserMemory`, `addManualFact` functions
- [ ] Fact extraction via flash model after complex task completion
- [ ] Deduplication (substring + word overlap)
- [ ] `getMemoryContext()` injected into system prompt for complex queries
- [ ] `/memory`, `/memory add`, `/memory remove`, `/memory clear` commands
- [ ] `formatMemoryForPrompt()` — compact format grouped by category
- [ ] Ring buffer: max 100 facts, evict by lowest confidence
- [ ] At least 15 tests (storage CRUD, extraction mock, dedup, formatting, injection)
- [ ] All existing tests pass, typecheck clean

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-16 | F.5 — Analytics dashboard (API + metrics UI) | Codex+Claude | PRs 343-346 → compromise, 1800 tests |
| 2026-03-16 | F.2 — Browser CDP (a11y tree, click/fill/scroll, sessions) | Claude Opus 4.6 | PR 342, 14 tests |
| 2026-03-16 | Phase 5.6 — Orchestra polish | Codex+Claude | PRs 337-339 → compromise |
| 2026-03-16 | Phase 5.4 — Acontext Disk file management | Codex+Claude | PRs 328-334 |
| 2026-03-16 | Phase 5.3 — Acontext Sandbox `run_code` tool | Codex+Claude | PR 323 |
