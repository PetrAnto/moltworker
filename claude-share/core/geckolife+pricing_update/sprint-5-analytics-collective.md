# Claude Code Prompt: Sprint 5 — Analytics + Collective Intelligence

**Repo**: `PetrAnto/ai-hub`
**Branch**: `claude/coaching-s5-analytics`
**Base**: `main` (after Sprint 4 merged)
**Effort**: ~20h
**Depends on**: Sprint 4 — full flywheel loop running, edges + brief working

---

## Context

Measurement + network effects. Without PostHog instrumentation, we can't prove the flywheel spins. Without collective intelligence, Pro has no knowledge-based differentiation.

**Read first:**
- `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.md` — §9 (PostHog Events), §11 (Collective Intelligence), §11 (Privacy)
- `claude-share/specs/posthog-event-schema.md` — existing EventMap, naming convention, client/server wrappers
- `src/lib/analytics.ts` — existing client-side track() function (if implemented)
- `src/lib/analytics-types.ts` — existing EventMap interface (if implemented)

---

## Part A: PostHog Instrumentation (4h)

### Step 1: Extend EventMap (1h)

Add to `src/lib/analytics-types.ts`:

```typescript
// Knowledge Flywheel events — add to existing EventMap
'coaching.capture_prompted': { gecko_id: string; source_type: string; accepted: boolean };
'coaching.capture_completed': { source_type: string; target_type: string; neurons_used: number };
'coaching.reuse_injected': { method: string; knowledge_type: string; context_type: string };
'coaching.proposal_shown': { gecko_id: string; proposal_type: string; priority: string };
'coaching.proposal_accepted': { gecko_id: string; proposal_type: string };
'coaching.proposal_dismissed': { gecko_id: string; proposal_type: string; dismiss_count: number };
'coaching.edge_created': { edge_type: string; manual: boolean };
'coaching.gescore_computed': { score: number; velocity: number; capture_rate: number; reuse_rate: number; density: number };
'coaching.morning_brief_viewed': { gecko_id: string; task_matches: number; sitmon_connections: number };
'neurons.consumed': { model: string; neurons: number; operation: string };
'neurons.daily_total': { total: number; free_remaining: number };
```

### Step 2: Instrument All Touchpoints (2h)

Add `track()` calls at every flywheel interaction point:

| Location | Event | When |
|----------|-------|------|
| `CapturePrompt.tsx` | `coaching.capture_prompted` | Prompt shown (accepted=false), user clicks save (accepted=true) |
| `auto-extract.ts` | `coaching.capture_completed` | Vault entry created from conversation |
| CIS inject action | `coaching.reuse_injected` | User taps "Inject" on knowledge card |
| `/prompt` slash command | `coaching.reuse_injected` | User inserts from vault via slash command |
| Coaching proposals UI | `coaching.proposal_shown` | Each proposal rendered |
| Proposal accept handler | `coaching.proposal_accepted` | User accepts |
| Proposal dismiss handler | `coaching.proposal_dismissed` | User dismisses |
| Edge creation | `coaching.edge_created` | Edge saved to D1 |
| Stats API response | `coaching.gescore_computed` | GeScore calculated (server-side event) |
| Morning brief render | `coaching.morning_brief_viewed` | Brief displayed |
| `neuron-estimator.ts` | `neurons.consumed` | Every Workers AI call |

### Step 3: Daily Neuron Summary (1h)

Create a scheduled check (or on-demand in the stats API) that computes daily neuron total:
```typescript
// In stats route or separate endpoint
const dailyTotal = await getDailyNeuronUsage(env);
trackServerEvent('neurons.daily_total', {
  total: dailyTotal.used,
  free_remaining: dailyTotal.remaining,
});
```

---

## Part B: Collective Intelligence — Pro Only (16h)

### Step 4: Shared Vectorize Index (3h)

Create a SECOND Vectorize index: `storia-collective` (PetrAnto creates in CF Dashboard).

Add binding to `wrangler.toml`:
```toml
[[vectorize]]
binding = "VECTORIZE_SHARED"
index_name = "storia-collective"
```

When a Pro user saves a vault entry AND opts in:
1. Generate embedding (already happens)
2. Insert into personal index (already happens)
3. ALSO insert into shared index with anonymized metadata:
   ```typescript
   {
     id: `shared_${entryId}`,
     values: vector,
     metadata: {
       tags: entry.tags,         // Topics only, no PII
       reuseCount: entry.reuseCount,
       knowledgeType: entry.knowledgeType,
       // NO userId, NO title, NO content
     },
   }
   ```

### Step 5: Privacy Opt-In (2h)

Add to user preferences (or `morning_brief_prefs`):
- `collectiveOptIn: boolean` — default false
- UI: toggle in Settings or Coaching tab settings
- When opt-out: delete user's vectors from shared index within 24h
- Show clear disclosure: "Anonymized topic patterns are shared. Content is never shared."

Create `src/app/api/coaching/collective/opt-in/route.ts`:
- `PUT` — Toggle opt-in. On opt-out, queue deletion of shared vectors.

### Step 6: Community Pattern Detection (4h)

Create `src/lib/coaching/collective-intelligence.ts`:

```typescript
export async function detectCommunityPatterns(
  userId: string,
  env: Env,
): Promise<CollectiveInsight[]> {
  // Get user's vault entries that are in the shared index
  const userVectors = await getUserSharedVectors(userId, env);
  
  for (const vector of userVectors) {
    // Find cluster around this vector
    const cluster = await env.VECTORIZE_SHARED.query(vector.values, {
      topK: 50,
    });
    
    // Count unique contributors (from anonymized metadata — we track contribution count, not identity)
    const clusterSize = cluster.matches.filter(m => m.score > 0.85).length;
    
    if (clusterSize >= 10) {
      // Find the highest-reuse entry in the cluster
      const bestReuse = Math.max(...cluster.matches.map(m => m.metadata?.reuseCount || 0));
      const userReuse = vector.metadata.reuseCount;
      
      if (userReuse < bestReuse * 0.8) {
        // User's version underperforms — suggest improvement
        insights.push({
          topic: vector.metadata.tags?.join(', '),
          userReuseRate: userReuse,
          communityBestRate: bestReuse,
          clusterSize,
        });
      }
    }
  }
  return insights;
}
```

### Step 7: Collective Insight Notification (3h)

Show collective insights as a special coaching proposal type:

```typescript
const collectiveProposal: CoachingProposal = {
  geckoId: 'vex',
  title: `Community pattern: "${insight.topic}"`,
  rationale: `Your approach scores ${insight.userReuseRate} reuses. ${insight.clusterSize} community members have similar entries — the best scores ${insight.communityBestRate}. Want to see what's different?`,
  proposalType: 'collective_insight',
  priority: 'medium',
};
```

"See what's different" action: show a side-by-side comparison of the user's tags/structure vs the top-performing cluster member's tags/structure. **Never show content** — only metadata comparison (tags, length, structure).

The comparison itself runs on the user's BYOK key (not system key) since it's a user-facing analysis.

### Step 8: Integration Tests (3h)

- Test collective opt-in/opt-out (shared vectors appear/disappear)
- Test pattern detection with mock cluster data
- Test that no PII leaks into shared index (assert metadata has no userId/title/content)
- Test neuron tracking accuracy
- Test PostHog event fire at every touchpoint

---

## Key Files to Create/Modify

| File | Action |
|------|--------|
| `src/lib/analytics-types.ts` | MODIFY — add coaching.* and neurons.* events |
| `src/lib/coaching/collective-intelligence.ts` | CREATE |
| `src/app/api/coaching/collective/opt-in/route.ts` | CREATE |
| All coaching components from Sprints 2-4 | MODIFY — add track() calls |
| `src/lib/providers/neuron-estimator.ts` | MODIFY — add PostHog logging |
| `wrangler.toml` | MODIFY — add VECTORIZE_SHARED binding |

---

## Acceptance Criteria

1. Build + tests pass
2. PostHog receives coaching.* events when flywheel interactions happen
3. neurons.daily_total event fires with accurate count
4. Pro users can opt in/out of collective intelligence
5. Opted-in users' vectors appear in shared index (anonymized)
6. Opted-out users' vectors are removed from shared index
7. Community pattern detection surfaces insights for underperforming entries
8. No PII in shared Vectorize index (verified by test)
9. Collective insights show as Vex coaching proposals
10. "See what's different" comparison runs on user's BYOK key, not system key

---

## After Completion — Feature Complete

1. Update `COACHING_FLYWHEEL_ROADMAP.md` — ALL sprints ✅
2. Update `GLOBAL_ROADMAP.md` — add Coaching Flywheel to completed features
3. Update `PROMPT_READY.md` — point to next priority (M2 growth features or next wave)
4. Create PostHog Knowledge Flywheel dashboard from event definitions
5. Celebrate. The flywheel spins. 🦎

---

*End of Coaching Flywheel implementation prompts.*
