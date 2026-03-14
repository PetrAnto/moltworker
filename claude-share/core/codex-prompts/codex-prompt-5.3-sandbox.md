# Codex Task: Phase 5.3 — Acontext Sandbox for Code Execution

## Goal

Add a `run_code` tool that executes Python, JavaScript, or Bash code in an Acontext Sandbox. This replaces the current `sandbox_exec` tool (which only does bash via Cloudflare containers) with a multi-language, persistent, Acontext-backed execution environment.

## Current State

- **Acontext client exists:** `src/acontext/client.ts` — REST client with session management, message storage, config updates. 45 tests.
- **sandbox_exec exists:** `src/openrouter/tools.ts` lines 582-599 (definition), 2467-2584 (implementation) — bash-only, ephemeral, Cloudflare Sandbox container.
- **ToolContext interface:** `src/openrouter/tools.ts` lines 79-89 — already has `sandbox?: SandboxLike`.
- **ACONTEXT_API_KEY:** Already configured in Cloudflare Workers secrets (used for Phase 2.3 observability).

## Spec (from brainstorming/tool-calling-analysis.md §4.2)

Acontext Sandbox provides:
- Isolated environment per session
- Multi-language: Python, JavaScript, Bash
- Access to Acontext Disk files (read artifacts, write results)
- Skill mounting at `/skills/{name}/`
- OpenAI-compatible tool schemas

## Implementation Plan

### 1. Extend Acontext Client (`src/acontext/client.ts`)

Add sandbox methods:

```typescript
async executeCode(params: {
  sessionId: string;
  language: 'python' | 'javascript' | 'bash';
  code: string;
  timeout?: number;  // default 30s, max 120s
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
}>
```

Use the Acontext Sandbox REST API. Check Acontext docs for the exact endpoint (likely `POST /v1/sandbox/execute` or similar).

### 2. Add `run_code` Tool Definition (`src/openrouter/tools.ts`)

Add to `AVAILABLE_TOOLS` array:

```typescript
{
  type: 'function',
  function: {
    name: 'run_code',
    description: 'Execute code in a sandboxed environment. Supports Python, JavaScript, and Bash. Use for calculations, data processing, testing code snippets, or running scripts. Files saved to disk persist across calls.',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['python', 'javascript', 'bash'],
          description: 'Programming language to execute'
        },
        code: {
          type: 'string',
          description: 'Code to execute'
        },
        timeout: {
          type: 'number',
          description: 'Execution timeout in seconds (default: 30, max: 120)'
        }
      },
      required: ['language', 'code']
    }
  }
}
```

### 3. Implement Tool Execution (`src/openrouter/tools.ts`)

Add `run_code` case to `executeTool()` switch:

```typescript
case 'run_code': {
  const { language, code, timeout } = toolArgs as {
    language: 'python' | 'javascript' | 'bash';
    code: string;
    timeout?: number;
  };

  if (!context.acontextClient) {
    return 'Error: Code execution not available (Acontext not configured)';
  }

  // Validate timeout
  const execTimeout = Math.min(Math.max(timeout || 30, 5), 120);

  // Execute via Acontext Sandbox
  const result = await context.acontextClient.executeCode({
    sessionId: context.acontextSessionId || 'default',
    language,
    code,
    timeout: execTimeout,
  });

  // Format output
  let output = '';
  if (result.stdout) output += result.stdout;
  if (result.stderr) output += (output ? '\n\nSTDERR:\n' : 'STDERR:\n') + result.stderr;
  if (!output) output = `(no output, exit code: ${result.exitCode})`;

  // Truncate (match existing 50KB limit)
  if (output.length > 50000) {
    output = output.substring(0, 50000) + '\n... (truncated)';
  }

  return output;
}
```

### 4. Wire ToolContext (`src/telegram/handler.ts` + `src/durable-objects/task-processor.ts`)

Add `acontextClient` and `acontextSessionId` to ToolContext. Pass through from env:

```typescript
// In handler.ts where ToolContext is built:
acontextClient: createAcontextClient(env.ACONTEXT_API_KEY),
acontextSessionId: taskId,

// In task-processor.ts where ToolContext is built:
acontextClient: this.acontextClient,
acontextSessionId: this.taskId,
```

### 5. Add to PARALLEL_SAFE_TOOLS

`run_code` is **NOT** parallel-safe (it mutates sandbox state). Do NOT add it to `PARALLEL_SAFE_TOOLS`.

### 6. Keep `sandbox_exec` as Fallback

Don't remove `sandbox_exec` — it works without Acontext. `run_code` is the upgrade path. If Acontext is unavailable, models can still use `sandbox_exec` for bash.

## Tests

Create `src/acontext/sandbox.test.ts`:

1. **Unit tests for Acontext client sandbox methods** — mock HTTP responses
2. **Tool execution tests** — mock acontextClient, verify run_code dispatches correctly
3. **Error handling** — timeout, network error, invalid language, code too long
4. **Output truncation** — verify 50KB limit
5. **Missing client** — verify graceful error when Acontext not configured

Target: 20+ new tests.

## Key Files to Modify

| File | Change |
|------|--------|
| `src/acontext/client.ts` | Add `executeCode()` method |
| `src/openrouter/tools.ts` | Add `run_code` tool definition + execution |
| `src/telegram/handler.ts` | Pass `acontextClient` in ToolContext |
| `src/durable-objects/task-processor.ts` | Pass `acontextClient` in ToolContext |
| `src/acontext/sandbox.test.ts` | New test file |

## Validation

```bash
npm test -- --reporter=verbose 2>&1 | tail -20
npm run typecheck
```

All existing tests must pass. No `any` types. Follow existing patterns in tools.ts for error handling and output formatting.
