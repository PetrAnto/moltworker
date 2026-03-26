# Model Management System — Review & Improvement Plan

**Date:** 2026-03-26
**Status:** Analysis complete, seeking collective intelligence

---

## Current State Assessment

### What Exists
- **60+ curated models** in static catalog + dynamic models from sync + auto-synced models
- **Three-tier priority**: dynamic (user-picked) > curated (code) > auto-synced (OpenRouter)
- **6+ display commands**: `/models`, `/model hub`, `/model list`, `/model rank`, `/model search`, `/model <alias>`
- **Enrichment pipeline**: Artificial Analysis benchmarks, OpenRouter live verification
- **Ranking system**: Multi-factor confidence score (5-95%) for orchestra readiness
- **Model overrides**: Patch metadata without code deploy via `/model update`
- **Sync pipeline**: Interactive picker for free models, full catalog sync, deprecation tracking

### Key Problems

#### 1. Display Overload
- `/models` dumps a wall of text with 60+ models grouped by price tier
- `/model rank` shows dense lines with too many symbols: `🥇 1. /kimidirect 🔌⚡👁️🧠 256K 95% $0.60/$3.00`
- Users can't quickly answer: "Which model should I use for X?"
- Free synced models show almost no info (just alias + vision/tools icons)

#### 2. Too Many Overlapping Commands
- `/models` vs `/model list` — identical output
- `/model hub` — tries to be a dashboard but is just more text
- `/model rank` — good idea but dense and hard to scan
- Users don't know which command to use

#### 3. Ranking Confidence Is Misleading
- "pony" at 88% FREE — a model nobody knows ranked higher than GPT-4o
- Confidence % conflates "good for orchestra" with "good model"
- SWE-Bench scores from model descriptions are self-reported and unreliable
- No user feedback loop (orchestra success/failure) actually affecting displayed rank

#### 4. Alias Chaos
- Cryptic aliases: `m2.5`, `q3coder`, `dsnv`, `qwennv`, `pony`, `deepchatfree`
- No naming convention — mix of abbreviations, versions, provider names
- NVIDIA models use `nvidia/` prefix pattern differently from OpenRouter `openrouter/` pattern
- Users can't guess aliases — have to memorize or look up

#### 5. No Intent-Based Navigation
- User thinks: "I need a fast, free model for quick questions"
- System shows: 60 models sorted by price tier
- No "recommended for your use case" flow
- No comparison view between 2-3 models

#### 6. Manual Enrichment
- User must run `/model enrich` manually to get benchmark data
- Without enrichment, ranking is based on heuristics and self-reported scores
- Enrichment results are cached but staleness isn't communicated

#### 7. Provider Fragmentation
- Models come from: OpenRouter, direct APIs (DeepSeek, Moonshot, DashScope, Anthropic), NVIDIA NIM, CF AI Gateway
- Each provider has different capabilities, latency, reliability
- No unified health/status view per provider

---

## Proposed Solutions

### A. Simplify to 3 Core Views

**1. `/models` — Smart Overview (replace current wall of text)**
- Show current model + 3-5 recommendations based on recent usage patterns
- Group by intent: "Fast & Free", "Best Quality", "Best for Coding", "Best for Orchestra"
- Max 15-20 models visible, with "show all" option
- Each line: `/{alias} — {name} · {one-liner}` (no symbol soup)

**2. `/model rank` — Focused Leaderboard**
- Two views: "Quality" (by intelligence index) and "Orchestra" (by agentic capability)
- Top 5 paid + Top 3 free only (not 12+8)
- Show actual benchmark numbers, not computed "confidence %"
- Add "last tested" date for orchestra rankings

**3. `/model <alias>` — Detail Card (keep, but improve)**
- Add "Similar models" section (same price range, similar capabilities)
- Add "Switch to this model" button
- Show provider health status

### B. Intent-Based Model Picker

New `/pick` command (or integrate into `/model`):
```
/pick fast     → Top 3 fastest models (by TPS)
/pick free     → Top 3 free models with tools
/pick coding   → Top 3 for coding tasks
/pick cheap    → Top 3 best value
/pick best     → Top 3 highest quality
/pick orchestra → Top 3 for multi-step agentic tasks
```

Each shows 3 models as inline buttons for instant switching.

### C. Clean Up Aliases

Establish naming convention:
- **Provider-agnostic** when possible: `deepseek`, `qwen`, `gemini` (not `dsnv`, `qwennv`)
- **Version suffix** only when needed: `deepseek3`, `gemini2`
- **Free suffix**: `deepseek-free` instead of `deepchatfree`
- **Remove cryptic aliases**: `m2.5`, `pony`, `q3coder` → descriptive names

### D. Auto-Enrichment + Staleness

- Run enrichment automatically on cron (every 6 hours)
- Show "data freshness" indicator in rankings
- Cache AA + OpenRouter data with smart invalidation
- Remove self-reported SWE-Bench scores from ranking formula

### E. Merge Redundant Commands

| Keep | Remove/Merge |
|------|-------------|
| `/models` (smart overview) | `/model list` (merge into /models) |
| `/model rank` (leaderboard) | `/model hub` (merge into /models) |
| `/model <alias>` (detail) | |
| `/model search <q>` | |
| `/pick <intent>` (new) | |
| `/model sync` | `/model syncall` (merge into sync) |
| `/model update` | Keep for admin |

---

## Prompts for Other AIs

See separate prompt files below for:
1. UX/Information Architecture review
2. Ranking Algorithm review
3. Display Format optimization
