# Codex Task: Phase 5.4 — Acontext Disk for File Management

## Goal

Add file management tools (`save_file`, `read_file`, `list_files`, `delete_file`) backed by Acontext Disk API. This gives the bot persistent file storage across tool calls and task resumes — models can save intermediate results, read previous artifacts, and manage a virtual workspace.

## Current State

- **Acontext client exists:** `src/acontext/client.ts` — REST client with sessions, messages, configs. 45 tests.
- **Workspace tools exist:** `src/openrouter/tools.ts` — `workspace_write_file`, `workspace_delete_file`, `workspace_commit` (lines 501-542) — these are GitHub-staging tools, NOT general file storage.
- **R2 storage exists** — Used for checkpoints, learnings, history. Not exposed as a tool to models.
- **ACONTEXT_API_KEY:** Already in Cloudflare Workers secrets.

## Spec (from brainstorming/tool-calling-analysis.md §4.2)

Acontext Disk provides:
- Virtual filesystem per session
- File persistence across calls
- Prefix-based listing (directory-like)
- Integration with Sandbox (code can read/write disk files)

## Implementation Plan

### 1. Extend Acontext Client (`src/acontext/client.ts`)

Add disk methods:

```typescript
async writeFile(params: {
  sessionId: string;
  name: string;
  content: string;
}): Promise<{ success: boolean; bytesWritten: number }>

async readFile(params: {
  sessionId: string;
  name: string;
}): Promise<{ content: string; size: number } | null>

async listFiles(params: {
  sessionId: string;
  prefix?: string;
}): Promise<Array<{ name: string; size: number; updatedAt: string }>>

async deleteFile(params: {
  sessionId: string;
  name: string;
}): Promise<{ success: boolean }>
```

Use the Acontext Disk REST API. Check Acontext docs for exact endpoints.

### 2. Add Tool Definitions (`src/openrouter/tools.ts`)

Add 4 tools to `AVAILABLE_TOOLS`:

```typescript
// save_file
{
  type: 'function',
  function: {
    name: 'save_file',
    description: 'Save content to a persistent file. Files persist across tool calls and task resumes. Use for storing intermediate results, notes, or generated content.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name or path (e.g., "results.json", "data/output.csv")' },
        content: { type: 'string', description: 'File content to save' }
      },
      required: ['name', 'content']
    }
  }
}

// read_file (distinct from github_read_file)
{
  type: 'function',
  function: {
    name: 'read_saved_file',
    description: 'Read a previously saved file from persistent storage. Use to retrieve intermediate results or artifacts saved with save_file.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name or path to read' }
      },
      required: ['name']
    }
  }
}

// list_files (distinct from github_list_files)
{
  type: 'function',
  function: {
    name: 'list_saved_files',
    description: 'List files in persistent storage. Optionally filter by prefix (directory-like path).',
    parameters: {
      type: 'object',
      properties: {
        prefix: { type: 'string', description: 'Optional prefix to filter files (e.g., "data/" to list files in data directory)' }
      },
      required: []
    }
  }
}

// delete_file
{
  type: 'function',
  function: {
    name: 'delete_saved_file',
    description: 'Delete a file from persistent storage.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name or path to delete' }
      },
      required: ['name']
    }
  }
}
```

**Important:** Use `read_saved_file`, `list_saved_files`, `delete_saved_file` to avoid confusion with `github_read_file` and `github_list_files`.

### 3. Implement Tool Execution (`src/openrouter/tools.ts`)

Add cases to `executeTool()` switch. Example for `save_file`:

```typescript
case 'save_file': {
  const { name, content } = toolArgs as { name: string; content: string };

  if (!context.acontextClient) {
    return 'Error: File storage not available (Acontext not configured)';
  }

  // Validate file name (no path traversal)
  if (name.includes('..') || name.startsWith('/')) {
    return 'Error: Invalid file name. Use relative paths without ".."';
  }

  // Size limit: 1MB
  if (content.length > 1_000_000) {
    return 'Error: File too large (max 1MB)';
  }

  const result = await context.acontextClient.writeFile({
    sessionId: context.acontextSessionId || 'default',
    name,
    content,
  });

  return `File saved: ${name} (${result.bytesWritten} bytes)`;
}
```

Follow the same pattern for `read_saved_file`, `list_saved_files`, `delete_saved_file`.

### 4. Add to PARALLEL_SAFE_TOOLS

- `read_saved_file` — YES, add to PARALLEL_SAFE_TOOLS (read-only)
- `list_saved_files` — YES, add to PARALLEL_SAFE_TOOLS (read-only)
- `save_file` — NO (mutates state)
- `delete_saved_file` — NO (mutates state)

### 5. Wire ToolContext

Same as Phase 5.3 — `acontextClient` and `acontextSessionId` in ToolContext. If 5.3 is done first, this is already wired. If not, add it:

```typescript
// ToolContext interface addition:
acontextClient?: AcontextClient;
acontextSessionId?: string;
```

### 6. Security

- **Path traversal:** Block `..`, absolute paths, and null bytes in file names
- **Size limits:** 1MB per file, 100 files per session
- **No binary:** Only text content (check for null bytes)
- **Sanitize names:** Strip control characters, limit length to 255 chars

## Tests

Create `src/acontext/disk.test.ts`:

1. **Acontext client disk methods** — mock HTTP, verify request format
2. **save_file tool** — success, too large, invalid name, no client
3. **read_saved_file tool** — success, file not found, no client
4. **list_saved_files tool** — with prefix, without prefix, empty result
5. **delete_saved_file tool** — success, file not found
6. **Security** — path traversal blocked, null bytes blocked, size limit enforced
7. **PARALLEL_SAFE_TOOLS** — verify read/list are in whitelist, save/delete are not

Target: 20+ new tests.

## Key Files to Modify

| File | Change |
|------|--------|
| `src/acontext/client.ts` | Add `writeFile()`, `readFile()`, `listFiles()`, `deleteFile()` methods |
| `src/openrouter/tools.ts` | Add 4 tool definitions + execution cases |
| `src/telegram/handler.ts` | Pass `acontextClient` in ToolContext (if not done in 5.3) |
| `src/durable-objects/task-processor.ts` | Pass `acontextClient` in ToolContext (if not done in 5.3) |
| `src/acontext/disk.test.ts` | New test file |

## Validation

```bash
npm test -- --reporter=verbose 2>&1 | tail -20
npm run typecheck
```

All existing tests must pass. No `any` types. Follow existing tool patterns for error handling and output formatting.
