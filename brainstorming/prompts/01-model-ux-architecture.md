# Prompt: Model Management UX & Information Architecture

Use this prompt with any capable AI (GPT-4o, Gemini, Claude, DeepSeek, etc.) to get fresh perspectives on redesigning the model selection experience.

---

## Context

I'm building **Moltworker**, a multi-model AI assistant accessible via Telegram, Discord, and a web admin panel. It connects to **60+ LLM models** from multiple providers:

- **OpenRouter** (30+ models, pay-per-token marketplace)
- **Direct APIs** (DeepSeek, Anthropic, Moonshot, DashScope — lower latency)
- **NVIDIA NIM** (7 free models via build.nvidia.com)
- **Cloudflare AI Gateway** (CF Workers AI, proxied providers)
- **Free models** (~15, from OpenRouter free tier and NVIDIA)

Users interact via Telegram commands. The system has **4 AI skills** (Orchestra for multi-step coding, Lyra for content, Spark for brainstorming, Nexus for research) that each work better with certain models.

### Current Model Commands

| Command | Purpose | Problem |
|---------|---------|---------|
| `/models` | Full catalog (60+ models) | Wall of text, overwhelming |
| `/model list` | Same as /models | Redundant |
| `/model hub` | Dashboard overview | More text, not actionable |
| `/model rank` | Orchestra capability ranking | Dense symbol soup, questionable scores |
| `/model <alias>` | Single model detail card | Good but no "switch" flow |
| `/model search <q>` | Find by keyword | Works fine |
| `/model sync` | Interactive free model picker | Complex multi-step flow |
| `/model syncall` | Full OpenRouter catalog sync | Background task |
| `/model enrich` | Fetch Artificial Analysis benchmarks | Manual, should be automatic |
| `/model update` | Patch model metadata | Admin tool, fine |
| `/model check` | Check for price/availability changes | Good utility |

### Current Display Format (actual output)

```
🏅 Model Ranking — Orchestra & Capability

💎 PAID (best for orchestra/complex tasks):
🥇 1. /kimidirect 🔌⚡👁️🧠 256K 95% $0.60/$3.00
🥇 2. /m2.5 🌐⚡📋🧠 192K 87% $0.20/$1.10
🥇 3. /qwennext 🌐⚡📋 256K 82% $0.20/$1.50
🥇 4. /haiku 🔌⚡📋👁️ 195K 79% $1/$5
🥇 5. /deep 🌐⚡📋🧠 160K 77% $0.25/$0.38

🆓 FREE (best free options):
 1. /pony 🌐 195K 88% FREE
 2. /devstral2free 🌐⚡ 256K 67% FREE
 3. /qwencoderfree 🌐⚡📋 256K 61% FREE
```

### Known Problems
1. Too many symbols per line — users can't parse `🔌⚡📋👁️🧠` at a glance
2. Confidence % is misleading — "pony" at 88% is ranked above models with proven track records
3. Aliases are cryptic — `m2.5`, `q3coder`, `dsnv`, `pony` mean nothing to users
4. No intent-based navigation — user can't say "I want the best free coding model"
5. Overlapping commands — `/models`, `/model list`, `/model hub` are redundant
6. No comparison between models
7. Telegram has 4096 char message limit — long lists get truncated or split awkwardly

### Constraints
- **Telegram UI**: inline keyboard buttons (up to 8 per row, practical limit 3-4), callback data max 64 bytes
- **No rich rendering**: plain text + limited Markdown/HTML. No tables, no cards, no CSS.
- **Response speed matters**: users expect instant responses, complex formatting is fine if pre-computed
- **Model landscape changes weekly**: new models appear, prices change, models get deprecated
- **Users range from technical (developers) to non-technical (content creators)**

---

## Questions for You

### 1. Information Architecture
- How would you restructure the model commands? Which should be merged, removed, or redesigned?
- What's the ideal number of "views" for a model catalog of 60+ items in a chat interface?
- How should we handle the tension between "show me everything" and "just recommend one"?

### 2. Display Format
- Design an improved model list format for Telegram (plain text, max 4096 chars). Show me concrete examples.
- How would you display model capabilities without symbol soup? What's the right level of detail for a list view vs. detail view?
- How should free vs. paid models be presented? Should they be mixed or separate?

### 3. Intent-Based Navigation
- Design a `/pick` or `/recommend` command that maps user intents to model recommendations.
- What are the right intent categories? (e.g., fast, cheap, coding, creative, reasoning, agentic)
- How should this work with Telegram inline buttons?

### 4. Comparison
- How would you let users compare 2-3 models side by side in a chat interface?
- What attributes matter most for comparison?

### 5. Onboarding
- A new user types `/start` and has never used the bot. How do they discover and pick their first model?
- How do you teach users the alias system without overwhelming them?

Please provide concrete, implementable designs with example output text that would work in Telegram. Think about progressive disclosure — show less by default, let users drill down. Consider both power users and newcomers.
