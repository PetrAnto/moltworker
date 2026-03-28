# Claude Code Prompt: Sprint 0 — Workers AI Infrastructure

**Repo**: `PetrAnto/ai-hub`
**Branch**: `claude/coaching-s0-workers-ai`
**Base**: `main`
**Effort**: ~14.5h
**Tracking**: `claude-share/core/COACHING_FLYWHEEL_ROADMAP.md`

---

## Context

The Coaching module (knowledge flywheel) requires Workers AI embeddings (bge-m3) and text generation (granite-micro) running natively on Cloudflare. Neither is wired into ai-hub today. This sprint adds the infrastructure — it ships no user-facing features.

**Read these specs first:**
- `claude-share/brainstorming/wave6/workers-ai-native-provider-spec-v1.1.md` — §4 (ai-hub integration), §6 (embeddings), §8 (env vars), §13 (Layer 0)
- `claude-share/core/AI_CODE_STANDARDS.md`
- `claude-share/audits/BACKEND_AUDIT_2026-02-11.md` — for API route patterns

**Existing patterns to follow:**
- All API routes use `export const runtime = 'edge'`
- All routes follow auth → validate (Zod) → try/catch → log pattern
- Zod validation on ALL inputs (Phase 0 requirement)
- Drizzle ORM for all DB operations

---

## Step 0: Decision Gate — env.AI Spike (0.5h)

**Do this FIRST. If it fails, the REST API fallback pattern applies to ALL subsequent steps.**

1. Create `src/app/api/test-ai/route.ts`:

```typescript
export const runtime = 'edge';

export async function GET(request: Request) {
  // @ts-expect-error — env.AI may not exist in Pages Functions
  const env = (request as any).cf?.env || {};
  
  if (!env.AI) {
    return Response.json({ 
      binding: false, 
      message: 'env.AI not available in Pages Functions. Use REST API fallback.',
    });
  }
  
  try {
    const result = await env.AI.run('@cf/ibm-granite/granite-4.0-h-micro', {
      messages: [{ role: 'user', content: 'Say hello in exactly 3 words.' }],
      max_tokens: 10,
    });
    return Response.json({ binding: true, response: result.response });
  } catch (e) {
    return Response.json({ binding: false, error: String(e) });
  }
}
```

2. Deploy to staging: `npm run pages:deploy`
3. Hit the endpoint. Record result.
4. **If `binding: false`**: Every `env.AI.run()` call in this sprint MUST use the REST API fallback from the Workers AI spec §4.2. Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` to wrangler secrets.
5. Delete the test route after recording result.

---

## Step 1: wrangler.toml Bindings (0.25h)

Add to the existing `wrangler.toml` (ai-hub, NOT byok-cloud):

```toml
# Workers AI native binding
[ai]
binding = "AI"

# Vectorize index (PetrAnto creates index in CF Dashboard first)
[[vectorize]]
binding = "VECTORIZE"
index_name = "storia-knowledge"
```

**Note**: The Vectorize index must be created by PetrAnto in CF Dashboard before this binding works. Coordinate timing.

---

## Step 2: Workers AI Provider (1.5h)

Create `src/lib/providers/workers-ai.ts` — copy the implementation from Workers AI spec §4.2 verbatim. It has both native `env.AI.run()` and REST API fallback paths.

Key requirements:
- Type-safe: define `WorkersAIConfig`, `WorkersAIMessage`, `WorkersAIResponse` interfaces
- The function signature is `runWorkersAI(env: Env, config, messages)`
- Return `{ content, model, provider: 'workers-ai', usage: { inputTokens, outputTokens } }`
- Add the provider to the Env type in `src/types/env.ts` (or wherever Env is defined):
  ```typescript
  AI?: {
    run: (model: string, inputs: any) => Promise<any>;
  };
  VECTORIZE?: {
    query: (vector: number[], options: any) => Promise<any>;
    insert: (vectors: any[]) => Promise<any>;
  };
  ```

---

## Step 3: Neuron Estimator (1h)

Create `src/lib/providers/neuron-estimator.ts`:

```typescript
// Neuron costs per model (from Workers AI spec §3.1)
const NEURON_COSTS: Record<string, { perKInput: number; perKOutput: number }> = {
  '@cf/ibm-granite/granite-4.0-h-micro': { perKInput: 2, perKOutput: 10 },
  '@cf/baai/bge-m3': { perKInput: 1.075, perKOutput: 0 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { perKInput: 5, perKOutput: 30 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { perKInput: 27, perKOutput: 205 },
  // ... add all models from spec §3.1
};

const DAILY_FREE_LIMIT = 10_000;

export function estimateNeurons(model: string, inputTokens: number, outputTokens: number): number;
export async function logNeuronUsage(env: Env, model: string, neurons: number, operation: string): Promise<void>;
export async function getDailyNeuronUsage(env: Env): Promise<{ used: number; remaining: number }>;
```

---

## Step 4: Neuron Log D1 Migration (0.5h)

Create `drizzle/migrations/XXXX_workers_ai_neuron_log.sql` (use next migration number):

```sql
CREATE TABLE workers_ai_neuron_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  model TEXT NOT NULL,
  neurons_consumed INTEGER NOT NULL,
  operation TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_neuron_log_date ON workers_ai_neuron_log(created_at);
CREATE INDEX idx_neuron_log_daily ON workers_ai_neuron_log(
  substr(created_at, 1, 10)
);
```

Add corresponding Drizzle schema in `src/lib/schema.ts`. Add Zod validation schema.

---

## Step 5: Embedding Utility (1h)

Create `src/lib/providers/embedding.ts`:

```typescript
import { runWorkersAI } from './workers-ai';

export async function generateEmbedding(
  env: Env,
  text: string | string[]
): Promise<{ vectors: number[][]; model: string; neurons: number }> {
  const inputs = Array.isArray(text) ? text : [text];
  
  // Use bge-m3 — cheapest multilingual embeddings (1,075 neurons/1M tokens)
  const result = await env.AI.run('@cf/baai/bge-m3', {
    text: inputs,
  });
  
  // Log neuron usage
  const neurons = Math.ceil(inputs.join(' ').length / 4 * 1.075 / 1000);
  await logNeuronUsage(env, '@cf/baai/bge-m3', neurons, 'embedding');
  
  return {
    vectors: result.data,
    model: '@cf/baai/bge-m3',
    neurons,
  };
}
```

If `env.AI` spike failed, this function must use the REST API fallback to `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/baai/bge-m3`.

---

## Step 6: Semantic Search API (2h)

Create `src/app/api/search/semantic/route.ts`:

```typescript
export const runtime = 'edge';

// GET /api/search/semantic?q=typescript+error+handling&limit=5
// Returns vault entries + journal entries ranked by cosine similarity
```

- Auth required (reuse existing middleware pattern)
- Zod validate query params: `q` (string, 1-500), `limit` (number, 1-20, default 5), `type` (optional: 'vault' | 'journal' | 'all')
- Generate embedding for query text
- Query Vectorize with `filter: { userId: session.userId }`
- Return matched items with scores, titles, and metadata
- Log neuron usage

---

## Step 7: FreeModelRouter Integration (2h)

- Add Workers AI models to the FreeModelRouter config (see Workers AI spec §4.1 stack diagram)
- Workers AI is position 4 in the fallback chain (after Groq, OpenRouter, Cerebras)
- Add the provider path in `/api/llm-proxy/route.ts`
- Model selector UI: add an "Edge" badge for Workers AI models (Codex task)

---

## Key Files to Study Before Starting

| File | Why |
|------|-----|
| `src/app/api/llm-proxy/route.ts` | Existing LLM proxy — add Workers AI path here |
| `src/lib/schema.ts` | Add neuron log table schema |
| `src/lib/validations/*.ts` | Pattern for Zod schemas |
| `wrangler.toml` | Add AI + Vectorize bindings |
| `src/types/env.ts` or wherever Env type is defined | Add AI + VECTORIZE to Env |

---

## Acceptance Criteria

1. `npm run build` passes
2. `npm run test` passes (no regressions)
3. `npx tsc --noEmit` clean
4. `env.AI.run()` returns a response on staging (or REST fallback works)
5. `generateEmbedding()` produces vectors stored in Vectorize
6. Semantic search API returns relevant results
7. Neuron usage logged to D1
8. Daily neuron counter works (stays under 10K free tier)
9. Workers AI models appear in FreeModelRouter fallback chain
10. No new npm dependencies (Workers AI and Vectorize are native CF bindings)

---

## After Completion

1. Update `claude-share/core/COACHING_FLYWHEEL_ROADMAP.md` — mark Sprint 0 tasks ✅
2. Update `claude-share/core/GLOBAL_ROADMAP.md` — changelog entry
3. Update `claude-share/core/claude-log.md` — session log
4. Update `claude-share/core/PROMPT_READY.md` — point to Sprint 1 prompt
5. Record `env.AI` spike result in the roadmap Decision Gate table

---

*Next: Sprint 1 — Schema + Embeddings + Quality Gate*
*Prompt: `claude-share/codex-prompts/coaching/sprint-1-schema-embeddings.md`*
