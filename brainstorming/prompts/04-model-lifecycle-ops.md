# Prompt: Model Lifecycle Operations & Automation

Use this prompt with any capable AI to get perspectives on automating model management.

---

## Context

I operate a **multi-model AI gateway** (Moltworker) that routes Telegram/Discord messages to 60+ LLMs. Models are sourced from:

- **OpenRouter** (30+ models, prices/availability change weekly)
- **Direct APIs** (DeepSeek, Anthropic, Moonshot — stable but versioned)
- **NVIDIA NIM** (7 free models, new ones appear monthly)
- **Cloudflare AI Gateway** (Workers AI + proxied providers)

The system runs on **Cloudflare Workers** with R2 storage for persistence and **Durable Objects** for long-running tasks. Config is baked into a Docker image (Cloudflare Sandbox container).

### Current Model Lifecycle

```
[Discovery] → [Registration] → [Enrichment] → [Ranking] → [Display] → [Selection] → [Usage] → [Monitoring] → [Deprecation]
```

**Discovery**: Manual (curated catalog in code) + semi-automatic (user-triggered sync from OpenRouter API)
**Registration**: Three tiers — curated (code), dynamic (user-picked), auto-synced (background)
**Enrichment**: Semi-automatic — Artificial Analysis API provides independent benchmarks (Intelligence Index, Coding, Math, LiveCodeBench) for ~40% of models. Cron can auto-run but currently requires manual `/model enrich` trigger. 24h cache in R2 with stale fallback.
**Ranking**: Pre-computed multi-factor score, stored in memory
**Display**: Multiple overlapping text-based views
**Selection**: User types `/alias` or taps inline button → stored in R2 per user
**Usage**: Requests routed to provider, tokens/cost tracked per session
**Monitoring**: Orchestra tracks success/failure per model, but data isn't used in rankings
**Deprecation**: Auto-synced models have lifecycle tracking (active → stale → deprecated → removed)

### Current Problems

1. **Discovery is fragmented** — curated models in TypeScript code, dynamic in R2, NVIDIA in shell script, CF Gateway in shell script
2. **Enrichment is manual** — user must remember to run `/model enrich`, data gets stale
3. **No health monitoring** — if OpenRouter is slow or a model returns errors, we don't know until users complain
4. **No price tracking** — prices change and we don't notice until someone runs `/model check`
5. **Deprecation is incomplete** — curated models in code never get removed automatically
6. **Config is split between code and runtime** — some models in TypeScript, some in shell script, some in R2
7. **No A/B testing** — can't easily test if a new model is better than an incumbent

### Technical Environment

- **Runtime**: Cloudflare Workers (10s CPU limit for sync handlers, 5min for Durable Objects)
- **Storage**: R2 (S3-compatible object store), KV (key-value with TTL)
- **Cron**: Worker cron triggers run every 5 minutes and every 6 hours
- **External APIs**: OpenRouter, Artificial Analysis, NVIDIA NIM catalog
- **Container**: Docker image rebuilt on deploy, shell script configures gateway at startup

### What We Track Per Model Usage

```typescript
{
  model: string,           // alias used
  resolvedModel: string,   // actual model ID sent to API
  provider: string,        // openrouter, deepseek, nvidia, etc.
  tokensIn: number,
  tokensOut: number,
  cost: number,
  duration: number,        // ms
  success: boolean,
  toolsUsed: string[],
  iterations: number,      // for multi-step tasks
}
```

---

## Questions for You

### 1. Unified Model Registry
- How should we unify model definitions across: TypeScript catalog, shell script config, R2 dynamic storage, and provider APIs?
- Should there be a single source of truth? Where should it live?
- How do you handle models that are "configured in code" vs "discovered at runtime"?

### 2. Automated Enrichment Pipeline
- Design an automated enrichment pipeline that runs on a cron schedule.
- What data should it collect? How often?
- How should staleness be handled? (e.g., benchmark data is 2 weeks old)
- What happens when Artificial Analysis is down or returns errors?

### 3. Health Monitoring
- Design a model health monitoring system that detects:
  - Provider outages (OpenRouter down, NVIDIA NIM rate limited)
  - Individual model degradation (slow responses, increased errors)
  - Price changes
  - New model availability
- How should this integrate with the user experience? (e.g., auto-fallback, warning messages)

### 4. Smart Deprecation
- Design a lifecycle for models going from "new and untested" → "verified and recommended" → "superseded" → "deprecated" → "removed"
- What triggers each transition?
- How do you notify users who have a deprecated model as their default?

### 5. Cost Optimization
- Users often don't realize they're using an expensive model for a simple task
- Design an auto-routing system that picks the cheapest model capable of handling the request
- How do you determine "capable of handling"? (task complexity estimation)
- How do you avoid degrading the user experience?

### 6. A/B Testing for Models
- How would you test whether a new model (e.g., "Nemotron Ultra 253B") is actually better than the current recommendation for coding tasks?
- What metrics would you compare?
- How many samples before you're confident?

### 7. Provider Abstraction
- Currently, each provider (OpenRouter, DeepSeek, NVIDIA NIM, CF Gateway) is configured differently (code, shell script, env vars)
- Design a unified provider interface that handles:
  - Different auth methods (API key header vs Bearer token)
  - Different request/response formats (OpenAI-compatible vs Anthropic Messages API)
  - Different error formats
  - Rate limiting and backoff
  - Health tracking

Please provide concrete designs with pseudocode where appropriate. Focus on what's practically implementable in a Cloudflare Workers environment (no long-running background processes, max 5min Durable Object executions, R2 for storage).
