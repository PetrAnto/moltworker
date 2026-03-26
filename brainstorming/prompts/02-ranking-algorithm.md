# Prompt: LLM Model Ranking Algorithm Design

Use this prompt with any capable AI to get perspectives on building a fair, useful ranking system for LLM models.

---

## Context

I run a **multi-model AI gateway** that routes user requests to 60+ LLM models from different providers. I need a ranking system that helps users pick the right model for their task. The ranking is displayed in a Telegram chat bot.

### Primary Data Source: Artificial Analysis (AA)

We already integrate with the **Artificial Analysis API** (https://artificialanalysis.ai/api/v2/data/llms/models) — an independent benchmarking service that runs standardized evaluations across LLMs. This is our best objective data source.

**AA provides per model:**
- Intelligence Index (0-100 composite) — our strongest ranking signal
- Coding Index — programming-specific performance
- Math Index — mathematical reasoning
- MMLU-Pro, GPQA Diamond, LiveCodeBench scores
- Speed (tokens/sec), TTFT (latency)
- Pricing data

**Coverage:** ~40% of our 60+ models (all major providers, misses niche/free models)
**Cache:** 24-hour TTL in R2, graceful fallback to stale data if API is down
**Matching:** 7-strategy fuzzy match (exact ID → normalized name → stripped versions → prefix match)

### Current Ranking System

The current system computes a **"confidence score" (5-95%)** for each model's suitability for agentic/orchestra tasks. It uses these factors:

| Factor | Max Points | Source |
|--------|-----------|--------|
| AA Intelligence Index | 30 | Artificial Analysis API (best signal) |
| AA Coding Index | 25 | Artificial Analysis API |
| AA LiveCodeBench | 10 | Artificial Analysis API |
| SWE-Bench score (from model description) | 25 | Self-reported in model metadata (unreliable) |
| "Agentic" keyword in description | 12 | Text matching |
| `orchestraReady` flag | 12 | Computed (has tools + coding≥40 + context≥64K) |
| Parallel calls + structured output | 8 | Binary flags |
| Direct API (vs OpenRouter proxy) | 8 | Provider type |
| Context window size | 10 | Numeric (500K→10, 200K→7, etc.) |
| Model size heuristic | ±15 | Dense→+10, <20B active→-15 |
| "Unknown model" penalty | -20 | No benchmark data |

Then normalized to 5-95% range.

### Problems with Current Approach

1. **AA data is the best signal but only covers ~40% of models** — the other 60% fall back to heuristics and self-reported scores, creating a two-tier ranking where heuristic-ranked models can score unrealistically high
2. **Self-reported SWE-Bench scores are unreliable** — model providers inflate them, and these are worth up to 25pts (comparable to AA Coding Index)
3. **"pony" (an unknown model) gets 88% confidence** — models without ANY AA data get -20pt penalty but can compensate with keyword matches + architecture bonuses
4. **No task differentiation** — ranking is the same whether user wants coding, creative writing, or research
5. **No real-world feedback loop** — we track orchestra success/failure events but don't actually use them in displayed rankings (code exists but data is sparse)
6. **Binary capability flags miss nuance** — "supports tools" doesn't mean "good at tools"
7. **Cost is not factored into ranking** — a $20/M model ranked #1 isn't useful if a $0.50/M model is 90% as good
8. **Confidence % implies precision we don't have** — 77% vs 79% is meaningless noise, especially when one is AA-backed and the other is heuristic-based

### Available Data Sources

| Source | What it provides | Coverage | Reliability |
|--------|-----------------|----------|-------------|
| **Artificial Analysis API** | Intelligence Index, Coding Index, Math Index, MMLU-Pro, GPQA, LiveCodeBench, Speed (TPS) | ~40% of models | **High** — independent, standardized |
| OpenRouter API | Pricing, context window, modality, tool support flag | 100% of OpenRouter models | High — live data |
| OpenRouter live verification | Actual tool/vision/structured output support | On-demand | High — tests real API |
| Self-reported descriptions | SWE-Bench %, architecture details | Curated models only | **Low** — inflated by providers |
| Orchestra event history | Per-model success rate, avg iterations, tool usage | Only models users actually tried | Medium — small sample sizes |
| User preference signals | Which models users manually switch to/from | Available in storage | Medium — popularity ≠ quality |
| NVIDIA NIM | Free models, tool support on some | 7 models | High — tested |

**Key insight:** AA data is our gold standard but covers less than half the catalog. The ranking system needs to clearly distinguish "AA-verified ranking" from "heuristic estimate" instead of blending them into one confidence %.

### Model Types

Users pick models for different purposes:
- **Chat** — general Q&A, creative writing, analysis
- **Coding** — code generation, debugging, PR creation
- **Orchestra** — multi-step agentic tasks (read repo → plan → code → PR)
- **Research** — web search, evidence gathering, synthesis (Nexus skill)
- **Content** — blog posts, headlines, rewrites (Lyra skill)
- **Brainstorming** — idea evaluation and development (Spark skill)

### Constraints
- Rankings must be pre-computable (no per-request API calls)
- Must work with incomplete data (many models lack benchmarks)
- Must handle 60+ models without being a wall of numbers
- Users are non-technical — "confidence %" doesn't mean anything to them
- New models appear weekly — ranking must degrade gracefully for unknowns

---

## Questions for You

### 1. Ranking Philosophy
- Should there be ONE ranking or MULTIPLE task-specific rankings (coding, creative, agentic, fast)?
- How do you handle models with no benchmark data? Should they be ranked at all, or shown in a separate "unranked" section?
- Is "confidence %" the right framing? Or should we use tiers (S/A/B/C), stars (★★★★☆), or qualitative labels ("excellent", "good", "basic")?

### 2. Scoring Formula
- Design a better scoring formula that:
  - Weights objective benchmarks higher than self-reported claims
  - Incorporates real-world usage data when available
  - Handles missing data gracefully (no wild guesses)
  - Considers cost-effectiveness (value per dollar)
  - Differentiates between task types
- Show me the formula with example calculations for 3 models.

### 3. Using Real-World Data
- We have orchestra run history: `{ model, success, iterations, toolsUsed, duration }`. How should this feed into rankings?
- What's the minimum sample size before trusting user data over benchmarks?
- How do you handle survivorship bias (users only try popular models)?

### 4. Presentation
- What's the most useful way to present rankings to a non-technical user in a chat interface?
- How many models should a "top" ranking show? (Currently: 12 paid + 8 free = 20 — too many?)
- Should we show the underlying score/factors or just the final rank?

### 5. Freshness & Decay
- How should rankings handle model deprecation? (e.g., model removed from OpenRouter but still in our catalog)
- Should rankings decay over time if not re-validated?
- How often should the ranking be recomputed?

Please provide a concrete, implementable design with:
- A scoring formula (pseudocode is fine)
- Example output showing how 5 models would be ranked
- Clear recommendations on presentation format
