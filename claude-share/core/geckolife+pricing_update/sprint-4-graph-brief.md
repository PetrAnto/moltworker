# Claude Code Prompt: Sprint 4 — Knowledge Graph + Morning Brief

**Repo**: `PetrAnto/ai-hub`
**Branch**: `claude/coaching-s4-graph`
**Base**: `main` (after Sprint 3 merged)
**Effort**: ~16h
**Depends on**: Sprint 3 — capture flow works, reuse tracking works, Vectorize populated

---

## Context

The knowledge graph gets richer with manual connections. The morning brief ties it all together with daily actionable intelligence. Zori starts surfacing cross-domain discoveries.

**Read first:**
- `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.md` — §6 (Gecko Roles, esp. Zori Discovery), §10 (Morning Brief)
- `src/lib/coaching/proposal-engine.ts` — from Sprint 2 (Zori's connection trigger extends this)

---

## Step 1: Knowledge Edge Creation UI (4h)

### "Connect to..." Action

Add a new action button on vault entry cards and journal entry previews: **"Connect to..."**

When tapped:
1. Show a searchable list of the user's other knowledge nodes (vault entries + journal entries)
2. User selects one or more items to link
3. Each link creates a row in `knowledge_edges` with `edge_type: 'related'`
4. Optional: user can change edge type via dropdown (related/supports/contradicts/derived_from/supersedes)

### API: `src/app/api/coaching/edges/route.ts`

- `POST` — Create an edge. Validate with `createEdgeSchema`. Enforce unique constraint (no duplicate edges).
- `GET` — List edges for a given node. Query params: `sourceType`, `sourceId` or `targetType`, `targetId`.
- `DELETE` — Remove an edge by ID.

### UI Locations

- Vault library page (`src/app/vault/page.tsx`): Add "Connect" action to each prompt card's overflow menu
- Journal view (`src/components/life/JournalView.tsx`): Add "Connect" action to each entry
- Both: show a small "🔗 {n} connections" badge on items that have edges

---

## Step 2: Zori Cross-Domain Discovery (2h)

Extend `src/lib/coaching/proposal-engine.ts` — add a `findCrossDomainConnections` function:

```typescript
async function findCrossDomainConnections(userId: string, env: Env): Promise<CoachingProposal[]> {
  // Get the most recent vault entry or journal entry (last 24h)
  const recent = await getRecentKnowledgeNodes(userId, 1);
  if (!recent.length) return [];
  
  // Query Vectorize for similar items, but EXCLUDE same-tag items
  const embedding = await env.VECTORIZE.getById(recent[0].embeddingVectorId);
  const matches = await env.VECTORIZE.query(embedding.values, {
    topK: 5,
    filter: { userId },
  });
  
  // Filter: only keep matches where tags DON'T overlap with the source
  const sourceTags = new Set(recent[0].tags || []);
  const crossDomain = matches.matches.filter(m => {
    const matchTags = (m.metadata?.tags || []) as string[];
    return matchTags.every(t => !sourceTags.has(t)) && m.score > 0.7;
  });
  
  if (crossDomain.length === 0) return [];
  
  return [{
    geckoId: 'zori',
    title: `Connection: "${recent[0].title}" ↔ "${crossDomain[0].metadata.title}"`,
    rationale: `These are about different topics but share a pattern. Want to link them?`,
    proposalType: 'connection_prompt',
    sourceIds: [recent[0].id, crossDomain[0].metadata.entryId],
    priority: 'medium',
  }];
}
```

---

## Step 3: Morning Brief Generator (3h)

Create `src/lib/coaching/morning-brief.ts`:

```typescript
export async function generateMorningBrief(
  userId: string,
  env: Env,
  prefs: MorningBriefPrefs,
): Promise<MorningBrief | null> {
  if (!prefs.enabled) return null;
  
  // 1. Today's tasks (D1 query, $0)
  const tasks = await getTodaysTasks(userId);
  
  // 2. Match tasks against vault (Vectorize, ~3 neurons)
  const taskMatches = await matchTasksToKnowledge(tasks, userId, env);
  
  // 3. Recent SitMon items matched to journal (Vectorize, ~2 neurons)
  const sitmonConnections = prefs.includeSitmon
    ? await findSitmonConnections(userId, env)
    : [];
  
  // 4. Format with gecko voice (granite-micro, ~30 neurons)
  const geckoId = prefs.preferredGecko;
  const content = await formatBriefWithGecko(env, geckoId, {
    tasks, taskMatches, sitmonConnections,
  });
  
  return { geckoId, content, taskMatches, sitmonConnections, generatedAt: new Date().toISOString() };
}
```

**Important**: This runs on-demand (when user opens Coaching tab), NOT on a cron. Cache the result for 24h. If cache is fresh, return cached.

### Morning Brief API

`src/app/api/coaching/brief/route.ts`:
- `GET` — Generate or return cached brief
- `PUT` — Update preferences (Zod validate with `morningBriefPrefsSchema`)

### Morning Brief Preferences API

`src/app/api/coaching/brief/prefs/route.ts`:
- `GET` / `PUT` — CRUD for `morning_brief_prefs` table

---

## Step 4: Morning Brief UI (2h)

In `src/components/life/LifePanel.tsx` or a new `src/components/coaching/MorningBrief.tsx`:

- Show at the top of the Coaching tab when enabled
- Gecko avatar + formatted brief text
- Task-knowledge matches shown as clickable cards ("Your vault entry about X matches today's task Y → [Inject]")
- SitMon connections shown with article preview + journal link
- Settings gear icon → opens morning brief preferences inline form
- Collapsed by default after first read (expand on tap)

---

## Key Files to Create/Modify

| File | Action |
|------|--------|
| `src/app/api/coaching/edges/route.ts` | CREATE |
| `src/lib/coaching/morning-brief.ts` | CREATE |
| `src/app/api/coaching/brief/route.ts` | CREATE |
| `src/app/api/coaching/brief/prefs/route.ts` | CREATE |
| `src/components/coaching/ConnectToModal.tsx` | CREATE — knowledge node picker |
| `src/components/coaching/MorningBrief.tsx` | CREATE — brief display component |
| `src/lib/coaching/proposal-engine.ts` | MODIFY — add Zori cross-domain discovery |
| `src/app/vault/page.tsx` | MODIFY — add "Connect" action to cards |
| `src/components/life/JournalView.tsx` | MODIFY — add "Connect" action + badge |
| `src/components/life/LifePanel.tsx` | MODIFY — mount MorningBrief component |

---

## Acceptance Criteria

1. Build + tests pass
2. Users can link vault entries to journal entries via "Connect to..." action
3. Linked items show connection badge with count
4. Edges API enforces unique constraint
5. Zori surfaces cross-domain connections in coaching proposals
6. Morning brief generates on tab open when enabled
7. Brief is cached for 24h (second open is instant)
8. Brief shows task-knowledge matches with inject action
9. Preferences form saves to D1
10. No new npm dependencies

---

*Next: Sprint 5 — Analytics + Collective Intelligence*
