# Task Execution Pipeline Audit (2026-03)

## Scope
Deep audit of the Durable Object task execution pipeline across five reliability areas:

1. Streaming reliability for all providers (OpenRouter, DeepSeek, Moonshot, DashScope)
2. Watchdog + auto-resume race conditions and threshold tuning
3. Remaining timeout leaks in `Promise.race` patterns
4. Error classification/recovery for provider-specific error formats
5. Context-window management between compressions

Primary runtime files audited:
- `src/durable-objects/task-processor.ts`
- `src/openrouter/client.ts`

## File map

- `src/openrouter/client.ts`
  - `parseSSEStream()` SSE parser and timeout handling
  - `chatCompletionStreamingWithTools()` OpenRouter streaming transport
- `src/durable-objects/task-processor.ts`
  - Provider routing and per-provider fetch loop
  - Watchdog alarm + auto-resume trigger path
  - Retry logic (400/402/429/503 and context compression)
  - Tool execution timeout paths

## Error history (pipeline-relevant)

Recent bug history shows recurring classes in this exact pipeline:
- SSE stream drops on slow providers (DeepSeek/Moonshot)
- Runaway or low-value auto-resumes
- Timeout tuning mismatches between long contexts and watchdog thresholds
- Context oversize/input validation failures on provider-specific validators

These align with historical entries tracked in roadmap/bug logs and are consistent with current retry/timeout branches.

## Findings and fixes delivered

### 1) Streaming reliability across 4 providers

**Finding:** direct-provider timeout scaling only multiplied idle timeout for Moonshot/DashScope and only in paid-mode. Free direct-provider traffic remained under-scaled despite similar first-token/inter-chunk delays.

**Fix:** apply provider multiplier to both free and paid paths, and tune DeepSeek multiplier to reduce false stream-idle timeouts on large contexts.

### 2) Watchdog + auto-resume race/threshold behavior

**Finding:** alarm auto-resume required `openrouterKey` even when the task was running on direct providers. That blocked valid auto-resume for DeepSeek/Moonshot/DashScope-only credentials.

**Fix:** gate alarm auto-resume on *any* provider key (OpenRouter or direct-provider key), while still reconstructing a valid request for resume.

### 3) Promise.race timeout leak

**Finding:** `parseSSEStream()` created per-read timeout timers inside `Promise.race` without cleanup. Completed reads left orphan timers alive until expiry.

**Fix:** `readWithTimeout()` now tracks timer IDs and clears timeout in `finally` for every read cycle.

### 4) Error classification and recovery

**Finding:** direct-provider non-2xx handling truncated raw response text and relied on brittle free-text regex over partially preserved payloads.

**Fix:** introduce `parseProviderError(response)` to normalize status/body/message extraction from provider JSON and non-JSON formats before classification/retry decisions.

### 5) Context-window management between compressions

**Finding:** 400 context-validation recovery retried only when message count decreased. Some compressions reduce token mass without reducing message count (e.g., in-place truncation), causing missed retries.

**Fix:** retry condition now accepts either message-count shrink **or** token-count shrink.

## Expected deliverables status

- [x] Bug fixes in pipeline runtime
- [x] Regression tests for timeout cleanup + direct-provider auto-resume path
- [x] Full test run and typecheck

## Validation commands used

- `npm test -- src/openrouter/client.test.ts src/durable-objects/task-processor-lifecycle.test.ts`
- `npm run typecheck`
- `npm test`
