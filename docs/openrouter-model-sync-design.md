# OpenRouter + Direct API Model Catalog Sync Design (Feb 2026)

This document defines a concrete architecture for keeping a large model catalog current while preserving quality curation.

## Scope

- Source A: OpenRouter `GET /api/v1/models` (all models, not only free)
- Source B: Direct providers (DeepSeek, DashScope/Qwen, Moonshot/Kimi)
- Runtime: Cloudflare Workers + R2-backed catalog

## Reality check: data freshness

For true “right now” ranking/pricing, you should treat this as **runtime data**, not static code.

In this environment, unauthenticated access to OpenRouter model listing failed with a proxy 403, so this design focuses on deterministic sync logic and curation policy rather than claiming verified live rankings/prices from this shell session.

## Recommended architecture

Use a **three-layer catalog**:

1. **Static curated tier** (`src/openrouter/models.ts`)
   - ~30-40 “recommended” aliases with stable names and hand-checked specialties.
2. **Dynamic full index** (R2)
   - Every OpenRouter model you can discover + metadata snapshots.
3. **Runtime resolver**
   - Alias lookup order: user-pinned alias > curated alias > dynamic alias > fallback.

This gives “best UX defaults” while still exposing long-tail models.

## Storage schema (R2)

Store one versioned object, e.g. `catalog/openrouter-models.v2.json`:

```json
{
  "schemaVersion": 2,
  "syncedAt": "2026-02-22T12:00:00.000Z",
  "source": "openrouter:/api/v1/models",
  "models": {
    "openai/gpt-4o": {
      "id": "openai/gpt-4o",
      "name": "GPT-4o",
      "provider": "openrouter",
      "pricing": { "prompt": 2.5, "completion": 10.0, "unit": "USD/1M" },
      "context": 128000,
      "modalities": ["text", "image"],
      "capabilities": {
        "tools": true,
        "vision": true,
        "reasoning": "none",
        "structuredOutput": true,
        "parallelToolCalls": true
      },
      "raw": { "...": "original subset from API" },
      "status": "active",
      "firstSeenAt": "...",
      "lastSeenAt": "..."
    }
  },
  "aliases": {
    "gpt": "openai/gpt-4o"
  },
  "deprecated": {
    "some-old-id": {
      "lastSeenAt": "...",
      "replacement": "new-id",
      "reason": "removed upstream"
    }
  }
}
```

## Sync pipeline

### 1) Fetch

- OpenRouter: `GET https://openrouter.ai/api/v1/models`
  - Include `Authorization` + `HTTP-Referer`.
  - Retry with backoff (3 attempts, jitter).

### 2) Normalize

Map from OpenRouter fields into internal shape:

- `id` -> `id`
- `name` -> `name`
- `context_length` -> `maxContext`
- `architecture.modality` -> modality flags
- `pricing.prompt` / `pricing.completion` -> numeric USD per token (convert to per-1M for display)
- `supported_parameters[]` -> first-pass capabilities

### 3) Capability inference (multi-signal)

Because `supported_parameters` is inconsistent, use weighted rules:

1. **Tools** = true if any:
   - `supported_parameters` includes one of: `tools`, `tool_choice`, `parallel_tool_calls`
   - OR model family known-good allowlist (kept in small override map)

2. **Vision** = true if any:
   - modality contains `image`
   - OR known multimodal families in override map

3. **Reasoning**:
   - `fixed` if model ID/name indicates locked reasoning (e.g. `reasoner`, `thinking`)
   - `configurable` if `supported_parameters` includes effort controls (e.g. `reasoning`, `reasoning_effort`)
   - else `none`

4. **Structured output**:
   - true if `supported_parameters` contains `response_format` or `json_schema`
   - OR known model supports strict JSON schema (override map)

5. **Parallel tool calls**:
   - true if `parallel_tool_calls` or equivalent appears in supported params.

Never hardcode only one signal; always combine API signals + small curated overrides.

### 4) Diff + lifecycle

For each sync:

- `new`: present now, absent before
- `changed`: same ID, metadata changed (pricing/context/caps)
- `missing`: absent now, present before

Deprecation policy:

- First missing sync -> mark `status=grace` and keep model resolvable.
- Missing for N consecutive syncs (recommend N=7 daily syncs) -> mark `deprecated` and hide from recommended lists.
- Keep alias redirect map for removed IDs to replacements.

### 5) Publish atomically

- Write full snapshot to `...tmp` key
- Verify JSON parse + checksum
- Promote to canonical key (copy/rename pattern)

## Alias strategy (deterministic + stable)

Current “strip provider + suffix + append f” works for quick free sync, but for all-model sync use:

1. Canonical base alias from model family + tier token
   - `qwen/qwen3-coder` -> `qwen3coder`
   - `qwen/qwen3-coder-next` -> `qwen3codernext`
2. Conflict suffix by provider short code + short hash (not repeated `f`)
   - `qwen3coder-or-ab12`
3. Maintain immutable alias->id ledger so aliases never silently repoint.
4. Optional “marketing aliases” (e.g. `bestcode`) are curated pointers, not auto-generated.

## Curation policy (recommended)

Use **hybrid mode**:

- Curated Recommended: 30-40 models (your current pattern)
- Dynamic Discoverable: everything else searchable/filterable

Why not fully dynamic?

- OpenRouter long tail includes duplicates, stale variants, niche checkpoints.
- End users typically want category winners, not 200+ options.

Implement two list APIs:

- `/api/models?tier=recommended`
- `/api/models?tier=all&provider=openrouter&capability=tools`

## Polling frequency (Cloudflare Cron)

Recommended:

- **Daily full sync** (off-peak UTC)
- **6-hour lightweight head check** (optional; compare counts/hash if endpoint supports stable ETag)
- **On-demand admin sync** (`/syncmodels all`) for manual refresh

This balances freshness vs quota/cost and avoids noisy hourly churn.

## Pricing buckets

Compute buckets from prompt/completion per-1M token prices:

- `free`: both = 0
- `budget`: max(prompt, completion) < 1
- `standard`: 1 to <5
- `advanced`: 5 to <15
- `premium`: >=15

Store both raw numeric values and bucket to avoid reclassification drift.

## Direct provider ingestion

Prefer provider-native model listing when available, else static registry + release feed:

- DeepSeek: check for official model list endpoint/docs; fallback to maintained allowlist in code.
- DashScope (Qwen): use OpenAI-compatible model-list endpoint if exposed for your account/region.
- Moonshot (Kimi): use provider’s model-list endpoint if available; otherwise registry.

For all direct providers, keep separate `providerCatalog` object in R2:

- avoid mixing OpenRouter-specific metadata assumptions
- preserve provider-native fields (cache pricing, temperature constraints, max output limits)

## “Best-in-class” selection logic (automatic + curated override)

Build category rankings from a score function:

`rank = qualityWeight*curatedQuality + costWeight*costScore + latencyWeight*latencyScore + capabilityBonus`

Per-category hard gates:

- coding: must support tools + high context
- reasoning: reasoning != `none`
- vision: supports vision
- image generation: `isImageGen`
- fast/cheap: budget/free + latency score

Then allow manual override list for final top picks shown to users.

## API contract for your Worker

- `GET /api/models` -> `{ recommended: ModelInfo[], allCount, syncedAt }`
- `GET /api/models/all?cursor=...` -> paginated all-model index
- `POST /api/models/sync` -> trigger sync job (admin only)
- `GET /api/models/changelog?days=30` -> additions/removals/price changes

## Known gotchas

- `supported_parameters` naming differs across providers and can be incomplete.
- Some models advertise tools but fail at strict tool-call JSON formatting.
- Free model availability can flap; do not hard-delete immediately.
- Model IDs can be reused with changed backend behavior; track `lastChangedAt` and metadata hash.

## Practical rollout plan

1. Implement normalization + capability inference module.
2. Add R2 snapshot schema v2 and migration from current dynamic-only free schema.
3. Extend `/syncmodels` to support modes: `free` (existing), `all`, `provider:<name>`.
4. Add recommended-tier API + UI filters (tools/vision/reasoning/structured/free/price-tier).
5. Add deprecation grace-state and changelog endpoint.

