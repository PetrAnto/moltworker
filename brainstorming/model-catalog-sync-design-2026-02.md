# Model Landscape + Full-Catalog Sync Design (Feb 2026)

## Scope

This note answers:
1. What to prioritize in the model landscape **right now** (based on this repo's curated catalog snapshot).
2. A concrete implementation plan to evolve `/syncmodels` from free-only to full-catalog sync with curation layers.

> Network-restricted environment note: this document is based on repository state and existing integration code, not a live OpenRouter fetch in this session.

---

## 1) Best-in-class models (from current curated catalog)

### Coding / Agentic coding
- **Top paid:** `opus` (Claude Opus 4.6), `grokcode`, `qwencoder`, `deep`, `kimidirect`.
- **Top value:** `deep`, `qwencoder`, `devstral2`.
- **Top free:** `qwencoderfree`, `gptoss`, `devstral2free`, `trinity`.

### Reasoning / Math
- **Top paid:** `opus`, `sonnet`, `geminipro`, `deepreason`, `qwenthink`.
- **Top free:** `deepfree`, `phi4reason`, `chimerafree`, `qwen235free`.

### General chat
- **Top paid:** `deep`, `gpt`, `sonnet`, `geminipro`, `kimi`.
- **Top free:** `deepchatfree`, `trinitymini`, `glmfree`, `maverick`.

### Fast / cheap
- **Paid low-cost:** `mini`, `devstral2`, `glm47`, `grok`.
- **Free fast:** `stepfree`, `deepchatfree`, `trinitymini`.

### Vision
- **Paid:** `gpt`, `geminipro`, `flash`, `kimi`, `haiku`, `sonnet`, `opus`.
- **Free:** `maverick`, `glmfree`.

### Image generation
- `fluxklein` (cheap), `fluxpro` (quality/value), `fluxflex` (text in image), `fluxmax` (highest quality).

---

## 2) Capability map (from current catalog metadata)

### Tool-calling (native)
Models with `supportsTools: true` should be considered first-class tool candidates. Examples: `gpt`, `sonnet`, `opus`, `deep`, `qwencoder`, `grok`, `geminipro`, `flash`, plus direct models `dcode`, `q3coder`, `kimidirect`.

### Structured output (JSON schema)
Currently flagged via `structuredOutput: true`: `gpt`, `geminipro`, `flash`, `deep`, `qwencoder`, `gptoss`, `mistrallarge`, `mini`, `dcode`, `q3coder`.

### Reasoning controls
- `reasoning: configurable` -> e.g. `deep`, `geminipro`, `flash`, `grok`, `dcode`.
- `reasoning: fixed` -> e.g. `phi4reason`, `qwenthink`, `grokcode`, `dreason`.

---

## 3) Pricing tiers (normalization for routing + UI)

Use a normalized USD-per-1M-token effective rate:
- Parse `cost` as input/completion pair when available.
- Compute weighted effective cost for ranking (default weight 70% input + 30% output).

Recommended bins:
- **free**: both input and output are zero or explicit FREE
- **ultra-cheap**: < $1 effective / 1M
- **budget**: $1–$5
- **standard**: $5–$15
- **premium**: > $15

Store bin in dynamic metadata for sorting and alias recommendations.

---

## 4) Full-catalog sync architecture (replace free-only)

## Endpoint usage
- Source: `GET https://openrouter.ai/api/v1/models`
- Existing fields consumed today: `id`, `name`, `description`, `context_length`, `architecture.modality`, `pricing.prompt`, `pricing.completion`, `supported_parameters`.

## New pipeline

1. **Fetch** all models.
2. **Normalize** raw model records into `NormalizedModel`.
3. **Infer capabilities** with deterministic heuristics (below).
4. **Score and classify** into tiers (`recommended`, `discoverable`, `hidden/deprecated`).
5. **Diff** with previous snapshot.
6. **Persist** snapshot + indexes in R2.
7. **Publish** to runtime cache with versioning.

## Suggested objects in R2
- `models/openrouter/latest.json`
- `models/openrouter/history/<ISO_TIMESTAMP>.json`
- `models/openrouter/index/recommended.json`
- `models/openrouter/index/aliases.json`
- `models/openrouter/tombstones.json`

## Proposed API surface in worker
- `POST /api/models/sync` (admin-auth only)
- `GET /api/models/catalog?tier=recommended|all&cap=tools,vision`
- `GET /api/models/changes?since=<timestamp>`
- `POST /api/models/alias/rebuild` (optional manual repair)

---

## 5) Capability detection strategy (robust against inconsistency)

Treat `supported_parameters` as a **signal**, not ground truth.

### tools
Set `supportsTools = true` if any true:
- `supported_parameters` includes `tools` or `tool_choice` or `functions`
- provider/model allowlist says tools known good

Set `supportsTools = false` if denylist says known-broken.

### vision
Set `supportsVision = true` if any true:
- `architecture.modality` includes image input (`image->text`, `text+image->text`, etc.)
- model id/name hints (`vision`, `vl`, `omni`) and not image-gen-only

### reasoning
- `configurable` if `supported_parameters` includes `reasoning` or reasoning-effort controls
- `fixed` if model family is known reasoning-first without exposed knob
- otherwise `none`

### structured output
Set `structuredOutput = true` if any true:
- `supported_parameters` includes `response_format` or `json_schema`
- provider/model allowlist for JSON-schema support

### image gen
`isImageGen = true` if modality is text->image / image generation families (`flux`, `sd`, `imagen`, etc.).

### confidence scoring
Attach `capabilityConfidence` per flag (`high|medium|low`) for explainability.

---

## 6) Alias generation (collision-safe + stable)

Current algorithm (strip provider/suffix, sanitize, append `f` on conflict) is good for quick UX but unstable at scale.

Use this scheme:
- Base slug from id tail: e.g. `google/gemini-3-flash-preview` -> `gemini3flash`
- If free model, optional short suffix `f` only when needed.
- On collision, append deterministic short hash from full id: `gemini3flash-a1c`.
- Persist permanent alias map (`aliases.json`) so future syncs never reassign existing aliases.
- Keep historical alias redirects for renamed models.

Rules:
- Never reuse old alias for different canonical model unless explicit migration.
- Max length 18 chars for command ergonomics.

---

## 7) Curation strategy: hybrid (recommended)

Do **not** go fully dynamic-only.

Adopt 3-layer catalog:
1. **Pinned curated (30-40)**: manually reviewed, stable aliases, default UI list.
2. **Auto-discovered (all)**: searchable/advanced picker, lower default rank.
3. **Hidden/deprecated**: excluded from default, still resolvable for grace period.

This preserves quality while keeping breadth.

---

## 8) Deprecation/removal handling

When model disappears or starts erroring:
1. Mark `status: deprecated` with `sunsetAt` + replacement hint.
2. Keep alias redirect for 14-30 days.
3. During grace period, auto-route to replacement and emit user-visible note once per chat.
4. Move to tombstone after grace period.

Track health with rolling error-rate checks on real traffic (or synthetic probe job).

---

## 9) Polling cadence (Cloudflare Cron)

Recommended:
- **Full sync** every 6 hours.
- **Light health check** hourly for recommended tier.
- **Manual forced sync** via admin endpoint.

Add jitter and ETag/If-None-Match caching if available.

---

## 10) Direct-provider parity (DeepSeek / DashScope / Moonshot)

Use provider adapters with unified output shape:

```ts
interface ProviderModelRecord {
  provider: 'openrouter' | 'deepseek' | 'dashscope' | 'moonshot';
  id: string;
  name: string;
  maxContext?: number;
  pricing?: { inputPerM?: number; outputPerM?: number };
  supportsTools?: boolean;
  supportsVision?: boolean;
  reasoning?: 'none' | 'fixed' | 'configurable';
  structuredOutput?: boolean;
  status: 'active' | 'deprecated';
}
```

If a provider does not expose complete model-list metadata, keep a **vendor-maintained static adapter file** with periodic verification checks.

---

## 11) Concrete migration steps from current `/syncmodels`

1. Extract existing OpenRouter fetch logic from Telegram handler into service module:
   - `src/openrouter/model-sync.ts`
2. Add schema types for raw API response + normalized record.
3. Extend from free-only filter to all models.
4. Add capability inference + confidence.
5. Add persistent alias map and tombstones in R2.
6. Add recommendation scorer (quality, cost, latency, reliability).
7. Expose admin APIs and keep `/syncmodels` as interactive front-end over same service.
8. Update `ModelInfo` with optional metadata fields:
   - `status`, `deprecatedAt`, `replacementAlias`, `capabilityConfidence`, `priceTier`, `lastSeenAt`.

---

## 12) Gotchas to account for

- `supported_parameters` can be stale/inaccurate.
- Free variants (`:free`) may disappear suddenly.
- Same base model can appear via multiple providers with different capabilities.
- Context length and pricing can change without alias change.
- Tool support can regress temporarily (keep denylist overrides).
- Image-gen models should be excluded from text model pickers.

