# Codex Task: Phase 5.6 — Orchestra Mode Polish

## Goal

Fix gaps in orchestra mode: populate `durationMs` on completed/failed tasks, add `## Step` header parsing to roadmap parser, and wire `cleanupStaleTasks` into `/orch run` (not just `/orch history`). These are focused, self-contained fixes.

## Current State

- **Orchestra is fully implemented** in `src/orchestra/orchestra.ts` (1,431 lines) with tests in `orchestra.test.ts` (1,659 lines).
- **REDO mode type** — already in `OrchestraTask.mode: 'init' | 'run' | 'redo'`, stored correctly, tests exist.
- **Roadmap parsing** — already handles `###`, `##`, numbered lists, indented checkboxes, flat checklists.
- **Stale task cleanup** — `cleanupStaleTasks()` exists and is called from `/orch history`.
- **History formatting** — `formatOrchestraHistory()` already shows model, duration, PR link, REDO tag, summary.

## What's Actually Missing (3 focused fixes)

### Fix 1: Populate `durationMs` in stored OrchestraTask

**Bug:** `OrchestraTask.durationMs` is defined in the type (line 29) and rendered in `formatOrchestraHistory` (line 911), but **never populated** when storing tasks.

**File:** `src/durable-objects/task-processor.ts`

**Where to fix — completed tasks** (around line 4060):
```typescript
const completedTask: OrchestraTask = {
  taskId: task.taskId,
  timestamp: Date.now(),
  modelAlias: task.modelAlias,
  repo,
  mode: orchestraMode,
  prompt: prompt.substring(0, 200),
  branchName: orchestraResult.branch,
  prUrl: verifiedPrUrl,
  status: taskStatus,
  filesChanged: orchestraResult.files,
  summary: taskSummary,
  // ADD THIS:
  durationMs: Date.now() - task.startTime,
};
```

**Where to fix — failed tasks** (around line 904):
```typescript
const failedTask: OrchestraTask = {
  taskId: task.taskId,
  timestamp: Date.now(),
  modelAlias: task.modelAlias,
  repo,
  mode: orchestraMode,
  prompt: prompt.substring(0, 200),
  branchName: branch,
  status: 'failed',
  filesChanged: [],
  summary: `FAILED: ${failureReason}`,
  // ADD THIS:
  durationMs: Date.now() - task.startTime,
};
```

**Test:** Add tests in `src/orchestra/orchestra.test.ts` or `src/durable-objects/task-processor.test.ts` verifying that `durationMs` appears in stored tasks.

### Fix 2: Add `## Step N:` header parsing to roadmap parser

**Gap:** `parseRoadmapPhases()` handles `### Phase N:`, `## Phase/Step/Sprint N:`, but some AI-generated roadmaps use `## Step 1:` without the `Phase/Step/Sprint` prefix, or use `# Phase 1:` (single `#`). The `##` match requires `Phase|Step|Sprint` prefix but `###` does not — inconsistent.

**File:** `src/orchestra/orchestra.ts` — `parseRoadmapPhases()` (line 980)

**Current regex (line 988-989):**
```typescript
const phaseMatch = line.match(/^###\s+(?:Phase\s+\d+[:.—\-]\s*)?(.+)/i)
  || line.match(/^##\s+(?:Phase|Step|Sprint)\s+\d+[:.—\-]\s*(.+)/i);
```

**Change to also match:**
- `## Title` (any `##` header without requiring Phase/Step/Sprint prefix — same flexibility as `###`)
- `# Phase N: Title` (single `#` with Phase prefix — some generators use this)

Suggested new regex:
```typescript
const phaseMatch = line.match(/^###\s+(?:Phase\s+\d+[:.—\-]\s*)?(.+)/i)
  || line.match(/^##\s+(?:(?:Phase|Step|Sprint)\s+\d+[:.—\-]\s*)?(.+)/i)
  || line.match(/^#\s+(?:Phase|Step|Sprint)\s+\d+[:.—\-]\s*(.+)/i);
```

**Important:** Don't match `# Title` without Phase/Step prefix (too greedy — would match document title).

**Test:** Add test cases for:
1. `## Custom Header` (no Phase prefix) with tasks
2. `# Phase 1: Setup` with tasks
3. `# Step 1 — Build` with tasks
4. Mixed `#`, `##`, `###` headers in same document

### Fix 3: Wire `cleanupStaleTasks` into `/orch run` path

**Gap:** `cleanupStaleTasks()` only runs on `/orch history`. If a task is stuck as "started" and the user runs `/orch run`, the run proceeds without cleaning up the stale task first. The stale task stays in history as "started" until the user explicitly checks history.

**File:** `src/telegram/handler.ts`

**Where:** In the `executeOrchestra` method (around line 1906), before creating the new task, call `cleanupStaleTasks`:

```typescript
// At the start of executeOrchestra, before the rest of the logic:
if (this.r2Bucket) {
  await cleanupStaleTasks(this.r2Bucket, userId);
}
```

This ensures stale tasks are cleaned up whenever the user starts a new orchestra action, not just when viewing history.

**Test:** Add a test verifying that running `/orch run` after a stale task properly cleans it up.

## Key Files

| File | Change |
|------|--------|
| `src/durable-objects/task-processor.ts` | Add `durationMs: Date.now() - task.startTime` to both orchestra task stores |
| `src/orchestra/orchestra.ts` | Extend `parseRoadmapPhases` regex for `##` without prefix and `#` with prefix |
| `src/orchestra/orchestra.test.ts` | Add tests for new header formats and durationMs |
| `src/telegram/handler.ts` | Call `cleanupStaleTasks` at start of `executeOrchestra` |

## Validation

```bash
npm test -- --reporter=verbose 2>&1 | tail -20   # All tests
npm test -- src/orchestra/orchestra.test.ts       # Orchestra tests only
npm run typecheck                                  # Type check
```

## Definition of Done

- [ ] `durationMs` populated in both completed and failed OrchestraTask stores
- [ ] `parseRoadmapPhases` handles `## Header` (no prefix) and `# Phase N:`
- [ ] `cleanupStaleTasks` called in `executeOrchestra` before creating new tasks
- [ ] At least 6 new tests (2 per fix)
- [ ] All existing tests pass, typecheck clean
