# Model Management v2 — Collective Intelligence Synthesis

**Date:** 2026-03-26
**Sources:** Gemini, Grok, ChatGPT (via prompts 01-04)
**Status:** Synthesis complete, ready for implementation planning

---

## Consensus Points (ALL agree)

### Commands: 4 total (down from 10+)
| Command | Purpose |
|---------|---------|
| `/models` | Smart overview: current model + categories as buttons |
| `/pick <intent>` | Task-based recommendation (coding/free/fast/orchestra/creative) |
| `/compare <a> <b>` | Side-by-side with winner highlights + switch buttons |
| `/model <alias>` | Detail card with benchmarks, best-for, switch button |

**Kill:** `/model list` (= /models), `/model hub` (= /models), `/model rank` (folded into /models + /pick)
**Automate:** `/model sync`, `/model enrich` → cron job (6h), no user action needed
**Keep as admin:** `/model update`, `/model check`

### Ranking: Stars + Evidence, NOT single %
- **Star ratings:** ★★★ (top) / ★★☆ (strong) / ★☆☆ (basic) / ☆☆☆ (untested) — universally readable
- **Evidence:** `✓` (AA benchmarks verified) or `?` (heuristic guess) — shown right after stars
- **Task-specific** capabilities shown as readable words: `coding · tools · reasoning · 160K`
- **No single confidence %** — it conflates too many signals with different reliability
- **Unknown models hard-capped at ★☆☆** — can't rate higher than verified models
- **Real orchestra data overrides benchmarks** after 10-20 samples

### Display: Compact, scannable, no emoji soup
- **Capability words** instead of emoji chains: `coding · tools · vision · 160K`
- **Max 8-15 models per view**, buttons for "show more"
- **Line format:** `/alias • Name • ★★★ ✓` + capability line below
- **Detail card:** best-for, capabilities, context, evidence, tradeoffs + action buttons

### Health: Manual `/ping-models` + auto-consequences
- Manual command pings all active models in parallel (~5 tokens each)
- Reports healthy / slow / failed with latency
- Auto-marks failures: degraded (timeout), rate-limited (429), unhealthy (3x consecutive)
- Warns users whose default model is down — never auto-switches

### Lifecycle: Unified R2 registry + auto-cron
- **Single source of truth:** R2 `models.json` (all providers merged)
- **Code catalog = seed/overrides only** — runtime reads from R2
- **6h cron:** fetch pricing, AA benchmarks, recompute star ratings, atomic write
- **Model states:** candidate → verified (≥20 runs) → recommended → superseded → deprecated → removed
- **Periodic auto-discovery:** TODO — detect and surface new high-quality models for approval

---

## Disagreements (flagged for decision)

| Topic | Options | Recommendation |
|-------|---------|----------------|
| Default entry command | Gemini/Grok: `/models`; ChatGPT: `/model home` with recs | `/models` — simpler, familiar |
| Categories | Gemini: 5; Grok: 6; ChatGPT: 8 | Start with 5: Free, Coding, Agentic, Fast, Premium |
| Cron frequency | Gemini: 12h; Grok/ChatGPT: 6h | 6h — prices change fast, AA is free tier |
| Rating system | Grok: S/A/B/C; ChatGPT: 2D (quality + evidence) | **Stars (★★★/★★☆/★☆☆/☆☆☆) + ✓/?** — universally readable, 2D (quality + evidence) |
| Formula weights | Vary by source | Start with Grok's, iterate with real data |
| Health monitoring | Gemini: circuit-break; Grok: active ping; ChatGPT: anomaly | **Manual `/ping-models`** with auto-consequences; passive circuit-break later |

---

## Implementation Priority (from Grok, adjusted)

### Phase 1: Foundation (highest impact, lowest risk)
1. Auto-enrich on 6h cron (already have the code, just wire to cron)
2. Star ratings (★★★/★★☆/★☆☆/☆☆☆ + ✓/?) — replace confidence %
3. New `/models` display (compact format, category buttons, capability words)
4. New `/pick <intent>` command with inline buttons
5. `/ping-models` manual health check with auto-consequences

### Phase 2: Quality (medium effort)
6. Unified R2 model registry (merge curated + dynamic + auto-synced)
7. Model state machine (candidate → verified → recommended → deprecated)
7. New `/compare` command
8. Kill redundant commands (/model list, /model hub)

### Phase 3: Intelligence (higher effort)
9. Orchestra success/failure feeding into rankings
10. Passive health monitoring + circuit-break
11. Task-aware auto-routing (simple query → cheapest capable)
12. A/B testing framework (10% traffic to new models)
