# Claude Code Prompt: Sprint 3 — Capture Flow + CIS Knowledge Cards

**Repo**: `PetrAnto/ai-hub`
**Branch**: `claude/coaching-s3-capture`
**Base**: `main` (after Sprint 2 merged)
**Effort**: ~18h
**Depends on**: Sprint 2 — proposals engine works, embeddings in Vectorize

---

## Context

This sprint closes the reuse loop. After a substantive chat, the gecko prompts you to save. When you type in any module, CIS surfaces related vault entries. Every reuse is tracked.

**Read first:**
- `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.md` — §9 (CIS Integration), §10 (CIS Latency Fix)
- `claude-share/brainstorming/wave6/prompt-vault-spec-v1.md` — §6 (CIS slash commands, already shipped)
- `src/components/chat/SaveToVaultButton.tsx` — existing save button (Prompt Vault Phase A)
- `src/components/cockpit/BottomBar.tsx` — existing CIS input area
- `src/lib/coaching/quality-gate.ts` — from Sprint 1
- `src/lib/coaching/embed-on-save.ts` — from Sprint 1

---

## Step 1: Post-Chat Capture Prompt (3h)

When a chat conversation ends (user navigates away or starts new conversation) AND the quality gate returns true:

Create `src/components/coaching/CapturePrompt.tsx`:
- Appears as a subtle banner below the last message (not a modal — non-blocking)
- Shows the assigned gecko avatar + coaching template: "That took {n} rounds. Save the approach?"
- Two actions: **Save to Vault** (fires granite-micro auto-extract) | **Skip**
- Gecko assignment: code topics → Vex, SitMon context → Zori, long conversations → Vex, default → Kai
- Animate: slides in from bottom, fades on skip

Wire into conversation lifecycle:
- Track quality signals during conversation (message count, copy events, thumbs up)
- On conversation end/switch, check `shouldProcessConversation(signals)`
- If true, render CapturePrompt

---

## Step 2: Auto-Extract via granite-micro (3h)

Create `src/lib/coaching/auto-extract.ts`:

When user clicks "Save to Vault" on the capture prompt:

```typescript
export async function extractVaultEntry(
  env: Env,
  conversationMessages: Message[],
  geckoId: GeckoId,
): Promise<{ title: string; content: string; tags: string[] }> {
  // Summarize the conversation into a reusable vault entry
  const result = await runWorkersAI(env, {
    model: '@cf/ibm-granite/granite-4.0-h-micro',
    maxTokens: 300,
    temperature: 0.3,
  }, [{
    role: 'system',
    content: `Extract a reusable knowledge entry from this conversation.
Return ONLY JSON: {"title": "...", "content": "...", "tags": ["..."]}
Title: concise problem description (max 60 chars).
Content: the solution approach + key insight (max 500 chars).
Tags: 3-5 lowercase topic tags.`,
  }, {
    role: 'user',
    content: conversationMessages
      .slice(-10) // Last 10 messages max to fit context
      .map(m => `${m.role}: ${m.content.slice(0, 300)}`)
      .join('\n'),
  }]);
  
  return JSON.parse(result.content);
}
```

After extraction:
1. Create vault entry via existing `/api/vault/prompts` POST
2. Embed it (Sprint 1 hook fires automatically)
3. Create `knowledge_captures` record linking conversation → vault entry
4. Log neuron usage

---

## Step 3: CIS Knowledge Cards — Session Pre-Fetch (2h)

Create `src/lib/coaching/knowledge-context.ts`:

```typescript
// Called once when user opens Chat/Code/Creator tab
export async function preloadKnowledgeContext(
  userId: string,
): Promise<KnowledgeContextItem[]> {
  // Fetch recent vault entries with embeddings
  const entries = await fetch('/api/vault/prompts?limit=50&hasEmbedding=true');
  // Cache in Zustand coaching store
  return entries.map(e => ({
    id: e.id,
    title: e.title,
    tags: e.tags,
    preview: e.content.slice(0, 120),
    reuseCount: e.reuseCount,
  }));
}
```

Create Zustand store slice: `src/store/coaching-store.ts` (or add to existing store):
```typescript
interface CoachingState {
  knowledgeContext: KnowledgeContextItem[];
  contextLoaded: boolean;
  loadContext: () => Promise<void>;
}
```

---

## Step 4: CIS Knowledge Cards UI (3h)

Extend `src/components/cockpit/BottomBar.tsx` (or the CIS input area):

When user types and a keyword matches a cached knowledge context item (client-side string matching, not server call):
- Show a small card above the input: "[📚 You have knowledge about this] Title — {preview}... [Inject]"
- Matching: split input into words, check against cached entry titles + tags
- Debounce at 500ms after last keystroke
- Max 2 cards visible at once
- "Inject" action: prepend vault entry content to the user's prompt as context

**Zero server cost** — matching runs against the pre-fetched Zustand cache.

---

## Step 5: Reuse Tracking (2.5h)

### API: `src/app/api/coaching/reuse/route.ts`

- `POST` — Log a knowledge reuse event
- Body validated with `createReuseSchema` from Sprint 1
- Also increments `prompt_library.reuse_count` and sets `last_reused_at`

### Wire into inject action

When user taps "Inject" on a knowledge card:
1. Insert vault entry content into prompt context
2. POST to `/api/coaching/reuse` with method `'cis_suggestion'`
3. This feeds GeScore v2's reuse_rate metric

### Wire into `/prompt` slash command

The existing `/prompt` slash command (Prompt Vault Phase A) already inserts vault entries. Add a reuse tracking call there too, with method `'slash_command'`.

---

## Key Files to Create/Modify

| File | Action |
|------|--------|
| `src/components/coaching/CapturePrompt.tsx` | CREATE — Post-chat capture banner |
| `src/lib/coaching/auto-extract.ts` | CREATE — granite-micro conversation extraction |
| `src/lib/coaching/knowledge-context.ts` | CREATE — Session pre-fetch utility |
| `src/store/coaching-store.ts` | CREATE — Zustand store for coaching state |
| `src/app/api/coaching/reuse/route.ts` | CREATE — Reuse tracking API |
| `src/components/cockpit/BottomBar.tsx` | MODIFY — Add knowledge card display area |
| `src/app/api/vault/prompts/route.ts` | MODIFY — Add `hasEmbedding` filter to GET |
| `src/components/cockpit/WindshieldViewport.tsx` or chat layout | MODIFY — Mount CapturePrompt |

---

## Acceptance Criteria

1. `npm run build` passes, `npm run test` passes
2. After a 5+ message conversation, capture prompt appears on conversation end
3. "Save to Vault" extracts a structured vault entry via granite-micro
4. Extracted entry is embedded and appears in semantic search
5. CIS knowledge cards appear when typing keywords matching vault entries
6. "Inject" inserts vault content into prompt and logs reuse
7. `prompt_library.reuse_count` increments on inject
8. GeScore reuse_rate reflects the logged reuses
9. No server calls during typing (client-side matching only)
10. No new npm dependencies

---

*Next: Sprint 4 — Knowledge Graph + Morning Brief*
