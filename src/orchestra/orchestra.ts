/**
 * Orchestra Mode
 *
 * Structured workflow that instructs the AI model to:
 * 1. Read the task prompt and understand the target repo
 * 2. Plan the approach
 * 3. Execute — modify code using GitHub tools or sandbox
 * 4. Create a PR with branch named bot/{task-slug}-{model}
 * 5. Update orchestra history in R2 for continuity across tasks
 */

// Orchestra task entry stored in R2
export interface OrchestraTask {
  taskId: string;
  timestamp: number;
  modelAlias: string;
  repo: string;            // owner/repo
  prompt: string;          // Original user prompt (truncated)
  branchName: string;      // Branch created
  prUrl?: string;          // PR URL if created
  status: 'started' | 'completed' | 'failed';
  filesChanged: string[];  // List of file paths touched
  summary?: string;        // AI-generated summary of what was done
}

// Per-user orchestra history stored in R2
export interface OrchestraHistory {
  userId: string;
  tasks: OrchestraTask[];
  updatedAt: number;
}

const MAX_HISTORY_TASKS = 30;

/**
 * Build the orchestra system prompt.
 * This is injected as the system message when /orchestra is used.
 * It instructs the model to follow the structured workflow.
 */
export function buildOrchestraPrompt(params: {
  repo: string;
  modelAlias: string;
  previousTasks: OrchestraTask[];
}): string {
  const { repo, modelAlias, previousTasks } = params;
  const [owner, repoName] = repo.split('/');

  // Format previous task context
  let historyContext = '';
  if (previousTasks.length > 0) {
    const recent = previousTasks.slice(-5);
    const lines = recent.map(t => {
      const status = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⏳';
      const pr = t.prUrl ? ` → ${t.prUrl}` : '';
      const summary = t.summary ? ` — ${t.summary.substring(0, 100)}` : '';
      return `  ${status} [${t.branchName}] "${t.prompt.substring(0, 80)}"${pr}${summary}`;
    });
    historyContext = `\n\n## Previous Orchestra Tasks (most recent)\n${lines.join('\n')}\n\nUse this history to understand what has already been done. Avoid duplicating work.`;
  }

  return `# Orchestra Mode — Structured Task Workflow

You are operating in Orchestra Mode. Follow this workflow precisely:

## Target Repository
- Owner: ${owner}
- Repo: ${repoName}
- Full: ${repo}

## Workflow Steps

### Step 1: UNDERSTAND
- Read the user's task prompt carefully
- Use \`github_list_files\` and \`github_read_file\` to understand the repo structure
- Identify the files that need to be changed
- Read existing conventions (naming, patterns, imports)

### Step 2: PLAN
- Outline your approach in 3-5 bullet points
- List the files you will create/modify/delete
- Identify any dependencies or risks

### Step 3: EXECUTE
- Make the code changes using either:
  - \`github_create_pr\` for simple changes (up to ~10 files)
  - \`sandbox_exec\` for complex changes (clone, build, test, push)
- Follow existing code conventions
- Include proper types (no \`any\`)
- Write tests if the repo has a test pattern

### Step 4: CREATE PR
- Branch name MUST follow: \`{task-slug}-${modelAlias}\`
  (the bot/ prefix is added automatically by github_create_pr)
- PR title: concise, under 70 characters
- PR body: include a summary of changes and a test plan
- If using sandbox_exec for git operations, name the branch: \`bot/{task-slug}-${modelAlias}\`

### Step 5: REPORT
- After creating the PR, provide a structured summary:
  \`\`\`
  ORCHESTRA_RESULT:
  branch: <branch-name>
  pr: <pr-url>
  files: <comma-separated list of changed files>
  summary: <1-2 sentence summary of what was done>
  \`\`\`
- This format is parsed automatically for history tracking.

## Rules
- Always create a PR — never just describe what should be done
- One PR per task — keep changes focused
- Use the model alias "${modelAlias}" in branch names for traceability
- Do NOT modify unrelated files
- If the task is unclear, read the repo first, then ask for clarification in your response
${historyContext}`;
}

/**
 * Parse the ORCHESTRA_RESULT block from the model's final response.
 * Returns extracted metadata or null if not found.
 */
export function parseOrchestraResult(response: string): {
  branch: string;
  prUrl: string;
  files: string[];
  summary: string;
} | null {
  const match = response.match(/ORCHESTRA_RESULT:\s*\n([\s\S]*?)(?:```|$)/);
  if (!match) return null;

  const block = match[1];
  // Parse each field line-by-line to avoid cross-line matching
  const lines = block.split('\n');
  let branch = '';
  let prUrl = '';
  let filesLine = '';
  let summary = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('branch:')) {
      branch = trimmed.slice('branch:'.length).trim();
    } else if (trimmed.startsWith('pr:')) {
      prUrl = trimmed.slice('pr:'.length).trim();
    } else if (trimmed.startsWith('files:')) {
      filesLine = trimmed.slice('files:'.length).trim();
    } else if (trimmed.startsWith('summary:')) {
      summary = trimmed.slice('summary:'.length).trim();
    }
  }

  const files = filesLine
    .split(',')
    .map(f => f.trim())
    .filter(Boolean);

  if (!branch && !prUrl) return null;

  return { branch, prUrl, files, summary };
}

/**
 * Generate a URL-safe task slug from a prompt.
 * Example: "Add dark mode toggle" → "add-dark-mode-toggle"
 */
export function generateTaskSlug(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 40)
    .replace(/-+$/, '');
}

/**
 * Parse the /orchestra command arguments.
 * Format: /orchestra owner/repo <prompt>
 * Returns null if invalid.
 */
export function parseOrchestraCommand(args: string[]): {
  repo: string;
  prompt: string;
} | null {
  if (args.length < 2) return null;

  const repo = args[0];
  // Validate owner/repo format
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) return null;

  const prompt = args.slice(1).join(' ').trim();
  if (!prompt) return null;

  return { repo, prompt };
}

// === R2 History Management ===

/**
 * Load orchestra history from R2.
 */
export async function loadOrchestraHistory(
  r2: R2Bucket,
  userId: string
): Promise<OrchestraHistory | null> {
  const key = `orchestra/${userId}/history.json`;
  try {
    const obj = await r2.get(key);
    if (!obj) return null;
    return await obj.json() as OrchestraHistory;
  } catch {
    return null;
  }
}

/**
 * Store an orchestra task entry in R2 history.
 */
export async function storeOrchestraTask(
  r2: R2Bucket,
  userId: string,
  task: OrchestraTask
): Promise<void> {
  const key = `orchestra/${userId}/history.json`;

  let history: OrchestraHistory;
  try {
    const obj = await r2.get(key);
    if (obj) {
      history = await obj.json() as OrchestraHistory;
    } else {
      history = { userId, tasks: [], updatedAt: Date.now() };
    }
  } catch {
    history = { userId, tasks: [], updatedAt: Date.now() };
  }

  history.tasks.push(task);

  // Keep only the most recent tasks
  if (history.tasks.length > MAX_HISTORY_TASKS) {
    history.tasks = history.tasks.slice(-MAX_HISTORY_TASKS);
  }

  history.updatedAt = Date.now();
  await r2.put(key, JSON.stringify(history));
}

/**
 * Format orchestra history for display to the user.
 */
export function formatOrchestraHistory(history: OrchestraHistory | null): string {
  if (!history || history.tasks.length === 0) {
    return '📋 No orchestra tasks yet.\n\nUsage: /orchestra owner/repo <task description>';
  }

  const lines: string[] = ['📋 Orchestra Task History\n'];

  for (const task of history.tasks.slice(-10).reverse()) {
    const status = task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : '⏳';
    const date = new Date(task.timestamp).toLocaleDateString();
    const pr = task.prUrl ? `\n   PR: ${task.prUrl}` : '';
    const summary = task.summary ? `\n   ${task.summary}` : '';
    lines.push(
      `${status} ${task.repo} — ${task.prompt.substring(0, 60)}${task.prompt.length > 60 ? '...' : ''}` +
      `\n   🤖 /${task.modelAlias} | 🌿 ${task.branchName} | ${date}${pr}${summary}`
    );
  }

  return lines.join('\n\n');
}
