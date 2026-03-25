# Gecko Skills — Implementation Roadmap

> **Source spec**: User-provided Gecko Skills Implementation Spec (2026-03-25)
> **Branch**: `claude/skills-runtime` (Phase 0), then per-skill branches
> **Build order**: Phase 0 → 1 → 2 → 3 (strictly sequential)

---

## Spec vs. Reality — Critical Gaps

These must be resolved during implementation. The spec makes assumptions that don't match the current codebase.

| Spec Assumes | Reality | Resolution |
|---|---|---|
| `env.R2_BUCKET` | Binding is `env.MOLTBOT_BUCKET` | Use `MOLTBOT_BUCKET` everywhere |
| `env.KV` (Nexus cache) | No KV binding in `MoltbotEnv` or `wrangler.toml` | Add KV namespace binding, or use R2 with TTL-check wrapper |
| `callLLM()` standalone function | Doesn't exist — LLM calls go through `OpenRouterClient.chat()` | Create `src/skills/llm.ts` — thin wrapper around `createOpenRouterClient()` |
| `selectModel()` standalone function | Doesn't exist — model resolution is in handler.ts | Extract into shared helper or pass model alias through `SkillRequest` |
| `fetchUrl()` importable | Internal to `tools.ts`, not exported for direct use | Export `fetchUrlContent()` from tools.ts or create skill-level fetch helper |
| Orchestra is a dir with `prompts.ts`, `types.ts` | Single file `src/orchestra/orchestra.ts` + test | Split during T0.6 refactor |
| `nanoid` import for Spark IDs | Not in deps — constraint says no new runtime deps | Inline simple ID generator using `crypto.randomUUID()` |
| `src/skills/` exists | Does not exist | Create from scratch |
| `src/storage/` exists | Does not exist — storage lives in `src/openrouter/storage.ts` | Create `src/storage/` for skill-specific CRUD |

---

## Phase 0 — Shared Skill Runtime

**Branch**: `claude/skills-runtime`
**Depends on**: Nothing (greenfield under `src/skills/`)
**Goal**: Skill registry, runtime, command routing, renderers — no skill logic yet.

### T0.1 — Core types + validators
- **Create** `src/skills/types.ts` — `SkillId`, `Transport`, `SkillRequest`, `SkillResult`, `SkillHandler`
- **Create** `src/skills/validators.ts` — `assertValid()` generic type-guard validator
- **Complexity**: Low — pure types, no imports from existing code
- **Note**: `SkillResult.telemetry` shape matches spec. `MoltbotEnv` import from `../types`

### T0.2 — Command map + flag parser
- **Create** `src/skills/command-map.ts` — `COMMAND_SKILL_MAP`, `parseFlags()`
- **Complexity**: Low — static map + regex
- **Test**: `command-map.test.ts` — verify all 14 command mappings + flag extraction

### T0.3 — LLM helper for skills
- **Create** `src/skills/llm.ts` — `callSkillLLM()` wrapping `OpenRouterClient`
- Accepts: system prompt, user prompt, model alias, response format, env
- Returns: raw string response
- Handles: model resolution via `getModelId()`, JSON mode via `response_format`
- Also export `selectSkillModel()` — returns alias based on request flags or default
- **Why**: Spec's `callLLM()` / `selectModel()` don't exist; every skill needs this

### T0.4 — Registry + runtime
- **Create** `src/skills/registry.ts` — skill handler map (initially only `orchestra`)
- **Create** `src/skills/runtime.ts` — `runSkill()` with:
  - R2 hot-prompt loading from `prompts/{skillId}/system.md`
  - Per-skill retry policy
  - Duration tracking in telemetry
  - Error wrapping
- **Note**: Uses `env.MOLTBOT_BUCKET` (not `R2_BUCKET`)

### T0.5 — Tool policy
- **Create** `src/skills/tool-policy.ts` — per-skill tool allowlists
- **Complexity**: Low — static config map

### T0.6 — Renderers
- **Create** `src/skills/renderers/telegram.ts` — `renderForTelegram(result)` per kind
- **Create** `src/skills/renderers/web.ts` — JSON envelope for ai-hub API
- **Complexity**: Medium — Telegram markdown formatting for each `SkillResult.kind`

### T0.7 — Orchestra refactor
- **Move** `src/orchestra/orchestra.ts` → `src/skills/orchestra/orchestra.ts`
- **Extract** types into `src/skills/orchestra/types.ts`
- **Extract** prompt builders into `src/skills/orchestra/prompts.ts`
- **Create** `handleOrchestra()` adapter that wraps existing logic → returns `SkillResult`
- **Update** imports in `src/telegram/handler.ts` and `src/durable-objects/task-processor.ts`
- **Move** test: `src/orchestra/orchestra.test.ts` → `src/skills/orchestra/orchestra.test.ts`
- **Complexity**: High — orchestra.ts is tightly coupled to handler.ts; must preserve all existing behavior
- **Risk**: Breaking existing `/orch` commands. Mitigate with test coverage first.

### T0.8 — Handler routing refactor
- **Edit** `src/telegram/handler.ts` — add early `COMMAND_SKILL_MAP` check before existing command dispatch
- Matched commands → `runSkill()` → `renderForTelegram()` → `sendMessage()`
- Non-matched commands → existing handler logic (unchanged)
- **Complexity**: Medium — handler.ts is ~5900 lines; need surgical insertion
- **Risk**: Must not break any existing commands. Only `/orch` goes through new path initially.

### T0.9 — API routes
- **Edit** `src/routes/api.ts` — add `/api/skills/execute` POST route
- Auth: `X-Storia-Secret` header check against `env.STORIA_MOLTWORKER_SECRET`
- **Complexity**: Low — follows existing route patterns

### T0.10 — Tests + typecheck
- **Run** `npm test` and `npm run typecheck`
- Fix any regressions from orchestra refactor
- Add tests for: `command-map.ts`, `runtime.ts` (mocked), `validators.ts`

---

## Phase 1 — Lyra (Crex — Content Creator)

**Branch**: `claude/skill-lyra`
**Depends on**: Phase 0 complete
**Goal**: `/write`, `/rewrite`, `/headline`, `/repurpose` commands

### S1 Contract (frozen before implementation)

| Decision | Choice |
|----------|--------|
| Result kinds | `draft`, `headlines`, `repurpose`, `error` |
| `/rewrite` storage | R2 mandatory — `lyra/{userId}/last-draft.json`. Returns error if no prior draft. |
| Self-review | Inline: single LLM call returns `{ content, quality }`. If quality < 3, automatic second call with revision instructions. No external review loop. |
| `/repurpose` URL fetch | Uses `executeSkillTool('lyra', ...)` with `fetch_url` tool. Policy-enforced via `skill-tools.ts`. |
| hotPrompt | Handler reads `request.context?.hotPrompt` for system prompt override from R2. Falls back to bundled `LYRA_SYSTEM_PROMPT`. |
| Subcommand parsing | Single-command skills (all Lyra commands) skip subcommand heuristic. `/write headline ideas` → text="headline ideas", NOT subcommand="headline". |
| Structured output | `callSkillLLM()` with `response_format: { type: 'json_object' }`. LyraArtifact parsed + validated via `isLyraArtifact` guard. |

### T1.1 — Types + prompts
- **Create** `src/skills/lyra/types.ts` — `LyraArtifact` interface + `isLyraArtifact` guard
- **Create** `src/skills/lyra/prompts.ts` — `LYRA_SYSTEM_PROMPT` bundled fallback
- **Complexity**: Low

### T1.2 — Lyra handler
- **Create** `src/skills/lyra/lyra.ts` — submode router + all 4 execute functions
- `executeWrite` — single LLM call → structured JSON → optional revision if quality < 3
- `executeRewrite` — load last draft from R2 → revise with instruction
- `executeHeadline` — 5 variants with commentary
- `executeRepurpose` — `executeSkillTool('lyra', fetch_url)` → adapt for target platform
- Uses `callSkillLLM()` from S0.3 + `executeSkillTool()` from S0 hardening
- **Complexity**: Medium — 4 submodes, JSON parsing, R2 read/write

### T1.3 — Storage
- **Create** `src/storage/lyra.ts` — draft persistence helpers
- R2 key pattern: `lyra/{userId}/last-draft.json`
- Uses `env.MOLTBOT_BUCKET`
- **Complexity**: Low

### T1.4 — Register + render
- **Update** `src/skills/init.ts` — add `registerSkill(LYRA_META, handleLyra)`
- Telegram renderer already handles `draft`/`headlines`/`repurpose` kinds with chunking
- **Complexity**: Low

### T1.5 — Tests
- Test all 4 submodes with mocked LLM responses
- Test `isLyraArtifact` guard with valid/invalid inputs
- Test flag parsing: `--for twitter`, `--audience devs`
- Test `/write headline ideas` does NOT get parsed as subcommand=headline
- Typecheck pass

---

## Phase 2 — Spark (Tach — Brainstorm + Ideas)

**Branch**: `claude/skill-spark`
**Depends on**: Phase 1 complete (or at minimum Phase 0)
**Goal**: `/save`, `/bookmark`, `/spark`, `/gauntlet`, `/brainstorm`, `/ideas`

### T2.1 — Types + prompts
- **Create** `src/skills/spark/types.ts` — `SparkItem`, `SparkGauntlet` + guards
- **Create** `src/skills/spark/prompts.ts` — `SPARK_QUICK_PROMPT`, `SPARK_GAUNTLET_PROMPT`
- **Complexity**: Low

### T2.2 — Storage
- **Create** `src/storage/spark.ts` — per-item R2 CRUD
- R2 key pattern: `spark/{userId}/items/{timestamp}-{id}.json`
- ID generation: `crypto.randomUUID()` (no nanoid dep)
- Uses `env.MOLTBOT_BUCKET`
- **Complexity**: Low-Medium — list + filter pattern over R2 objects

### T2.3 — Spark services
- **Create** `src/skills/spark/capture.ts` — save item + URL summary + list inbox
- **Create** `src/skills/spark/gauntlet.ts` — quick reaction + full 6-stage gauntlet
- **Create** `src/skills/spark/brainstorm.ts` — cluster + challenge all inbox items
- **Complexity**: Medium — gauntlet is a single structured LLM call; brainstorm clusters multiple items

### T2.4 — Spark handler
- **Create** `src/skills/spark/spark.ts` — submode router
- `/brainstorm` with no input → cluster. `/ideas` or `/brainstorm` with input → list inbox
- **Complexity**: Low — thin dispatch layer

### T2.5 — Register + render
- **Update** registry + telegram renderer for gauntlet + digest + capture_ack kinds
- **Complexity**: Low

### T2.6 — Tests
- Test save → list → gauntlet → brainstorm cycle
- Test empty inbox edge case
- Test URL extraction + summary fallback
- Typecheck pass

---

## Phase 3 — Nexus (Omni — Research)

**Branch**: `claude/skill-nexus`
**Depends on**: Phase 2 complete (or at minimum Phase 0)
**Goal**: `/research`, `/dossier` with full/quick/decision modes + HITL gate

### T3.1 — Resolve KV binding
- **Decision needed**: Add KV namespace to `wrangler.toml` + `MoltbotEnv`, or use R2 with TTL check
- If KV: add `NEXUS_KV: KVNamespace` binding, update `src/types.ts`
- If R2: store cache objects with `customMetadata.expiresAt`, check on read
- **Complexity**: Low (KV) or Medium (R2 TTL wrapper)
- **Recommendation**: KV is simpler and purpose-built for cache; prefer it

### T3.2 — Types + prompts
- **Create** `src/skills/nexus/types.ts` — `EvidenceItem`, `NexusDossier` + guards
- **Create** `src/skills/nexus/prompts.ts` — `NEXUS_SYSTEM_PROMPT`
- **Complexity**: Low

### T3.3 — Source packs
- **Create** `src/skills/nexus/source-packs.ts` — deterministic source selection
- Implement fetchers: `webSearch`, `wikipedia`, `hackerNews`, `redditJson`, `gdelt`, `arxiv`, `coinGecko`, `yahooFinance`, `dexScreener`, `reliefWeb`
- Each fetcher: fetch → extract text → return `{ data, url }`
- Reuse `web_search` tool internals where possible (Brave Search API)
- **Complexity**: High — 10 source fetchers, each with different API shapes
- **Risk**: External APIs may rate-limit or change. Build resilient with fallbacks.

### T3.4 — Cache
- **Create** `src/skills/nexus/cache.ts` — `getCachedDossier()`, `cacheDossier()`
- 4-hour TTL, normalized key
- **Complexity**: Low

### T3.5 — Evidence model
- **Create** `src/skills/nexus/evidence.ts` — evidence aggregation + confidence scoring helpers
- **Complexity**: Medium

### T3.6 — Nexus handler
- **Create** `src/skills/nexus/nexus.ts` — mode router (full/quick/decision)
- Query classification via fast LLM call → source pack selection
- Quick mode: top 3 sources in parallel → synthesize → cache
- Full mode: HITL gate (return `source_plan`) → user confirms → dispatch to DO
- Decision mode: always fresh, structured pros/cons/risks
- **Complexity**: High — HITL flow, DO dispatch, parallel fetching

### T3.7 — DO extension
- **Edit** `src/durable-objects/task-processor.ts` — add `type: 'skill'` task support
- When `taskRequest.type === 'skill'`: run source fetchers → synthesize → return `SkillResult`
- **Complexity**: Medium — surgical addition to existing DO logic

### T3.8 — Storage
- **Create** `src/storage/nexus.ts` — dossier cache helpers (thin wrapper if using KV)
- **Complexity**: Low

### T3.9 — Register + render
- **Update** registry + telegram renderer for dossier + source_plan kinds
- **Complexity**: Low

### T3.10 — Tests
- Test entity + topic + market + decision query classification
- Test cache hit/miss
- Test HITL gate flow (source_plan → approved re-request)
- Test quick mode parallel fetch with partial failures
- Typecheck pass

---

## Pre-Deployment Checklist

- [ ] Delete R2 bucket contents at Cloudflare dashboard (per spec constraint)
- [ ] Upload R2 prompt packs: `prompts/lyra/system.md`, `prompts/spark/system.md`, `prompts/nexus/system.md`, `prompts/orchestra/system.md`
- [ ] If KV chosen for Nexus: add namespace in `wrangler.toml`, run `wrangler deploy`
- [ ] Full test suite: `npm test`
- [ ] Typecheck: `npm run typecheck`
- [ ] Simulate key commands via `/simulate/command` endpoint
- [ ] Verify existing commands still work (regression check)

---

## Estimated File Count

| Phase | New Files | Modified Files |
|-------|-----------|----------------|
| Phase 0 | ~12 | 3 (handler.ts, api.ts, index.ts) |
| Phase 1 | 5 | 2 (registry.ts, telegram renderer) |
| Phase 2 | 7 | 2 (registry.ts, telegram renderer) |
| Phase 3 | 8 | 3 (registry.ts, telegram renderer, task-processor.ts) |
| **Total** | **~32** | **~10** |

---

## Dependency Graph

```
T0.1 (types) ──┬── T0.2 (command-map)
               ├── T0.3 (llm helper)
               ├── T0.5 (tool-policy)
               └── T0.6 (renderers)
T0.3 (llm) ────┬── T0.4 (registry + runtime)
               └── T0.7 (orchestra refactor)
T0.4 ───────────── T0.8 (handler routing)
T0.8 ───────────── T0.9 (API routes)
T0.9 ───────────── T0.10 (tests)

Phase 0 done ──┬── T1.* (Lyra)
               ├── T2.* (Spark) -- can start after T1 or in parallel if registry is ready
               └── T3.* (Nexus) -- depends on T3.1 KV decision
```
