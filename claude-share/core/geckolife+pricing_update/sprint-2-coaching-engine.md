# Claude Code Prompt: Sprint 2 — Coaching Engine + GeScore v2

**Repo**: `PetrAnto/ai-hub`
**Branch**: `claude/coaching-s2-engine`
**Base**: `main` (after Sprint 1 merged)
**Effort**: ~18h
**Depends on**: Sprint 1 — knowledge tables exist, embedding pipeline works

---

## Context

**This is the paradigm shift sprint.** After this, geckos proactively suggest tasks instead of waiting for the user. The module tab label changes from "Life" to "Coaching" and the cockpit section title from "Your mentors" to "Your Coaches."

**Read first:**
- `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.md` — §2 (Coaching Paradigm), §6 (GeScore v2), §7 (Gecko Coach Roles)
- `claude-share/specs/gecko-companions-spec.md` — gecko personality system
- `claude-share/specs/mode-geckos-v3-FINAL.md` — combo system + personality traits
- `src/lib/gecko-life.ts` — existing GeScore calculation + personality responses
- `src/lib/gecko-personalities.ts` — TELOS profiles + gecko registry
- `src/components/life/LifePanel.tsx` — existing tab layout
- `src/components/life/StatsView.tsx` — existing GeScore display

---

## Step 1: Coaching Proposal Engine (4h)

Create `src/lib/coaching/proposal-engine.ts`:

Implement `generateCoachingProposals(userId, env)` — runs on-demand when user opens Coaching tab. See spec §2.3 for full implementation. 6 proposal types:

1. **Knowledge gaps** — D1 query: count chat topics with 0 vault saves. Gecko: Vex. Cost: $0.
2. **Reuse opportunities** — Vectorize: embed upcoming task titles, match against vault. Gecko: Kai. Cost: ~6 neurons.
3. **Stale knowledge** — D1 query: vault entries >42 days old, reuse_count=0. Gecko: Razz. Cost: $0.
4. **Connection prompts** — Vectorize: cross-match recent bookmarks ↔ journal. Gecko: Zori. Cost: ~2 neurons.
5. **Learning consolidation** — D1 query: 3+ captures in same topic within 7 days. Gecko: Zori. Cost: $0.
6. **Application pressure** — D1 query: captures/reuses ratio >5:1 in 14 days. Gecko: Razz. Cost: $0.

Return max 5 proposals per generation. Cache for 24h in KV or client-side state.

---

## Step 2: Proposal API Routes (3.5h)

### `src/app/api/coaching/proposals/route.ts`

- `GET` — Generate or return cached proposals for authenticated user
- Auth required. Zod validate query params.
- Calls `generateCoachingProposals()` if no cached proposals or cache expired.

### `src/app/api/coaching/proposals/[id]/route.ts`

- `PATCH` — Accept or dismiss a proposal
- Body: `{ action: 'accept' | 'dismiss' }`
- On **accept**: Create a task in `life_tasks` with `gecko_assigned` from proposal. Set `coaching_proposals.status = 'accepted'`, link `accepted_task_id`.
- On **dismiss**: Set status to `'dismissed'`, increment dismiss counter for this `proposal_type` + `gecko_id` combo.

### Dismiss-to-Learn Logic

Track dismissals in a simple counter pattern:
```typescript
// After 3+ dismissals of same proposalType → reduce frequency
// After 5+ dismissals from same gecko → that gecko proposes less
// Store in user preferences or a simple D1 counter table
```

---

## Step 3: GeScore v2 (3.5h)

### Update `src/lib/gecko-life.ts`

Replace the current GeScore formula:
```
OLD: tasks_completed * 0.4 + journal_entries * 0.3 + calendar_events * 0.3
NEW: knowledge_velocity * 0.25 + capture_rate * 0.25 + reuse_rate * 0.30 + connection_density * 0.20
```

Implement all 4 metric functions from spec §7.3 — all pure D1 queries, $0.

### Update `src/app/api/life/stats/route.ts`

Return the new metrics alongside the old ones (backward compatible):
```json
{
  "geScore": 62,
  "metrics": {
    "knowledgeVelocity": 75,
    "captureRate": 40,
    "reuseRate": 55,
    "connectionDensity": 80
  },
  "legacy": { "tasks": 35, "journal": 28, "calendar": 22 },
  "streak": { "days": 7, "type": "knowledge" }
}
```

### Update gecko commentary templates

Replace the activity-based commentary with growth-based commentary from spec §7.2 table.

---

## Step 4: Coaching Tab UI (3h)

### Update `src/components/life/LifePanel.tsx`

- Add a **"Proposed"** section above the existing Tasks tab content (or as a sub-tab within Tasks)
- Show coaching proposals with:
  - Gecko avatar badge (which coach proposed it)
  - Title + rationale text
  - Priority indicator (color coding)
  - Two action buttons: **Accept** (green) + **Dismiss** (gray)
- Animate: proposal slides up on accept, fades on dismiss
- Empty state: "Your coaches have no suggestions yet. Keep chatting and capturing knowledge!"

### Rename labels

Search all cockpit components for "Your mentors" or "Gecko Life" or "Life" tab label and rename:
- "Your mentors" → **"Your Coaches"** (cockpit personality gecko section)
- "Life" tab → **"Coaching"** (ModuleTabs)
- Any references in empty states, tooltips, or gecko flavor text

Files likely affected:
- `src/components/cockpit/CockpitShell.tsx`
- `src/components/cockpit/ModuleTabs.tsx`
- `src/components/cockpit/BottomBar.tsx` (mode display)
- `src/components/gecko/CardHandDock.tsx` (gecko section title)

---

## Step 5: Gecko Coaching Templates (1h)

Add to `src/lib/gecko-life.ts` (or create `src/lib/coaching/gecko-coaching.ts`):

```typescript
export const COACHING_PROPOSAL_TEMPLATES: Record<ProposalType, Record<GeckoId, string>> = {
  knowledge_gap: {
    vex: '{count} conversations about "{topic}" but 0 vault entries. Capture your best approach.',
    kai: 'You keep coming back to "{topic}." Let\'s save what you know so far.',
    // ...
  },
  application_pressure: {
    razz: '{captures} vault entries in {days} days. {reuses} reused. Pick ONE and use it today.',
    // ...
  },
  // ... all 6 types × 4 geckos
};

export const GESCORE_V2_COMMENTARY: Array<{
  min: number; max: number; geckoId: GeckoId; template: string;
}> = [
  // From spec §7.2
];
```

---

## Acceptance Criteria

1. `npm run build` passes
2. `npm run test` passes with new tests
3. Coaching tab shows proposals when opened
4. Accepting a proposal creates a linked task
5. Dismissing 3+ proposals of same type reduces that type's frequency
6. GeScore uses new 4-metric formula
7. StatsView shows velocity, capture rate, reuse rate, connection density
8. "Your Coaches" label visible in cockpit
9. "Coaching" tab label visible in ModuleTabs
10. Gecko commentary matches GeScore range
11. No new npm dependencies

---

## After Completion

Update: `COACHING_FLYWHEEL_ROADMAP.md`, `GLOBAL_ROADMAP.md`, `claude-log.md`, `PROMPT_READY.md` → Sprint 3

*Next: Sprint 3 — Capture Flow + CIS Knowledge Cards*
