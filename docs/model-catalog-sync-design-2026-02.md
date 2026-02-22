# Model Catalog Sync Design (Feb 2026)

This note captures a practical design for keeping `src/openrouter/models.ts` quality high while scaling to the full OpenRouter catalog.

## 1) Current Landscape (using in-repo signals)

Because model rankings/pricing move weekly, treat this section as a **starting point** that should be refreshed from provider APIs.

### Best-in-class buckets to track

- **Coding**: Qwen coder line, DeepSeek coding/reasoning line, Devstral line, GPT-OSS tools variants.
- **Reasoning**: DeepSeek R1 family, Qwen reasoning variants, large MoE reasoning models.
- **General chat**: GPT-4o class models, Claude Sonnet-class, Gemini 2.5 class, Kimi/K2 class.
- **Fast/cheap**: flash/mini/haiku model tiers.
- **Vision**: multimodal variants (modality includes image input).
- **Image generation**: flux/stable diffusion families (isImageGen=true in local catalog).

### Direct API providers already configured

- DeepSeek (OpenAI-compatible chat/completions)
- DashScope/Qwen (OpenAI-compatible compatible-mode endpoint)
- Moonshot/Kimi (OpenAI-compatible chat/completions)

See `PROVIDERS` in `src/openrouter/models.ts` for URLs and env keys.

## 2) Recommended Architecture

Use a **hybrid** approach:

1. **Curated core (~30-40 models)**
   - Hand-maintained metadata (`specialty`, concise alias, UX copy, safe defaults).
   - Used by `/use`, `/help`, onboarding prompts.
2. **Dynamic long-tail (~all active OpenRouter models)**
   - Auto-synced to R2 on a schedule.
   - Searchable, selectable, but not shown in default shortlist.
3. **Compatibility layer**
   - Alias redirects and deprecation maps to avoid breaking existing user preferences.

## 3) Sync Pipeline

### Source endpoints

- OpenRouter model listing: `GET https://openrouter.ai/api/v1/models`
- Optional enrichment per provider (if available in your account tier): provider-native model-list APIs.

### Worker Cron cadence

- **Every 6 hours** for OpenRouter full catalog refresh.
- **Daily** for curated ranking recalculation + deprecation sweep.
- **On-demand** `/syncmodels all` admin command for manual repair.

### Storage objects in R2

- `models/openrouter/raw-YYYYMMDDHH.json` (snapshot)
- `models/openrouter/current.json` (normalized full list)
- `models/openrouter/curated.json` (top shortlist)
- `models/openrouter/deprecations.json` (redirects + tombstones)

## 4) Field Mapping (OpenRouter -> ModelInfo)

Normalize OpenRouter records into your `ModelInfo` shape:

- `id` <- `data[i].id`
- `name` <- `data[i].name`
- `maxContext` <- `data[i].context_length`
- `cost` <- formatted from `pricing.prompt` + `pricing.completion`
- `supportsVision` <- `architecture.modality` contains image input
- `supportsTools` <- true if `supported_parameters` contains tool/function keys OR capability override table marks true
- `reasoning` <-
  - `configurable` if supported parameters expose reasoning controls (`reasoning`, `reasoning_effort`, etc.)
  - `fixed` if model family is known reasoning-first but lacks controls
  - `none` otherwise
- `structuredOutput` <- true if `supported_parameters` contains `response_format`/`json_schema` OR override table marks true
- `isImageGen` <- modality/output indicates image generation model
- `isFree` <- prompt + completion pricing both zero
- `provider` <- `openrouter` (dynamic catalog); direct-api entries remain static/managed separately

## 5) Capability Detection (robust against inconsistent metadata)

Use a 3-layer resolver:

1. **Explicit API signals** (`supported_parameters`, modality, pricing)
2. **Heuristic parser** (id/name regex families, e.g. `/(vision|vl|omni|image)/i`)
3. **Manual overrides** in versioned JSON:
   - `capability-overrides.json`
   - `alias-overrides.json`
   - `deprecation-overrides.json`

Always persist `detectionSource` for each flag (`api|heuristic|override`) to debug bad classifications.

## 6) Alias Generation

Deterministic algorithm:

1. Start with `id.split('/')[1]` if present, else full id.
2. Remove well-known suffix noise (`:free`, date tags, vendor rev tags).
3. Canonicalize separators to `-`, then collapse to short token.
4. If collision: append stable base36 hash (`-x3f`) rather than repeated `f`.
5. Reserve human-friendly aliases via `alias-overrides.json`.

Keep alias history map:

```json
{
  "oldAlias": "qwencoder",
  "newAlias": "qwen3-coder",
  "modelId": "qwen/qwen3-coder",
  "since": "2026-02-22"
}
```

## 7) Deprecation / Removal Handling

Lifecycle states:

- `active`: present in latest feed
- `stale`: missing for <14 days
- `deprecated`: missing >=14 days (hide from picker, keep redirect)
- `removed`: missing >=30 days and no active user bindings

When a bound model disappears:

1. Try alias redirect map.
2. Try same-family fallback (same provider + capability profile).
3. Fall back to `auto` and notify user once.

## 8) Curation Quality Strategy

Do **not** go fully dynamic for end-user UX.

Instead score all models and select top N per bucket:

`rank = qualityScore * 0.45 + reliabilityScore * 0.25 + latencyScore * 0.15 + costScore * 0.15`

Then enforce diversity constraints:

- min 5 coding
- min 5 reasoning
- min 8 general chat
- min 5 fast/cheap
- min 4 vision
- min 3 image-gen
- max 2 per provider-family in each bucket

## 9) Pricing Tier Classification

Suggested output tiers (per 1M input tokens):

- `free` = 0
- `budget` = (0, 1)
- `standard` = [1, 5)
- `pro` = [5, 15)
- `premium` = >=15

Store both raw prices and tier. Tier can drive `/use` recommendations.

## 10) Direct APIs: practical handling

Treat direct providers as separate adapters with independent refresh jobs.

- **DeepSeek**: track reasoning + chat SKUs and token ceilings.
- **DashScope/Qwen**: track Qwen turbo/plus/max + coder/reasoning lines.
- **Moonshot/Kimi**: track Kimi fast/long-context/reasoning lines.

If provider listing endpoints are unavailable or unstable, maintain pinned manifests in R2 with manual review.

## 11) Implementation checklist

1. Extract current `/syncmodels` code into `src/openrouter/model-sync/` modules.
2. Add `normalizeOpenRouterModel(raw)` with typed output and detection-source metadata.
3. Add `capability-overrides.json` + `alias-overrides.json`.
4. Add cron handler for full refresh and curated refresh.
5. Add `/api/admin/models/status` and `/api/admin/models/refresh` endpoints.
6. Add tests for normalization, alias collisions, and deprecation transitions.

## 12) Known gotchas

- `supported_parameters` can be incomplete/wrong for tools and JSON-schema features.
- `:free` variants may disappear abruptly; avoid hard-coding availability assumptions.
- Model IDs can be renamed without clear alias continuity.
- Some models advertise tool calling but fail in practice; keep runtime success telemetry and auto-downgrade capability flags based on observed failures.
