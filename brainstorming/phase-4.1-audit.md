# Phase 4.1 Audit — Token-Budgeted Context Retrieval

## Summary of findings

### ✅ Improvements made

1. **Reduced incorrect tool pairing on malformed histories**
   - `buildToolPairings()` previously fell back to the most recent assistant for *any* unmatched `tool_call_id`.
   - This could incorrectly bind a real tool result to the wrong assistant/tool call chain.
   - Fix: fallback now applies **only** when `tool_call_id` is missing (truly malformed tool message), not when an unknown ID is present.

2. **Strengthened pairing closure during greedy keep selection**
   - The greedy phase already added direct pair links, but this could miss transitive closure in malformed/duplicate-id histories.
   - Fix: added `expandPairedSet()` to recursively include all paired messages for both always-keep and additional keep sets.
   - Result: lower risk of invalid sequences under edge-case histories.

3. **More conservative image token estimate**
   - Increased image part estimate from 300 → **425** tokens.
   - Rationale: 300 underestimates medium/high image contexts too often for multi-image inputs.

4. **Slightly more conservative JSON estimation**
   - Added an additional heuristic bump for JSON-like payloads (`{"...": ...}` patterns).
   - This narrows underestimation risk for tool result payloads and structured outputs.

5. **Model-aware context budgets in TaskProcessor integration**
   - Compression budget is now derived from `getModel(alias)?.maxContext` with safety headroom (75%).
   - Retains fallback budget when metadata is missing.
   - Replaced fixed `MAX_CONTEXT_TOKENS` threshold checks with per-model budget checks.

### ⚠️ Remaining limitations (known)

1. **Estimator is still heuristic-based**
   - Better than raw chars/4, but still approximate.
   - For heterogeneous content (code + JSON + natural language + vision), variance remains non-trivial.

2. **Very small budgets can still exceed target in mandatory-set scenarios**
   - If the always-keep set is itself huge, algorithm keeps a valid conversation subset rather than dropping foundational context.
   - This is intentional graceful degradation, but strict budget adherence is not guaranteed in pathological inputs.

3. **Priority scoring remains simple**
   - Position bias is still meaningful and can out-rank some older but semantically critical snippets.
   - The current logic is acceptable for Phase 4.1 but should evolve (see Phase 4.2 recommendations).

## Token estimation accuracy analysis (cl100k_base)

I attempted to benchmark against a local tokenizer implementation (`tiktoken` / `js-tiktoken`), but package installation is blocked in this environment (registry/proxy 403), so true runtime cl100k counts could not be generated programmatically here.

The table below includes:
- **Current estimator outputs** (measured from code)
- **Target expectation notes** for cl100k behavior

| Sample type | Sample | Estimated tokens |
|---|---|---:|
| English prose | `The quick brown fox jumps over the lazy dog...` | 22 |
| TypeScript code | `function add(a: number, b: number)...` | 22 |
| JSON tool result | `{"status":"ok","items":[...],"elapsed_ms":42}` | 37 |
| Mixed content | `I inspected src/index.ts and found this block: if (!token)...` | 24 |
| Numbered reasoning text | `1) Gather data\n2) Validate assumptions...` | 20 |

### Interim assessment

- The estimator appears directionally correct and intentionally conservative for code/JSON.
- Without direct cl100k counts in this environment, exact percentage error cannot be truthfully reported.
- Recommendation: rerun this table in CI/dev with `js-tiktoken` and record absolute/relative error bands.

## Edge-case audit results

All requested scenarios are now covered with tests:

- Conversation with 0 tool calls (pure chat) ✅
- Conversation with 100+ tool calls (stress) ✅
- `ContentPart[]` vision messages with `image_url` ✅
- `reasoning_content` messages ✅
- Budget smaller than always-keep set ✅
- Single message conversation ✅
- All messages are tool results (malformed) ✅
- Tool pairing robustness: missing IDs, duplicate IDs, unknown IDs ✅

## Production readiness assessment

**Verdict: mostly production-ready for heuristic phase (Phase 4.1), with caveats.**

- Correctness and edge-case resilience are materially improved.
- Integration now respects model-specific context windows.
- Main remaining risk is heuristic estimation drift vs true tokenizer behavior.

If strict context-bound guarantees are required for high-cost models, this still needs Phase 4.2.

## Recommendations for Phase 4.2

1. **Adopt real tokenizer path (`js-tiktoken`)**
   - Validate Cloudflare Worker compatibility (bundle size + WASM/runtime constraints).
   - Use lazy init + memoized encoder.

2. **Dual-mode estimation strategy**
   - Fast heuristic first pass for candidate ranking.
   - Exact tokenizer pass only for final keep set and summary insertion.

3. **Add tokenizer regression tests**
   - Snapshot token counts for prose/code/JSON/vision/mixed payloads.
   - Set acceptable error thresholds when fallback heuristic is used.

4. **Make scoring policy configurable**
   - Add weighted knobs for role, recency, and tool evidence importance.
   - Optionally boost messages referenced by later assistant outputs.

5. **Telemetry hooks**
   - Record estimated vs provider-reported prompt tokens when available.
   - Feed this data into automatic heuristic recalibration.
