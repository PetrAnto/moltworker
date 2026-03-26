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

### Ranking: Tiers + Evidence, NOT single %
- **Quality tiers:** S (≥90) / A (75-89) / B (60-74) / C (<60) — or Best/Strong/Budget/Experimental
- **Evidence tiers:** AA-verified / Tested (real orchestra data) / Partial / Heuristic-only
- **Task-specific scores:** coding, agentic, creative, fast, general
- **No single confidence %** — it conflates too many signals with different reliability
- **Unknown models hard-capped at B tier** — can't rank higher than verified models
- **Real orchestra data overrides benchmarks** after 10-20 samples

### Display: Compact, scannable, no emoji soup
- **Text tags** instead of emoji chains: `[tools][vision][128k]`
- **Max 8-15 models per view**, buttons for "show more"
- **Line format:** `/alias • Name • $cost • tags • Tier • Evidence`
- **Detail card:** best-for, capabilities, context, evidence, tradeoffs + action buttons

### Lifecycle: Unified R2 registry + auto-cron
- **Single source of truth:** R2 `models.json` (all providers merged)
- **Code catalog = seed/overrides only** — runtime reads from R2
- **6h cron:** fetch pricing, AA benchmarks, recompute tiers, atomic write
- **Model states:** candidate → verified (≥20 runs) → recommended → superseded → deprecated → removed
- **Health:** passive (orchestra logs) + circuit-break on 3x errors → auto-fallback

---

## Disagreements (flagged for decision)

| Topic | Options | Recommendation |
|-------|---------|----------------|
| Default entry command | Gemini/Grok: `/models`; ChatGPT: `/model home` with recs | `/models` — simpler, familiar |
| Categories | Gemini: 5; Grok: 6; ChatGPT: 8 | Start with 5: Free, Coding, Agentic, Fast, Premium |
| Cron frequency | Gemini: 12h; Grok/ChatGPT: 6h | 6h — prices change fast, AA is free tier |
| Tier system | Grok: S/A/B/C; ChatGPT: 2D (quality + evidence) | 2D — evidence tier is critical for trust |
| Formula weights | Vary by source | Start with Grok's, iterate with real data |
| Health monitoring | Gemini: circuit-break; Grok: active ping; ChatGPT: anomaly | Passive first (orchestra logs), add circuit-break |

---

## Implementation Priority (from Grok, adjusted)

### Phase 1: Foundation (highest impact, lowest risk)
1. Auto-enrich on 6h cron (already have the code, just wire to cron)
2. Tier computation (S/A/B/C + evidence tier) — replace confidence %
3. New `/models` display (compact format, category buttons)
4. New `/pick <intent>` command with inline buttons

### Phase 2: Quality (medium effort)
5. Unified R2 model registry (merge curated + dynamic + auto-synced)
6. Model state machine (candidate → verified → recommended → deprecated)
7. New `/compare` command
8. Kill redundant commands (/model list, /model hub)

### Phase 3: Intelligence (higher effort)
9. Orchestra success/failure feeding into rankings
10. Passive health monitoring + circuit-break
11. Task-aware auto-routing (simple query → cheapest capable)
12. A/B testing framework (10% traffic to new models)
