# Model Catalog + Sync Strategy (Feb 2026)

This document captures a concrete strategy for keeping the model catalog current across OpenRouter + direct providers while preserving a curated UX.

## 1) Current Landscape (how to keep it accurate weekly)

Because model releases and pricing move weekly, treat "best-in-class" as **computed**, not hard-coded.

### Category leaderboard logic

Compute category winners from fresh metadata + rolling quality signals:

- **Coding**: prioritize `supportsTools=true`, high context, strong coding benchmark notes, and low p95 latency.
- **Reasoning**: prioritize explicit reasoning-capable families (`r1`, `reasoning`, `think`) + quality score.
- **General chat**: prioritize quality/latency balance and stability (low error rate).
- **Fast/cheap**: lowest output cost + low latency + acceptable quality floor.
- **Vision**: `supportsVision=true`, then quality/latency.
- **Image generation**: `isImageGen=true`, then quality/cost.

Use a weighted score to rank:

```ts
score =
  qualityWeight * normalizedQuality +
  latencyWeight * normalizedLatency +
  costWeight * normalizedInverseCost +
  reliabilityWeight * normalizedSuccessRate
```

Store this score in a generated file (`models.generated.json`) and regenerate daily.

### Pricing tiers

Normalize all models into consistent buckets from parsed per-1M token prices:

- `free`
- `budget` (< $1/M)
- `value` ($1-$5/M)
- `mid` ($5-$15/M)
- `premium` (> $15/M)

Keep both `promptCostPerM` and `completionCostPerM` numerics. Keep existing display string separately.

### New releases in last 60-90 days

Track via first-seen timestamps:

- Persist `firstSeenAt` when model ID first appears.
- `isNew = now - firstSeenAt <= 90 days`.
- Surface in admin UI and `/syncmodels` diff summary.

## 2) OpenRouter full-sync design (all models, not only free)

## Endpoints

- Source: `GET https://openrouter.ai/api/v1/models`
- Optional detail fetches (if needed later): model-specific endpoint (when available), provider docs pages.

## Data model split

Use a **two-layer catalog**:

1. **Generated dynamic layer** (all models)
   - file key in R2: `catalog/openrouter/all-models.v{date}.json`
   - includes normalized metadata for every discovered model.
2. **Curated layer** (recommended 30-40)
   - repo file: `src/openrouter/models.ts`
   - hand-tuned aliases, descriptions, safe defaults.

At runtime:

1. Load curated layer.
2. Load dynamic layer from R2.
3. Merge (curated overrides dynamic on alias + copy text fields).
4. Expose:
   - `/models` default: curated only
   - `/models?all=1`: full merged catalog

This gives stable UX and full discovery without polluting the default picker.

## Field mapping (OpenRouter -> ModelInfo)

- `id` -> `id`
- generated short name -> `alias`
- `name` -> `name`
- parsed context length -> `maxContext`
- parsed pricing -> numeric fields + display `cost`
- modality flags -> `supportsVision`, `isImageGen`
- inferred params -> `supportsTools`, `structuredOutput`, `reasoning`
- provider routing source -> `provider: 'openrouter'`

Add internal fields for sync bookkeeping:

```ts
interface SyncedModelMeta {
  firstSeenAt: string;
  lastSeenAt: string;
  lastVerifiedAt: string;
  source: 'openrouter';
  rawSupportedParameters?: string[];
  rawArchitecture?: string;
  deprecationState?: 'active' | 'soft-deprecated' | 'removed';
}
```

## Capability detection (robust heuristics)

`supported_parameters` is useful but inconsistent. Use a confidence stack:

1. **High-confidence explicit flags**
   - tools: contains any of `tools`, `tool_choice`, `parallel_tool_calls`, `function_call`
   - structured output: contains any of `response_format`, `json_schema`, `json_object`, `structured_outputs`
   - reasoning configurable: contains `reasoning`, `reasoning_effort`, `thinking`
2. **Medium-confidence modality hints**
   - vision: modalities include image input OR model family suffix hints (`vision`, `vl`, `omni`) with allowlist checks
   - image gen: output modality image OR image model families (`flux`, `sdxl`, `imagen`, `recraft`)
3. **Low-confidence fallback**
   - known model family lookup table maintained in code (`capability-overrides.ts`).

Persist a `capabilityConfidence` map so you can review weak inferences.

## Alias generation (deterministic + collision-safe)

Current strategy is close; make it deterministic and reversible:

1. Base alias from model tail (drop provider prefix).
2. Normalize:
   - lowercase
   - remove punctuation and common suffix noise (`-instruct`, `-preview`, dates)
   - replace `:` with `-`
3. If collision:
   - append provider short code (`-or`, `-ds`, `-ms`, `-qw`)
4. If still collision:
   - append 4-char stable hash of full ID.

Store alias map in R2 so aliases remain stable across sync runs.

## Deprecation/removal lifecycle

Do not hard-delete immediately.

- Missing in fetch #1 -> mark `soft-deprecated` + `deprecatedAt`
- Missing for N consecutive syncs (recommended N=7 daily runs) -> mark `removed`
- Keep removed records for 30 days so old chats/configs resolve with helpful migration text.

Runtime behavior:

- If a removed model is requested, fallback to mapped successor and return warning metadata.

## Polling frequency (Cloudflare Cron)

Recommended:

- **Full sync**: every 6 hours (`0 */6 * * *`) for pricing/capability drift.
- **Leaderboard recompute**: daily.
- **Hotfix/manual trigger**: admin endpoint to force sync.

Add jitter in worker logic (`random 0-5 minutes`) to avoid synchronized spikes.

## 3) Direct provider sync (DeepSeek / DashScope / Moonshot)

Implement provider adapters with same normalized output shape.

```ts
interface ProviderAdapter {
  provider: 'openrouter' | 'deepseek' | 'dashscope' | 'moonshot';
  listModels(env: Env): Promise<RawModel[]>;
  normalize(raw: RawModel): NormalizedModel;
}
```

Practical notes:

- **DeepSeek**: OpenAI-compatible APIs typically provide a models list endpoint in many stacks, but treat availability/versioning as environment-dependent; keep manual overrides path.
- **DashScope/Qwen**: model families evolve quickly; maintain adapter mapping table for naming changes.
- **Moonshot/Kimi**: keep explicit context/reasoning overrides because capability docs can lag behind behavior.

Even if a provider has list APIs, keep a provider override file for:

- forced `supportsTools=false` when behavior is flaky,
- fixed temperature constraints,
- known context caps,
- temporary deprecations.

## 4) Quality curation strategy (recommended)

Use **hybrid curation**:

- Curated top 30-40 = default UX
- Dynamic long tail = searchable/advanced UI

Curation pipeline:

1. Auto-rank by objective signals (quality/cost/latency/reliability).
2. Apply hard safety filters (availability, error rate threshold).
3. Human-review shortlist weekly.
4. Publish curated set version (`curated-vYYYYMMDD`).

This keeps discoverability while preventing choice overload.

## 5) Concrete implementation plan in your codebase

1. Add `src/openrouter/model-sync/` modules:
   - `fetch-openrouter.ts`
   - `normalize.ts`
   - `capability-detect.ts`
   - `alias.ts`
   - `deprecations.ts`
   - `rank.ts`
2. Add R2 keys:
   - `catalog/openrouter/all-models.latest.json`
   - `catalog/openrouter/history/{timestamp}.json`
   - `catalog/openrouter/aliases.json`
3. Extend `/syncmodels` command:
   - modes: `--free-only` (legacy), `--all`, `--curated-refresh`
   - interactive diff grouped by added/changed/deprecated/removed
4. Add admin routes:
   - `GET /_admin/models/health`
   - `POST /_admin/models/sync`
   - `GET /_admin/models/diff?from=...&to=...`
5. Add tests:
   - fixture-based normalization tests
   - capability inference tests with inconsistent `supported_parameters`
   - alias collision determinism tests
   - deprecation lifecycle tests

## 6) Gotchas to explicitly handle

- Price units mismatch (token vs 1K vs 1M): normalize before bucketting.
- Missing/empty `supported_parameters`: never assume false; mark `unknown` + fallback heuristics.
- Context length inflation in marketing names: trust numeric metadata first.
- "Free" models that silently become paid: detect by price diff and notify.
- Same base model with multiple quantizations/suffixes: collapse in UI but preserve raw IDs.

## 7) Operational alerting

Emit alerts when:

- curated model disappears,
- price change >30%,
- capability regression (`supportsTools true -> false`),
- top-category winner changes.

Send to logs + optional Telegram admin notification.
