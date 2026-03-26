# Model Management v2 — Implementation Plan

**Date:** 2026-03-26 (updated)
**Branch:** TBD (claude/model-v2-*)
**Depends on:** Collective intelligence synthesis

---

## Design Decisions

### Rating: Stars (★) instead of letter tiers
Letters (S/A/B/C) are gaming jargon — not universally readable. Stars are instant:

| Stars | Meaning | Criteria |
|-------|---------|----------|
| ★★★ | Top tier | AA Intelligence ≥ 70 OR (AA Coding ≥ 60 AND orchestra success ≥ 80%) |
| ★★☆ | Strong | AA Intelligence ≥ 55 OR AA Coding ≥ 45 |
| ★☆☆ | Basic | AA Intelligence ≥ 40 OR has tools + context ≥ 64K |
| ☆☆☆ | Untested | No AA data AND no orchestra history |

**Hard cap: models without AA data cannot exceed ★☆☆**

### Evidence: ✓ verified vs ? unknown
Shown right after stars. Two values only — no jargon:
- `✓` = AA benchmarks exist (we measured it)
- `?` = no benchmarks (heuristic guess)

### Capabilities: readable words, not emoji soup
Instead of `🔌⚡📋👁️🧠`, use a plain capabilities line:
```
coding · tools · reasoning · vision · 160K
```
Reads like natural language. Ordered by relevance to the category being shown.

---

## Phase 1: Quick Wins (can ship independently)

### 1.1 Auto-enrich on cron
**File:** `src/index.ts` (cron handler)
**What:** Wire `runEnrichment()` to the 6h cron trigger. Remove manual-only requirement.
**Why:** Rankings are stale unless user remembers `/model enrich`. This makes AA data always fresh.
**LOC:** ~10

### 1.2 Star rating system (replace confidence %)
**File:** `src/openrouter/models.ts`
**What:**
- New type: `StarRating = 3 | 2 | 1 | 0`
- New type: `EvidenceLevel = 'verified' | 'unverified'`
- New function: `computeRating(model): { stars: StarRating, evidence: EvidenceLevel }`
- New formatter: `formatStars(stars)` → `★★★` / `★★☆` / `★☆☆` / `☆☆☆`
- Replace `confidence` field in `RankedOrchestraModel`
- Add capability word list: `getCapabilityWords(model): string[]` → `['coding', 'tools', 'vision', '160K']`
**LOC:** ~80

### 1.3 New `/models` display (compact format)
**File:** `src/openrouter/models.ts` — rewrite `formatModelsList()`
**What:** Replace wall-of-text with compact category view:

```
🤖 Models — You're using /deep (DeepSeek V3.2)

🆓 Top Free:
  /nemotron • Nemotron Ultra 253B • ★★☆ ✓
    tools · 131K • FREE
  /qwencoderfree • Qwen3 Coder 480B • ★★☆ ✓
    coding · tools · structured · 262K • FREE
  /devstral • Devstral Small • ★☆☆
    coding · tools · 128K • FREE

💻 Best for Coding:
  /deep • DeepSeek V3.2 • ★★★ ✓
    coding · tools · reasoning · 160K • $0.25
  /grok • Grok 4.1 Fast • ★★☆ ✓
    coding · tools · vision · 2M • $0.20

🎼 Best for Orchestra:
  /kimidirect • Kimi K2.5 • ★★★ ✓
    tools · structured · 256K • $0.60
  /deep • DeepSeek V3.2 • ★★★ ✓
    coding · tools · reasoning · 160K • $0.25

⚡ Fastest:
  /flash • Gemini 2.0 Flash • ★★☆ ✓
    tools · vision · 1M • $0.10
  /haiku • Claude 3.5 Haiku • ★★☆ ✓
    tools · vision · 195K • $1

60+ models · /pick <task> for recs · /model <alias> for details
```

- Max 3-4 models per category
- Inline buttons below: [Free] [Coding] [Orchestra] [Fast] [All Paid] [NVIDIA]
**LOC:** ~120

### 1.4 New `/pick <intent>` command
**File:** `src/telegram/handler.ts` + `src/openrouter/models.ts`
**What:** Intent-based model recommender with instant-switch buttons.

```
/pick coding

💻 Best for Coding:

★★★ ✓  /deep — DeepSeek V3.2
  coding · tools · reasoning · structured · 160K
  $0.25/$0.38 — Best value for coding tasks.

★★☆ ✓  /grok — Grok 4.1 Fast
  coding · tools · vision · reasoning · 2M
  $0.20/$0.50 — Huge context, good for large repos.

★★☆ ✓  /qwencoderfree — Qwen3 Coder 480B
  coding · tools · structured · 262K
  FREE — Best free option for coding.

[Use /deep] [Use /grok] [Use /qwencoderfree]
```

Intents: `free`, `coding`, `fast`, `orchestra`, `creative`, `cheap`, `best`, `vision`, `reasoning`
Each shows top 3 (or 2 paid + 1 free) with switch buttons.
**LOC:** ~150

### 1.5 `/ping-models` — Manual health check
**File:** `src/telegram/handler.ts` + new `src/openrouter/health.ts`
**What:** Send a tiny probe ("Say hi", ~5 tokens) to all active models in parallel via Durable Object. Report health + auto-mark failures.

```
/ping-models

🏓 Model Health (14 models, 8.2s)

✅ Healthy (11):
  /deep 420ms · /flash 310ms · /grok 890ms
  /haiku 650ms · /sonnet 1.2s · /nemotron 780ms
  /devstral 950ms · /qwencoderfree 1.1s
  /trinity 1.4s · /kimidirect 510ms · /mini 380ms

⚠️ Slow (>5s) (1):
  /opus 6.8s — works but slow

❌ Failed (2):
  /pony — 408 Request Timeout
  /deepchatfree — 429 Rate Limited

Actions taken:
  → /pony marked degraded (users see ⚠️ warning)
  → /deepchatfree rate-limited (auto-recheck in 1h)
```

**Automatic consequences for failures:**

| Failure | Action | User impact |
|---------|--------|-------------|
| Timeout / 5xx | Mark `degraded` | Warning sent to users with this as default: "⚠️ /pony is down. Try /deep?" |
| 429 rate limited | Mark `rate-limited`, auto-recheck in 1h | Hidden from `/pick` recommendations |
| 3 consecutive failures | Mark `unhealthy` | Hidden from `/pick`, shown with ⚠️ in `/models` |
| Recovery (next successful ping) | Clear degraded status | Back to normal |

**No model is auto-removed or auto-switched.** The bot surfaces info and warns — user decides.

**Scope of ping:** All models the user (or any user) has selected in the last 7 days + all curated models. Skip image-gen models.

**Cost:** ~5 tokens × 14 models × $0.25/M avg = effectively $0. Even premium models cost < $0.001 per ping.

**LOC:** ~200 (health.ts: ping logic + state tracking, handler: command + warning DM)

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
Rating          ★★★ ✓         ★★☆ ✓
Cost (in/out)   $0.25/$0.38    $0.20/$0.50
Context         160K           2M ← winner
AA Intelligence 72             65
AA Coding       68 ← winner   58
Capabilities    coding · tools coding · tools
                reasoning      vision · reasoning
Orchestra       87% (23 runs)  71% (15 runs)

→ /deep wins for coding · /grok wins for large repos + vision

[Use /deep] [Use /grok]
```

### 2.4 Kill redundant commands
- `/model list` → redirect to `/models`
- `/model hub` → redirect to `/models`
- `/model rank` → redirect to `/models` (stars are integrated)
- Keep: `/models`, `/pick`, `/compare`, `/model <alias>`, `/model search`, `/model update`, `/model check`, `/ping-models`

---

## Phase 3: Intelligence (longer term)

### 3.1 Orchestra feedback loop
- After each orchestra run: record `{ model, success, iterations, tools, duration }`
- After 20+ runs: compute success rate, avg iterations
- Override star rating if real data diverges significantly
- Show "tested" badge: `✓ 87% success (23 runs)`

### 3.2 Passive health monitoring (supplement to /ping-models)
- Track error rates per provider per hour (from normal traffic)
- Circuit-break: 3 errors in 5 min → mark model as degraded automatically
- Same warning system as /ping-models but triggered by real usage, not manual

### 3.3 Task-aware auto-routing
- Estimate task complexity from message length + keywords
- Simple queries (<100 tokens, no tools needed) → cheapest ★★☆+ free model
- Complex/coding → user's chosen model
- User can opt out: `/autoroute off`

### 3.4 Periodic model discovery (TODO — discuss next)
- Auto-detect and evaluate new high-quality models from OpenRouter/NVIDIA
- Surface recommendations: "New model available: X — ★★☆ ✓, better than Y for coding"
- User approves before adding to catalog

---

## Migration Notes

- Phase 1 is fully backward-compatible — no breaking changes
- Phase 2 changes storage format — needs migration path from current R2 data
- Phase 3 needs orchestra run data — accumulates over time, no immediate impact
- All phases can ship independently to different branches/PRs
