# Model Management v2 — Implementation Plan

**Date:** 2026-03-26
**Branch:** TBD (claude/model-v2-*)
**Depends on:** Collective intelligence synthesis

---

## Phase 1: Quick Wins (can ship independently)

### 1.1 Auto-enrich on cron (1 task)
**File:** `src/index.ts` (cron handler)
**What:** Wire `runEnrichment()` to the 6h cron trigger (already runs every 6h for R2 sync). Remove manual-only requirement.
**Why:** Rankings are stale unless user remembers `/model enrich`. This makes AA data always fresh.
**LOC:** ~10

### 1.2 Tier system (replace confidence %)
**File:** `src/openrouter/models.ts`
**What:**
- New type: `ModelTier = 'S' | 'A' | 'B' | 'C' | 'unranked'`
- New type: `EvidenceTier = 'verified' | 'tested' | 'partial' | 'heuristic'`
- New function: `computeModelTier(model: ModelInfo): { quality: ModelTier, evidence: EvidenceTier }`
  - S: AA Intelligence ≥ 70 OR (AA Coding ≥ 60 AND orchestra success rate ≥ 80%)
  - A: AA Intelligence ≥ 55 OR AA Coding ≥ 45
  - B: AA Intelligence ≥ 40 OR has tools + context ≥ 64K
  - C: everything else
  - Unranked: no AA data AND no orchestra history
  - Evidence: verified (AA data), tested (≥20 orchestra runs), partial (AA OR runs), heuristic (neither)
- **Hard cap: models without AA data cannot exceed tier B**
- Replace `confidence` field in `RankedOrchestraModel` with `{ quality, evidence }`
**LOC:** ~80

### 1.3 New `/models` display (compact format)
**File:** `src/openrouter/models.ts` — rewrite `formatModelsList()`
**What:**
Replace wall-of-text with compact category view:

```
🤖 Models — You're using /deep (DeepSeek V3.2)

🆓 Top Free:
  /nemotron • Nemotron Ultra 253B • S [tools][131k] ✓AA
  /qwencoderfree • Qwen3 Coder 480B • A [tools][262k] ✓AA
  /devstral • Devstral Small • B [tools][128k]

💻 Best for Coding:
  /deep • DeepSeek V3.2 • S [tools][160k] • $0.25 ✓AA
  /grok • Grok 4.1 Fast • A [tools][2M] • $0.20 ✓AA
  /sonnet • Claude Sonnet 4 • S [tools][200k] • $3 ✓AA

🎼 Best for Orchestra:
  /kimidirect • Kimi K2.5 • S [tools][256k] • $0.60 ✓AA
  /deep • DeepSeek V3.2 • S [tools][160k] • $0.25 ✓AA

⚡ Fastest:
  /flash • Gemini 2.0 Flash • A [tools][1M] • $0.10 ✓AA
  /haiku • Claude 3.5 Haiku • A [tools][195k] • $1 ✓AA

60+ models available · /pick <task> for recommendations
/model <alias> for details · /compare <a> <b>
```

- Max 3-4 models per category
- Text tags: `[tools]`, `[vision]`, `[128k]`, `[reasoning]`
- Evidence indicator: `✓AA` (AA-verified) or nothing (heuristic)
- Tier letter: S/A/B/C
- Inline buttons below: [Free] [Coding] [Orchestra] [All Paid] [NVIDIA]
**LOC:** ~100

### 1.4 New `/pick <intent>` command
**File:** `src/telegram/handler.ts` + `src/openrouter/models.ts`
**What:** Intent-based model recommender with instant-switch buttons.

```
/pick coding

💻 Best for Coding:

 S  /deep — DeepSeek V3.2
    $0.25/$0.38 · tools · structured · 160K · ✓AA
    Best value for coding. Strong at multi-file changes.

 A  /grok — Grok 4.1 Fast
    $0.20/$0.50 · tools · vision · 2M ctx · ✓AA
    Huge context, good for large repos.

 🆓 /qwencoderfree — Qwen3 Coder 480B
    FREE · tools · structured · 262K · ✓AA
    Best free option for coding tasks.

[Use /deep] [Use /grok] [Use /qwencoderfree]
```

Intents: `free`, `coding`, `fast`, `orchestra`, `creative`, `cheap`, `best`, `vision`, `reasoning`
Each shows top 3 (or 2 paid + 1 free) with switch buttons.
**LOC:** ~150

---

## Phase 2: Structural (requires more planning)

### 2.1 Unified R2 model registry
- Merge curated + dynamic + auto-synced into single R2 `models-registry.json`
- Code catalog becomes seed data (loaded only if R2 is empty)
- All runtime reads from R2
- `/model update` patches R2 directly

### 2.2 Model state machine
- Add `state` field: `candidate | verified | recommended | superseded | deprecated | removed`
- Transitions triggered by: orchestra runs (candidate→verified), AA enrichment (verified→recommended), new model release (old→superseded), 30d zero-use (deprecated→removed)
- Notify users whose default model is deprecated

### 2.3 `/compare` command
```
/compare deep grok

⚖️ DeepSeek V3.2 vs Grok 4.1 Fast

                    /deep          /grok
Tier                S              A
Cost (in/out)       $0.25/$0.38    $0.20/$0.50
Context             160K           2M ← winner
AA Intelligence     72             65
AA Coding           68 ← winner    58
Tools               ✓              ✓
Vision              ✗              ✓ ← winner
Reasoning           configurable   configurable
Orchestra tested    ✓ (87% success) ✓ (71% success)

→ /deep wins for coding · /grok wins for large repos + vision

[Use /deep] [Use /grok]
```

### 2.4 Kill redundant commands
- `/model list` → redirect to `/models`
- `/model hub` → redirect to `/models`
- `/model rank` → redirect to `/models` (tiers are integrated)
- Keep: `/models`, `/pick`, `/compare`, `/model <alias>`, `/model search`, `/model update`, `/model check`

---

## Phase 3: Intelligence (longer term)

### 3.1 Orchestra feedback loop
- After each orchestra run: record `{ model, success, iterations, tools, duration }`
- After 20+ runs: compute success rate, avg iterations
- Override AA-based tier if real data diverges significantly
- Show "tested" badge: `✓ 87% success (23 runs)`

### 3.2 Passive health monitoring
- Track error rates per provider per hour (from normal traffic)
- Circuit-break: 3 errors in 5 min → mark model as degraded
- Auto-suggest fallback: "⚠️ /deep is slow right now. Try /grok?"
- No active pinging (saves cost)

### 3.3 Task-aware auto-routing
- Estimate task complexity from message length + keywords
- Simple queries (<100 tokens, no tools needed) → cheapest Tier A free model
- Complex/coding → user's chosen model
- User can opt out: `/autoroute off`

---

## Migration Notes

- Phase 1 is fully backward-compatible — no breaking changes
- Phase 2 changes storage format — needs migration path from current R2 data
- Phase 3 needs orchestra run data — accumulates over time, no immediate impact
- All phases can ship independently to different branches/PRs
