# Full Audit + Build Improvement Plan

## Scope and Problem Statement

Primary pain points reported:

1. Complex coding tasks keep resuming on `/dcode`.
2. Multiple models are hallucinating and producing low-trust output.

This document audits current behavior and proposes a staged implementation plan to improve routing reliability, output quality, and build confidence.

## Current-State Audit (Evidence)

### 1) Model persistence + resume path can trap users on a weak model for hard tasks

- User model selection is persisted in R2 preferences and reused for new/resumed tasks. If the user ever selected `/dcode`, resume flows continue with that model unless manually changed. (`getUserModel()` and `setUserModel()`).
- `continue` uses the persisted `modelAlias` directly when creating a new DO task.
- Resume callback path also uses persisted `modelAlias`.

**Impact:** difficult tasks can repeatedly resume on a model that is not best for instruction following, causing a perceived “stuck on /dcode” loop.

### 2) Default model remains `auto`, which may vary provider behavior

- `DEFAULT_MODEL` is `auto` (OpenRouter auto-routing).

**Impact:** non-deterministic quality and tool behavior; harder to debug hallucinations across sessions.

### 3) Auto-resume UX messaging is stale/inconsistent with runtime limits

- Code currently limits free-model auto-resumes to 15.
- User-facing text in `/autoresume` still says 50x free.

**Impact:** users expect much longer retries than system actually does, creating trust and debugging confusion.

### 4) Guardrails exist but are mostly post-hoc (review prompts), not hard output constraints

- Task processor includes phase prompts and critical review checks.
- Tool/result fallback logic exists, but there is no strict “evidence required” response contract for coding answers.

**Impact:** models can still confidently synthesize non-verified claims when tool outputs are sparse/noisy.

### 5) Build/test pipeline is solid but lacks explicit quality gates for “hallucination-prone” regressions

- Scripts cover `test`, `typecheck`, `build`, lint/format.
- No targeted CI checks for model-routing behavior, resume-model policy, or response citation/evidence validation.

**Impact:** regressions in model selection and reliability can ship undetected.

## Root-Cause Summary

The “resumes on `/dcode`” issue is primarily a **policy gap** (resume model selection = persisted user model) rather than a raw runtime bug. Hallucination risk is primarily a **guardrail gap** (insufficient evidence enforcement + model routing policy + missing reliability tests).

## Build Improvement Plan

## Phase 1 — Stabilize model routing and resume behavior (high priority)

1. **Introduce a Task Router policy function** (single source of truth):
   - Inputs: user-selected model, task intent (coding/reasoning/general), tool requirement, checkpoint metadata.
   - Output: execution model alias + rationale string.
2. **Add “complex coding override” on resume:**
   - If resume is for coding task + previous run stalled/no-progress, route to stronger coding model (`/opus`, `/sonnet`, `/q3coder` depending on credentials/cost policy).
3. **Pin checkpoint metadata to model used at creation time** and expose in `/checkpoints` output.
4. **Add explicit `/resume <model>` override** so users can force model upgrade at resume time.
5. **Fix user-facing auto-resume text** to match runtime constants.

**Definition of done:** no automatic resume path silently reuses `/dcode` when policy says escalate.

## Phase 2 — Hallucination reduction guardrails (high priority)

1. **Evidence-Required Answer Mode (for coding tasks):**
   - Final answer must include “Evidence” block with tool outputs or file references.
   - If evidence missing, force model to answer with uncertainty + next tool action.
2. **Hard “No Fake Success” contract:**
   - If `github_create_pr` / `git` / test commands were not executed successfully, response must say “not completed”.
3. **Source-grounding prompt layer:**
   - Inject strict instruction: do not assert repo state unless observed from command/tool output in current session.
4. **Confidence labeling:**
   - Add `Confidence: High/Medium/Low` based on observed evidence count and recency.

**Definition of done:** model cannot return high-confidence completion claims without concrete session evidence.

## Phase 3 — Build/CI reliability gates (medium-high priority)

1. **Add policy unit tests** for Task Router:
   - resumes from `/dcode` + coding task + stall → escalates model.
   - paid vs free policy matrix.
2. **Add regression tests** for user messaging and constants parity (auto-resume limits).
3. **Add integration tests** for DO resume flows (`continue`, callback `resume:task`) validating selected model.
4. **Add CI pipeline stages:**
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
   - optional: coverage threshold for `src/durable-objects` and `src/telegram`.

**Definition of done:** routing and anti-hallucination behaviors are test-protected.

## Phase 4 — Operational observability (medium priority)

1. **Structured logs for model routing decisions:** selected model, reason, task category, auto-resume count.
2. **Metrics dashboard fields:**
   - hallucination proxy signals (toolless high-confidence responses, user corrections, retry rate)
   - model success/failure by task type.
3. **Admin/debug endpoint enhancement:** show last 10 routing decisions per user (redacted).

**Definition of done:** you can diagnose why `/dcode` (or any model) was selected within minutes.

## Phase 5 — UX controls and safer defaults (medium priority)

1. **“Smart mode” default for complex tasks** (router chooses best model).
2. **“Cost mode” and “Quality mode” user toggles** stored in preferences.
3. **Inline warnings when weak model is selected for complex coding task.**
4. **One-click “retry on stronger model” button** in Telegram.

**Definition of done:** users can easily escape weak-model loops without knowing internal aliases.

## Suggested Implementation Order (1 week sprint)

- **Day 1-2:** Phase 1 (router + resume policy + message fix)
- **Day 3-4:** Phase 2 (evidence contract + no-fake-success checks)
- **Day 5:** Phase 3 (tests + CI gates)
- **Day 6:** Phase 4 logging/metrics
- **Day 7:** Phase 5 UX polish

## Immediate Quick Wins (can ship first)

1. Fix `/autoresume` text to 15x free.
2. On resume, if current model is `/dcode` and last run had no progress, auto-suggest `/opus` or `/sonnet` with one-tap switch.
3. Add explicit warning in final responses: “Unverified claim” when no tool/file evidence exists.

## Success Metrics

Track weekly:

- Resume-loop rate (>=2 consecutive resumes with no new tools)
- “Wrong model for task” manual switches after failure
- User-reported hallucination incidents
- Task completion rate on first attempt
- PR/task false-success incidents (claimed done but not done)

Targets after rollout:

- 50% reduction in no-progress resume loops
- 40% reduction in hallucination complaints
- 25% increase in first-attempt completion on coding tasks

## Rollback and Safety

- Keep feature flags for:
  - router override policy
  - evidence-required mode
  - confidence labels
- If regression appears, disable feature flag and retain logs for postmortem.

## Notes for Follow-up

- If you want, next step can be implementation of **Phase 1 only** as an atomic PR: minimal risk, immediately addresses `/dcode` resume pain.
