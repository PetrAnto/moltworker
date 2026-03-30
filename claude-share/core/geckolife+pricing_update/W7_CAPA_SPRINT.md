# Wave 7 CAPA Sprint (Corrective & Preventive Actions)

> **Purpose**: Executable corrective actions based on audit of ai-hub PRs #662-#686.
> **Date**: 2026-03-29
> **Trigger**: Audit found Wave 7 "COMPLETE" status is premature. Sprint 5 is scaffolded, not finished. Multiple post-merge fix PRs (#672, #680, #683, #685) reveal spec-to-implementation gaps.
> **Priority**: BLOCKING — must be resolved before Wave 7 can be considered feature-complete.

---

## Audit Summary

| Axis | Score | Finding |
|------|------:|---------|
| Product/technical decomposition | 8/10 | Good sprint breakdown, dependencies, and file mapping |
| Codebase connection accuracy | 7/10 | Mostly good, some runtime links remained theoretical |
| Acceptance criteria | 5/10 | Too build/test oriented, insufficient UX and negative-path coverage |
| Privacy/consent discipline | 3/10 | Collective consent poorly isolated (piggybacks on `includeSitmon`) |
| Final functional validation | 4/10 | Too many post-merge fix PRs for robust closure |
| Documentary governance | 4/10 | Contradiction between "complete" claim and roadmap/queue state |

**Verdict**: Treat #686 as **release candidate incomplete**, not as end of Wave 7.

---

## CAPA-1: Retract "Wave 7 Complete" Status

**Severity**: Critical (documentary)
**Action**: Update all status documents to reflect real state.

New canonical status:
```
Wave 7 Core: SHIPPED (S1-S4, S5 partial, S6)
Sprint 5 (Analytics + Collective): SCAFFOLDED — not complete
Moltworker (M1-M3): TODO — not started
```

**Files to update in ai-hub**:
- `GLOBAL_ROADMAP.md` — remove "WAVE 7 COMPLETE", set "Wave 7 core shipped / S5 partial / M1-M3 pending"
- `PROMPT_READY.md` — align status
- `WORK_STATUS.md` — align status

---

## CAPA-2: Dedicated Collective Consent Storage

**Severity**: Critical (privacy)
**Problem**: Route `/api/coaching/collective/opt-in` (at `src/app/api/coaching/collective/opt-in/route.ts`) stores consent by reusing `morning_brief_prefs.include_sitmon` as a proxy. The `morning_brief_prefs` table (migration `0017_knowledge_flywheel.sql`) has `includeSitmon` which is semantically a content preference, not a privacy consent flag.

**Confirmed ai-hub state**:
- Table `morning_brief_prefs` exists (migration 0017)
- Route `src/app/api/coaching/collective/opt-in/` exists with GET/PUT
- `includeSitmon` field is the proxy — confirmed in `MorningBrief` component
- No dedicated consent table or column exists

**Required deliverables**:
1. D1 migration `0020_collective_consent.sql`: new table `collective_consent` (`user_id TEXT PRIMARY KEY`, `opted_in INTEGER DEFAULT 0`, `consented_at TEXT`, `revoked_at TEXT`)
   - Option B (dedicated table) preferred over column for audit trail
2. Add Drizzle schema + Zod validator in `src/lib/schema.ts` (currently ~40 sqliteTable definitions)
3. Update `src/app/api/coaching/collective/opt-in/route.ts` to use new table
4. Remove `includeSitmon` proxy usage for consent
5. Default value: `false` (opt-in, not opt-out)
6. Store consent timestamp and revocation timestamp

**Tests required**:
- opt-in creates consent record with timestamp
- opt-out sets `revoked_at`, does NOT delete record (audit trail)
- default state is opted-out
- `includeSitmon` changes do NOT affect collective consent
- collective consent changes do NOT affect morning brief prefs

**Done definition**:
- Zero coupling between morning brief preferences and collective consent
- Migration applies cleanly
- Consent record includes timestamps for compliance

---

## CAPA-3: Complete Sprint 5 Collective Intelligence Engine

**Severity**: High (functional completeness)
**Problem**: Sprint 5 delivered only scaffolding (`analytics-types.ts`, opt-in route, `VECTORIZE_SHARED` binding, 6 client instrumentation points). The actual engine is missing.

**Confirmed ai-hub state**:
- `src/lib/analytics-types.ts` exists (typed EventMap + `trackCoachingEvent()`)
- `src/app/api/coaching/collective/opt-in/` exists (GET/PUT) — but uses `includeSitmon` proxy
- `VECTORIZE_SHARED` binding declared in `wrangler.jsonc` — but index `storia-collective` **NOT created** in Cloudflare
- `src/lib/providers/embedding.ts` exists (bge-m3) — can be reused for shared writes
- `src/lib/coaching/` has: proposal-engine.ts, morning-brief.ts, embed-on-save.ts, auto-extract.ts, knowledge-context.ts, tag-extraction.ts
- `src/lib/coaching/collective-intelligence.ts` does **NOT exist**
- No Sprint 5 test files were added in PR #686

**Missing deliverables** (from spec `12-ANALYTICS-COLLECTIVE.md`):

1. **`src/lib/coaching/collective-intelligence.ts`** — the core engine:
   - Write anonymized embeddings to `VECTORIZE_SHARED` index on knowledge save (if Pro + opted-in)
   - Reuse existing `src/lib/providers/embedding.ts` (bge-m3) for vectorization
   - Hook into existing `src/lib/coaching/embed-on-save.ts` flow (currently writes to `VECTORIZE` only)
   - Metadata must be strictly anonymized: allowlist only (`tags`, `knowledgeType`, reuse aggregates)
   - NO `userId`, `title`, `content` in shared metadata
   - Delete user's shared vectors on opt-out (real deletion, not soft)
   - Community pattern detector: query `VECTORIZE_SHARED` for similar patterns
   - Proposal injection: surface community patterns via existing `src/lib/coaching/proposal-engine.ts` (currently 3 types; add `community_pattern` as 4th)

2. **PostHog instrumentation alignment**:
   - Spec defined: `morning_brief_viewed` with `task_matches` + `sitmon_connections`
   - Implementation delivered: `task_count` + `capture_count` via `analytics-types.ts`
   - Action: reconcile — either update code to match spec or version the spec with rationale
   - Existing PostHog SDK: `posthog 1.352.0` already in dependencies

3. **Neuron event journaling**:
   - `src/lib/providers/neuron-estimator.ts` exists (10K/day budget)
   - `workers_ai_neuron_log` table exists (migration 0019)
   - `neurons.*` events need to be emitted at all required touchpoints
   - Daily neuron rollups need an aggregation endpoint

4. **HUMAN BLOCKER**: `storia-collective` Vectorize index must be created by PetrAnto before CAPA-3 can be tested

**Tests required**:
- Anonymized write to shared index: assert NO PII in metadata payload
- Opt-out deletion: vectors removed from `VECTORIZE_SHARED`
- Write/delete lifecycle on shared index
- Analytics emitted ONLY on successful operations (not optimistically)
- Event schema matches declared types (payload shape validation)
- Pattern detection returns relevant community patterns
- Community proposal injection creates valid proposal objects

**Done definition**:
- `collective-intelligence.ts` exists and is tested
- Full write/read/delete lifecycle operational on `VECTORIZE_SHARED`
- PII guardrail test passes
- Analytics taxonomy matches between spec and runtime

---

## CAPA-4: Fix LifePanel Proposal Accept/Dismiss Bug

**Severity**: High (data integrity + UX)
**Confirmed location**: Component likely in `src/components/coaching/` (LifePanel or proposal-related component). API endpoint at `src/app/api/coaching/proposals/` (PATCH). Coaching store at `src/store/coaching-store.ts`.
**Problem**: In `LifePanel`, proposal accept/dismiss action:
1. Sends PATCH request
2. Does NOT check `resp.ok`
3. Tracks analytics event (accept/dismiss) regardless
4. Removes proposal from UI regardless

This causes: false analytics events, UI/server desync, false positives on coaching acceptance metrics.

**Fix**:
```typescript
// BEFORE (broken):
await safeFetchJson(`/api/coaching/proposals/${id}`, { method: 'PATCH', body: ... });
trackEvent('coaching.proposal_accepted', { ... });
setProposals(prev => prev.filter(p => p.id !== id));

// AFTER (correct):
const resp = await safeFetchJson(`/api/coaching/proposals/${id}`, { method: 'PATCH', body: ... });
if (resp.ok) {
  trackEvent('coaching.proposal_accepted', { ... });
  setProposals(prev => prev.filter(p => p.id !== id));
} else {
  // Show error state, keep proposal visible
  setError(`Failed to ${action} proposal`);
}
```

**Tests required**:
- PATCH success -> analytics tracked + proposal removed
- PATCH failure -> analytics NOT tracked + proposal stays visible + error shown
- Network error -> same as failure path

**Done definition**:
- `resp.ok` checked before ANY side effects
- Error state visible to user on failure
- No false analytics events possible

---

## CAPA-5: Fix "No-Op" UI Actions (from PR #683, #685 findings)

**Severity**: Medium (functional)
**Problem**: Multiple UI actions were merged as "wired" but had no real effect:
- "Save to Vault" — no real effect (fixed in #683)
- "Inject" knowledge card — no real effect (fixed in #683)
- Morning brief checkboxes — no-op handlers (fixed in #685, added daily cache)

**Preventive action**: For all remaining and future UI actions, verify:
- [ ] Action handler calls a real API endpoint
- [ ] API endpoint performs actual mutation
- [ ] Success/failure state reflected in UI
- [ ] Test covers the end-to-end path (click -> API -> mutation -> UI update)

**Audit checklist** (run against current ai-hub codebase):
```bash
# Find all onClick/onSubmit handlers that might be stubs
grep -rn "onClick.*=.*async\|onSubmit.*=.*async" src/components/ --include="*.tsx" | head -30
# Find TODOs in component handlers
grep -rn "TODO\|FIXME\|no.op\|placeholder" src/components/ --include="*.tsx" -i | head -30
```

---

## CAPA-6: Realign Analytics Event Taxonomy

**Severity**: Medium (observability)
**Problem**: Sprint 5 spec promised specific event names and payload shapes that differ from implementation.

**Action**:
1. Extract all event names from `src/lib/analytics-types.ts`
2. Compare against Sprint 5 spec (`12-ANALYTICS-COLLECTIVE.md`) event list
3. For each mismatch, decide: update code or update spec with rationale
4. Document final event taxonomy in a single source-of-truth file
5. Add payload shape validation tests (event emitted matches declared TypeScript type)

---

## Preventive Gates (Apply to All Future Sprints)

### P1: Ban "complete" with blocking TODOs
Any PR containing `TODO` comments on core functionality paths must be labeled `scaffolded`, not `complete`. Feature flags can be merged but not marked done.

### P2: Mandatory failure modes section in every sprint spec
Each spec must include:
- Mutation refused scenarios
- Access control edge cases
- Archived/deleted entity handling
- Duplication prevention
- Store/UI staleness scenarios
- UI actions that appear to work but don't

### P3: Spec -> Code -> Test -> Proof traceability matrix
For each requirement:
| Requirement | File(s) Modified | Test(s) | Runtime Proof | Status |
|---|---|---|---|---|
| Opt-in stores consent | `collective-consent.ts` | `collective.test.ts:L42` | POST returns 200 + record exists | validated |

### P4: Four-level completion taxonomy
| Level | Meaning | Merge OK? | Mark Complete? |
|---|---|---|---|
| scaffolded | Types + routes exist, no real logic | Yes (behind flag) | No |
| wired | Logic exists, calls real APIs | Yes | No |
| validated | Tests pass, negative paths covered | Yes | Almost |
| complete | User-path verification + no blocking TODOs | Yes | Yes |

### P5: User-path verification gate before merge
Not just `build clean` + `tests pass`. Explicit scenarios:
- "Save to Vault creates a real entry" (verify DB)
- "Inject modifies the actual textarea" (verify DOM)
- "Opt-out deletes shared vectors" (verify Vectorize)
- "Proposal accept/dismiss stays consistent" (verify UI + server)

### P6: Ban semantic column reuse for privacy/consent/billing
Never repurpose an existing column for a different semantic purpose, especially for:
- Privacy consent
- Billing/entitlement state
- Audit-sensitive data
- Feature flags with compliance implications

---

## Execution Order for CAPA Items

```
CAPA-1 (status correction)     — immediate, docs only
CAPA-4 (LifePanel fix)         — quick fix, ~30min
CAPA-2 (consent storage)       — migration + route update, ~2-3h
CAPA-3 (collective engine)     — substantial, ~6-8h
CAPA-5 (no-op audit)           — verification + fixes, ~2h
CAPA-6 (analytics realignment) — reconciliation, ~2h
CAPA-7 (PR #448 gecko caps)    — 3 fixes, ~3-4h
```

---

## CAPA-7: PR #448 Gecko Capability System Fixes (ai-hub)

**Source**: Audit of PR #448 (gecko capability access + combo selection APIs)
**Overall PR score**: 7.9/10 — good architectural foundation, 4 meaningful findings
**Severity**: High (findings 1-2), Medium (findings 3-4), Low (finding 5)

### 7a) Expired grants bypass in POST /api/gecko/combo (HIGH)

**Problem**: `GET /api/gecko/access` filters expired grants correctly, but `POST /api/gecko/combo` reads from `gecko_capability_access` with NO expiry filtering before calling `canAccessGecko()`. Expired trials remain active.

**Fix**:
- In `src/app/api/gecko/combo/route.ts`: apply same expiry filter as access route
- Extract shared helper `getValidCapabilityGrants(userId)` to avoid logic drift
- Add test: expired grant → combo selection rejected

### 7b) Client store too coarse for backend access model (HIGH)

**Problem**: Zustand store uses `hasProAccess: boolean` which ignores trial/admin grants. `setCapability` and `toggleCapability` return early if not Pro, blocking users who have valid trial or admin-granted access.

**Fix**:
- Replace `hasProAccess: boolean` with `accessibleCapabilities: CapabilityGeckoId[]` (or `accessMap`)
- Hydrate from `/api/gecko/access` instead of compressing to boolean
- Update `setCapability`/`toggleCapability` to check actual capability-level access
- Files: `src/lib/gecko/state.ts`

### 7c) Operational failures masked as free-tier state (MEDIUM)

**Problem**: Both `/api/gecko/access` and `/api/gecko/state` swallow database errors and return 200 with default/locked data. Migration failures go unnoticed.

**Fix**:
- Add `degraded: true` + `source: "fallback"` field to error responses
- OR return 500 for real operational failures, with separate explicit fallback for pre-migration states
- Files: `src/app/api/gecko/access/route.ts`, `src/app/api/gecko/state/route.ts`

### 7d) Verify prompt-merger wiring (LOW / follow-up)

**Problem**: `src/lib/gecko/prompt-merger.ts` is well-designed but PR alone doesn't prove all inference paths use it.

**Fix**:
- Verify runtime chat path calls `buildCombinedSystemPrompt()` or `buildPersonalityPrompt()`
- Add integration test covering personality+capability combo prompt

### Effort: ~3-4h total

**Total CAPA effort**: ~13-16h

After CAPA completion, Wave 7 status becomes:
```
Wave 7 ai-hub: COMPLETE (with CAPA evidence)
Moltworker M1-M3: TODO (separate track)
```
