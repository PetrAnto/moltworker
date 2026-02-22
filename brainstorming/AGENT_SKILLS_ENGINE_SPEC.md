# Agent Skills Engine — Claude Code Implementation Spec

> **Version**: 2.0
> **Date**: February 22, 2026
> **Owner**: Claude (backend) + Codex (frontend)
> **Effort**: ~75-85h total (agent core: 30h, IDE integration: 45h)
> **Status**: Ready for implementation
> **Dependencies**: BYOK.cloud Phase 1 (vault), private fork migration (§10.5)
> **Parent Specs**: `AGENT_MODE_SPEC.md`, `dream-machine-moltworker-brief.md`
> **New Input**: Community agent architecture patterns from `everything-claude-code` (49k⭐) and `awesome-claude-code` (24.6k⭐)

---

## 0. Purpose of This Document

This spec tells Claude Code **exactly what to build** for Storia's agent system. It merges:

1. The existing `AGENT_MODE_SPEC.md` (transport layer, BYOK auth, SSE streaming)
2. The `dream-machine-moltworker-brief.md` (batch overnight execution)
3. **NEW**: Proven agent architecture patterns from the open-source community — specifically multi-agent orchestration, composable skills, verification loops, and hook-driven automation

The core insight: **moltworker and Storia IDE share one agent engine with multiple transport layers.** Telegram, HTTP/SSE (IDE), and Queue (Dream Machine) are just different frontends to the same core.

---

## 1. Architecture Overview

### 1.1 Unified Agent Core (The Key Change)

**Before** (current moltworker): Monolithic Telegram bot with inline tool logic.
**After**: Composable agent engine with pluggable transports.

```
storia-agent (private fork of moltworker)
├── /core/                    ← SHARED agent engine (this spec)
│   ├── /agents/              ← Specialized agent definitions
│   │   ├── planner.ts        ← Plan-only mode (analyzes, proposes steps)
│   │   ├── executor.ts       ← Full execution mode (writes code, runs tests)
│   │   ├── reviewer.ts       ← Code review + security check
│   │   ├── verifier.ts       ← CoVe verification loop
│   │   └── index.ts          ← Agent registry + routing
│   ├── /skills/              ← Composable capability units
│   │   ├── /coding/          ← TDD, refactor, debug, generate
│   │   ├── /git/             ← clone, branch, commit, PR
│   │   ├── /analysis/        ← codebase scan, dependency audit
│   │   ├── /testing/         ← run tests, coverage, lint
│   │   └── skill-registry.ts ← Skill discovery + matching
│   ├── /orchestrator/        ← Multi-agent routing + task decomposition
│   │   ├── task-router.ts    ← Route task → appropriate agent(s)
│   │   ├── step-planner.ts   ← Break large tasks into CF-safe steps
│   │   └── budget-tracker.ts ← Token/cost tracking per task
│   ├── /hooks/               ← Event-driven automation
│   │   ├── pre-action.ts     ← Security check before destructive ops
│   │   ├── post-action.ts    ← Verify results, update memory
│   │   ├── on-error.ts       ← Retry logic, model fallback
│   │   └── hook-registry.ts  ← Register/trigger hooks
│   ├── /memory/              ← Context management
│   │   ├── context-loader.ts ← Load relevant context for task
│   │   ├── compactor.ts      ← Compress context when approaching limits
│   │   └── r2-store.ts       ← Persistent memory via R2
│   └── agent-loop.ts         ← Main execution loop (shared by all transports)
│
├── /transports/              ← How tasks enter the system
│   ├── telegram.ts           ← Existing Telegram webhook handler
│   ├── http-sse.ts           ← NEW: Storia IDE REST + SSE streaming
│   ├── websocket.ts          ← NEW: Phase D low-latency option
│   └── queue.ts              ← NEW: Dream Machine batch via CF Queue
│
├── /sandbox/                 ← CF Sandbox integration (existing)
│   ├── executor.ts           ← Run commands in sandbox
│   ├── file-ops.ts           ← Read/write/diff files
│   └── git-ops.ts            ← Clone, branch, commit, push
│
└── /api/                     ← NEW: HTTP endpoints
    ├── agent/task.ts         ← POST /api/agent/task (IDE)
    ├── agent/status.ts       ← GET /api/agent/status/:taskId
    ├── dream-build.ts        ← POST /api/dream-build (Dream Machine)
    └── health.ts             ← GET /api/health
```

### 1.2 Data Flow — All Three Transports

```
┌─────────────────────────────────────────────────────────────────┐
│                        TRANSPORTS                                │
│                                                                   │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────────┐ │
│  │  Telegram    │   │  HTTP/SSE    │   │  CF Queue            │ │
│  │  (bot msgs)  │   │  (IDE tasks) │   │  (Dream Machine)     │ │
│  └──────┬──────┘   └──────┬───────┘   └──────────┬───────────┘ │
│         │                  │                       │              │
│         ▼                  ▼                       ▼              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              TRANSPORT ADAPTER LAYER                      │   │
│  │  Normalizes input → AgentTask, routes output → transport  │   │
│  └──────────────────────────┬───────────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     AGENT CORE ENGINE                            │
│                                                                   │
│  ┌────────────┐   ┌──────────────┐   ┌────────────────────┐    │
│  │ Task Router │──►│ Step Planner │──►│ Agent Selection    │    │
│  │             │   │ (decompose)  │   │ (planner/executor/ │    │
│  │             │   │              │   │  reviewer/verifier) │    │
│  └────────────┘   └──────────────┘   └────────┬───────────┘    │
│                                                 │                 │
│  ┌──────────────────────────────────────────────┼──────────┐    │
│  │                  AGENT LOOP                   │          │    │
│  │                                               ▼          │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │    │
│  │  │ Pre-Hook │─►│ Execute  │─►│ Verify   │─►│Post-Hook│ │    │
│  │  │ (security│  │ (skill   │  │ (CoVe    │  │(memory, │ │    │
│  │  │  check)  │  │  calls)  │  │  loop)   │  │ metrics)│ │    │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────┘ │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                    SKILLS LAYER                            │    │
│  │  coding:generate │ coding:refactor │ git:clone │ git:pr   │    │
│  │  testing:run │ testing:lint │ analysis:scan │ analysis:deps│    │
│  └──────────────────────────────────────────────────────────┘    │
│                              │                                    │
│                              ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │              CF SANDBOX (execution environment)            │    │
│  │  git clone → npm install → edit files → run tests → PR    │    │
│  └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Agent Definitions

Inspired by the multi-agent patterns in `everything-claude-code` (13 specialized agents), adapted for our CF Workers + BYOK context.

### 2.1 Agent Interface

```typescript
// /core/agents/types.ts

interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  skills: string[];           // skill IDs this agent can use
  maxTokenBudget: number;     // per-invocation limit
  verificationRequired: boolean;
}

interface AgentTask {
  id: string;                 // UUID
  userId: string;             // google_sub from JWT
  transport: 'telegram' | 'ide' | 'queue';
  repo?: string;              // "PetrAnto/ai-hub"
  branch?: string;            // defaults to "main"
  instruction: string;        // natural language task
  files?: string[];           // scope to specific files
  mode: 'plan' | 'execute';
  model: string;              // user's preferred model
  apiKey: string;             // user's decrypted BYOK key (HTTPS only, never logged)
  budgetLimit?: number;       // max tokens
  context?: TaskContext;       // loaded by context-loader
  createdAt: number;
  status: TaskStatus;
}

type TaskStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'       // plan-only mode pauses here
  | 'executing'
  | 'verifying'
  | 'complete'
  | 'error';

interface TaskContext {
  repoStructure?: string;     // file tree (truncated)
  relevantFiles?: FileContent[];
  projectMemory?: string;     // from Storia's project_memory table
  agentRules?: string;        // user's .mdc rules
  previousTasks?: TaskSummary[]; // recent task history for continuity
}
```

### 2.2 Specialized Agents

```typescript
// /core/agents/planner.ts
export const plannerAgent: Agent = {
  id: 'planner',
  name: 'Planner',
  description: 'Analyzes task, scans codebase, proposes implementation plan',
  systemPrompt: `You are a senior software architect. Given a task and codebase context:
1. Identify ALL files that need changes
2. Estimate risk level per file (low/medium/high)
3. Propose ordered steps with clear descriptions
4. Flag any dependencies or blockers
5. Estimate token cost for execution

Output format: JSON { steps: PlanStep[], estimatedCost: number, filesAffected: string[], risks: string[] }

NEVER execute changes. ONLY plan.`,
  skills: ['analysis:scan', 'analysis:deps', 'git:clone'],
  maxTokenBudget: 8000,
  verificationRequired: false,
};

// /core/agents/executor.ts
export const executorAgent: Agent = {
  id: 'executor',
  name: 'Executor',
  description: 'Writes code, edits files, runs commands based on approved plan',
  systemPrompt: `You are a senior developer executing an approved plan.
For each step:
1. Read the target file(s)
2. Make the specified changes
3. Verify the change compiles/passes lint
4. Report what you changed and why

Rules:
- Follow existing code patterns in the repo
- Add Zod validation on any new API routes
- Write tests for new functions
- Never modify files outside the plan scope
- If a step fails, stop and report — don't improvise`,
  skills: ['coding:generate', 'coding:refactor', 'coding:debug', 'git:commit', 'testing:run', 'testing:lint'],
  maxTokenBudget: 50000,
  verificationRequired: true,
};

// /core/agents/reviewer.ts
export const reviewerAgent: Agent = {
  id: 'reviewer',
  name: 'Reviewer',
  description: 'Reviews code changes for quality, security, and correctness',
  systemPrompt: `You are a code reviewer. For each file diff:
1. Check for security issues (injection, XSS, SSRF, auth bypass)
2. Verify TypeScript types are correct (no \`as any\`)
3. Check edge runtime compatibility (no Node.js APIs on CF Workers)
4. Verify Zod validation on API routes
5. Check for test coverage on new functions

Output: { approved: boolean, issues: Issue[], suggestions: string[] }`,
  skills: ['analysis:scan', 'analysis:deps'],
  maxTokenBudget: 10000,
  verificationRequired: false,
};

// /core/agents/verifier.ts — CoVe (Chain of Verification)
export const verifierAgent: Agent = {
  id: 'verifier',
  name: 'Verifier',
  description: 'Independently verifies claims made by executor',
  systemPrompt: `You are a QA engineer. The executor claims it made changes.
Your job: INDEPENDENTLY VERIFY each claim.
1. Read the actual file content (not what executor says it is)
2. Run the actual tests
3. Check the actual git diff
4. Verify the build passes

For each claim, output: { claim: string, verified: boolean, evidence: string }

NEVER trust the executor's output. Always check yourself.`,
  skills: ['testing:run', 'testing:lint', 'git:diff', 'analysis:scan'],
  maxTokenBudget: 15000,
  verificationRequired: false,
};
```

### 2.3 Agent Router

```typescript
// /core/orchestrator/task-router.ts

import { plannerAgent, executorAgent, reviewerAgent, verifierAgent } from '../agents';

interface AgentPipeline {
  agents: Agent[];
  parallel: boolean;
}

export function routeTask(task: AgentTask): AgentPipeline {
  switch (task.mode) {
    case 'plan':
      return {
        agents: [plannerAgent],
        parallel: false,
      };

    case 'execute':
      return {
        agents: [
          plannerAgent,       // Step 1: Plan
          executorAgent,      // Step 2: Execute (after plan approval)
          reviewerAgent,      // Step 3: Review changes
          verifierAgent,      // Step 4: Verify claims
        ],
        parallel: false,      // Sequential — each depends on previous
      };
  }
}
```

---

## 3. Skills System

Inspired by `everything-claude-code`'s 43 skills, adapted for CF Workers environment.

### 3.1 Skill Interface

```typescript
// /core/skills/types.ts

interface Skill {
  id: string;                 // e.g. "coding:generate"
  category: SkillCategory;
  name: string;
  description: string;
  keywords: string[];         // for auto-matching
  execute: (input: SkillInput, sandbox: SandboxExecutor) => Promise<SkillOutput>;
  estimateTokens: (input: SkillInput) => number;
}

type SkillCategory = 'coding' | 'git' | 'testing' | 'analysis';

interface SkillInput {
  task: AgentTask;
  files?: FileContent[];
  previousOutput?: SkillOutput;  // chaining
  sandboxContext?: SandboxState;
}

interface SkillOutput {
  success: boolean;
  result: unknown;            // skill-specific output
  filesChanged?: FileDiff[];
  terminalOutput?: string;
  tokensUsed: number;
  duration: number;
}
```

### 3.2 Core Skills (Phase A — ship with MVP)

| Skill ID | Category | Description | CF Sandbox? |
|----------|----------|-------------|-------------|
| `coding:generate` | coding | Generate new code from description | No (LLM only) |
| `coding:refactor` | coding | Refactor existing code | No (LLM only) |
| `coding:debug` | coding | Analyze error, propose fix | No (LLM only) |
| `coding:explain` | coding | Explain code in context | No (LLM only) |
| `git:clone` | git | Clone repo into sandbox | Yes |
| `git:branch` | git | Create/switch branch | Yes |
| `git:commit` | git | Stage + commit changes | Yes |
| `git:pr` | git | Push branch + create PR via GitHub API | Yes |
| `git:diff` | git | Generate diff of current changes | Yes |
| `testing:run` | testing | Run `npm test` in sandbox | Yes |
| `testing:lint` | testing | Run `npm run lint` | Yes |
| `analysis:scan` | analysis | Scan codebase structure + file tree | Yes |
| `analysis:deps` | analysis | Check dependencies, audit security | Yes |

### 3.3 Skill Registry

```typescript
// /core/skills/skill-registry.ts

const skillRegistry = new Map<string, Skill>();

export function registerSkill(skill: Skill): void {
  skillRegistry.set(skill.id, skill);
}

export function getSkill(id: string): Skill | undefined {
  return skillRegistry.get(id);
}

export function matchSkills(instruction: string): Skill[] {
  const words = instruction.toLowerCase().split(/\s+/);
  return Array.from(skillRegistry.values())
    .filter(skill => skill.keywords.some(kw => words.includes(kw)))
    .sort((a, b) => {
      // Rank by keyword match density
      const aMatches = a.keywords.filter(kw => words.includes(kw)).length;
      const bMatches = b.keywords.filter(kw => words.includes(kw)).length;
      return bMatches - aMatches;
    });
}

// Auto-register all skills on Worker startup
export function initializeSkills(): void {
  // Coding skills
  registerSkill(codingGenerateSkill);
  registerSkill(codingRefactorSkill);
  registerSkill(codingDebugSkill);
  registerSkill(codingExplainSkill);
  // Git skills
  registerSkill(gitCloneSkill);
  registerSkill(gitBranchSkill);
  registerSkill(gitCommitSkill);
  registerSkill(gitPrSkill);
  registerSkill(gitDiffSkill);
  // Testing skills
  registerSkill(testingRunSkill);
  registerSkill(testingLintSkill);
  // Analysis skills
  registerSkill(analysisScanSkill);
  registerSkill(analysisDepsSkill);
}
```

### 3.4 Example Skill Implementation

```typescript
// /core/skills/coding/generate.ts

import type { Skill, SkillInput, SkillOutput } from '../types';

export const codingGenerateSkill: Skill = {
  id: 'coding:generate',
  category: 'coding',
  name: 'Code Generator',
  description: 'Generate new code from natural language description',
  keywords: ['create', 'generate', 'write', 'build', 'implement', 'add', 'new'],

  async execute(input: SkillInput, sandbox: SandboxExecutor): Promise<SkillOutput> {
    const startTime = Date.now();

    // Build prompt with context
    const prompt = buildCodeGenPrompt(input);

    // Call LLM via user's BYOK key
    const response = await callLLM({
      model: input.task.model,
      apiKey: input.task.apiKey,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      maxTokens: 4000,
    });

    // Parse structured output (file changes)
    const changes = parseCodeChanges(response.content);

    // Apply changes to sandbox if available
    let filesChanged: FileDiff[] = [];
    if (sandbox && changes.length > 0) {
      for (const change of changes) {
        const diff = await sandbox.writeFile(change.path, change.content);
        filesChanged.push(diff);
      }
    }

    return {
      success: true,
      result: { changes, explanation: response.content },
      filesChanged,
      tokensUsed: response.usage.totalTokens,
      duration: Date.now() - startTime,
    };
  },

  estimateTokens(input: SkillInput): number {
    // Rough estimate: context + instruction + output
    const contextTokens = (input.files?.reduce((sum, f) => sum + f.content.length / 4, 0)) ?? 0;
    return contextTokens + 2000; // 2k for instruction + response overhead
  },
};
```

---

## 4. Hook System

Event-driven automation inspired by `everything-claude-code`'s hook architecture and Wave 4 Additions §3.3.

### 4.1 Hook Interface

```typescript
// /core/hooks/types.ts

type HookEvent =
  | 'task:received'        // Task enters the system
  | 'task:planned'         // Plan generated
  | 'task:approved'        // User approved plan (IDE) or auto-approved (queue)
  | 'step:before'          // About to execute a step
  | 'step:after'           // Step completed
  | 'step:error'           // Step failed
  | 'file:modified'        // File was changed in sandbox
  | 'test:complete'        // Test run finished
  | 'task:complete'        // All steps done
  | 'task:error';          // Task failed unrecoverably

interface Hook {
  id: string;
  event: HookEvent;
  priority: number;         // Lower = runs first
  handler: (ctx: HookContext) => Promise<HookResult>;
}

interface HookContext {
  task: AgentTask;
  event: HookEvent;
  data: unknown;            // Event-specific payload
  sandbox?: SandboxExecutor;
  abortController: AbortController;
}

interface HookResult {
  continue: boolean;        // false = abort the pipeline
  modified?: unknown;       // Optional modified data to pass forward
  message?: string;         // Reason for abort or modification
}
```

### 4.2 Built-in Hooks

```typescript
// /core/hooks/pre-action.ts — Security gate

export const destructiveOpGuard: Hook = {
  id: 'security:destructive-op-guard',
  event: 'step:before',
  priority: 0,  // Always runs first
  async handler(ctx) {
    const step = ctx.data as PlanStep;

    // Block dangerous operations
    const destructivePatterns = [
      /rm\s+-rf/,
      /DROP\s+TABLE/i,
      /DELETE\s+FROM/i,
      /force\s+push/i,
      /--force/,
      /main\s+branch.*delete/i,
    ];

    for (const pattern of destructivePatterns) {
      if (pattern.test(step.description) || pattern.test(JSON.stringify(step))) {
        return {
          continue: false,
          message: `BLOCKED: Destructive operation detected — "${step.description}". Requires manual approval.`,
        };
      }
    }

    return { continue: true };
  },
};

// /core/hooks/post-action.ts — Memory + metrics

export const memoryUpdateHook: Hook = {
  id: 'memory:post-task-update',
  event: 'task:complete',
  priority: 10,
  async handler(ctx) {
    const result = ctx.data as TaskResult;

    // Store task summary in R2 for future context
    await ctx.sandbox?.r2Store.put(
      `tasks/${ctx.task.userId}/${ctx.task.id}.json`,
      JSON.stringify({
        instruction: ctx.task.instruction,
        filesChanged: result.filesChanged,
        tokensUsed: result.tokensUsed,
        cost: result.cost,
        completedAt: Date.now(),
      })
    );

    return { continue: true };
  },
};

// /core/hooks/on-error.ts — Model fallback

export const modelFallbackHook: Hook = {
  id: 'resilience:model-fallback',
  event: 'step:error',
  priority: 5,
  async handler(ctx) {
    const error = ctx.data as AgentError;

    // If rate limited or model unavailable, try fallback
    if (error.code === 'rate_limited' || error.code === 'model_unavailable') {
      const fallbackModel = getFallbackModel(ctx.task.model);
      if (fallbackModel) {
        ctx.task.model = fallbackModel;
        return {
          continue: true,
          message: `Falling back to ${fallbackModel} due to ${error.code}`,
        };
      }
    }

    return { continue: false, message: error.message };
  },
};
```

### 4.3 Hook Registry

```typescript
// /core/hooks/hook-registry.ts

const hooks = new Map<HookEvent, Hook[]>();

export function registerHook(hook: Hook): void {
  const existing = hooks.get(hook.event) ?? [];
  existing.push(hook);
  existing.sort((a, b) => a.priority - b.priority);
  hooks.set(hook.event, existing);
}

export async function triggerHooks(event: HookEvent, ctx: HookContext): Promise<boolean> {
  const eventHooks = hooks.get(event) ?? [];

  for (const hook of eventHooks) {
    const result = await hook.handler(ctx);

    if (!result.continue) {
      // Emit abort event to transport for user visibility
      ctx.task.status = 'error';
      emitEvent(ctx.task, {
        type: 'error',
        data: { message: result.message, code: 'hook_abort', recoverable: false },
      });
      return false; // Pipeline stops
    }

    // Pass modified data forward if hook changed it
    if (result.modified) {
      ctx.data = result.modified;
    }
  }

  return true; // All hooks passed
}
```

---

## 5. Context Management & Token Efficiency

Critical for CF Workers' 30-second CPU limit and keeping BYOK costs down.

### 5.1 Context Loading Strategy

```typescript
// /core/memory/context-loader.ts

export async function loadTaskContext(
  task: AgentTask,
  sandbox: SandboxExecutor,
  r2: R2Bucket
): Promise<TaskContext> {
  const context: TaskContext = {};

  // 1. Repo structure (always load, cheap)
  if (task.repo) {
    context.repoStructure = await sandbox.exec(
      `find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | head -200`
    );
  }

  // 2. Relevant files (smart selection based on instruction)
  if (task.files && task.files.length > 0) {
    // User specified files — load them directly
    context.relevantFiles = await loadFiles(sandbox, task.files);
  } else {
    // Auto-detect relevant files from instruction
    context.relevantFiles = await smartFileSelection(sandbox, task.instruction);
  }

  // 3. Project memory from Storia D1 (if available via callback)
  // Loaded by transport layer before calling agent core

  // 4. User's agent rules (.mdc files)
  const mdcContent = await sandbox.exec('cat .cursor/rules/*.mdc 2>/dev/null || cat .claude/rules/*.md 2>/dev/null || echo ""');
  if (mdcContent.trim()) {
    context.agentRules = mdcContent;
  }

  // 5. Recent task history (from R2)
  context.previousTasks = await loadRecentTasks(r2, task.userId, 5);

  return context;
}
```

### 5.2 Context Compaction

When context exceeds model limits, compress intelligently.

```typescript
// /core/memory/compactor.ts

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-sonnet-4-5-20250929': 200000,
  'claude-haiku-4-5-20251001': 200000,
  'claude-opus-4-6': 200000,
  'gpt-4o': 128000,
  'deepseek-chat': 64000,
};

export function compactContext(
  context: TaskContext,
  model: string,
  reserveForOutput: number = 8000
): TaskContext {
  const limit = (MODEL_CONTEXT_LIMITS[model] ?? 64000) - reserveForOutput;
  let currentTokens = estimateContextTokens(context);

  if (currentTokens <= limit) return context;

  // Compaction priority (remove least important first):
  // 1. Trim repo structure to top-level only
  if (context.repoStructure && currentTokens > limit) {
    context.repoStructure = truncateFileTree(context.repoStructure, 2); // depth 2
    currentTokens = estimateContextTokens(context);
  }

  // 2. Remove old task history
  if (context.previousTasks && currentTokens > limit) {
    context.previousTasks = context.previousTasks.slice(0, 2);
    currentTokens = estimateContextTokens(context);
  }

  // 3. Truncate large files (keep first 200 + last 50 lines)
  if (context.relevantFiles && currentTokens > limit) {
    context.relevantFiles = context.relevantFiles.map(f => ({
      ...f,
      content: truncateFileContent(f.content, 200, 50),
    }));
    currentTokens = estimateContextTokens(context);
  }

  // 4. Summarize agent rules
  if (context.agentRules && currentTokens > limit) {
    context.agentRules = context.agentRules.slice(0, 2000) + '\n[truncated]';
  }

  return context;
}
```

### 5.3 Prompt Caching (Cost Savings)

Use Anthropic's `cache_control` for 90% savings on repeated system prompts.

```typescript
// /core/memory/prompt-cache.ts

export function buildCachedMessages(
  agent: Agent,
  context: TaskContext,
  instruction: string
): AnthropicMessage[] {
  return [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: agent.systemPrompt,
          cache_control: { type: 'ephemeral' }, // Cache the static system prompt
        },
        ...(context.agentRules ? [{
          type: 'text' as const,
          text: `\n\nUser Agent Rules:\n${context.agentRules}`,
          cache_control: { type: 'ephemeral' as const },
        }] : []),
      ],
    },
    {
      role: 'user',
      content: buildUserPrompt(context, instruction),
    },
  ];
}
```

---

## 6. Main Agent Loop

The shared execution engine used by ALL transports.

```typescript
// /core/agent-loop.ts

import { routeTask } from './orchestrator/task-router';
import { triggerHooks } from './hooks/hook-registry';
import { loadTaskContext } from './memory/context-loader';
import { compactContext } from './memory/compactor';
import { getSkill } from './skills/skill-registry';

export interface AgentEvent {
  type: 'status' | 'plan' | 'file_diff' | 'terminal' | 'verification' | 'complete' | 'error';
  timestamp: number;
  data: unknown;
}

type EventEmitter = (event: AgentEvent) => void;

export async function executeTask(
  task: AgentTask,
  sandbox: SandboxExecutor,
  r2: R2Bucket,
  emit: EventEmitter
): Promise<TaskResult> {
  const startTime = Date.now();
  let totalTokens = 0;

  try {
    // Phase 1: Load context
    emit({ type: 'status', timestamp: Date.now(), data: { message: 'Loading context...', phase: 'setup', progress: 5 } });

    await triggerHooks('task:received', { task, event: 'task:received', data: task, sandbox, abortController: new AbortController() });

    let context = await loadTaskContext(task, sandbox, r2);
    context = compactContext(context, task.model);
    task.context = context;

    // Phase 2: Route to agent pipeline
    const pipeline = routeTask(task);

    for (const agent of pipeline.agents) {
      emit({ type: 'status', timestamp: Date.now(), data: { message: `${agent.name} working...`, phase: agent.id, progress: calculateProgress(agent, pipeline) } });

      // Check budget before each agent
      if (task.budgetLimit && totalTokens >= task.budgetLimit) {
        emit({ type: 'error', timestamp: Date.now(), data: { message: 'Budget limit reached', code: 'budget_exceeded', recoverable: false } });
        break;
      }

      // Pre-hook
      const hookCtx = { task, event: 'step:before' as const, data: { agent: agent.id }, sandbox, abortController: new AbortController() };
      const canProceed = await triggerHooks('step:before', hookCtx);
      if (!canProceed) break;

      // Execute agent's skills
      const agentResult = await executeAgent(agent, task, sandbox, emit);
      totalTokens += agentResult.tokensUsed;

      // Post-hook
      await triggerHooks('step:after', { ...hookCtx, event: 'step:after', data: agentResult });

      // Verification loop (if required by agent)
      if (agent.verificationRequired) {
        emit({ type: 'status', timestamp: Date.now(), data: { message: 'Verifying changes...', phase: 'verification' } });
        const verification = await runVerification(task, agentResult, sandbox, emit);
        totalTokens += verification.tokensUsed;

        if (!verification.allPassed) {
          emit({ type: 'verification', timestamp: Date.now(), data: verification });
          // Optionally retry or report
        }
      }

      // If planner agent in plan-only mode, emit plan and stop
      if (agent.id === 'planner' && task.mode === 'plan') {
        emit({ type: 'plan', timestamp: Date.now(), data: agentResult.result });
        break;
      }
    }

    // Phase 3: Complete
    const result: TaskResult = {
      summary: generateSummary(task),
      filesChanged: collectFileDiffs(task),
      tokensUsed: totalTokens,
      cost: calculateCost(totalTokens, task.model),
      duration: Date.now() - startTime,
    };

    await triggerHooks('task:complete', { task, event: 'task:complete', data: result, sandbox, abortController: new AbortController() });
    emit({ type: 'complete', timestamp: Date.now(), data: result });

    return result;

  } catch (error) {
    const agentError = { message: (error as Error).message, code: 'execution_error', recoverable: false };
    await triggerHooks('task:error', { task, event: 'task:error', data: agentError, sandbox, abortController: new AbortController() });
    emit({ type: 'error', timestamp: Date.now(), data: agentError });
    throw error;
  }
}
```

---

## 7. Transport Layer Implementations

### 7.1 HTTP/SSE Transport (Storia IDE)

**This is the primary new transport to build.**

```typescript
// /transports/http-sse.ts

import { executeTask } from '../core/agent-loop';
import { initializeSkills } from '../core/skills/skill-registry';
import { initializeHooks } from '../core/hooks/hook-registry';

// Initialize on Worker startup
initializeSkills();
initializeHooks();

export async function handleAgentTask(request: Request, env: Env): Promise<Response> {
  // 1. Validate JWT from storia.digital
  const jwt = request.headers.get('Authorization')?.replace('Bearer ', '');
  const claims = await validateStoriaJWT(jwt, env.STORIA_JWT_PUBLIC_KEY);
  if (!claims) return new Response('Unauthorized', { status: 401 });

  // 2. Parse request body
  const body = await request.json() as AgentTaskRequest;

  // 3. Validate with Zod
  const validation = agentTaskSchema.safeParse(body);
  if (!validation.success) {
    return new Response(JSON.stringify({ error: validation.error.issues }), { status: 400 });
  }

  // 4. Build AgentTask
  const task: AgentTask = {
    id: crypto.randomUUID(),
    userId: claims.sub,
    transport: 'ide',
    repo: body.repo,
    branch: body.branch ?? 'main',
    instruction: body.task,
    files: body.files,
    mode: body.mode,
    model: body.model ?? 'claude-sonnet-4-5-20250929',
    apiKey: body.anthropic_key,  // From BYOK vault, client-side decrypted
    budgetLimit: body.budget_limit,
    createdAt: Date.now(),
    status: 'queued',
  };

  // 5. Return SSE stream
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const emit = (event: AgentEvent) => {
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  // Execute in background (non-blocking)
  const sandbox = await env.SANDBOX.create();

  (async () => {
    try {
      await executeTask(task, sandbox, env.R2_BUCKET, emit);
    } catch (error) {
      emit({ type: 'error', timestamp: Date.now(), data: { message: (error as Error).message } });
    } finally {
      writer.close();
      await sandbox.destroy();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Task-Id': task.id,
    },
  });
}
```

### 7.2 Queue Transport (Dream Machine)

```typescript
// /transports/queue.ts

import { executeTask } from '../core/agent-loop';

export async function handleDreamBuild(message: QueueMessage, env: Env): Promise<void> {
  const job = message.body as DreamBuildJob;

  // Validate trust level
  const claims = await validateStoriaJWT(job.authToken, env.STORIA_JWT_PUBLIC_KEY);
  if (!['builder', 'shipper'].includes(claims.dreamTrustLevel)) {
    await callbackStatus(job.callbackUrl, { status: 'rejected', reason: 'Insufficient trust level' });
    return;
  }

  // Build task from Dream Machine spec
  const task: AgentTask = {
    id: job.jobId,
    userId: claims.sub,
    transport: 'queue',
    repo: `${job.repoOwner}/${job.repoName}`,
    branch: job.baseBranch,
    instruction: job.specMarkdown,  // The full .md spec IS the instruction
    mode: 'execute',
    model: 'claude-sonnet-4-5-20250929',
    apiKey: job.anthropicKey,
    budgetLimit: job.budget?.maxTokens,
    createdAt: Date.now(),
    status: 'queued',
  };

  const sandbox = await env.SANDBOX.create();

  // Emit via callback URL instead of SSE
  const emit = (event: AgentEvent) => {
    // Batch events and send via callback every 5 seconds
    batchCallback(job.callbackUrl, event);
  };

  try {
    const result = await executeTask(task, sandbox, env.R2_BUCKET, emit);
    await callbackStatus(job.callbackUrl, { status: 'complete', result });
  } catch (error) {
    await callbackStatus(job.callbackUrl, { status: 'error', error: (error as Error).message });
  } finally {
    await sandbox.destroy();
  }
}
```

### 7.3 Telegram Transport (Existing — Adapter)

```typescript
// /transports/telegram.ts (refactored from existing handler)

import { executeTask } from '../core/agent-loop';

export async function handleTelegramMessage(update: TelegramUpdate, env: Env): Promise<void> {
  const message = update.message;
  if (!message?.text) return;

  // Existing auth check (Telegram user ID + gateway token)
  const userId = await validateTelegramUser(message.from.id, env);
  if (!userId) return;

  // Adapt Telegram message → AgentTask
  const task: AgentTask = {
    id: crypto.randomUUID(),
    userId,
    transport: 'telegram',
    instruction: message.text,
    mode: detectMode(message.text),  // "/plan ..." → plan, else execute
    model: 'claude-sonnet-4-5-20250929',
    apiKey: env.ANTHROPIC_API_KEY,   // Moltworker uses PetrAnto's key for Telegram
    createdAt: Date.now(),
    status: 'queued',
  };

  // Emit via Telegram chat messages
  const emit = (event: AgentEvent) => {
    sendTelegramMessage(message.chat.id, formatEventForTelegram(event), env);
  };

  const sandbox = await env.SANDBOX.create();

  try {
    await executeTask(task, sandbox, env.R2_BUCKET, emit);
  } catch (error) {
    await sendTelegramMessage(message.chat.id, `❌ Error: ${(error as Error).message}`, env);
  } finally {
    await sandbox.destroy();
  }
}
```

---

## 8. Cloudflare Workers Constraints & Mitigations

### 8.1 Critical Limits

| Constraint | Limit | Mitigation |
|-----------|-------|------------|
| CPU time | 30s (Workers), 15min (Durable Objects) | Break large tasks into steps, checkpoint to R2 |
| Wall-clock time | 30s Workers, unbounded DO | Use Durable Objects for long tasks |
| Memory | 128MB | Stream file contents, don't load entire repos |
| Subrequests | 50 per invocation (Workers) | Batch API calls, use DO for multi-step |
| Request body | 100MB | Compress large specs, paginate file diffs |

### 8.2 Step Decomposition for Long Tasks

```typescript
// /core/orchestrator/step-planner.ts

const MAX_STEP_DURATION_MS = 25000; // Leave 5s buffer from 30s limit

export function decomposeTask(plan: PlanStep[]): TaskChunk[] {
  const chunks: TaskChunk[] = [];
  let currentChunk: PlanStep[] = [];
  let estimatedDuration = 0;

  for (const step of plan) {
    const stepDuration = estimateStepDuration(step);

    if (estimatedDuration + stepDuration > MAX_STEP_DURATION_MS) {
      // Save checkpoint and start new chunk
      chunks.push({
        steps: currentChunk,
        checkpoint: true,  // Save state to R2 before next chunk
      });
      currentChunk = [step];
      estimatedDuration = stepDuration;
    } else {
      currentChunk.push(step);
      estimatedDuration += stepDuration;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push({ steps: currentChunk, checkpoint: false });
  }

  return chunks;
}
```

### 8.3 Durable Object for Task State

```typescript
// /sandbox/task-state-do.ts

export class TaskStateDO implements DurableObject {
  state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/execute': {
        const task = await request.json() as AgentTask;
        // Durable Objects have 15-minute timeout — enough for complex tasks
        const result = await this.executeWithCheckpointing(task);
        return new Response(JSON.stringify(result));
      }
      case '/status': {
        const status = await this.state.storage.get('status');
        return new Response(JSON.stringify(status));
      }
      case '/cancel': {
        await this.state.storage.put('cancelled', true);
        return new Response('OK');
      }
    }

    return new Response('Not found', { status: 404 });
  }

  private async executeWithCheckpointing(task: AgentTask) {
    // Load checkpoint if resuming
    const checkpoint = await this.state.storage.get('checkpoint');

    // Execute with periodic state saves
    // ... (uses agent-loop.ts with checkpoint middleware)
  }
}
```

---

## 9. Security Requirements

### 9.1 BYOK Key Handling

```
CRITICAL: The user's API key is the most sensitive data in the system.

Rules:
1. Key arrives in HTTPS request body — NEVER in URL params, NEVER in headers
2. Key is NEVER logged, NEVER stored in R2, NEVER written to disk
3. Key exists only in Worker memory for the duration of the request
4. Key is passed to LLM API calls via Authorization header over HTTPS
5. If task is checkpointed (long-running), key must be re-provided on resume
6. Worker's wrangler.jsonc must NOT have any logging of request bodies
```

### 9.2 Sandbox Isolation

```
Per-user sandbox requirements:
1. Each task gets its own CF Sandbox instance
2. Sandbox is destroyed after task completion
3. No shared filesystem between users
4. Network access limited to: GitHub API, npm registry, LLM provider APIs
5. File size limits: 10MB per file, 500MB total per sandbox
6. No access to Worker env vars from within sandbox
```

### 9.3 Trust Gating (Dream Machine)

```
Trust levels (stored in Storia D1, verified via JWT claim):
- 👀 Observer: Cannot trigger agent
- 📋 Planner: Cannot trigger agent
- 🔨 Builder: Can trigger agent (write + PR only)
- 🚀 Shipper: Can trigger agent (write + PR + deploy)

JWT validation:
- storia-agent validates JWT signature against Storia's public key
- dreamTrustLevel claim must be present and sufficient
- JWT TTL: 5 minutes max
- Reuse existing Cloudflare Access + device-pairing middleware
```

---

## 10. Implementation Phases

### Phase A: Agent Core Engine (30h)

| Step | Task | Effort | Branch |
|------|------|--------|--------|
| A.1 | Refactor moltworker into `/core` + `/transports` structure | 4h | `claude/agent-core-refactor` |
| A.2 | Implement Agent interface + 4 specialized agents | 6h | `claude/agent-definitions` |
| A.3 | Implement Skill interface + 13 core skills | 8h | `claude/skill-system` |
| A.4 | Implement Hook system + 3 built-in hooks | 4h | `claude/hook-system` |
| A.5 | Implement context-loader + compactor | 4h | `claude/context-management` |
| A.6 | Implement main agent-loop.ts | 4h | `claude/agent-loop` |
| **Total** | | **30h** | |

**Validation**: Existing Telegram transport still works after refactor. Run existing test suite.

### Phase B: HTTP/SSE Transport (16h)

| Step | Task | Effort | Branch |
|------|------|--------|--------|
| B.1 | `/api/agent/task` endpoint + Zod validation | 4h | `claude/http-transport` |
| B.2 | SSE streaming implementation | 4h | `claude/sse-stream` |
| B.3 | JWT validation (storia.digital → storia-agent) | 4h | `claude/jwt-auth` |
| B.4 | `/api/agent/status/:taskId` endpoint | 2h | `claude/task-status` |
| B.5 | Integration test: end-to-end task execution via HTTP | 2h | `claude/http-integration-test` |
| **Total** | | **16h** | |

### Phase C: Storia IDE Frontend (24h) — Codex

| Step | Task | Effort | Branch |
|------|------|--------|--------|
| C.1 | `AgentPanel.tsx` — task input + mode selector | 8h | `codex/agent-panel` |
| C.2 | `AgentStream.tsx` — SSE consumer, live status rendering | 6h | `codex/agent-stream` |
| C.3 | `DiffViewer.tsx` — side-by-side diff in Monaco | 6h | `codex/diff-viewer` |
| C.4 | `TerminalOutput.tsx` — scrolling terminal pane | 2h | `codex/terminal-output` |
| C.5 | `AgentHistory.tsx` — past task results | 2h | `codex/agent-history` |
| **Total** | | **24h** | |

### Phase D: Durable Objects + Queue (12h)

| Step | Task | Effort | Branch |
|------|------|--------|--------|
| D.1 | TaskStateDO for long-running tasks | 4h | `claude/task-state-do` |
| D.2 | Queue consumer for Dream Machine | 4h | `claude/dream-queue` |
| D.3 | Step decomposition + checkpointing | 4h | `claude/step-checkpointing` |
| **Total** | | **12h** | |

### Phase E: BYOK Key Passthrough (4h)

| Step | Task | Effort | Branch |
|------|------|--------|--------|
| E.1 | Integrate byok-crypto for key decryption flow | 2h | `claude/byok-passthrough` |
| E.2 | Key lifecycle management (never log, memory-only) | 2h | `claude/key-security` |
| **Total** | | **4h** | |

---

## 11. Testing Requirements

### 11.1 Unit Tests (MANDATORY per phase)

```
Phase A tests:
- /core/agents/__tests__/task-router.test.ts — routing correctness
- /core/skills/__tests__/skill-registry.test.ts — registration, matching
- /core/hooks/__tests__/hook-registry.test.ts — trigger order, abort behavior
- /core/hooks/__tests__/destructive-op-guard.test.ts — blocks dangerous commands
- /core/memory/__tests__/compactor.test.ts — context fits within limits
- /core/memory/__tests__/context-loader.test.ts — loads correct files

Phase B tests:
- /transports/__tests__/http-sse.test.ts — SSE event format, auth rejection
- /api/__tests__/agent-task.test.ts — Zod validation, error responses
```

### 11.2 Integration Tests

```
- End-to-end: HTTP request → agent-loop → skill execution → SSE events
- Telegram adapter: message → agent-loop → Telegram response (existing tests still pass)
- Budget enforcement: task stops when token limit reached
- Hook abort: destructive op detected → pipeline stops → error event emitted
```

---

## 12. Files to Create/Modify

### New Files

```
src/core/agents/types.ts
src/core/agents/planner.ts
src/core/agents/executor.ts
src/core/agents/reviewer.ts
src/core/agents/verifier.ts
src/core/agents/index.ts
src/core/skills/types.ts
src/core/skills/skill-registry.ts
src/core/skills/coding/generate.ts
src/core/skills/coding/refactor.ts
src/core/skills/coding/debug.ts
src/core/skills/coding/explain.ts
src/core/skills/git/clone.ts
src/core/skills/git/branch.ts
src/core/skills/git/commit.ts
src/core/skills/git/pr.ts
src/core/skills/git/diff.ts
src/core/skills/testing/run.ts
src/core/skills/testing/lint.ts
src/core/skills/analysis/scan.ts
src/core/skills/analysis/deps.ts
src/core/orchestrator/task-router.ts
src/core/orchestrator/step-planner.ts
src/core/orchestrator/budget-tracker.ts
src/core/hooks/types.ts
src/core/hooks/hook-registry.ts
src/core/hooks/pre-action.ts
src/core/hooks/post-action.ts
src/core/hooks/on-error.ts
src/core/memory/context-loader.ts
src/core/memory/compactor.ts
src/core/memory/prompt-cache.ts
src/core/memory/r2-store.ts
src/core/agent-loop.ts
src/transports/http-sse.ts
src/transports/queue.ts
src/transports/telegram.ts          ← refactored from existing
src/api/agent/task.ts
src/api/agent/status.ts
src/api/dream-build.ts
src/api/health.ts
```

### Modified Files

```
wrangler.jsonc                       ← Add Durable Object + Queue bindings
src/index.ts                         ← Add HTTP route handlers
package.json                         ← Any new dependencies (should be minimal)
```

---

## 13. Environment Variables & Bindings

```jsonc
// wrangler.jsonc additions
{
  "durable_objects": {
    "bindings": [
      { "name": "TASK_STATE", "class_name": "TaskStateDO" }
    ]
  },
  "queues": {
    "consumers": [
      { "queue": "dream-build-queue", "max_batch_size": 1 }
    ],
    "producers": [
      { "queue": "dream-build-queue", "binding": "DREAM_QUEUE" }
    ]
  },
  "vars": {
    "STORIA_JWT_PUBLIC_KEY": "...",   // For validating storia.digital JWTs
    "STORIA_MOLTWORKER_SECRET": "..." // Shared secret for Dream Machine callbacks
  }
}
```

---

## 14. Success Criteria

| Metric | Target |
|--------|--------|
| Telegram still works after refactor | 100% existing tests pass |
| HTTP task → plan response | < 10s for simple tasks |
| HTTP task → full execution | < 60s for single-file changes |
| SSE events delivered in order | 100% |
| Destructive op guard blocks `rm -rf` | 100% |
| Budget limit stops execution | Within 5% of limit |
| BYOK key never appears in logs | 100% (audit Worker logs) |
| Context compaction keeps within model limits | 100% |

---

## 15. Reference Repos (Study, Don't Copy)

These repos informed this spec's architecture. Study their **patterns**, not their code (they target CLI, we target CF Workers).

| Repo | Stars | What to Study |
|------|-------|---------------|
| [everything-claude-code](https://github.com/affaan-m/everything-claude-code) | 49k | Agent definitions, skill decomposition, verification loops, token efficiency |
| [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | 24.6k | Ecosystem overview, AgentSys workflow patterns, Auto-Claude SDLC |
| [steipete/agent-rules](https://github.com/steipete/agent-rules) | 5.3k | .mdc rule format parsing, user-defined agent rules |
| [Trigger.dev](https://trigger.dev) | Growing | Durable workflow patterns for long-running tasks |

**Key adaptations from CLI → CF Workers:**
- No filesystem persistence → use R2
- No long-running processes → use Durable Objects + step decomposition
- No stdio → use SSE/WebSocket
- No local git → use GitHub API + CF Sandbox
- Single API key → BYOK multi-key passthrough

---

## 16. Conventions Reminder

```
Branch naming:    claude/agent-[task-name]
Commits:          feat: description / fix: description
Validation:       Zod on ALL new API endpoints
Logging:          createApiContext pattern (NEVER log API keys)
Tests:            MANDATORY per phase — run `npm run test`
Conflict resolve: test-results-summary.json → always --theirs
Doc sync:         Update GLOBAL_ROADMAP.md + claude-log.md after each phase
Edge compat:      No Node.js APIs — CF Workers runtime only
TypeScript:       No `as any` — proper types everywhere
```

---

## 17. What NOT to Build (Out of Scope)

- **User Agent Rules UI** → Phase 2.9, separate spec
- **Gecko personality injection** → Separate from agent core, layered on top
- **GeScore integration** → Post-MVP, hooks will support it later
- **Multi-model orchestration in agent** → Agent uses single model per task; multi-model is Storia's orchestrator concern
- **WebSocket transport** → Phase D only, SSE is sufficient for MVP
- **Deploy capability** → 🚀 Shipper tier, post-MVP

---

*This spec supersedes `AGENT_MODE_SPEC.md` v1.0 for implementation purposes. The parent spec remains valid for architectural context and competitive positioning.*
