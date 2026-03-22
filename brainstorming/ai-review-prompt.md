# Moltworker Architecture Review — Request for Opinions

You are reviewing the architecture of **Moltworker**, a multi-platform AI assistant gateway on Cloudflare Workers that orchestrates coding tasks across 26+ LLM models. The system has a **Telegram bot** that accepts `/orch next` commands to automatically pick the next task from a GitHub repo's roadmap, dispatch it to a **Durable Object (DO)** for long-running execution (with tool-calling loops up to 100 iterations), and create PRs when done.

We need opinions on **4 architectural decisions**. Each section includes the full technical context.

---

## System Architecture Summary

```
User → Telegram Bot → TelegramHandler → executeOrchestra()
  → Fetches ROADMAP.md from GitHub
  → Resolves next task (concreteness scoring 0–10, ambiguity classification)
  → Builds system prompt (tier: minimal/standard/full based on model capability)
  → Dispatches TaskRequest to Durable Object (TaskProcessor)
    → Tool-calling loop (max 100 iterations)
    → Tools: github_read_file, github_create_pr, github_api, fetch_url, web_search, sandbox_exec, browse_url
    → Checkpoints to R2 every 3 tool calls
    → Context compression every 6 tool calls
    → Watchdog alarm every 90s detects stalls → auto-resume
    → Health scoring at completion (green/yellow/red)
```

---

## Decision 1: Selective Sandbox for Simple Tasks

### Current State
- Sandbox (Cloudflare Browser Rendering container) is available when `env.Sandbox` is set
- `hasSandbox: !!this.sandbox` is passed to prompt builders
- When sandbox is available, the system prompt adds a "Step 3.5: VERIFY" section telling the model to clone, test, and verify before creating a PR
- The `sandbox_exec` tool is included in the tool set when sandbox capability is true
- Sandbox stalls are a known problem: output fingerprinting detects stagnation after ~45s of identical stdout/stderr, kills the process, marks `task.sandboxStalled = true`, and escalates health to YELLOW

### The Problem
Sandbox adds latency and can stall. For simple tasks (rename a variable, update a config value, add a comment), the verification step is overkill and risks stalling.

### Current Classification Infrastructure
There's already a task classifier (`src/utils/task-classifier.ts`) but it only does `simple | complex` based on keyword matching and is used to gate R2 reads, not sandbox decisions.

The orchestra has a **concreteness scorer** (0–10) for task titles:
- Positive: file paths (+3), backtick identifiers (+3), numbered steps (+2), domain nouns (+2)
- Negative: generic phrases like "Create the new file" (−4), short titles (−1)
- Ambiguity: `none` (≥5), `low` (≥3), `high` (<3)

There's also `/orch advise` which uses regex to detect heavy coding tasks:
```
isHeavyCoding = /refactor|split|migrat|rewrite|architect|complex|multi.?file|test suite/i
isSimple = /add comment|update readme|rename|typo|config|bump|version/i
```

### Options Under Consideration
1. **Task complexity classifier** — Use concreteness score + keyword analysis to skip sandbox for trivial tasks. Question: what thresholds? What about false negatives (skipping sandbox on a task that actually needed testing)?
2. **Model-based** — Weak models (free tier, <28 intelligence index) skip sandbox because they stall more often. But model capability ≠ task complexity.
3. **User flag** (`/orch next --no-sandbox`) — Explicit override. Low risk but requires user judgment.
4. **Hybrid** — Default sandbox ON for all tasks, but allow override + auto-skip for tasks matching `isSimple` regex.

### Questions
- What criteria would you use to decide "this task doesn't need sandbox verification"?
- Is it better to err on the side of always using sandbox (slower but safer) or to be aggressive about skipping it (faster but risk of broken PRs)?
- Should the model itself decide whether to use sandbox_exec, or should we remove the tool entirely for certain tasks?

---

## Decision 2: Orchestra Task Classification Gap

### Current State
When a user sends `/orch next`, the system:
1. Fetches ROADMAP.md from GitHub
2. Parses it into phases with `parseRoadmapPhases()`
3. Resolves next task with `resolveNextRoadmapTask()` — returns title, phase, concreteScore, ambiguity, executionBrief
4. Builds a system prompt with tier selection based on the **model's capability** (intelligence index)
5. Dispatches to DO

### The Problem
The **task classifier** (`src/utils/task-classifier.ts`) runs on the **user's message** (which is just `/orch next` — 10 characters), not on the resolved task content. So every orchestra task is classified as "simple" (short message, no keywords), which means:
- R2 learnings/session history are NOT loaded (gated behind `complex` classification)
- The model starts without institutional memory

Meanwhile, the orchestra has its OWN classification system (concreteness scoring, ambiguity detection, execution briefs) that doesn't feed back into the general task classifier.

### Relevant Code Flow
```
User sends: "/orch next"
  → handleOrchestraCommand() parses subcommand
  → executeOrchestra() called with mode='run'
    → Fetches roadmap, resolves task (resolvedTask, executionBrief)
    → Builds messages with system prompt
    → Creates TaskRequest
    → Dispatches to DO

Meanwhile, independently:
  → taskClassifier.classify("/orch next") → 'simple' (wrong!)
  → R2 learnings skipped
  → Session history skipped
```

### The Question
How should we fix this? Options:
1. **Override classification for orchestra tasks** — Always treat `/orch` commands as `complex`. Simple but imprecise.
2. **Classify the resolved task title** — Run `taskClassifier.classify(resolvedTask.title)` instead of the user message. More accurate but requires the classifier to run after task resolution.
3. **Use concreteness score** — Map `concreteScore ≥ 5` → complex, `< 5` → complex anyway (orchestra tasks are always complex). Redundant?
4. **Separate orchestra context injection** — Don't use the general classifier at all for orchestra. Always load learnings + history for orchestra tasks.

### Questions
- Is the general task classifier even relevant for orchestra tasks? Or should orchestra always bypass it?
- What additional context (learnings, session history) actually helps orchestra task execution?
- Should the two classification systems (general + orchestra) be unified?

---

## Decision 3: Resume Frequency and Watchdog Thresholds

### Current State
The Durable Object watchdog system:

| Parameter | Value | Notes |
|-----------|-------|-------|
| Watchdog interval | 90s | Alarm fires every 90s |
| Stuck threshold (free) | 150s | Time since last heartbeat |
| Stuck threshold (paid) | 240s | Time since last heartbeat |
| Orphaned threshold (free) | 120s | When `isRunning=false` (DO evicted) |
| Orphaned threshold (paid) | 180s | When `isRunning=false` (DO evicted) |
| Max auto-resumes (default) | 10 | Raised from 5 for complex tasks |
| Max auto-resumes (free) | 5 | Conservative |
| Max auto-resumes (orchestra) | 6 | Tighter than general |
| No-progress abort | 3 consecutive | Fail if 3 resumes with no new unique tool calls |
| Orchestra stall check | 3+ resumes, no PR | Specific "read loop" detection |

### How It Works
1. Watchdog alarm fires every 90s
2. Checks `isRunning` (in-memory flag — is processTask() active?)
3. Checks heartbeat timestamps (in-memory + storage)
4. If `isRunning=false` AND time since last activity exceeds threshold → task is stuck
5. If stuck: check auto-resume eligibility (under limit, has API keys, not stalled)
6. Stall detection: compare tool signatures before/after resume (dedup detection)
7. After compression, allow ONE set of duplicate reads (model legitimately needs to re-read)
8. Resume: restore original messages, inject resume notice, restart processTask()

### The User's Question
> "Are you sure this really affects reliability or did we build that just to make sure the weak pipeline algo was anyway able to complete?"

### The Context
The watchdog was originally designed when:
- Models were weaker and stalled more often
- The tool-calling loop had no stall detection
- There was no health scoring or sandbox stall detection
- DO eviction was more common before optimizations

Now we have:
- Sandbox stall detection (fingerprinting, ~45s kill)
- No-progress detection (3 consecutive resumes)
- Orchestra-specific stall detection (3+ resumes, no PR)
- Health scoring (green/yellow/red with issue tracking)
- Run health footer in Telegram messages

### Actual Numbers
- Paid models: 240s stuck threshold = ~4 minutes before resume trigger
- With 90s watchdog: worst case is 90s + 240s = 330s (5.5 min) before first resume
- With 180s watchdog: worst case is 180s + 240s = 420s (7 min)
- With 300s watchdog: worst case is 300s + 240s = 540s (9 min)

### Questions
- Given the improved stall detection, is 90s watchdog too aggressive? Would 180s or 300s be better?
- Should orchestra tasks have different thresholds than general chat tasks?
- Is 10 max resumes too many? Most successful tasks complete in 0–2 resumes. What would you cap it at?
- The fundamental question: is the resume system a reliability feature (catches real failures) or a compensating control (covers for weak model behavior)?

---

## Decision 4: Checkpoint Context Truncation Strategy

### Current State

**Token Budget System:**
```
Context budget = min(model.maxContext × 0.75, 100,000 tokens)
  Floor: 16,000 tokens
  Ceiling: 100,000 tokens (even for 1M-context models)
  Default: 60,000 tokens (unknown models)
```

**Compression Algorithm (5 steps):**
1. Estimate tokens for all messages (BPE tokenizer or heuristic ~4 chars/token)
2. Always keep: system message, user prompt, last 6 messages
3. Track tool message pairing (assistant tool_calls ↔ tool results kept/evicted together)
4. Greedy fill: sort remaining by priority (recent > tool results > reasoning), add until budget filled
5. Summarize evicted messages: `[Context summary: Tools used: X, Y. N tool results processed. Files: ...]`

**Priority Scoring:**
```
System message (index 0):     100 (always kept)
User prompt (index 1):         90 (always kept)
Recent tool results:          55–85
Assistant tool-calls:         35–65
Assistant plain text:         18–48 (lowest)
System injections:            45–75
Position component:            0–30 (recency bonus)
```

**Tool Result Truncation (2-tier):**

Tier 1 — At tool execution:
| Tool | Limit |
|------|-------|
| fetch_url | 20 KB |
| github_read_file | 30 KB |
| github_api | 50 KB |
| sandbox_exec | 50 KB |

Tier 2 — At DO level (dynamic):
```
perResultLimit = (contextBudget × 0.25 × 4 chars/token) / batchSize
  Min: 4,000 chars
  Max: 50,000 chars
Example: 60K budget → 15K chars total → 3.75K per result
```

On checkpoint resume: truncate to 16KB per tool result, then compress to 50% of budget.

### The User's Question
> "Character-budget-aware vs fixed-line truncation. Marginal gain, high complexity."

### What We Currently Use
- **Character-based truncation** at the tool level (fixed KB limits per tool)
- **Token-budget-aware compression** at the context level (priority scoring + greedy fill)
- **Head+tail preservation** for truncated results: `first_half + "[TRUNCATED N chars]" + last_half`
- **Line-based truncation** only on checkpoint resume: keep first 15 lines + last 5 lines of old tool results

### The Question
Is the current hybrid approach (character limits at tool level + token-aware compression at context level) good enough? Or should we:
1. **Unify to token-budget-aware everywhere** — More accurate but complex. Every tool result would be truncated relative to remaining context budget.
2. **Simplify to fixed limits everywhere** — Less accurate but simpler. Just cap everything at 8KB and compress aggressively.
3. **Keep hybrid but tune** — The current approach works but some limits may be wrong (e.g., 30KB for github_read_file seems high when DO budget is often 15K chars total).

### Questions
- Is the 100K token ceiling for DOs appropriate? Would raising it to 150K help or hurt (API latency vs. context)?
- Is the 50% budget target on resume too aggressive? Models re-read files after compression, wasting iterations.
- Would a smarter summary (LLM-generated rather than template) of evicted context be worth the extra API call?
- The `minRecentMessages = 6` — is this too many or too few? Should it scale with task progress?

---

## Decision 5: Model Tiering for Orchestra (Policy Decision)

### Current Scoring System (getRankedOrchestraModels)

Models are scored on a multi-factor system:

| Factor | Points | Source |
|--------|--------|--------|
| Intelligence Index (35–70 scale) | 0–30 | Artificial Analysis |
| Coding Index (25–60 scale) | 0–25 | Artificial Analysis |
| LiveCodeBench (30–60 scale) | 0–10 | Artificial Analysis |
| SWE-Bench ≥75% | +25 | Benchmarks |
| SWE-Bench ≥65% | +15 | Benchmarks |
| "Agentic" keyword | +12 | Model metadata |
| `orchestraReady` flag | +12 | Computed |
| Parallel tool calls | +5 | Model capability |
| Direct API | +8 | Lower latency |
| Context ≥500K | +10 | Architecture |
| Dense model | +10 | vs. MoE |
| Mini/small/lite/nano | −20 | Architecture penalty |
| Flash models | −10 | Architecture penalty |
| Heavy coding + SWE≥65% | +10 | Task-specific |
| Simple task + free model | +15 | Cost optimization |
| Real-world success rate | ±20 | Event history (Laplace smoothed) |
| Stall rate >30% | −8 | Event history |

### orchestraReady Computation
A model is `orchestraReady` if:
- supports tools
- not image generation
- context ≥ 64K
- AND either high benchmark scores OR matches known strong model families

### Prompt Tier Selection
```
Intelligence Index ≥ 45  → FULL prompt (~3500 tokens)
Intelligence Index ≥ 28  → STANDARD prompt (~1500 tokens)
Intelligence Index < 28  → MINIMAL prompt (~900 tokens)
Fallback: paid → FULL, free + large context → STANDARD, free + small context → MINIMAL
```

### Escalation (Advisory Only)
When a task stalls on a weak/free model:
- Detects coding intent via keywords
- Checks if model is free OR alias is `dcode`
- Checks low tool-to-iteration ratio
- **Suggests** (never forces) escalation to: deep → grok → sonnet

### Cost Tiers
```
Free:        18 models
Exceptional: $0.00–$0.50/M output (DeepSeek, MiMo)
Great:       $0.50–$2.00/M output (Devstral, Grok Fast)
Good:        $2.00–$5.00/M output (Flash, Haiku, Kimi)
Premium:     $5.00+/M output (Opus, GPT-5.4, Gemini Pro)
```

### Questions
- Is the scoring system appropriately weighted? SWE-Bench at +25 is the single highest factor — is that justified?
- Should `orchestraReady` be a hard gate (reject models that aren't ready) or soft (just lower ranking)?
- Is advisory-only escalation the right call? Or should we auto-escalate after N stalls?
- How should we handle new models with no event history? The −20 "unknown penalty" (no AA + no SWE-Bench) seems steep.
- Should cost factor into ranking explicitly, or just be shown as context (current approach)?

---

## Meta-Questions

1. **Priority** — If you could only change ONE of these 5 areas, which would have the highest impact on task success rate?
2. **Simplification** — Which of these systems is over-engineered and could be simplified without meaningful loss?
3. **Missing** — What architectural concern are we NOT considering that matters more than any of the above?

---

## Resolution Status (Updated 2026-03-22)

> Tracking which decisions have been resolved and which gaps remain.
> Commits: `ca00708` (F.18), `50611b8` (F.18.1)

| Decision | Status | Commits | Remaining Gaps |
|----------|--------|---------|----------------|
| **D1: Selective Sandbox** | ✅ Closed | F.18 profile → `requiresSandbox`, F.18.1 → tool-level gating | — |
| **D2: Classification Gap** | ✅ Closed | F.18 `buildExecutionProfile()` centralizes all signals | F.20: runtime/diff risk classification (future) |
| **D3: Resume Frequency** | ✅ Closed | F.18 profile-driven `maxAutoResumes` (3/4/6/8) | — |
| **D4: Checkpoint Truncation** | ⚠️ Partial | Existing boundary-aware chunking | Gemini: token-aware chunking that respects JSON/YAML structure |
| **D5: Model Tiering** | ✅ Closed | F.18.1 `forceEscalation` auto-upgrades weak models | F.24: broader model floor policy (future) |

### Tracked Follow-Up Items (in GLOBAL_ROADMAP.md)

| ID | Description | Source |
|----|-------------|--------|
| F.20 | Runtime/diff-based risk classification | GPT, Grok, Gemini — all three flagged this |
| F.21 | `pendingChildren` downstream consumers | GPT |
| F.22 | Tests for profile enforcement behavior | GPT |
| F.23 | Branch-level concurrency mutex | Gemini |
| F.24 | Broader escalation policy (model floor) | GPT |

### Reviewer Consensus Summary

- **Grok**: Decision 2 fully closed. Profile is now the control plane. Remaining items are optimization, not correctness.
- **GPT**: Three immediate gaps fixed. Still flags runtime risk classification (F.20) as the deepest remaining root cause.
- **Gemini**: Architecture centralization resolved. Flags branch-level concurrency (F.23) as critical for multi-task safety.
