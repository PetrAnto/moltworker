# Prompt: Chat-Based Model Catalog Display Design

Use this prompt with any capable AI to get creative solutions for displaying model catalogs in a chat interface.

---

## Context

I have a **Telegram bot** that provides access to **60+ AI models**. Users need to browse, compare, and switch between models. The challenge: designing information-dense displays that work within Telegram's constraints.

### Telegram Constraints
- **Max message length**: 4096 characters
- **Formatting**: HTML or Markdown (limited). No tables, no CSS, no custom fonts.
- **Inline buttons**: Up to 8 per row, 3-4 practical. Callback data max 64 bytes.
- **Monospace**: Available via `<code>` or backticks
- **Bold/italic**: Available
- **No images in formatted messages** (images are separate messages)
- **Users are on mobile phones** — small screens, fat fingers

### What We Need to Display Per Model

**Essential (must show in list view):**
- Alias (how to switch: `/deep`)
- Name (human-readable: "DeepSeek V3.2")
- Price (FREE or $0.25/$0.38)
- Key capability indicator (has tools? vision?)

**Important (show in detail view):**
- Full model ID
- Provider (OpenRouter / Direct API / NVIDIA NIM)
- Context window
- Capabilities: tools, vision, structured output, parallel calls, reasoning
- Benchmark scores (when available)
- Recommended use cases

**Nice to have:**
- Quality tier (S/A/B/C or stars)
- Speed (tokens/sec)
- Popularity / user preference signal

### Current Formats (problems noted)

**Model list line:**
```
  /deep 🔧👁️ DeepSeek V3.2 🔧🧠 · $0.25/$0.38
```
Problem: Icons are duplicated, meaning is unclear, no hierarchy.

**Ranking line:**
```
🥇 1. /kimidirect 🔌⚡👁️🧠 256K 95% $0.60/$3.00
```
Problem: 5 emojis in a row that nobody can decode without reading a legend.

**Free model line:**
```
  /devstral 🔧
```
Problem: Almost no information. What IS this model?

### Model Categories to Display

1. **Recommended** (3-5 models based on context)
2. **Free models** (~15) — most important for casual users
3. **Paid by value tier** — exceptional / great / good / premium
4. **Direct API** — fastest, bypass OpenRouter
5. **NVIDIA NIM** — free, direct, bypass egress issues
6. **Image generation** — separate category (4 FLUX models)
7. **Orchestra-ready** — for multi-step coding tasks

### Real User Scenarios

1. **New user**: "What models do you have?" → Needs a concise overview, not 60 models
2. **Cost-conscious user**: "What are the best free models?" → Needs free models ranked by quality
3. **Developer**: "Best model for writing code and creating PRs?" → Needs coding + tools ranking
4. **Power user**: "Switch to Gemini 2.5" → Needs search/fuzzy match
5. **Orchestra user**: "Which model should I use for /orch init?" → Needs agentic ranking

---

## Questions for You

### 1. List View Design
- Design a model list format that fits 15-20 models in one Telegram message (under 4096 chars).
- Show me 3 different format options with real example text.
- How do you handle the "more models available" overflow?

### 2. Capability Indicators
- Design a system to show model capabilities that ISN'T a row of emojis.
- Options to consider: text tags, abbreviated codes, grouped by capability, or separate capability views
- How do you show "supports tools" vs "excellent at tools"?

### 3. Categorization
- What's the best way to group 60+ models into scannable categories?
- Should categories be based on: price tier, capability, provider, use case, or quality?
- How many categories before it becomes overwhelming?

### 4. Progressive Disclosure
- Design a 3-level drill-down: overview → category → detail
- The overview should fit in ONE message with buttons to drill down
- Each level should be self-contained and useful on its own

### 5. Comparison View
- Design a side-by-side comparison format for 2-3 models in plain text
- What attributes to compare?
- How to trigger: `/compare deep grok` or interactive selection?

### 6. Quick Actions
- Design inline buttons that let users switch models without typing commands
- How many "quick switch" buttons on a model list? On a ranking? On a comparison?
- Should there be a persistent "favorites" bar?

### 7. Status Indicators
- How to show: model is slow right now / model was deprecated / model is new / model has been tested in orchestra
- Should this be inline or a separate "status" view?

Please provide **concrete text examples** that would work in Telegram. Use actual model names and real data. Think about how it looks on a **5.5-inch phone screen**. Aim for clarity over completeness — it's better to show 10 models clearly than 60 models in a mess.

### Example Models for Your Designs

Use these real models:

| Alias | Name | Cost | Capabilities |
|-------|------|------|-------------|
| deep | DeepSeek V3.2 | $0.25/$0.38 | tools, structured, reasoning |
| grok | Grok 4.1 Fast | $0.20/$0.50 | tools, vision, structured, reasoning |
| sonnet | Claude Sonnet 4 | $3/$15 | tools, vision, structured |
| flash | Gemini 2.0 Flash | $0.10/$0.40 | tools, vision |
| haiku | Claude 3.5 Haiku | $1/$5 | tools, vision, structured |
| nemotron | Nemotron Ultra 253B | FREE (NIM) | tools |
| devstral | Devstral Small | FREE | tools |
| qwencoderfree | Qwen3 Coder 480B | FREE | tools, structured |
| trinity | Trinity Large 400B | FREE | tools |
| opus | Claude Opus 4.5 | $15/$75 | tools, vision, structured, reasoning |
