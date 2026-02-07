#!/bin/bash
# Setup script for moltworker-private repo
# Run this in a Codespace opened on PetrAnto/moltworker-private
#
# Usage:
#   1. Open a Codespace on github.com/PetrAnto/moltworker-private
#   2. Paste this entire script into the terminal
#   3. It creates all files, commits, and pushes

set -e

echo "=== Setting up moltworker-private orchestration files ==="

# Create directories
mkdir -p claude-share/core

# ─────────────────────────────────────────────────
# FILE 1: README.md
# ─────────────────────────────────────────────────
cat > README.md << 'ENDOFFILE'
# Moltworker Orchestration (Private)

> Private companion repo for [PetrAnto/moltworker](https://github.com/PetrAnto/moltworker).
> Contains development strategy, roadmaps, and multi-AI orchestration docs.

## Setup

Clone this repo alongside the main moltworker repo:

```bash
# Your workspace should look like:
~/projects/
├── moltworker/                  # Public fork (github.com/PetrAnto/moltworker)
└── moltworker-private/          # This repo (private)
    ├── claude-share/core/*.md   # Orchestration docs
    └── tool-calling-analysis.md # Technical analysis
```

### Symlink into the public repo (optional)

If you want AI agents to auto-discover these files from within the public repo:

```bash
cd ~/projects/moltworker
ln -s ../moltworker-private/claude-share claude-share
ln -s ../moltworker-private/tool-calling-analysis.md brainstorming/tool-calling-analysis.md
```

The `.gitignore` in the public repo already excludes `claude-share/` and `brainstorming/tool-calling-analysis.md`, so symlinks won't be committed.

## Contents

| File | Purpose |
|------|---------|
| `claude-share/core/SYNC_CHECKLIST.md` | Post-task checklist for all AI agents |
| `claude-share/core/GLOBAL_ROADMAP.md` | Master roadmap (6 phases, 30+ tasks) |
| `claude-share/core/WORK_STATUS.md` | Current sprint tracking |
| `claude-share/core/next_prompt.md` | Next task prompt for AI sessions |
| `claude-share/core/AI_CODE_STANDARDS.md` | Code quality rules |
| `claude-share/core/SPECIFICATION.md` | Product specification |
| `claude-share/core/claude-log.md` | Claude session log |
| `claude-share/core/codex-log.md` | Codex session log |
| `claude-share/core/bot-log.md` | Other AI session log |
| `tool-calling-analysis.md` | Technical analysis (10 gaps, 13 recommendations) |
ENDOFFILE

# ─────────────────────────────────────────────────
# FILE 2: claude-share/core/SYNC_CHECKLIST.md
# ─────────────────────────────────────────────────
cat > claude-share/core/SYNC_CHECKLIST.md << 'ENDOFFILE'
# Sync Checklist

> **EVERY AI assistant MUST follow this checklist after completing any task.**
> No exceptions. Skipping steps creates drift between agents.

**Last Updated:** 2026-02-06

---

## After EVERY Task

- [ ] **Update session log** — Append to the correct log file:
  - Claude: `claude-share/core/claude-log.md`
  - Codex: `claude-share/core/codex-log.md`
  - Other: `claude-share/core/bot-log.md`
- [ ] **Update GLOBAL_ROADMAP.md** — Change task status emoji and add changelog entry
- [ ] **Update WORK_STATUS.md** — Reflect current sprint state
- [ ] **Update next_prompt.md** — Point to the next task for the next AI session
- [ ] **Run tests** — `npm test` must pass before pushing
- [ ] **Run typecheck** — `npm run typecheck` must pass before pushing
- [ ] **Commit with proper format** — See commit message format below
- [ ] **Push to correct branch** — Never push to `main` directly

---

## Session Log Entry Format

```markdown
## Session: YYYY-MM-DD | Task Name (Session: SESSION_ID)

**AI:** Claude / Codex / Other (model name)
**Branch:** branch-name
**Status:** Completed / Partial / Blocked

### Summary
Brief description of what was accomplished.

### Changes Made
- Change 1
- Change 2

### Files Modified
- `path/to/file1.ts`
- `path/to/file2.ts`

### Tests
- [ ] Tests pass
- [ ] Typecheck passes

### Notes for Next Session
Any context the next AI needs to continue.
```

---

## Changelog Entry Format

Add to `GLOBAL_ROADMAP.md` → Changelog section (newest first):

```
YYYY-MM-DD | AI Name (Session: ID) | Task Description: Details | file1.ts, file2.ts
```

---

## Commit Message Format

```
<type>(<scope>): <description>

[optional body]

AI: <model-name> (Session: <session-id>)
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`
Scopes: `tools`, `models`, `client`, `gateway`, `telegram`, `discord`, `task-processor`, `openrouter`, `docs`

Example:
```
feat(tools): add parallel tool execution via Promise.allSettled

Replace sequential for...of loop with Promise.allSettled for independent
tool calls. ~2-5x speedup per iteration in multi-tool scenarios.

AI: Claude Opus 4.6 (Session: abc123)
```

---

## Branch Naming Convention

| AI Agent | Branch Pattern | Example |
|----------|---------------|---------|
| Claude | `claude/<task-slug>-<id>` | `claude/parallel-tools-x7k2` |
| Codex | `codex/<task-slug>-<id>` | `codex/cost-tracking-m3p1` |
| Other | `bot/<task-slug>-<id>` | `bot/gemini-flash-tools-q2w3` |
| Human | `feat/<task-slug>` or `fix/<task-slug>` | `feat/mcp-integration` |

---

## What NOT to Do

- Do NOT push to `main` directly
- Do NOT skip tests ("I'll fix them later")
- Do NOT modify files outside your task scope without documenting why
- Do NOT leave `console.log` debug statements in production code
- Do NOT commit secrets, API keys, or `.dev.vars`
- Do NOT amend another AI's commits without coordination
ENDOFFILE

# ─────────────────────────────────────────────────
# FILE 3: claude-share/core/GLOBAL_ROADMAP.md
# ─────────────────────────────────────────────────
cat > claude-share/core/GLOBAL_ROADMAP.md << 'ENDOFFILE'
# Moltworker Global Roadmap

> **Single source of truth** for all project planning and status tracking.
> Updated by every AI agent after every task. Human checkpoints marked explicitly.

**Last Updated:** 2026-02-06

---

## Project Overview

**Moltworker** is a multi-platform AI assistant gateway deployed on Cloudflare Workers. It provides:
- 26+ AI models via OpenRouter + direct provider APIs
- 5 tools (fetch_url, github_read_file, github_list_files, github_api, browse_url)
- Durable Objects for unlimited-time task execution
- Multi-platform chat (Telegram, Discord, Slack)
- Image generation (FLUX.2 models)
- Browser automation (Cloudflare Browser Rendering)
- Admin dashboard (React)

**Philosophy:** Ship fast, compound learnings, multi-model by default.

---

## Status Legend

| Emoji | Status |
|-------|--------|
| ✅ | Complete |
| 🔄 | In Progress |
| 🔲 | Not Started |
| ⏸️ | Blocked |
| 🧪 | Needs Testing |

---

## Phase Plan

### Phase 0: Quick Wins (Trivial effort, immediate value)

| ID | Task | Status | Owner | Notes |
|----|------|--------|-------|-------|
| 0.1 | Enable `supportsTools: true` for Gemini 3 Flash | 🔲 | Any AI | One-line fix in `models.ts` |
| 0.2 | Add GPT-OSS-120B to model catalog | 🔲 | Any AI | New entry in `models.ts` |
| 0.3 | Add GLM 4.7 to model catalog | 🔲 | Any AI | Upgrade from GLM 4.5 Air |
| 0.4 | Fix section numbering in tool-calling-analysis.md | ✅ | Human | Resolved externally |

> 🧑 HUMAN CHECK 0.5: Verify new model IDs are correct on OpenRouter — ⏳ PENDING

---

### Phase 1: Tool-Calling Optimization (Low-Medium effort, high value)

| ID | Task | Status | Owner | Notes |
|----|------|--------|-------|-------|
| 1.1 | Implement parallel tool execution (`Promise.allSettled`) | 🔲 | Claude | `client.ts` L221-238, `task-processor.ts` L728-759 |
| 1.2 | Enrich model capability metadata | 🔲 | Claude/Codex | Extend `ModelInfo` with `parallelCalls`, `structuredOutput`, `reasoning`, `maxContext` |
| 1.3 | Add configurable reasoning per model | 🔲 | Claude | Pass `reasoning` param to API based on model capability |
| 1.4 | Combine vision + tools into unified method | 🔲 | Codex | Merge `chatCompletionWithVision` and `chatCompletionWithTools` |
| 1.5 | Add structured output support | 🔲 | Claude | `response_format: { type: "json_schema" }` for compatible models |

> 🧑 HUMAN CHECK 1.6: Test parallel tool execution with real API calls — ⏳ PENDING
> 🧑 HUMAN CHECK 1.7: Verify reasoning control doesn't break existing models — ⏳ PENDING

---

### Phase 2: Observability & Cost Intelligence (Medium effort)

| ID | Task | Status | Owner | Notes |
|----|------|--------|-------|-------|
| 2.1 | Add token/cost tracking per request | 🔲 | Claude | New `src/openrouter/costs.ts`, accumulate in task processor |
| 2.2 | Add `/costs` Telegram command | 🔲 | Claude | Show usage breakdown by model |
| 2.3 | Integrate Acontext observability (Phase 1) | 🔲 | Claude/Codex | Store messages in Acontext Sessions for replay |
| 2.4 | Add Acontext dashboard link to admin UI | 🔲 | Codex | Low-risk, read-only integration |

> 🧑 HUMAN CHECK 2.5: Set up Acontext account and configure API key — ⏳ PENDING
> 🧑 HUMAN CHECK 2.6: Review cost tracking accuracy against OpenRouter billing — ⏳ PENDING

---

### Phase 3: Compound Engineering (Medium effort, transformative)

| ID | Task | Status | Owner | Notes |
|----|------|--------|-------|-------|
| 3.1 | Implement compound learning loop | 🔲 | Claude | New `src/openrouter/learnings.ts`, extract patterns after task completion |
| 3.2 | Add structured task phases (Plan → Work → Review) | 🔲 | Claude | Phase tracking in `TaskState`, phase-aware prompts |
| 3.3 | Add `/learnings` Telegram command | 🔲 | Claude/Codex | View past patterns and success rates |
| 3.4 | Inject relevant learnings into system prompts | 🔲 | Claude | Use stored learnings to improve future tasks |

> 🧑 HUMAN CHECK 3.5: Review learning data quality after 20+ tasks — ⏳ PENDING

---

### Phase 4: Context Engineering (Medium-High effort)

| ID | Task | Status | Owner | Notes |
|----|------|--------|-------|-------|
| 4.1 | Replace `compressContext()` with Acontext token-budgeted retrieval | 🔲 | Claude | Eliminate chars/4 heuristic |
| 4.2 | Replace `estimateTokens()` with actual tokenizer | 🔲 | Claude | Use Acontext or tiktoken |
| 4.3 | Add tool result caching | 🔲 | Codex | Cache identical tool calls (same GitHub file, etc.) |
| 4.4 | Implement cross-session context continuity | 🔲 | Claude | Resume complex tasks days later with full context |

> 🧑 HUMAN CHECK 4.5: Validate context quality with Acontext vs. current compression — ⏳ PENDING

---

### Phase 5: Advanced Capabilities (High effort, strategic)

| ID | Task | Status | Owner | Notes |
|----|------|--------|-------|-------|
| 5.1 | Multi-agent review for complex tasks | 🔲 | Claude | Route results through reviewer model |
| 5.2 | MCP integration (mcporter pattern) | 🔲 | Claude | Dynamic tool registration from MCP servers |
| 5.3 | Acontext Sandbox for code execution | 🔲 | Codex | Replaces roadmap Priority 3.2 |
| 5.4 | Acontext Disk for file management | 🔲 | Codex | Replaces roadmap Priority 3.3 |
| 5.5 | Web search tool | 🔲 | Any AI | Brave Search or SearXNG |
| 5.6 | Multi-agent orchestration | 🔲 | Claude | Leverage Claude Sonnet 4.5 speculative execution |

> 🧑 HUMAN CHECK 5.7: Evaluate MCP server hosting options (Sandbox vs. external) — ⏳ PENDING
> 🧑 HUMAN CHECK 5.8: Security review of code execution sandbox — ⏳ PENDING

---

### Phase 6: Platform Expansion (Future)

| ID | Task | Status | Owner | Notes |
|----|------|--------|-------|-------|
| 6.1 | Telegram inline buttons | 🔲 | Any AI | Confirmations, model selection |
| 6.2 | Response streaming (Telegram) | 🔲 | Any AI | Progressive message updates |
| 6.3 | Voice messages (Whisper + TTS) | 🔲 | Any AI | High effort |
| 6.4 | Calendar/reminder tools | 🔲 | Any AI | Cron-based |
| 6.5 | Email integration | 🔲 | Any AI | Cloudflare Email Workers |
| 6.6 | WhatsApp integration | 🔲 | Any AI | WhatsApp Business API |

---

## AI Task Ownership

| AI Agent | Primary Responsibilities | Strengths |
|----------|------------------------|-----------|
| **Claude** | Architecture, complex refactoring, tool-calling logic, task processor, compound learning | Deep reasoning, multi-step changes, system design |
| **Codex** | Frontend (React admin UI), tests, simple model additions, Acontext integration | Fast execution, UI work, parallel tasks |
| **Other Bots** | Code review, documentation, simple fixes, model catalog updates | Varies by model |
| **Human** | Security review, deployment, API key management, architecture decisions | Final authority |

---

## Human Checkpoints Summary

| ID | Description | Status |
|----|-------------|--------|
| 0.5 | Verify new model IDs on OpenRouter | ⏳ PENDING |
| 1.6 | Test parallel tool execution with real APIs | ⏳ PENDING |
| 1.7 | Verify reasoning control compatibility | ⏳ PENDING |
| 2.5 | Set up Acontext account/API key | ⏳ PENDING |
| 2.6 | Review cost tracking vs. OpenRouter billing | ⏳ PENDING |
| 3.5 | Review learning data quality | ⏳ PENDING |
| 4.5 | Validate Acontext context quality | ⏳ PENDING |
| 5.7 | Evaluate MCP hosting options | ⏳ PENDING |
| 5.8 | Security review of code execution | ⏳ PENDING |

---

## Bug Fixes & Corrective Actions

| Date | Issue | Fix | Files | AI |
|------|-------|-----|-------|----|
| — | No bugs tracked yet | — | — | — |

---

## Changelog

> Newest first. Format: `YYYY-MM-DD | AI | Description | files`

```
2026-02-06 | Claude Opus 4.6 (Session: 011qMKSadt2zPFgn2GdTTyxH) | docs: Create multi-AI orchestration documentation structure | claude-share/core/*.md, CLAUDE.md, AGENTS.md
2026-02-06 | Claude Opus 4.6 (Session: 011qMKSadt2zPFgn2GdTTyxH) | docs: Add Compound Engineering Plugin analysis | brainstorming/tool-calling-analysis.md
2026-02-06 | Claude Opus 4.6 (Session: 011qMKSadt2zPFgn2GdTTyxH) | docs: Add Acontext context data platform analysis | brainstorming/tool-calling-analysis.md
2026-02-06 | Claude Opus 4.6 (Session: 011qMKSadt2zPFgn2GdTTyxH) | docs: Initial tool-calling landscape and steipete analysis | brainstorming/tool-calling-analysis.md
```

---

## Dependency Graph

```mermaid
graph TD
    P0[Phase 0: Quick Wins] --> P1[Phase 1: Tool-Calling Optimization]
    P1 --> P2[Phase 2: Observability & Costs]
    P1 --> P3[Phase 3: Compound Engineering]
    P2 --> P4[Phase 4: Context Engineering]
    P3 --> P4
    P4 --> P5[Phase 5: Advanced Capabilities]
    P5 --> P6[Phase 6: Platform Expansion]

    subgraph "Phase 0 (Trivial)"
        P0_1[0.1 Gemini Flash tools]
        P0_2[0.2 GPT-OSS-120B]
        P0_3[0.3 GLM 4.7]
    end

    subgraph "Phase 1 (Low-Medium)"
        P1_1[1.1 Parallel tools]
        P1_2[1.2 Model metadata]
        P1_3[1.3 Reasoning control]
        P1_4[1.4 Vision + tools]
    end

    subgraph "Phase 2 (Medium)"
        P2_1[2.1 Cost tracking]
        P2_3[2.3 Acontext observability]
    end

    subgraph "Phase 3 (Medium)"
        P3_1[3.1 Learning loop]
        P3_2[3.2 Task phases]
    end

    subgraph "Phase 4 (Medium-High)"
        P4_1[4.1 Acontext context]
        P4_3[4.3 Tool caching]
    end

    subgraph "Phase 5 (High)"
        P5_1[5.1 Multi-agent review]
        P5_2[5.2 MCP integration]
        P5_3[5.3 Code execution]
    end

    P0_1 --> P1_2
    P0_2 --> P1_2
    P1_1 --> P5_1
    P1_2 --> P1_3
    P1_2 --> P2_1
    P2_3 --> P4_1
    P3_1 --> P3_2
    P3_2 --> P5_1
```

---

## References

- [Tool-Calling Analysis](../tool-calling-analysis.md) — Full analysis with 10 gaps and 13 recommendations
- [Future Integrations](https://github.com/PetrAnto/moltworker/blob/main/brainstorming/future-integrations.md) — Original roadmap (pre-analysis)
- [README](https://github.com/PetrAnto/moltworker) — User-facing documentation
- [AGENTS.md](https://github.com/PetrAnto/moltworker/blob/main/AGENTS.md) — Developer/AI agent instructions
- [CLAUDE.md](https://github.com/PetrAnto/moltworker/blob/main/CLAUDE.md) — Claude Code project instructions
ENDOFFILE

# ─────────────────────────────────────────────────
# FILE 4: claude-share/core/WORK_STATUS.md
# ─────────────────────────────────────────────────
cat > claude-share/core/WORK_STATUS.md << 'ENDOFFILE'
# Work Status

> Current sprint status. Updated by every AI agent after every task.

**Last Updated:** 2026-02-06

---

## Current Sprint: Foundation & Quick Wins

**Sprint Goal:** Establish multi-AI orchestration documentation, ship Phase 0 quick wins, begin Phase 1 tool-calling optimization.

**Sprint Duration:** 2026-02-06 → 2026-02-13

---

### Active Tasks

| Task ID | Description | Assignee | Status | Branch |
|---------|-------------|----------|--------|--------|
| 0.1 | Enable Gemini Flash tool support | Unassigned | 🔲 Not Started | — |
| 0.2 | Add GPT-OSS-120B model | Unassigned | 🔲 Not Started | — |
| 0.3 | Add GLM 4.7 model | Unassigned | 🔲 Not Started | — |
| 1.1 | Parallel tool execution | Unassigned | 🔲 Not Started | — |
| 1.2 | Model capability metadata | Unassigned | 🔲 Not Started | — |

---

### Parallel Work Tracking

| AI Agent | Current Task | Branch | Started |
|----------|-------------|--------|---------|
| Claude | Orchestration docs (this) | `claude/analyze-tool-calling-5ee5w` | 2026-02-06 |
| Codex | — | — | — |
| Other | — | — | — |

---

### Completed This Sprint

| Task ID | Description | Completed By | Date | Branch |
|---------|-------------|-------------|------|--------|
| — | Tool-calling landscape analysis | Claude Opus 4.6 | 2026-02-06 | `claude/analyze-tool-calling-5ee5w` |
| — | Acontext platform analysis | Claude Opus 4.6 | 2026-02-06 | `claude/analyze-tool-calling-5ee5w` |
| — | Compound Engineering analysis | Claude Opus 4.6 | 2026-02-06 | `claude/analyze-tool-calling-5ee5w` |
| — | Multi-AI orchestration docs | Claude Opus 4.6 | 2026-02-06 | `claude/analyze-tool-calling-5ee5w` |

---

### Blocked

| Task ID | Description | Blocked By | Resolution |
|---------|-------------|-----------|------------|
| 2.3 | Acontext integration | Human: Need API key | 🧑 HUMAN CHECK 2.5 |

---

## Next Priorities Queue

> Ordered by priority. Next AI session should pick the top item.

1. **Phase 0.1-0.3** — Quick model catalog fixes (trivial, any AI)
2. **Phase 1.1** — Parallel tool execution (low effort, high impact)
3. **Phase 1.2** — Model capability metadata (low effort, unlocks 1.3 and 2.1)
4. **Phase 2.1** — Token/cost tracking (medium effort, high value)
5. **Phase 3.2** — Structured task phases (medium effort, high value)

---

## Sprint Velocity

| Sprint | Tasks Planned | Tasks Completed | Notes |
|--------|-------------|----------------|-------|
| Sprint 1 (current) | 5 | 0 | Ramp-up sprint, docs focus |
ENDOFFILE

# ─────────────────────────────────────────────────
# FILE 5: claude-share/core/next_prompt.md
# ─────────────────────────────────────────────────
cat > claude-share/core/next_prompt.md << 'ENDOFFILE'
# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-02-06

---

## Current Task: Phase 0 — Quick Model Catalog Wins

### Requirements

You are working on Moltworker, a multi-platform AI assistant gateway on Cloudflare Workers.

Complete these three quick wins in `src/openrouter/models.ts`:

1. **Enable Gemini 3 Flash tool support** (Task 0.1)
   - Add `supportsTools: true` to the `flash` model entry
   - Gemini 3 Flash supports tool calling via OpenRouter

2. **Add GPT-OSS-120B model** (Task 0.2)
   - Add new entry with alias `gptoss`
   - Model ID: `openai/gpt-oss-120b` (verify on OpenRouter)
   - Native tool use, structured outputs, configurable reasoning depth
   - Cost: approximately $0.50/$2.00
   - Set `supportsTools: true`

3. **Add GLM 4.7 model** (Task 0.3)
   - Add new entry with alias `glm47`
   - Model ID: `z-ai/glm-4.7` (verify on OpenRouter)
   - Multi-step reasoning, complex agent tasks
   - Upgrade from existing `glmfree` (GLM 4.5 Air)
   - Set `supportsTools: true`

### Success Criteria

- [ ] `flash` model has `supportsTools: true`
- [ ] `gptoss` model added with correct ID and capabilities
- [ ] `glm47` model added with correct ID and capabilities
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] Changes committed with format: `feat(models): add tool support for Gemini Flash, GPT-OSS-120B, GLM 4.7`

### Key Files
- `src/openrouter/models.ts` — Model definitions (primary)
- `src/openrouter/tools.ts` — `modelSupportsTools()` fallback list (may need update)

---

## Queue After This Task

| Priority | Task | Effort |
|----------|------|--------|
| Next | 1.1: Parallel tool execution (`Promise.allSettled`) | Low |
| Then | 1.2: Model capability metadata (extend `ModelInfo`) | Low |
| Then | 2.1: Token/cost tracking | Medium |
| Then | 3.2: Structured task phases (Plan → Work → Review) | Medium |

---

## Recently Completed

| Date | Task | AI | Session |
|------|------|----|---------|
| 2026-02-06 | Tool-calling landscape analysis | Claude Opus 4.6 | 011qMKSadt2zPFgn2GdTTyxH |
| 2026-02-06 | Acontext platform analysis | Claude Opus 4.6 | 011qMKSadt2zPFgn2GdTTyxH |
| 2026-02-06 | Compound Engineering analysis | Claude Opus 4.6 | 011qMKSadt2zPFgn2GdTTyxH |
| 2026-02-06 | Multi-AI orchestration docs | Claude Opus 4.6 | 011qMKSadt2zPFgn2GdTTyxH |

---

## Bot Acknowledgment Format

When starting a session, respond with:

```
ACK: [Task ID] — [Task Name]
Branch: [branch-name]
Files to modify: [list]
Estimated changes: [brief scope]
Starting now.
```

---

## Key Documentation

| Document | Path | Purpose |
|----------|------|---------|
| Sync Checklist | `claude-share/core/SYNC_CHECKLIST.md` | What to update after EVERY task |
| Global Roadmap | `claude-share/core/GLOBAL_ROADMAP.md` | Master status tracker |
| Code Standards | `claude-share/core/AI_CODE_STANDARDS.md` | Code quality rules |
| Specification | `claude-share/core/SPECIFICATION.md` | Product spec |
| Tool-Calling Analysis | `tool-calling-analysis.md` | Technical analysis with 13 recommendations |
| Future Integrations | `brainstorming/future-integrations.md` | Original roadmap |
ENDOFFILE

# ─────────────────────────────────────────────────
# FILE 6: claude-share/core/AI_CODE_STANDARDS.md
# ─────────────────────────────────────────────────
cat > claude-share/core/AI_CODE_STANDARDS.md << 'ENDOFFILE'
# AI Code Standards

> Universal code quality rules for ALL AI assistants working on Moltworker.
> These are non-negotiable. Violations will be caught in review.

**Last Updated:** 2026-02-06

---

## TypeScript Patterns

### General
- **Strict mode** — `tsconfig.json` has strict enabled. Never use `any` unless absolutely necessary.
- **Explicit function signatures** — Always type parameters and return types for exported functions.
- **Prefer `const`** — Use `let` only when reassignment is needed. Never use `var`.
- **Use template literals** — For string concatenation, prefer `` `Hello ${name}` `` over `"Hello " + name`.

### Imports
- Use named imports: `import { getModel } from './models'`
- Group imports: stdlib → external packages → internal modules
- No circular imports

### Naming
- **Files:** `kebab-case.ts` (e.g., `task-processor.ts`)
- **Classes:** `PascalCase` (e.g., `TaskProcessor`)
- **Functions/variables:** `camelCase` (e.g., `getModelId`)
- **Constants:** `UPPER_SNAKE_CASE` (e.g., `MAX_TOOL_RESULT_LENGTH`)
- **Interfaces:** `PascalCase`, no `I` prefix (e.g., `ToolContext`, not `IToolContext`)
- **Types:** `PascalCase` (e.g., `Provider`)

### Async/Await
- Always use `async/await` over raw Promises
- Use `Promise.allSettled()` for parallel operations that should not fail-fast
- Use `Promise.all()` only when ALL promises must succeed
- Always handle errors with try/catch, never `.catch()` chaining

---

## Error Handling

### Rules
1. **Never swallow errors silently** — At minimum, `console.error` the error
2. **Typed error messages** — Include context: `Error executing ${toolName}: ${error.message}`
3. **User-facing errors** — Must be human-readable, no stack traces to end users
4. **Tool errors** — Return error as tool result, don't crash the conversation loop
5. **API errors** — Include HTTP status code and truncated response body (max 200 chars)

### Pattern
```typescript
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ComponentName] Operation failed: ${message}`);
  // Return graceful fallback, don't re-throw unless caller handles it
  return { error: message };
}
```

### Timeouts
- Every external API call MUST have a timeout
- Default: 30s for simple fetches, 60s for tool execution, 300s for LLM API calls
- Use `Promise.race()` with a timeout promise:
```typescript
const result = await Promise.race([
  apiCall(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000))
]);
```

---

## Security

### Absolute Rules
1. **No secrets in code** — API keys, tokens go in environment variables only
2. **No secrets in logs** — Use the redaction utility in `src/utils/logging.ts`
3. **Validate all external input** — URL parameters, request bodies, tool arguments
4. **No `eval()` or `new Function()`** — Ever
5. **Sanitize user input before passing to APIs** — Especially GitHub API endpoints

### URL Handling
- Validate URLs before fetching: must start with `https://` (or `http://` for localhost)
- Never construct URLs from unvalidated user input without sanitization
- Use `URL` constructor to parse and validate

### Authentication
- Cloudflare Access JWT validation for admin routes
- Gateway token for control UI
- GitHub token injected via `ToolContext`, never exposed to models

---

## Testing

### Requirements
- **Every new function** must have at least one test
- **Every bug fix** must have a regression test
- **Test files** colocated with source: `foo.ts` → `foo.test.ts`

### Framework
- **Vitest** — `npm test` to run all, `npm run test:watch` for development
- **Coverage** — `@vitest/coverage-v8`

### Patterns
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('functionName', () => {
  it('should handle the happy path', () => {
    expect(functionName(validInput)).toBe(expectedOutput);
  });

  it('should handle edge case', () => {
    expect(functionName(edgeInput)).toBe(edgeOutput);
  });

  it('should throw on invalid input', () => {
    expect(() => functionName(invalidInput)).toThrow('Expected error');
  });
});
```

### Mocking
- Use `vi.fn()` for function mocks
- Use `vi.spyOn()` for method spying
- Use test utilities from `src/test-utils.ts`

---

## File Organization

### Directory Structure
```
src/
├── index.ts              # Worker entrypoint — keep thin
├── types.ts              # Shared TypeScript types
├── config.ts             # Constants and configuration
├── auth/                 # Authentication logic
├── gateway/              # Sandbox/container management
├── routes/               # HTTP route handlers
├── openrouter/           # OpenRouter API integration
│   ├── client.ts         # API client
│   ├── models.ts         # Model definitions
│   ├── tools.ts          # Tool definitions and execution
│   ├── storage.ts        # Conversation state
│   └── costs.ts          # (new) Cost tracking
├── telegram/             # Telegram bot
├── discord/              # Discord integration
├── durable-objects/      # Durable Objects (TaskProcessor)
├── client/               # React admin UI
└── utils/                # Shared utilities
```

### Rules
- **One concern per file** — Don't mix routing with business logic
- **Max ~500 lines per file** — Split if growing beyond this
- **Keep route handlers thin** — Extract logic to service modules
- **New tools** go in `src/openrouter/tools.ts` (or a `tools/` subdirectory if it grows)
- **New models** go in `src/openrouter/models.ts`

---

## Git Workflow

### Branches
- `main` — Production, protected. PRs only.
- `claude/<slug>-<id>` — Claude work branches
- `codex/<slug>-<id>` — Codex work branches
- `feat/<slug>` — Human feature branches
- `fix/<slug>` — Human bugfix branches

### Commits
- Atomic commits — one logical change per commit
- Descriptive messages — see SYNC_CHECKLIST.md for format
- Run `npm test && npm run typecheck` before committing

### Pull Requests
- Title: `<type>(<scope>): <description>` (max 70 chars)
- Body: Summary bullets + test plan
- Must pass CI before merging
- At least one review (human or AI reviewer agent)

---

## Performance

### Cloudflare Workers Constraints
- **CPU time**: 30ms on free plan, 30s on paid plan (Workers), unlimited on Durable Objects
- **Memory**: 128MB per Worker invocation
- **Subrequests**: 50 per request (paid), 1000 per Durable Object request
- **Response body**: 100MB max

### Best Practices
- Minimize JSON.stringify/parse in hot paths (especially in task processor)
- Use streaming for LLM responses to avoid response.text() hangs
- Avoid storing large objects in Durable Object storage (prefer R2 for >100KB)
- Use `waitUntil()` for non-critical async work (logging, analytics)
ENDOFFILE

# ─────────────────────────────────────────────────
# FILE 7: claude-share/core/SPECIFICATION.md
# ─────────────────────────────────────────────────
cat > claude-share/core/SPECIFICATION.md << 'ENDOFFILE'
# Moltworker Product Specification

> Product vision, feature specifications, and technical requirements.

**Last Updated:** 2026-02-06
**Version:** 2.0 (post-analysis)

---

## Vision & Philosophy

### Mission
Provide a self-hosted, multi-model AI assistant that gets better with every interaction, accessible from any messaging platform.

### Core Principles
1. **Multi-model by default** — No vendor lock-in. Users choose models per task.
2. **Compound improvement** — Each task should make subsequent tasks easier (learnings, patterns, context).
3. **Edge-first** — Run on Cloudflare Workers for global low-latency. No traditional servers.
4. **Privacy-respecting** — Users bring their own API keys. No data leaves their control.
5. **Ship fast, iterate** — Working features over perfect features.

---

## Feature Specifications by Phase

### Phase 0: Foundation (Current)

#### F0.1: Multi-Model Chat
- **Status:** ✅ Complete
- **Description:** 26+ models accessible via aliases (`/deep`, `/sonnet`, `/grok`, etc.)
- **Models:** OpenRouter (20+) + Direct APIs (DashScope, Moonshot, DeepSeek)
- **Interface:** Telegram, Discord, Slack, Web UI (via OpenClaw)

#### F0.2: Tool Calling
- **Status:** ✅ Complete (5 tools)
- **Tools:** `fetch_url`, `github_read_file`, `github_list_files`, `github_api`, `browse_url`
- **Execution:** Sequential, single-model, max 10 iterations (Worker) or 100 (Durable Object)

#### F0.3: Image Generation
- **Status:** ✅ Complete
- **Models:** FLUX.2 Klein, Pro, Flex, Max
- **Interface:** `/imagine <prompt>` via Telegram

#### F0.4: Long-Running Tasks
- **Status:** ✅ Complete
- **Engine:** Durable Objects with R2 checkpointing
- **Features:** Auto-resume (up to 10 times), watchdog alarms, progress updates

---

### Phase 1: Tool-Calling Intelligence

#### F1.1: Parallel Tool Execution
- **Status:** 🔲 Planned
- **Spec:** When a model returns multiple `tool_calls`, execute independent calls concurrently via `Promise.allSettled()`.
- **Dependency detection:** Tools with output→input dependencies (e.g., `github_read_file` result used in `github_api` body) must remain sequential. Initial implementation: parallelize ALL calls (models already handle ordering).
- **Metric:** Measure iteration time reduction (target: 2-5x for multi-tool iterations).

#### F1.2: Model Capability Metadata
- **Status:** 🔲 Planned
- **Spec:** Extend `ModelInfo` interface:
  ```typescript
  interface ModelInfo {
    // ... existing fields
    parallelCalls?: boolean;
    structuredOutput?: boolean;
    reasoning?: 'none' | 'fixed' | 'configurable';
    reasoningLevels?: string[];  // e.g., ['minimal', 'low', 'medium', 'high']
    maxContext?: number;          // tokens
    specialties?: string[];      // 'coding', 'research', 'agentic', etc.
  }
  ```
- **Usage:** Tool dispatch, model recommendation, cost optimization.

#### F1.3: Configurable Reasoning
- **Status:** 🔲 Planned
- **Spec:** Pass `reasoning` parameter to API for models that support it:
  - DeepSeek V3.2: `reasoning: { enabled: boolean }`
  - Gemini 3 Flash: `reasoning: { effort: 'minimal' | 'low' | 'medium' | 'high' }`
  - Grok 4.1: `reasoning: { enabled: boolean }`
- **Default:** Auto-detect from task type (simple Q&A → disabled, coding → medium, research → high).

#### F1.4: Vision + Tools Combined
- **Status:** 🔲 Planned
- **Spec:** Unified method that accepts both image input and tool definitions. User sends screenshot + "fix this" → model sees image AND calls GitHub tools.

---

### Phase 2: Observability & Cost Intelligence

#### F2.1: Token/Cost Tracking
- **Status:** 🔲 Planned
- **Spec:** Track per-request, per-conversation, and per-user costs.
- **Data model:**
  ```typescript
  interface UsageRecord {
    userId: string;
    modelAlias: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    timestamp: number;
    taskId?: string;
  }
  ```
- **Storage:** R2 (`usage/{userId}/YYYY-MM.json`)
- **Commands:** `/costs` (today), `/costs week`, `/costs model`

#### F2.2: Acontext Observability
- **Status:** 🔲 Planned
- **Spec:** Store all task processor messages in Acontext Sessions. Link admin dashboard to Acontext for session replay and success rate tracking.
- **Dependency:** Acontext API key (human setup).

---

### Phase 3: Compound Engineering

#### F3.1: Compound Learning Loop
- **Status:** 🔲 Planned
- **Spec:** After each completed Durable Object task:
  1. Extract structured metadata (tools, model, iterations, success/failure, category)
  2. Store in R2 (`learnings/{userId}/history.json`)
  3. Before new tasks, inject relevant past patterns into system prompt
- **Example injection:** "For similar GitHub tasks, the most effective pattern: `github_read_file` (2x) → `github_api`. Average: 4 iterations, 92% success rate."

#### F3.2: Structured Task Phases
- **Status:** 🔲 Planned
- **Spec:** Add phase tracking to `TaskState`:
  ```typescript
  interface TaskState {
    // ... existing fields
    phase: 'planning' | 'executing' | 'reviewing';
    plan?: string[];  // Planned steps
    currentStep?: number;
  }
  ```
- **Workflow:**
  1. Planning: Model creates explicit plan before tool calls
  2. Executing: Track progress against plan
  3. Reviewing: Self-review before sending final result
- **Telegram UX:** `Planning... → Executing (step 3/7)... → Reviewing...`

---

### Phase 4: Context Engineering

#### F4.1: Token-Aware Context Management
- **Status:** 🔲 Planned
- **Spec:** Replace `compressContext()` and `estimateTokens()` with Acontext token-budgeted retrieval.
- **Improvement over current:** Actual tokenization vs. chars/4 heuristic. Selective tool result pruning vs. blind middle-message removal.

#### F4.2: Tool Result Caching
- **Status:** 🔲 Planned
- **Spec:** Cache tool call results keyed by `hash(toolName + args)`. TTL: 5 minutes for `fetch_url`, 30 minutes for `github_read_file`.
- **Storage:** In-memory Map within Durable Object (cleared on completion).

---

### Phase 5: Advanced Capabilities

#### F5.1: Multi-Agent Review
- **Spec:** After primary model completes complex task, route result to reviewer model. Use cost-efficient reviewers (Gemini Flash, Grok Fast) for expensive output (Claude Opus).

#### F5.2: MCP Integration
- **Spec:** Dynamic tool registration from MCP servers. Use mcporter patterns for Cloudflare Workers compatibility.

#### F5.3: Code Execution (via Acontext Sandbox)
- **Spec:** `run_code({ language: 'python' | 'javascript' | 'bash', code: string })` tool backed by Acontext Sandbox.

#### F5.4: Web Search Tool
- **Spec:** `web_search({ query: string, num_results?: number })` via Brave Search API.

---

## Technical Requirements

### Performance
- **Chat response latency:** <2s for non-tool queries (Worker → OpenRouter → response)
- **Tool execution:** <5s per individual tool call
- **Task processor iteration:** <30s average (including API call + tool execution)
- **Parallel tools:** Should not exceed 2x single-tool latency

### Reliability
- **Auto-resume:** Tasks survive DO restarts (up to 10 auto-resumes)
- **Checkpointing:** Every 3 tool calls to R2
- **Watchdog:** 90s alarm interval, 60s stuck threshold
- **API retries:** 3 attempts with 2s backoff

### Security
- **No secrets in code or logs** — Redaction via `src/utils/logging.ts`
- **Input validation** — All tool arguments validated before execution
- **Auth layers:** Cloudflare Access (admin), Gateway token (UI), User allowlist (Telegram)
- **No code execution** until Phase 5 with proper sandboxing

### Scalability
- **Users:** Single-user focus (personal assistant), multi-user via separate deployments
- **Models:** Extensible catalog, add new models via `models.ts`
- **Tools:** Extensible tool system, add new tools via `tools.ts`
- **Platforms:** Extensible chat platforms, add via new route handlers

---

## Success Criteria

### Phase 1 Success
- [ ] Parallel tool execution reduces multi-tool iteration time by 2x+
- [ ] All models correctly tagged with capability metadata
- [ ] Reasoning control demonstrably improves tool-calling accuracy

### Phase 2 Success
- [ ] Users can see per-model cost breakdown
- [ ] Acontext dashboard shows session replays

### Phase 3 Success
- [ ] Bot demonstrably improves on repeated task types
- [ ] Plan→Work→Review reduces average iterations by 20%+

### Overall Success
- [ ] Bot handles 95%+ of Telegram requests without errors
- [ ] Average task completion under 60s for tool-using queries
- [ ] Users report the bot "gets better over time" (compound effect)
ENDOFFILE

# ─────────────────────────────────────────────────
# FILE 8: claude-share/core/claude-log.md
# ─────────────────────────────────────────────────
cat > claude-share/core/claude-log.md << 'ENDOFFILE'
# Claude Session Log

> All Claude sessions logged here. Newest first.

---

## Session: 2026-02-06 | Multi-AI Orchestration & Tool-Calling Analysis (Session: 011qMKSadt2zPFgn2GdTTyxH)

**AI:** Claude Opus 4.6
**Branch:** `claude/analyze-tool-calling-5ee5w`
**Status:** Completed

### Summary
Created comprehensive tool-calling landscape analysis and multi-AI orchestration documentation structure. Analyzed three external projects (steipete ecosystem, Acontext, Compound Engineering Plugin) for applicability to Moltworker. Identified 10 architectural gaps and produced 13 actionable recommendations across 6 phases.

### Changes Made
1. Created `brainstorming/tool-calling-analysis.md` — Full analysis (475 lines)
   - steipete ecosystem analysis (mcporter, Peekaboo, CodexBar, oracle)
   - Acontext context data platform analysis
   - Compound Engineering Plugin analysis
   - OpenRouter tool-calling model landscape
   - 10 gaps identified, 13 recommendations, priority matrix
2. Created multi-AI orchestration documentation structure:
   - `claude-share/core/SYNC_CHECKLIST.md`
   - `claude-share/core/GLOBAL_ROADMAP.md`
   - `claude-share/core/WORK_STATUS.md`
   - `claude-share/core/next_prompt.md`
   - `claude-share/core/AI_CODE_STANDARDS.md`
   - `claude-share/core/SPECIFICATION.md`
   - `claude-share/core/claude-log.md` (this file)
   - `claude-share/core/codex-log.md`
   - `claude-share/core/bot-log.md`
3. Created `CLAUDE.md` — Claude Code project instructions
4. Updated `AGENTS.md` — Added multi-agent coordination section

### Files Modified
- `brainstorming/tool-calling-analysis.md` (new)
- `claude-share/core/*.md` (all new, 9 files)
- `CLAUDE.md` (new)
- `AGENTS.md` (updated)

### Tests
- [x] No code changes, documentation only
- [x] Existing tests unaffected

### Notes for Next Session
- Start with Phase 0 quick wins (tasks 0.1-0.3 in GLOBAL_ROADMAP.md)
- See `next_prompt.md` for ready-to-copy task prompt
- Model IDs for GPT-OSS-120B and GLM 4.7 need verification on OpenRouter
ENDOFFILE

# ─────────────────────────────────────────────────
# FILE 9: claude-share/core/codex-log.md
# ─────────────────────────────────────────────────
cat > claude-share/core/codex-log.md << 'ENDOFFILE'
# Codex Session Log

> All Codex sessions logged here. Newest first.

---

*No sessions yet. First task suggestions for Codex:*
- *Phase 0.1-0.3: Quick model catalog fixes (trivial)*
- *Phase 1.4: Vision + tools combined (medium)*
- *Phase 2.4: Acontext dashboard link in admin UI (low)*
ENDOFFILE

# ─────────────────────────────────────────────────
# FILE 10: claude-share/core/bot-log.md
# ─────────────────────────────────────────────────
cat > claude-share/core/bot-log.md << 'ENDOFFILE'
# Bot Session Log

> All other AI model sessions logged here. Newest first.
> (Gemini, Grok, DeepSeek, GPT, etc.)

---

*No sessions yet. Suitable first tasks for other models:*
- *Phase 0.1-0.3: Quick model catalog fixes (trivial)*
- *Code review of existing tool implementations*
- *Documentation improvements*
ENDOFFILE

echo ""
echo "=== All orchestration files created! ==="
echo ""
echo "Files created:"
find claude-share -type f | sort
echo "README.md"
echo ""
echo "Now committing and pushing..."

git add -A
git commit -m "docs: add multi-AI orchestration documentation structure

- SYNC_CHECKLIST.md: Post-task checklist for all AI agents
- GLOBAL_ROADMAP.md: 6-phase master roadmap (30+ tasks)
- WORK_STATUS.md: Sprint tracking and parallel work coordination
- next_prompt.md: Ready-to-copy prompt for next AI session
- AI_CODE_STANDARDS.md: Universal code quality rules
- SPECIFICATION.md: Product spec with TypeScript interfaces
- claude-log.md, codex-log.md, bot-log.md: Session logs
- Updated README.md with setup instructions

AI: Claude Opus 4.6 (Session: 011qMKSadt2zPFgn2GdTTyxH)"

git push origin main

echo ""
echo "=== Done! All files pushed to moltworker-private ==="
