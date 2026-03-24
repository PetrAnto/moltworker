# Gecko Specialist Skills — Architecture Spec v1.2

> **Date**: March 24, 2026
> **Author**: PetrAnto + Claude Opus (synthesis) + GPT (repo review) + Gemini (tactical review) + Grok (implementation audit)
> **Status**: FINAL — All 3 AI reviews incorporated, 8 implementation gaps closed
> **Supersedes**: `gecko-specialist-skills-spec-v1.md`, `gecko-specialist-skills-spec-v1.1.md`
> **Scope**: 3 new specialist skills for Moltworker bot + shared skill runtime extraction
> **Phase 0 status**: UNBLOCKED

---

## 0. Revision History

### v1.0 → v1.1 (GPT + Gemini)

- Hybrid skill model (SKILL.md for persona, TypeScript for runtime)
- Shared skill runtime as Phase 0 prerequisite
- Single-pass structured output for Lyra (no mandatory 2nd LLM call)
- Per-item R2 storage for Spark (not single JSON)
- Deterministic source packs for Nexus (not model-improvised)
- HITL gate and semantic cache for Nexus
- Deferred: Nexus watch mode, Spark automated mining
- Corrected: CPU constraint, repo boundary split

### v1.1 → v1.2 (Grok Implementation Audit — 8 Gaps Closed)

| Gap | Issue | Resolution |
|-----|-------|------------|
| 1. Prompt hot-reload lost | v1.1 hardcoded persona in `prompts.ts` → deploy required for tweaks | Persona strings in R2, fallback to bundled constants |
| 2. API auth contract undefined | `/api/skills/execute` exposed with no auth spec | `X-Storia-Secret` header + CF Service Binding preferred path |
| 3. Zod dependency violation | Zod adds runtime dep, violates "patterns yes, dependency no" | Rejected Zod. Native TS type guards + `assertValid()` helper |
| 4. DO implementation missing | `dispatchToDO` referenced but no DO class/binding specified | Extend existing `TaskProcessor` DO with `skillId` field |
| 5. Command routing unspecified | `resolveSubmode()` assumed but never defined | Explicit command-to-SkillRequest mapping table |
| 6. Error & retry policy absent | `SkillResult` had no error variant or retry config | Added `error` kind + per-skill retry policy |
| 7. OpenClaw compatibility gap | Hybrid runtime could collide with existing SKILL.md loader | Coexistence spec: generic loader untouched, specialists route via registry |
| 8. Container CPU reality | "300s" conflated billing limit with hard timeout | Clarified: billed-usage, no hard wall. DO for reliability, not CPU. |

---

## 1. Architectural Correction: The Hybrid Skill Model

### 1.1 The Problem With SKILL.md-Only

v1.0 assumed skills could be pure prompt engineering. Both GPT and Gemini independently rejected this.

**GPT's argument**: Orchestra itself proves it. The useful parts are in TypeScript — task scoring, runtime risk, roadmap parsing, validation, retries. SKILL.md provides personality and trigger hints, but the *behavior* is code.

**What SKILL.md IS good for:** persona voice, guardrails, trigger hints, examples, decision tree hints, temperature/model preferences.

**What SKILL.md CANNOT do alone:** stateful pipelines, structured storage, typed evidence graphs, transport renderers, HITL gates, retry logic, audit trails.

### 1.2 The Hybrid Model

```
┌─────────────────────────────────────────────────────────────┐
│                      SKILL = HYBRID                          │
│                                                              │
│  R2 Prompt Pack (hot-reload)     TypeScript (deploy-time)    │
│  ───────────────────────────    ──────────────────────────   │
│  • Gecko persona voice          • State machines             │
│  • Guardrails                   • Typed schemas (type guards)│
│  • Trigger hints                • Storage (R2/D1/KV)         │
│  • Examples + few-shot          • Tool allowlists            │
│  • Decision tree hints          • Transport renderers        │
│  • Temperature/model prefs      • HITL gates                 │
│                                 • Telemetry/analytics        │
│                                 • Error handling + retries   │
│                                 • Structured output parse    │
└─────────────────────────────────────────────────────────────┘
```

**Rule**: Personality shapes tone and framing, not data flow. Data flow is typed TypeScript.

### 1.3 Validation Approach: No Zod (Grok v1.2 Patch)

**Decision**: Zod is rejected for moltworker.

**Rationale**: "Patterns yes, dependency no" applies to any runtime package not already in the dependency tree. Moltworker currently has zero validation libraries. Adding Zod (~50KB) establishes a precedent that erodes the lean container philosophy.

**Alternative**: Native TS type guards + lightweight `assertValid()` helper, matching the Orchestra pattern of inline validation.

```typescript
// src/skills/validators.ts

export function assertValid<T>(data: unknown, guard: (d: unknown) => d is T): T {
  if (!guard(data)) {
    throw new Error(`Invalid skill output: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

// Example type guard for LyraArtifact
export function isLyraArtifact(d: unknown): d is LyraArtifact {
  if (!d || typeof d !== 'object') return false;
  const obj = d as Record<string, unknown>;
  return (
    typeof obj.audience === 'string' &&
    typeof obj.platform === 'string' &&
    typeof obj.hook === 'string' &&
    typeof obj.output === 'string' &&
    typeof obj.qualityScore === 'number' &&
    obj.qualityScore >= 1 && obj.qualityScore <= 5 &&
    Array.isArray(obj.selfCritique)
  );
}
```

**Impact on spec**: All `z.object()` / `z.string()` / `z.infer` references in this spec are replaced with TS interfaces + type guard functions. The schemas are documentation; the guards are runtime.

---

## 2. Prerequisite: Shared Skill Runtime

### 2.1 Why This Must Ship Before Any Skill

GPT's strongest point: if Lyra is built on ad-hoc Telegram handler code, it becomes another Orchestra-style exception. Then Spark duplicates the pattern. Then Nexus duplicates again. Three bespoke integrations instead of one shared contract.

### 2.2 The Skill Contract

```typescript
// src/skills/types.ts

export type SkillId = 'orchestra' | 'lyra' | 'spark' | 'nexus';
export type Transport = 'telegram' | 'discord' | 'slack' | 'web';

export interface SkillRequest {
  skill: SkillId;
  transport: Transport;
  userId: string;
  chatId?: number;
  input: string;
  command?: string;           // e.g., 'write', 'gauntlet', 'research'
  flags?: Record<string, string>; // e.g., { for: 'twitter', audience: 'devs' }
  context?: Record<string, unknown>;
}

export interface SkillResult<T = unknown> {
  kind: 'text' | 'draft' | 'dossier' | 'gauntlet' | 'digest'
      | 'source_plan' | 'capture_ack' | 'error';
  payload: T | null;
  error?: {
    code: string;      // e.g., 'SOURCE_FETCH_FAILED', 'LLM_TIMEOUT'
    message: string;
    retryable: boolean;
  };
  telemetry: {
    modelAlias: string;
    durationMs?: number;
    toolsUsed?: string[];
    tokenCost?: number;
  };
}
```

### 2.3 Command-to-SkillRequest Mapping Table (Grok v1.2 Patch)

This is the explicit bridge between Telegram commands and the skill runtime. Without it, Phase 0 stalls.

```typescript
// src/skills/command-map.ts

export const COMMAND_SKILL_MAP: Record<string, { skill: SkillId; command: string }> = {
  // Lyra (Crex — Creator)
  '/write':     { skill: 'lyra',  command: 'write' },
  '/rewrite':   { skill: 'lyra',  command: 'rewrite' },
  '/headline':  { skill: 'lyra',  command: 'headline' },
  '/repurpose': { skill: 'lyra',  command: 'repurpose' },

  // Spark (Tach — Chat/Brainstorm)
  '/save':       { skill: 'spark', command: 'save' },
  '/bookmark':   { skill: 'spark', command: 'save' },
  '/spark':      { skill: 'spark', command: 'spark' },
  '/gauntlet':   { skill: 'spark', command: 'gauntlet' },
  '/brainstorm': { skill: 'spark', command: 'brainstorm' },
  '/ideas':      { skill: 'spark', command: 'brainstorm' },

  // Nexus (Omni — Monitor/Research)
  '/research':   { skill: 'nexus', command: 'research' },
  '/dossier':    { skill: 'nexus', command: 'research' },

  // Orchestra (Edoc — Code) — existing, refactored
  '/code':       { skill: 'orchestra', command: 'code' },
  '/orch':       { skill: 'orchestra', command: 'orch' },
};

// Flag parser: "--for twitter --audience devs" → { for: 'twitter', audience: 'devs' }
export function parseFlags(input: string): { cleanInput: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const cleanInput = input.replace(/--(\w+)\s+(\S+)/g, (_, key, val) => {
    flags[key] = val;
    return '';
  }).trim();
  return { cleanInput, flags };
}
```

### 2.4 The Skill Registry

```typescript
// src/skills/registry.ts

import { handleOrchestra } from './orchestra/orchestra';
import { handleLyra } from './lyra/lyra';
import { handleSpark } from './spark/spark';
import { handleNexus } from './nexus/nexus';
import type { SkillId, SkillRequest, SkillResult } from './types';

type SkillHandler = (req: SkillRequest, env: MoltbotEnv) => Promise<SkillResult>;

export const skillRegistry: Record<SkillId, SkillHandler> = {
  orchestra: handleOrchestra,
  lyra: handleLyra,
  spark: handleSpark,
  nexus: handleNexus,
};
```

### 2.5 The Runtime (With Hot-Reload + Error Handling)

```typescript
// src/skills/runtime.ts

import { skillRegistry } from './registry';
import type { SkillRequest, SkillResult } from './types';

// Grok v1.2: Prompt hot-reload from R2
async function loadPromptPack(skillId: string, env: MoltbotEnv): Promise<string | null> {
  try {
    const obj = await env.R2_BUCKET.get(`prompts/${skillId}/system.md`);
    return obj ? await obj.text() : null;
  } catch {
    return null; // Fall back to bundled prompts.ts constants
  }
}

// Grok v1.2: Retry policy per skill
const RETRY_POLICY: Record<string, { maxRetries: number; backoffMs: number }> = {
  nexus:     { maxRetries: 2, backoffMs: 2000 },  // Source failures are transient
  orchestra: { maxRetries: 1, backoffMs: 1000 },  // GitHub API can hiccup
  lyra:      { maxRetries: 0, backoffMs: 0 },      // Generation failures surface immediately
  spark:     { maxRetries: 0, backoffMs: 0 },      // Same — no auto-retry
};

export async function runSkill(req: SkillRequest, env: MoltbotEnv): Promise<SkillResult> {
  const handler = skillRegistry[req.skill];
  if (!handler) {
    return {
      kind: 'error',
      payload: null,
      error: { code: 'UNKNOWN_SKILL', message: `No handler for: ${req.skill}`, retryable: false },
      telemetry: { modelAlias: 'none' },
    };
  }

  // Hot-load persona prompt from R2 (falls back to bundled constant)
  const hotPrompt = await loadPromptPack(req.skill, env);
  if (hotPrompt) {
    req.context = { ...req.context, hotPrompt };
  }

  const policy = RETRY_POLICY[req.skill] ?? { maxRetries: 0, backoffMs: 0 };
  let lastError: SkillResult | null = null;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, policy.backoffMs * attempt));
    }

    const startMs = Date.now();
    try {
      const result = await handler(req, env);
      result.telemetry.durationMs = Date.now() - startMs;

      if (result.kind === 'error' && result.error?.retryable && attempt < policy.maxRetries) {
        lastError = result;
        continue;
      }

      await logSkillExecution(req, result, env);
      return result;
    } catch (err) {
      lastError = {
        kind: 'error',
        payload: null,
        error: {
          code: 'SKILL_EXCEPTION',
          message: err instanceof Error ? err.message : String(err),
          retryable: attempt < policy.maxRetries,
        },
        telemetry: { modelAlias: 'unknown', durationMs: Date.now() - startMs },
      };
    }
  }

  // All retries exhausted
  await logSkillExecution(req, lastError!, env);
  return lastError!;
}
```

### 2.6 Transport Becomes Thin

After extraction, Telegram handler becomes:

```typescript
// In handler.ts — the ONLY skill-related code left here

import { COMMAND_SKILL_MAP, parseFlags } from '../skills/command-map';
import { runSkill } from '../skills/runtime';
import { renderForTelegram } from '../skills/renderers/telegram';

// Inside command handler:
const mapping = COMMAND_SKILL_MAP[command];
if (mapping) {
  const { cleanInput, flags } = parseFlags(rawInput);
  const req: SkillRequest = {
    skill: mapping.skill,
    transport: 'telegram',
    userId,
    chatId,
    input: cleanInput,
    command: mapping.command,
    flags,
  };
  const result = await runSkill(req, env);
  const text = renderForTelegram(result);
  await sendTelegramMessage(chatId, text, env);
  return;
}
```

No more skill logic in `handler.ts`. Ever. All future commands are entries in `COMMAND_SKILL_MAP`.

### 2.7 Transport-Specific Renderers

```typescript
// src/skills/renderers/telegram.ts
export function renderForTelegram(result: SkillResult): string {
  if (result.kind === 'error') {
    return `❌ ${result.error?.message ?? 'Unknown error'}`;
  }
  // Per-kind formatting...
}

// src/skills/renderers/web.ts (consumed by ai-hub via API)
export function renderForWeb(result: SkillResult): SkillWebResponse { ... }
```

### 2.8 Tool Allowlists Per Skill

```typescript
// src/skills/tool-policy.ts

export const SKILL_TOOL_ALLOWLIST: Record<SkillId, string[]> = {
  orchestra: ['github_read_file', 'github_list_files', 'github_api', 'github_create_pr',
              'fetch_url', 'browse_url', 'sandbox_exec'],
  lyra:      ['fetch_url'],
  spark:     ['fetch_url'],
  nexus:     ['fetch_url', 'browse_url', 'web_search'],
};
```

### 2.9 Prompt Hot-Reload (Grok v1.2 Patch)

Persona strings live in R2 for zero-downtime tweaks:

```
R2 bucket:
  prompts/lyra/system.md      ← Crex persona, platform decision trees
  prompts/spark/system.md     ← Tach persona, gauntlet stage prompts
  prompts/nexus/system.md     ← Omni persona, confidence labeling rules
  prompts/orchestra/system.md ← Edoc persona (existing)
```

**Loading**: `runtime.ts` hot-loads from R2 on every `runSkill()` call (see §2.5). Falls back to bundled `prompts.ts` constants if R2 read fails. This preserves the SKILL.md-style live editability that the hybrid model otherwise loses.

**Editing workflow**: Update the R2 file → next skill invocation picks it up. No deploy needed for persona/guardrail tuning.

### 2.10 File Structure (Updated)

```
src/skills/
  types.ts              # SkillRequest, SkillResult, SkillId, Transport
  validators.ts         # assertValid() + type guards (no Zod)
  command-map.ts        # Command → SkillRequest mapping + flag parser
  registry.ts           # Skill handler map
  runtime.ts            # runSkill() + hot-reload + retry policy
  tool-policy.ts        # Per-skill tool allowlists
  renderers/
    telegram.ts         # Telegram-specific output formatting
    web.ts              # Web/API response formatting

  orchestra/            # (existing, refactored to conform to contract)
    orchestra.ts
    prompts.ts          # Bundled fallback for Edoc persona
    types.ts            # TS interfaces + type guards

  lyra/
    lyra.ts             # Main handler (submode router)
    prompts.ts          # Bundled fallback for Crex persona
    types.ts            # LyraArtifact interface + type guard

  spark/
    spark.ts            # Main handler (submode router)
    capture.ts          # SparkCaptureService
    gauntlet.ts         # SparkGauntletService
    prompts.ts          # Bundled fallback for Tach persona
    types.ts            # SparkItem, SparkGauntlet interfaces + guards

  nexus/
    nexus.ts            # Main handler (submode router)
    source-packs.ts     # Deterministic source pack definitions
    evidence.ts         # EvidenceItem, NexusDossier interfaces + guards
    prompts.ts          # Bundled fallback for Omni persona
    types.ts            # Nexus-specific types

src/storage/
  spark.ts              # Per-item R2 CRUD for Spark inbox
  nexus.ts              # Dossier cache, source results
  lyra.ts               # Draft history (optional)
```

### 2.11 Effort Estimate: Shared Runtime Extraction (Revised)

| Component | Effort | Notes |
|-----------|--------|-------|
| `types.ts`, `validators.ts`, `command-map.ts` | 3h | Core contracts + type guards + mapping |
| `registry.ts`, `runtime.ts` (with hot-reload + retry) | 3h | Includes R2 prompt loading, error handling |
| `tool-policy.ts` | 1h | Allowlist config |
| `renderers/telegram.ts` | 3h | Extract from current handler.ts |
| `renderers/web.ts` | 2h | API response format for ai-hub |
| Refactor Orchestra to conform to SkillResult | 4h | Move existing code, don't rewrite |
| Refactor `handler.ts` to thin dispatcher | 3h | Implement command-map routing |
| Analytics hook integration | 2h | Reuse existing patterns |
| **Total** | **21h** | +3h from v1.1 for command-map, validators, hot-reload, retry |

---

## 3. Corrected Constraints (Grok v1.2 Patch — Full Replacement)

| Constraint | v1.0 (stale) | v1.1 (partially corrected) | v1.2 (actual) |
|-----------|-------------|---------------------------|---------------|
| CPU time | 30 seconds | 300 seconds | **Billed-usage** (standard-1 container, pay-per-ms, no hard wall) |
| Durable Objects | 100 iterations | 100 iterations | 100 iterations (confirmed) |
| Filesystem | None | R2 mount via s3fs | Container has s3fs filesystem; Worker isolate does not |
| R2 object size | 5GB | 5GB | 5GB (confirmed) |
| KV value size | 25MB | 25MB | 25MB (confirmed) |

**Decision impact (revised)**:
- There is no hard 300s CPU wall — `standard-1` is billed usage. However, long-running operations should still use Durable Objects for **reliability** (network timeouts, checkpointing, auto-resume), not CPU.
- **Lyra**: In-worker. Single LLM call, no multi-step orchestration.
- **Spark capture**: In-worker. Trivial R2 write.
- **Spark gauntlet**: In-worker for most ideas. DO only if the model needs extensive tool calls (rare for brainstorming).
- **Nexus full research**: **DO required** — parallel source fetches can have network timeouts, need checkpointing, and benefit from auto-resume on stalls.
- **Nexus quick**: In-worker (3 sources, bounded time).

---

## 4. Repo Boundary: Moltworker vs ai-hub

### 4.1 The Split

| Responsibility | Lives In | Rationale |
|---------------|---------|-----------|
| Skill registry, handlers, runtime | `moltworker` | Agent backend — transport-agnostic |
| State machines, schemas, storage | `moltworker` | Data layer stays with compute |
| Evidence models, source packs | `moltworker` | Research infrastructure |
| Command routing (Telegram/Discord) | `moltworker` | Bot transport |
| Prompt packs (gecko persona) — R2 | `moltworker` | Injected into LLM calls, hot-reloadable |
| Schedulers (cron, watch mode future) | `moltworker` | CF Cron Triggers |
| Transport-neutral result objects | `moltworker` | SkillResult is the API contract |
| CIS (Contextual Input System) | `ai-hub` | React UI layer |
| Entity cards, quick action chips | `ai-hub` | Frontend components |
| Dossier/gauntlet interactive renderers | `ai-hub` | Rich web visualization |
| Cockpit UX, module tabs | `ai-hub` | Next.js routes |

### 4.2 API Contract (Moltworker → ai-hub)

```typescript
POST /api/skills/execute
Body: SkillRequest
Response: SkillResult

GET /api/skills/spark/inbox?userId=xxx
Response: SparkItem[]

GET /api/skills/nexus/cache?topic=xxx
Response: NexusDossier | null
```

### 4.3 API Auth Contract (Grok v1.2 Patch)

All `/api/skills/*` endpoints require authentication:

**Preferred path**: CF Service Binding (ai-hub and moltworker share the same CF account). Service Bindings bypass public network — no header needed, implicit trust.

**HTTP fallback path** (for external clients or cross-account):
```
Header: X-Storia-Secret: ${env.STORIA_MOLTWORKER_SECRET}
```

This is the same shared secret already specified in the Dream Machine brief (`STORIA_MOLTWORKER_SECRET` env var).

**Enforcement**:
```typescript
// src/routes/api.ts — middleware for all /api/skills/* routes

function validateAuth(request: Request, env: MoltbotEnv): boolean {
  // Service Bindings bypass this check (no public request)
  const secret = request.headers.get('X-Storia-Secret');
  if (!secret || secret !== env.STORIA_MOLTWORKER_SECRET) {
    // Audit log: unauthorized attempt
    console.error(`AUTH_FAIL: ${request.url} from ${request.headers.get('CF-Connecting-IP')}`);
    return false; // → 403
  }
  return true;
}
```

**Multi-tenant safety**: `SkillRequest.userId` is validated against the authenticated session. A user cannot execute skills as another user.

### 4.4 DO Implementation for Nexus (Grok v1.2 Patch)

Nexus full research dispatches to Durable Objects for reliability. Rather than creating a new DO class, extend the existing `TaskProcessor` with a `skillId` field:

```typescript
// src/do/task-processor.ts (existing — add skill-aware dispatch)

interface SkillTaskRequest {
  type: 'skill';
  skillId: SkillId;
  skillRequest: SkillRequest;
  sourcePack: SourcePack;
  queryType: string;
}

// In TaskProcessor.fetch():
if (taskRequest.type === 'skill') {
  return await this.executeSkillTask(taskRequest);
}
```

**Wrangler binding** (confirm in `wrangler.jsonc`):
```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "TASK_PROCESSOR",
        "class_name": "TaskProcessor"
        // Already exists for Orchestra — Nexus reuses it
      }
    ]
  }
}
```

**DO ID pattern**: `env.TASK_PROCESSOR.idFromName('nexus-' + userId + '-' + Date.now())`

### 4.5 OpenClaw Coexistence (Grok v1.2 Patch)

The hybrid skill runtime operates **alongside** the existing OpenClaw SKILL.md loader, not replacing it.

**Current state**: OpenClaw loads generic skills from `/root/clawd/skills/` (in-container) and syncs from R2. These are community/generic skills that respond to intent matching.

**New state**: Specialist skills (Lyra/Spark/Nexus/Orchestra) are routed via the `COMMAND_SKILL_MAP` (§2.3) and bypass the generic loader entirely. They have explicit slash commands — there is no intent-matching ambiguity.

**Coexistence rule**: If a command matches `COMMAND_SKILL_MAP`, route to the skill registry. If not, fall through to the existing OpenClaw handler (generic skills, conversational mode, model routing). No collision because specialist skills use explicit `/commands` and generic skills use intent matching.

```
User message → Is it a /command in COMMAND_SKILL_MAP?
  YES → runSkill() via registry
  NO  → Existing OpenClaw handler (generic skills, conversation)
```

**Migration path for Orchestra**: Orchestra already lives outside the generic loader. Refactoring it to conform to `SkillResult` is a code reorganization, not a behavioral change.

---

## 5. Skill: 📖 Crex × Lyra (Content) — v1 MVP

### 5.1 What Ships in v1

| Feature | Status |
|---------|--------|
| `/write <topic>` | ✅ Ship |
| `/write <topic> --for <platform>` | ✅ Ship |
| `/write <topic> --audience <who>` | ✅ Ship |
| `/rewrite` (revise last output) | ✅ Ship |
| `/rewrite --shorter`, `--tone casual` | ✅ Ship |
| `/headline <topic>` (5 variants) | ✅ Ship |
| `/repurpose <url> --for <platform>` | ✅ Ship (single target) |
| `/repurpose <url> --all` | ❌ Deferred to v1.1 |
| Visual track (image prompts) | ❌ Deferred to v2 |
| Storyboard / thumbnail | ❌ Deferred to v2 |
| Mandatory 2nd LLM self-review | ❌ Rejected — single-pass structured output |

### 5.2 Implementation: Structured Editorial Transaction

Single-pass structured output with self-critique inline:

```typescript
// src/skills/lyra/types.ts

export interface LyraArtifact {
  audience: string;
  platform: 'twitter' | 'linkedin' | 'blog' | 'telegram' | 'discord' | 'newsletter';
  hook: string;
  arc: { setup: string; tension: string; resolution: string };
  selfCritique: string[];
  qualityScore: number;  // 1-5, self-assessed
  output: string;
  revisedOutput?: string;  // Only if qualityScore < 3
}

export function isLyraArtifact(d: unknown): d is LyraArtifact {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  return typeof o.audience === 'string'
    && typeof o.platform === 'string'
    && typeof o.hook === 'string'
    && typeof o.output === 'string'
    && typeof o.qualityScore === 'number'
    && o.qualityScore >= 1 && o.qualityScore <= 5
    && Array.isArray(o.selfCritique)
    && typeof o.arc === 'object' && o.arc !== null;
}
```

**Flow:**
1. Parse command → resolve audience + platform (from flags or ask user)
2. Build prompt: hot-loaded Crex persona (R2) + platform decision tree + output schema
3. Single LLM call → returns `LyraArtifact` as JSON
4. `assertValid(result, isLyraArtifact)` — runtime validation
5. If `qualityScore < 3`, run ONE revision pass (not mandatory)
6. Render for transport

**Latency**: In-worker. No DO needed.

### 5.3 Platform Decision Trees

Stored in R2 (`prompts/lyra/system.md`) for hot-reload. Bundled fallback in `prompts.ts`. Content unchanged from v1.1 — Crex persona + per-platform rules (Twitter: 5-7 tweets, hook-first; LinkedIn: ~1300 chars, professional insight; Blog: 800-2000 words, SEO-aware; Discord: ~500 chars, energetic; Telegram: ~2000 chars, conversational; Newsletter: 200-400 words, curiosity hook).

### 5.4 Effort Estimate

| Component | Effort | Notes |
|-----------|--------|-------|
| `lyra.ts` submode router | 2h | |
| `prompts.ts` bundled fallback + R2 prompt | 3h | |
| `types.ts` interfaces + type guards | 1h | |
| `executeWrite()` pipeline | 3h | |
| `executeRewrite()` + draft storage | 2h | |
| `executeHeadline()` | 1h | |
| `executeRepurpose()` (single target) | 3h | |
| Telegram renderer | 2h | |
| Testing | 3h | |
| **Total** | **20h** | |

---

## 6. Skill: 🎭 Tach × Spark (Brainstorm) — v1 MVP

### 6.1 What Ships in v1

| Feature | Status |
|---------|--------|
| `/save <idea or url>` | ✅ Ship |
| `/bookmark` (reply-to-message) | ✅ Ship |
| `/spark <idea>` (quick Tach reaction) | ✅ Ship |
| `/gauntlet <idea>` (6-stage stress test) | ✅ Ship |
| `/ideas` (list inbox) | ✅ Ship |
| `/brainstorm` (cluster + challenge inbox) | ✅ Ship (LLM clustering, <50 items) |
| Automated mining (X, Telegram stars, history) | ❌ All deferred |
| Kanban cockpit view | ❌ Deferred (ai-hub) |
| Vectorize clustering | ❌ Deferred to v2 |

### 6.2 Storage: Per-Item R2 Objects

```typescript
// src/storage/spark.ts

export interface SparkItem {
  id: string;
  userId: string;
  source: 'save' | 'bookmark' | 'cross_module';
  content: string;
  url?: string;
  urlSummary?: string;
  createdAt: string;
  tags?: string[];
  clusterId?: string;
  processed: boolean;
}

// R2 key: spark/{userId}/items/{timestamp}-{id}.json
// Manifest: spark/{userId}/manifest.json
```

### 6.3 Gauntlet: Typed Output

```typescript
// src/skills/spark/types.ts

export interface SparkGauntlet {
  idea: string;
  steelman: string;
  redTeam: string[];
  inversion: string[];
  precedents: Array<{ name: string; lesson: string }>;
  mvp: string;
  verdict: { score: number; primaryRisk: string; nextAction: string };
}

export function isSparkGauntlet(d: unknown): d is SparkGauntlet {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  return typeof o.idea === 'string'
    && typeof o.steelman === 'string'
    && Array.isArray(o.redTeam)
    && Array.isArray(o.inversion)
    && Array.isArray(o.precedents)
    && typeof o.mvp === 'string'
    && typeof o.verdict === 'object' && o.verdict !== null;
}
```

### 6.4 Internal Decomposition

Externally one skill ("Spark"), internally three services: `SparkCaptureService`, `SparkGauntletService`, `SparkBrainstormService`.

### 6.5 Effort Estimate

| Component | Effort | Notes |
|-----------|--------|-------|
| `spark.ts` submode router | 2h | |
| `capture.ts` (save, bookmark, list) | 3h | |
| `gauntlet.ts` (quick + full 6-stage) | 4h | |
| `prompts.ts` Tach persona + stage prompts | 3h | |
| `types.ts` interfaces + guards | 1h | |
| `src/storage/spark.ts` R2 CRUD + manifest | 3h | |
| Brainstorm clustering (LLM-driven) | 3h | |
| Telegram renderer | 2h | |
| Testing | 3h | |
| **Total** | **24h** | |

---

## 7. Skill: 🕸️ Omni × Nexus (Research) — v1 MVP

### 7.1 What Ships in v1

| Feature | Status |
|---------|--------|
| `/research <topic>` | ✅ Ship |
| `/research <topic> --quick` | ✅ Ship |
| `/research <topic> --decision` | ✅ Ship |
| `/dossier <entity>` (alias) | ✅ Ship |
| HITL gate (source plan approval) | ✅ Ship |
| Semantic cache (KV, 4h TTL) | ✅ Ship |
| Watch mode (`/watch`, `/brief`) | ❌ Deferred to v2 |
| Source health dashboard | ❌ Deferred |
| Interactive connections graph | ❌ Deferred (ai-hub) |
| Open-ended source selection | ❌ Rejected — deterministic packs |

### 7.2 Deterministic Source Packs

```typescript
// src/skills/nexus/source-packs.ts

export type SourcePackId = 'entity' | 'topic' | 'event' | 'market' | 'decision';

export interface SourcePack {
  id: SourcePackId;
  sources: SourceFetcher[];
  maxParallelFetches: number;
}

export const SOURCE_PACKS: Record<SourcePackId, SourcePack> = {
  entity:   { id: 'entity',   sources: [webSearch, wikipedia, hackerNews, redditJson, gdelt], maxParallelFetches: 5 },
  topic:    { id: 'topic',    sources: [webSearch, hackerNews, redditJson, arxiv, gdelt],     maxParallelFetches: 5 },
  event:    { id: 'event',    sources: [webSearch, gdelt, redditJson, reliefWeb],             maxParallelFetches: 4 },
  market:   { id: 'market',   sources: [coinGecko, yahooFinance, dexScreener, webSearch, redditJson], maxParallelFetches: 5 },
  decision: { id: 'decision', sources: [webSearch, hackerNews, redditJson, arxiv],            maxParallelFetches: 4 },
};
```

### 7.3 Evidence Model

```typescript
// src/skills/nexus/evidence.ts

export interface EvidenceItem {
  source: string;
  sourceTier: 1 | 2 | 3 | 4;
  claim: string;
  confidence: 'observed' | 'plausible' | 'unknown';
  url?: string;
  timestamp?: string;
  corroboratedBy?: string[];
}

export interface NexusDossier {
  topic: string;
  queryType: SourcePackId;
  generatedAt: string;
  sourcesQueried: number;
  sourcesReturned: number;
  overallConfidence: 'high' | 'medium' | 'low';
  executiveSummary: string;
  evidence: EvidenceItem[];
  connectionsMap: Array<{
    from: string; to: string; relationship: string;
    confidence: 'observed' | 'plausible' | 'unknown';
  }>;
  intelligenceGaps: Array<{
    source: string; reason: string; impact: 'critical' | 'degraded' | 'minimal';
  }>;
  recommendedNextSteps: string[];
}
```

### 7.4 HITL Gate + Semantic Cache + DO Dispatch

Source plan shown to user before fetch (skip for `--quick`). KV cache with 4h TTL for identical topics. Full research dispatched to existing `TaskProcessor` DO extended with `skillId` (§4.4).

### 7.5 Effort Estimate

| Component | Effort | Notes |
|-----------|--------|-------|
| `nexus.ts` router + HITL gate | 3h | |
| `source-packs.ts` + fetchers | 5h | Reuse Sit Mon modules |
| `evidence.ts` + `types.ts` | 2h | |
| `cache.ts` (KV semantic cache) | 1h | |
| Query classification | 2h | |
| Cross-reference + confidence + connections | 5h | |
| DO dispatch (extend TaskProcessor) | 3h | |
| Telegram renderer for dossier | 2h | |
| Testing | 3h | |
| **Total** | **26h** | |

---

## 8. Implementation Sequence

### 8.1 Ticket-by-Ticket Roadmap

```
Phase 0: Shared Skill Runtime (21h)
  T0.1  types.ts + validators.ts + command-map.ts        3h
  T0.2  registry.ts + runtime.ts (hot-reload + retry)    3h
  T0.3  tool-policy.ts                                   1h
  T0.4  renderers/telegram.ts                            3h
  T0.5  renderers/web.ts                                 2h
  T0.6  Refactor Orchestra to SkillResult contract       4h
  T0.7  Thin handler.ts (command-map routing)            3h
  T0.8  Analytics hook + auth middleware                  2h

Phase 1: Lyra (20h)
  T1.1  types.ts + prompts.ts + R2 prompt upload         4h
  T1.2  lyra.ts submode router                           2h
  T1.3  executeWrite() pipeline                          3h
  T1.4  executeRewrite() + draft storage                 2h
  T1.5  executeHeadline()                                1h
  T1.6  executeRepurpose() (single target)               3h
  T1.7  Telegram renderer for LyraArtifact               2h
  T1.8  Testing + goldens                                3h

Phase 2: Spark (24h)
  T2.1  types.ts + prompts.ts + R2 prompt upload         4h
  T2.2  spark.ts submode router                          2h
  T2.3  SparkCaptureService (save, bookmark, list)       3h
  T2.4  src/storage/spark.ts (R2 per-item CRUD)          3h
  T2.5  SparkGauntletService (quick + full 6-stage)      4h
  T2.6  SparkBrainstormService (LLM clustering)          3h
  T2.7  Telegram renderer                                2h
  T2.8  Testing + goldens                                3h

Phase 3: Nexus (26h)
  T3.1  types.ts + evidence.ts + prompts.ts              3h
  T3.2  source-packs.ts + fetcher modules                5h
  T3.3  nexus.ts router + HITL gate                      3h
  T3.4  cache.ts (KV semantic cache)                     1h
  T3.5  Query classification                             2h
  T3.6  Cross-reference + confidence + connections       5h
  T3.7  DO dispatch (extend TaskProcessor)               3h
  T3.8  Telegram renderer for dossier                    2h
  T3.9  Testing + goldens                                2h

TOTAL: 91h across 4 phases
```

### 8.2 What Ships When

| Phase | Duration | Deliverable |
|-------|---------|------------|
| Phase 0 | 1 week | Shared runtime. Command routing. Orchestra refactored. Auth middleware. Hot-reload working. |
| Phase 1 | 1 week | `/write`, `/rewrite`, `/headline`, `/repurpose` live. Crex persona active. |
| Phase 2 | 1.5 weeks | `/save`, `/bookmark`, `/spark`, `/gauntlet`, `/brainstorm`, `/ideas` live. Tach active. |
| Phase 3 | 1.5 weeks | `/research`, `/research --quick`, `/research --decision` live. Omni active. HITL gate. Cache. |

---

## 9. Resolved Decisions (Complete — All 3 Reviews)

| Decision | v1.0 | v1.1 | v1.2 Final | Source |
|----------|------|------|-----------|--------|
| Implementation model | SKILL.md only | Hybrid (SKILL.md + TS) | **Hybrid + R2 hot-reload** | GPT + Grok |
| Validation | Zod | Zod | **Native TS type guards** | Grok |
| Persona editing | N/A | Deploy required | **R2 hot-reload, bundled fallback** | Grok |
| API auth | N/A | Undefined | **X-Storia-Secret + Service Binding** | Grok |
| Error handling | N/A | No error kind | **`error` kind + per-skill retry** | Grok |
| DO for Nexus | Vague | "dispatchToDO" | **Extend existing TaskProcessor** | Grok |
| Command routing | Implicit | Implicit | **Explicit COMMAND_SKILL_MAP** | Grok |
| OpenClaw compat | N/A | N/A | **Coexistence: registry for specialist, loader for generic** | Grok |
| CPU constraint | 30s | 300s | **Billed-usage, no hard wall. DO for reliability.** | Grok |
| Ship order | Lyra→Spark→Nexus | Runtime→Lyra→Spark→Nexus | **Runtime→Lyra→Spark→Nexus** (confirmed) | All |
| Names | Lyra/Spark/Nexus | Confirmed + UI labels | **Confirmed** | All |
| Nexus watch mode | v1 | Deferred | **Deferred** | GPT + Gemini |
| Spark mining | v1 | Deferred | **Deferred** | GPT + Gemini |
| Lyra self-review | 2nd LLM call | Single-pass | **Single-pass** (confirmed) | GPT + Gemini |
| HITL gate (Nexus) | None | Added | **Confirmed** | Gemini |
| Semantic cache | None | Added (4h KV) | **Confirmed** | Gemini |
| Source packs | Model picks freely | Deterministic | **Deterministic** (confirmed) | Gemini |
| Gauntlet placement | In Spark | In Spark | **In Spark** (confirmed) | All |

---

## 10. v2 Backlog (Explicitly Deferred)

| Feature | Skill | Effort | Dependency |
|---------|-------|--------|------------|
| `/repurpose --all` | Lyra | 3h | None |
| Visual track (image prompts) | Lyra | 8h | Image model BYOK |
| Storyboard outlines | Lyra | 5h | None |
| X/Twitter bookmark ingestion | Spark | 6h | OAuth PKCE |
| Telegram starred mining | Spark | 3h | Bot API perms |
| Chat history mining | Spark | 4h | Context mgmt |
| Cross-module "save to ideas" | Spark | 2h | Runtime (Phase 0) |
| Kanban cockpit view | Spark | 4h | ai-hub CIS |
| Vectorize clustering | Spark | 5h | CF Vectorize |
| Watch mode | Nexus | 12h | Cron + delta engine |
| Interactive graph | Nexus | 6h | ai-hub D3 |
| Source health dashboard | Nexus | 3h | Sit Mon Phase 1 |
| Source expansion (15+) | Nexus | 8h | Sit Mon Phase 6 |

---

## 11. Per-Skill Eval Goldens

### Lyra
- Twitter thread: "BYOK vs subscription AI" → hook in tweet 1, arc, CTA in last tweet
- LinkedIn: technical decision post → insight opener, engagement question closer
- Repurpose: blog URL → Twitter thread restructures entirely (not just truncation)

### Spark
- Gauntlet: "prompt marketplace" → strong steelman, real risks in red team, testable MVP
- Quick `/spark` → 1-3 sentences, Tach voice (not generic)
- Brainstorm: 10 items → thematically coherent clusters with provocative names

### Nexus
- Entity: "Anthropic" → observed/plausible evidence mix, connections map, academic gap noted
- Decision: "Deno vs Bun" → balanced pros/cons, precedents, dependency map
- Quick: top 3 sources only, fast, no gap analysis

---

## Appendix: Cross-Skill Data Flow

```
CAPTURE (Spark /save)
    ↓ validated ideas
RESEARCH (Nexus /research)
    ↓ evidence + insights
CREATE (Lyra /write) or BUILD (Orchestra /code)
    ↓ outputs generate new ideas
FEEDBACK → CAPTURE (Spark inbox)
```

This is the Dream Machine pipeline (Wave 4 §1) made concrete. The shared skill runtime enables cross-skill piping in v2.

---

*End of spec v1.2. All reviewer gaps closed. Phase 0 unblocked. Ship.*
