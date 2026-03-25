/**
 * Orchestra Mode
 *
 * Two-mode structured workflow:
 *
 * INIT mode: Takes a complex project description and creates:
 *   - ROADMAP.md — phased task breakdown with status markers
 *   - WORK_LOG.md — empty log ready for entries
 *   - Any other scaffold docs the project needs
 *   All delivered as a PR.
 *
 * RUN mode: Picks up the next task from ROADMAP.md (or a specific one):
 *   - Reads the roadmap to find the next uncompleted task
 *   - Implements the task
 *   - Creates a PR with code changes + updated ROADMAP.md + WORK_LOG.md entry
 */

import { getModel } from '../../openrouter/models';
import type { OrchestraDraft } from '../../openrouter/storage';

// Orchestra task entry stored in R2
export interface OrchestraTask {
  taskId: string;
  timestamp: number;
  modelAlias: string;
  repo: string;            // owner/repo
  mode: 'init' | 'run' | 'redo' | 'do' | 'draft';
  prompt: string;          // Original user prompt (truncated)
  branchName: string;      // Branch created
  durationMs?: number;     // Execution duration in milliseconds
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

// Repo health check thresholds — files above these limits should be split
// before the bot attempts modifications
export const LARGE_FILE_THRESHOLD_LINES = 500;
export const LARGE_FILE_THRESHOLD_KB = 30;
// Warning zone: files approaching the threshold get flagged in the roadmap
// so splitting is planned before they become blockers
export const LARGE_FILE_WARNING_LINES = 400;

// Common file names the model should look for as existing roadmaps
const ROADMAP_FILE_CANDIDATES = [
  'ROADMAP.md',
  'roadmap.md',
  'TODO.md',
  'todo.md',
  'docs/ROADMAP.md',
  'docs/roadmap.md',
  'docs/status.md',
  '.github/ROADMAP.md',
];

// ============================================================
// INIT MODE — Create roadmap + scaffold from project description
// ============================================================

/**
 * Build the system prompt for /orchestra init.
 * Instructs the model to analyze a project description and produce
 * a ROADMAP.md + WORK_LOG.md as a PR.
 */
export function buildInitPrompt(params: {
  repo: string;
  modelAlias: string;
  branchSlug?: string; // Pre-generated branch slug (without bot/ prefix)
}): string {
  const { repo, modelAlias, branchSlug } = params;
  const [owner, repoName] = repo.split('/');
  const branch = branchSlug || `roadmap-init-${modelAlias}`;

  return `# Orchestra INIT Mode — Project Roadmap Creation

You are a PLANNER, not an implementer. Your ONLY job is to create ROADMAP.md and WORK_LOG.md.

**CRITICAL — NO IMPLEMENTATION:**
- Your PR must ONLY contain ROADMAP.md and WORK_LOG.md
- DO NOT create, modify, or include any source code files (.ts, .tsx, .js, .jsx, .py, .vue, .css, .html, etc.)
- DO NOT write any implementation code — only plan what needs to be done
- If you create any file other than ROADMAP.md and WORK_LOG.md, the task is FAILED

## Target Repository
- Owner: ${owner}
- Repo: ${repoName}
- Full: ${repo}

## Workflow

### Step 1: UNDERSTAND THE REPO (STRICT BUDGET: max 5 file reads total)
**Be efficient — read only what you need, then move to Step 3 quickly.**
**HARD LIMIT: You have a budget of 12 total tool calls for init. Plan accordingly: list_files → 2-3 read_file → create_pr.**
- If the user asks to COPY or USE an existing roadmap, just find it and copy it — skip analysis.
- Use \`github_list_files\` to scan the root and main source directory
- Use \`github_read_file\` to read ONLY these key files:
  - README.md (project overview)
  - package.json or equivalent (dependencies, scripts)
  - Any existing roadmap: ${ROADMAP_FILE_CANDIDATES.join(', ')}
  - 1-2 main source files (entry point, main component)
- Do NOT read every file — the listing gives you enough structure info
- Do NOT re-read a file you already read — use the content from the first read

### Step 1.5: FLAG LARGE FILES (skip if user asked to copy existing roadmap)
- Note file sizes from the listing to flag large files (>${LARGE_FILE_THRESHOLD_LINES} lines or ~${LARGE_FILE_THRESHOLD_KB}KB)
- Also flag files in the WARNING ZONE: ${LARGE_FILE_WARNING_LINES}-${LARGE_FILE_THRESHOLD_LINES} lines
- Only check source code files (.ts, .tsx, .js, .jsx, .py, .vue, .svelte, etc.) — skip config, generated, and lock files
- Record which files are large and what they contain

### Step 2: ANALYZE THE PROJECT REQUEST
- Read the user's project description carefully
- Break it down into concrete, implementable phases
- Each phase should have 2-5 specific tasks
- Order tasks by dependency (foundations first)

### Step 3: CREATE ROADMAP.md
Write a \`ROADMAP.md\` file with this exact format:

\`\`\`markdown
# Project Roadmap

> Auto-generated by Orchestra Mode | Model: ${modelAlias} | {date}

## Overview
{1-2 sentence project summary}

## Phases

### Phase 1: {phase name}
- [ ] **Task 1.1**: {task title}
  - Description: {what needs to be done}
  - Files: {likely files to create/modify}
  - Depends on: {none or task IDs}
- [ ] **Task 1.2**: {task title}
  ...

### Phase 2: {phase name}
- [ ] **Task 2.1**: {task title}
  ...

## Notes
{any architectural decisions, risks, or open questions}
\`\`\`

Key rules for the roadmap:
- Use \`- [ ]\` for pending tasks, \`- [x]\` for completed
- Task titles should be specific enough to act on (e.g., "Add JWT auth middleware" not "Handle auth")
- Include file hints so the next run knows where to work
- Include dependency info so tasks execute in order. Always extract leaf modules first (modules that no other modules depend on) before extracting parent modules.
- 3-6 phases is typical, each with 2-5 tasks

**CRITICAL — ATOMIC REFACTORING TASKS:**
When a task involves moving code from one file to new module files, the ENTIRE move (create new file + add imports + DELETE from source) MUST be ONE task. NEVER split "create modules" and "update source file" into separate tasks.
- Each task = create + import + DELETE — all three in ONE task
- Use the word "DELETE" explicitly — never say "modify" for code removal
- Anchor on function/const/component NAMES, not line numbers (they shift)
- Include a verification gate (e.g., "grep for 'function X' returns 0 in source file")
- Extract in topological order: leaf dependencies first, then parents
- One extraction per task — don't combine multiple unrelated extractions
- List ALL cross-file references — if other files import the extracted code, update their imports in the same task

- **Large file splitting:** If Step 1.5 found large files (>${LARGE_FILE_THRESHOLD_LINES} lines) or warning-zone files (>${LARGE_FILE_WARNING_LINES} lines), add extraction tasks EARLY in the roadmap. Use \`github_create_pr\` with BOTH new modules AND updated source in a SINGLE PR call.

### Step 4: CREATE or UPDATE WORK_LOG.md
**CRITICAL — WORK_LOG.md is APPEND-ONLY and FORMAT-PRESERVING:**
- If WORK_LOG.md already exists, use \`github_read_file\` to get its current content first
- **PRESERVE THE EXISTING TABLE FORMAT** — do NOT change column headers or restructure existing rows
- KEEP ALL existing rows BYTE-FOR-BYTE identical — do NOT reformat, reorder columns, or re-encode characters
- APPEND your new row at the bottom of the table, matching the EXISTING column format exactly
- For your new row: fill in columns that match what you have (date, task, branch, status, etc.) — leave others as "-" if the column doesn't apply
- If the file doesn't exist, create it with this template:

\`\`\`markdown
# Work Log

> Orchestra task execution history for ${repo}

| Date | Task | Model | Branch | PR | Status |
|------|------|-------|--------|-----|--------|
| {date} | Roadmap creation | ${modelAlias} | {branch} | {pr} | ✅ |
\`\`\`

### Step 5: CREATE PR
- Include both ROADMAP.md and WORK_LOG.md in the PR
- If existing files were found, use action "update" and preserve ALL existing content (especially work log rows)
- If creating new files, use action "create"
- Branch: \`${branch}\` (bot/ prefix added automatically)
- PR title: "feat: initialize project roadmap [${modelAlias}]"
- PR body: include the full roadmap content as preview, and a footer line: "Generated by: ${modelAlias}"
- Commit messages MUST include the model alias, e.g.: "feat: initialize project roadmap [${modelAlias}]"

### Step 5.5: VERIFY PR CREATION
**CRITICAL** — After calling \`github_create_pr\`, CHECK THE TOOL RESULT:
- If it returned a PR URL (https://github.com/...) → success, proceed to Step 6
- If it returned an error (422, 403, etc.) → FIX AND RETRY. If the error is about the PR (not the branch), push a fix commit to the SAME branch and retry the PR. Only use a different branch name as a last resort — and if you do, re-include ALL your changes (not just the fix), because a new branch forks from main and loses prior commits.
- If it returned "AUDIT TRAIL VIOLATION" → you modified existing WORK_LOG.md rows. Re-read the file with \`github_read_file\`, use the EXACT content as-is (do NOT reformat or restructure the table), and ONLY append your new row at the bottom matching the existing column format.
- **NEVER claim you created a PR if the tool returned an error.**

### Step 6: REPORT
\`\`\`
ORCHESTRA_RESULT:
branch: {branch-name}
pr: {pr-url}
files: {comma-separated list of changed files}
summary: {1-2 sentence summary}
\`\`\`

The \`pr:\` field MUST be a real GitHub URL. If PR creation failed, set \`pr: FAILED\` and explain in the summary.

## Rules
- **DO NOT ask for user confirmation or permission** — execute ALL steps immediately and autonomously
- **Be FAST** — read only essential files (5-8 max), then create the PR. Do not exhaustively read every file.
- Always create a PR — never just describe what should be done
- If an existing roadmap exists, incorporate its content (don't discard previous work)
- Keep phases realistic — avoid overplanning
- Task descriptions should be actionable by a coding AI model in a single session
- You MUST produce an ORCHESTRA_RESULT: block with a real PR URL — the task is NOT complete without it
- **ABSOLUTELY NO SOURCE CODE** — your PR contains ONLY ROADMAP.md and WORK_LOG.md. Zero implementation files.`;
}

// ============================================================
// DRAFT INIT — Generate roadmap for preview (no PR)
// ============================================================

/**
 * Build a prompt that asks the model to generate a roadmap and output it
 * in structured blocks (not committed). Used for the preview-before-commit flow.
 *
 * The model reads the repo structure, generates ROADMAP.md and WORK_LOG.md content,
 * and outputs them in DRAFT_ROADMAP / DRAFT_WORKLOG blocks for extraction.
 */
export function buildDraftInitPrompt(params: {
  repo: string;
  modelAlias: string;
  revision?: string; // If revising, contains user's feedback on the previous draft
  previousDraft?: string; // The previous roadmap content to revise
}): string {
  const { repo, modelAlias, revision, previousDraft } = params;
  const [owner, repoName] = repo.split('/');
  const isRevision = !!revision && !!previousDraft;

  const revisionBlock = isRevision ? `
## REVISION REQUEST
The user reviewed the previous draft and wants changes:

**Previous draft:**
\`\`\`markdown
${previousDraft}
\`\`\`

**User feedback:**
${revision}

Apply the user's feedback to produce an improved roadmap. Keep parts they didn't mention.
` : '';

  const repoReadingSteps = isRevision ? `
### Step 1: APPLY REVISION
You already have the previous roadmap above. Apply the user's feedback to improve it.
You may read 1-2 repo files if the revision requires new understanding, but prefer using existing knowledge.
` : `
### Step 1: UNDERSTAND THE REPO (STRICT BUDGET: max 5 file reads total)
**Be efficient — read only what you need, then move to Step 2 quickly.**
**HARD LIMIT: You have a budget of 8 total tool calls for this draft.**
- Use \`github_list_files\` to scan the root and main source directory
- Use \`github_read_file\` to read ONLY these key files:
  - README.md (project overview)
  - package.json or equivalent (dependencies, scripts)
  - Any existing roadmap: ${ROADMAP_FILE_CANDIDATES.join(', ')}
  - 1-2 main source files (entry point, main component)

### Step 1.5: FLAG LARGE FILES
- Note file sizes from the listing to flag large files (>${LARGE_FILE_THRESHOLD_LINES} lines or ~${LARGE_FILE_THRESHOLD_KB}KB)
- Also flag files in the WARNING ZONE: ${LARGE_FILE_WARNING_LINES}-${LARGE_FILE_THRESHOLD_LINES} lines
- Only check source code files — skip config, generated, and lock files
`;

  return `# Orchestra DRAFT Mode — Roadmap Preview

You are a PLANNER generating a DRAFT roadmap for user review. You do NOT create a PR.
Your job: analyze the repo, generate a roadmap, and output it for the user to preview.

**CRITICAL: DO NOT call github_create_pr. DO NOT commit anything. Output the roadmap in text only.**

## Target Repository
- Owner: ${owner}
- Repo: ${repoName}
- Full: ${repo}
${revisionBlock}
## Workflow
${repoReadingSteps}
### Step 2: ANALYZE THE PROJECT REQUEST
- Read the user's project description carefully
- Break it down into concrete, implementable phases
- Each phase should have 2-5 specific tasks
- Order tasks by dependency (foundations first)

### Step 3: OUTPUT THE DRAFT

Output the roadmap in a DRAFT_ROADMAP block and the work log in a DRAFT_WORKLOG block.
These will be shown to the user for review before committing.

\`\`\`DRAFT_ROADMAP
# Project Roadmap

> Auto-generated by Orchestra Mode | Model: ${modelAlias} | {date}

## Overview
{1-2 sentence project summary}

## Phases

### Phase 1: {phase name}
- [ ] **Task 1.1**: {task title}
  - Description: {what needs to be done}
  - Files: {likely files to create/modify}
  - Depends on: {none or task IDs}
...

## Notes
{any architectural decisions, risks, or open questions}
\`\`\`

\`\`\`DRAFT_WORKLOG
# Work Log

> Orchestra task execution history for ${repo}

| Date | Task | Model | Branch | PR | Status |
|------|------|-------|--------|-----|--------|
| {date} | Roadmap creation | ${modelAlias} | - | pending | 📋 Draft |
\`\`\`

## Roadmap Rules
- Use \`- [ ]\` for pending tasks, \`- [x]\` for completed
- Task titles should be specific enough to act on
- Include file hints so the next run knows where to work
- Include dependency info so tasks execute in order
- 3-6 phases is typical, each with 2-5 tasks
- **ATOMIC REFACTORING**: create + import + DELETE in ONE task, never split
- **Large files**: add extraction tasks EARLY if files >${LARGE_FILE_THRESHOLD_LINES} lines
- **ABSOLUTELY NO SOURCE CODE** — plan only, no implementation

## Output Rules
- Output DRAFT_ROADMAP and DRAFT_WORKLOG blocks — these are REQUIRED
- Do NOT call github_create_pr — this is a draft, not a commit
- Be concise in analysis, detailed in the roadmap
- After the blocks, add a brief summary of what the roadmap covers`;
}

/**
 * Parse DRAFT_ROADMAP and DRAFT_WORKLOG blocks from model output.
 * Returns null if the roadmap block is not found.
 *
 * Tolerant of: CRLF line endings, optional spaces around fences,
 * case variations (DRAFT_ROADMAP, draft_roadmap, Draft_Roadmap).
 */
export function parseDraftBlocks(output: string): { roadmap: string; workLog: string } | null {
  // Normalize CRLF to LF for consistent matching
  const normalized = output.replace(/\r\n/g, '\n');
  // Match ```DRAFT_ROADMAP ... ``` blocks — case-insensitive, tolerant of spaces
  const roadmapMatch = normalized.match(/```\s*DRAFT_ROADMAP\s*\n([\s\S]*?)```/i);
  const workLogMatch = normalized.match(/```\s*DRAFT_WORKLOG\s*\n([\s\S]*?)```/i);

  if (!roadmapMatch) return null;

  const roadmap = roadmapMatch[1].trim();
  if (!roadmap) return null; // Empty roadmap is invalid

  return {
    roadmap,
    workLog: workLogMatch ? workLogMatch[1].trim() : '',
  };
}

/**
 * Format a roadmap draft as a compact Telegram-friendly preview.
 * Shows phases and task counts, truncated if too long.
 */
export function formatDraftPreview(roadmapContent: string, maxLength: number = 3000): string {
  const lines = roadmapContent.split('\n');
  const parts: string[] = [];

  // Extract overview
  let inOverview = false;
  for (const line of lines) {
    if (/^## Overview/i.test(line)) { inOverview = true; continue; }
    if (/^##\s/.test(line) && inOverview) { inOverview = false; continue; }
    if (inOverview && line.trim()) {
      parts.push(`📋 ${line.trim()}`);
      break;
    }
  }

  // Extract phases with task counts
  let currentPhase = '';
  let taskCount = 0;
  const phases: string[] = [];

  for (const line of lines) {
    const phaseMatch = line.match(/^###\s+(.+)/);
    if (phaseMatch) {
      if (currentPhase) {
        phases.push(`📦 ${currentPhase} (${taskCount} tasks)`);
      }
      currentPhase = phaseMatch[1].trim();
      taskCount = 0;
      continue;
    }
    if (/^\s*-\s*\[[ x]\]/.test(line)) {
      taskCount++;
    }
  }
  if (currentPhase) {
    phases.push(`📦 ${currentPhase} (${taskCount} tasks)`);
  }

  parts.push('');
  parts.push(...phases);

  // Extract notes if present
  let inNotes = false;
  const notes: string[] = [];
  for (const line of lines) {
    if (/^## Notes/i.test(line)) { inNotes = true; continue; }
    if (/^##\s/.test(line) && inNotes) break;
    if (inNotes && line.trim()) notes.push(line.trim());
  }
  if (notes.length > 0) {
    parts.push('');
    parts.push(`💡 ${notes.slice(0, 3).join(' ')}`);
  }

  // Count total tasks and append summary before truncation
  const totalTasks = (roadmapContent.match(/^\s*-\s*\[[ x]\]/gm) || []).length;
  parts.push('');
  parts.push(`📊 Total: ${phases.length} phases, ${totalTasks} tasks`);

  let result = parts.join('\n');
  if (result.length > maxLength) {
    result = result.slice(0, maxLength - 20) + '\n\n[Truncated]';
  }

  return result;
}

// ============================================================
// DO MODE — One-shot task execution without a roadmap
// ============================================================

/**
 * Build the system prompt for /orchestra do.
 * Executes a user-described task directly — no roadmap needed.
 * Creates a PR with the implementation + optional WORK_LOG.md entry.
 */
export function buildDoPrompt(params: {
  repo: string;
  modelAlias: string;
  branchSlug?: string;
  hasSandbox?: boolean;
}): string {
  const { repo, modelAlias, branchSlug, hasSandbox } = params;
  const [owner, repoName] = repo.split('/');
  const branch = branchSlug || `do-${modelAlias}`;

  return `# Orchestra DO Mode — Direct Task Execution

You are executing a task directly from the user's description. There is NO roadmap — just do what the user asks.

## Target Repository
- Owner: ${owner}
- Repo: ${repoName}
- Full: ${repo}

## Workflow

### Step 1: UNDERSTAND THE REPO (max 5 file reads)
- Use \`github_list_files\` to scan the root and main source directory
- Use \`github_read_file\` to read key files relevant to the user's request
- Do NOT read every file — be efficient

### Step 2: IMPLEMENT THE TASK
- Read the user's description carefully
- Implement exactly what was asked — no more, no less
- Use \`workspace_write_file\` + \`workspace_commit\` for creating/modifying files
- For small changes (≤3 files, <100 lines each): ONE \`github_create_pr\` with all changes is OK

### Creating files — USE WORKSPACE PATTERN (prevents timeout/streaming failures)
1. \`workspace_write_file\` — stage file A (path, content)
2. \`workspace_write_file\` — stage file B
3. \`workspace_delete_file\` — stage file removal (if needed)
4. \`workspace_commit\` — push all staged files to branch \`${branch}\` in one commit
5. \`github_create_pr\` — open PR

For "patch" action: \`{"path":"file.js","action":"patch","patches":[{"find":"exact text","replace":"new text"}]}\`
For "create" action: \`{"path":"file.js","action":"create","content":"full content"}\`
${hasSandbox ? `
### Step 2.5: VERIFY (sandbox available)
Before creating the PR, use \`sandbox_exec\` to test your changes:
- Clone: \`["git clone https://github.com/${repo}.git repo && cd repo && git checkout ${branch}"]\`
- Run tests: \`["cd repo && npm test"]\` or the project's test command
- If tests fail, fix and retry.
` : ''}
### Step 3: CREATE PR
- Branch: \`${branch}\` (bot/ prefix added automatically)
- PR title should describe what was done, ending with [${modelAlias}]
- All calls use branch \`${branch}\`
- **After calling github_create_pr, CHECK THE RESULT.** If error, fix and retry.

### Step 4: REPORT
\`\`\`
ORCHESTRA_RESULT:
branch: {branch-name}
pr: {pr-url from tool result}
files: {comma-separated changed files}
summary: {one sentence}
\`\`\`

## Rules
- **DO NOT ask for user confirmation** — execute ALL steps immediately
- **Be efficient** — read only what you need, implement, create PR
- Do NOT create ROADMAP.md or WORK_LOG.md — this is a one-shot task
- You MUST produce an ORCHESTRA_RESULT: block with a real PR URL — the task is NOT complete without it
- **IMPORTANT: Do NOT output a plan or outline. CALL the tools directly. Start with github_list_files or github_read_file.**

Begin now.`;
}

// ============================================================
// RUN MODE — Execute next task from roadmap
// ============================================================

// Shared params type for all run prompt builders
interface BuildRunPromptParams {
  repo: string;
  modelAlias: string;
  previousTasks: OrchestraTask[];
  specificTask?: string; // Optional: user-specified task instead of "next"
  branchSlug?: string; // Pre-generated branch slug (without bot/ prefix)
  hasSandbox?: boolean; // If true, sandbox_exec is available — prompt encourages testing
  /** Pre-fetched roadmap content — eliminates Step 1 github_read_file call. */
  roadmapContent?: string;
  /** Pre-fetched roadmap file path (e.g. ROADMAP.md). */
  roadmapPath?: string;
  /** Pre-fetched WORK_LOG.md content — eliminates another read call. */
  workLogContent?: string;
  /** Override prompt tier from execution profile (avoids recomputing). */
  promptTierOverride?: 'minimal' | 'standard' | 'full';
  /** Pre-resolved execution brief — overrides specificTask in the system prompt. */
  executionBrief?: string;
}

/**
 * Determine prompt complexity tier based on model capability.
 * Uses AA Intelligence Index from enrichment pipeline when available,
 * falls back to isFree + maxContext heuristic otherwise.
 */
function getPromptTier(modelAlias: string): 'minimal' | 'standard' | 'full' {
  const model = getModel(modelAlias);
  if (!model) return 'standard'; // Unknown model → safe middle ground

  // Use enrichment data when available (populated by /model enrich → R2)
  if (model.intelligenceIndex !== undefined) {
    if (model.intelligenceIndex >= 45) return 'full';     // Strong: Claude, GPT-4o, Grok
    if (model.intelligenceIndex >= 28) return 'standard'; // Mid: 70B-class, Mixtral
    return 'minimal';                                     // Weak: 32B-class
  }

  // Fallback when enrichment data isn't loaded
  if (!model.isFree) return 'full';  // Paid models are generally stronger
  if ((model.maxContext || 0) >= 200000) return 'standard';
  return 'minimal';
}

/**
 * Build the pre-fetched roadmap/worklog section for injection into prompts.
 * Eliminates 1-2 LLM round-trips by providing the content directly.
 */
function buildPrefetchedDocsSection(params: BuildRunPromptParams): string {
  if (!params.roadmapContent) return '';
  const sections: string[] = [];
  sections.push(`\n\n## PRE-LOADED: ${params.roadmapPath || 'ROADMAP.md'} (already fetched — do NOT re-read)\n\`\`\`\n${params.roadmapContent}\n\`\`\``);
  if (params.workLogContent) {
    sections.push(`\n## PRE-LOADED: WORK_LOG.md (already fetched — do NOT re-read)\n\`\`\`\n${params.workLogContent}\n\`\`\``);
  }
  return sections.join('\n');
}

/**
 * Build the system prompt for /orchestra run.
 * Dispatches to tier-specific builders based on model capability.
 * - minimal (~900 tokens): weak/free models that drown in long prompts
 * - standard (~1500 tokens): mid-tier models that need guidance but not hand-holding
 * - full (~3500 tokens): strong models that benefit from detailed rules
 */
export function buildRunPrompt(params: BuildRunPromptParams): string {
  // Use profile-provided tier when available; fall back to model-based heuristic
  const tier = params.promptTierOverride ?? getPromptTier(params.modelAlias);
  console.log(`[orchestra] buildRunPrompt tier=${tier} for /${params.modelAlias}${params.promptTierOverride ? ' (from profile)' : ''}`);
  if (tier === 'minimal') return buildMinimalRunPrompt(params);
  if (tier === 'standard') return buildStandardRunPrompt(params);
  return buildFullRunPrompt(params);
}

/**
 * MINIMAL run prompt (~900 tokens).
 * For weak/free models (32B class). Stripped to bare essentials
 * with explicit guardrail mentions to avoid audit trail blocks.
 */
function buildMinimalRunPrompt(params: BuildRunPromptParams): string {
  const { repo, modelAlias, specificTask, branchSlug, executionBrief } = params;
  const [owner, repoName] = repo.split('/');
  const branch = branchSlug || `task-${modelAlias}`;

  const taskInstruction = executionBrief
    ? `Execute this work item (pre-resolved from roadmap):\n${executionBrief}`
    : specificTask
    ? `Find and execute this task: "${specificTask}"`
    : 'Find the first unchecked task `- [ ]` whose dependencies are done.';

  return `# Orchestra RUN

Execute the next task from the roadmap for **${repo}**.

## RULES (breaking these will block your PR)
- Read each file AT MOST ONCE. Never call github_read_file on the same path twice.
- WORK_LOG.md is APPEND-ONLY. Read it first, then add ONE new row at the bottom matching the existing column format. Never add a row that already exists. Never delete or modify existing rows.
- ROADMAP.md: only change your task from \`- [ ]\` to \`- [x]\`. Never delete or modify other tasks. If the roadmap has a "current priority" or "next task" callout pointing at your task, update it to point to the next uncompleted task.
- Complete ALL code changes before updating ROADMAP.md or WORK_LOG.md. Code first, docs last.
- Do NOT regenerate entire files from memory — use "patch" action for edits.
- Always finish with a github_create_pr call + ORCHESTRA_RESULT block. Use github_push_files to batch large changes before the PR.

${params.roadmapContent
    ? `## Step 1: TASK SELECTION\nThe roadmap and work log are pre-loaded below — do NOT re-read them.\n${taskInstruction}\n\n## Step 2: READ RELEVANT FILES\nRead only the code files you need to implement the task. Call multiple github_read_file in parallel when possible. Stop reading when you have enough.\n${buildPrefetchedDocsSection(params)}`
    : `## Step 1: READ ROADMAP\nUse \`github_read_file\` with owner="${owner}" repo="${repoName}" to read ROADMAP.md.\nCheck paths: ${ROADMAP_FILE_CANDIDATES.slice(0, 3).join(', ')}. Also read WORK_LOG.md if it exists.\n${taskInstruction}\n\n## Step 2: READ RELEVANT FILES\nRead only the files you need to implement the task. Stop reading when you have enough.`}

## Step 3: IMPLEMENT
For "patch" action: \`{"path":"file.js","action":"patch","patches":[{"find":"exact text","replace":"new text"}]}\`
For "create" action: \`{"path":"file.js","action":"create","content":"full content"}\`

### Creating files — USE WORKSPACE PATTERN (prevents timeout/streaming failures)
**ALWAYS use workspace_write_file + workspace_commit instead of github_push_files for new files:**
1. \`workspace_write_file\` — stage file A (path, content)
2. \`workspace_write_file\` — stage file B
3. \`workspace_delete_file\` — stage file removal (if needed)
4. \`workspace_commit\` — push all staged files to branch \`${branch}\` in one commit
5. \`github_create_pr\` — open PR on existing branch with ROADMAP/WORK_LOG patches

Each workspace_write_file is a tiny tool call (just path + content). No streaming risk.

**If creating ≤3 small files** (<100 lines each): ONE \`github_create_pr\` with all changes is also OK.

When splitting files: DELETE the extracted code from the original file. Do NOT rename it or leave dead code. If other files import the extracted code from the original, update their imports too.

### REFACTOR = CREATE + IMPORT + DELETE + UPDATE REFS (all four, same PR)
If a task says "split", "extract", or "move" code: CREATE the new file, ADD imports, DELETE the originals from the source file, UPDATE imports in other files that referenced the extracted code. Locate code by function/const name, not line number. Source file MUST shrink. Never defer deletion to a later task.

All calls use branch \`${branch}\` (bot/ prefix added automatically). Title ends with [${modelAlias}].
**After calling github_create_pr, CHECK THE RESULT.** If error, fix and retry.
${params.hasSandbox ? `
## Step 3.5: VERIFY (sandbox available)
Before creating the PR, use \`sandbox_exec\` to test your changes:
- Clone the repo: \`["git clone https://github.com/${repo}.git repo && cd repo && git checkout ${branch}"]\`
- Run tests: \`["cd repo && npm test"]\` or the project's test command
- If tests fail, fix the code and retry. Do NOT create a PR with failing tests.
` : ''}
## Step 4: REPORT
\`\`\`
ORCHESTRA_RESULT:
branch: {branch-name}
pr: {pr-url from tool result}
files: {comma-separated changed files}
summary: {one sentence}
\`\`\`

## EXTRACTION + TEST QUALITY RULES
- If you extract code into a new module for testability, you MUST also update the production file to import from the new module and DELETE the inline duplicates. Never leave two copies of the same logic.
- Test fixtures MUST use real data shapes from the codebase. Read production data files and use actual key names (e.g. \`{en: 0.6}\` not \`{english: 0.9}\`).
- Only add dependencies strictly required for the task. No UI/dev-only packages unless explicitly requested.

**IMPORTANT: Do NOT output a plan, outline, or list of steps. CALL the tools directly. Your first action must be a github_read_file tool call.**

Begin now. Read the roadmap first.`;
}

/**
 * STANDARD run prompt (~1500 tokens).
 * For mid-tier models (70B class). Adds patch guidance, few-shot example,
 * file splitting rules, and history context over minimal.
 */
function buildStandardRunPrompt(params: BuildRunPromptParams): string {
  const { repo, modelAlias, previousTasks, specificTask, branchSlug, executionBrief } = params;
  const [owner, repoName] = repo.split('/');
  const branch = branchSlug || `task-${modelAlias}`;

  const taskInstruction = executionBrief
    ? `Execute this work item (pre-resolved from roadmap):\n${executionBrief}\nDo not switch to another task.`
    : specificTask
    ? `The user requested: "${specificTask}"\nFind this task in the roadmap and execute it.`
    : `Find the NEXT uncompleted task: first \`- [ ]\` whose dependencies are all \`- [x]\`.`;

  // Abbreviated history (last 3 tasks)
  let historyContext = '';
  if (previousTasks.length > 0) {
    const recent = previousTasks.slice(-3);
    const lines = recent.map(t => {
      const icon = t.status === 'completed' ? '✅' : '❌';
      return `  ${icon} "${t.prompt.substring(0, 60)}"`;
    });
    historyContext = `\n\n## Recent History\n${lines.join('\n')}\nAvoid duplicating this work.`;
  }

  return `# Orchestra RUN

Execute the next task from the roadmap for **${repo}**.

## RULES (breaking these will block your PR)
- Read each file AT MOST ONCE. Never call github_read_file on the same path twice.
- WORK_LOG.md is APPEND-ONLY. Read it first, then add ONE new row at the bottom matching the existing column format. Never add a row that already exists. Never delete or modify existing rows.
- ROADMAP.md: only change your task from \`- [ ]\` to \`- [x]\`. Never delete or modify other tasks. If the roadmap has a "current priority" or "next task" callout pointing at your task, update it to point to the next uncompleted task.
- Complete ALL code changes before updating ROADMAP.md or WORK_LOG.md. Code first, docs last.
- Do NOT regenerate entire files from memory — use "patch" action for edits.
- Always finish with a github_create_pr call + ORCHESTRA_RESULT block. Use github_push_files to batch large changes before the PR.

${params.roadmapContent
    ? `## Step 1: TASK SELECTION\nThe roadmap and work log are pre-loaded below — do NOT re-read them.\n${taskInstruction}\n\n## Step 2: UNDERSTAND CODEBASE\nUse \`github_list_files\` and \`github_read_file\` to read files related to the task. Call multiple reads in parallel when possible.\nIf any source file exceeds ~${LARGE_FILE_WARNING_LINES} lines, you may split it as part of this task.\n${buildPrefetchedDocsSection(params)}`
    : `## Step 1: READ ROADMAP\nUse \`github_read_file\` with owner="${owner}" repo="${repoName}" to read ROADMAP.md.\nCheck paths: ${ROADMAP_FILE_CANDIDATES.join(', ')}. Also read WORK_LOG.md if it exists.\n${taskInstruction}\n\n## Step 2: UNDERSTAND CODEBASE\nUse \`github_list_files\` and \`github_read_file\` to read files related to the task.\nIf any source file exceeds ~${LARGE_FILE_WARNING_LINES} lines, you may split it as part of this task.`}

## Step 3: IMPLEMENT
Branch: \`${branch}\` (bot/ prefix added automatically)
Title: under 70 chars, ends with [${modelAlias}]
Body: summary + "Generated by: ${modelAlias}"

### How to edit files — USE PATCH ACTION
For existing files (especially >100 lines), use action \`"patch"\`:
1. Read the file first with github_read_file
2. Use \`{"path":"file.js","action":"patch","patches":[{"find":"exact text to find","replace":"replacement text"}]}\`
3. Each "find" must match EXACTLY once — copy text verbatim including whitespace

Only use "update" (full content) for small files (<100 lines) or when >50% of the file changes.
Use "create" for new files.

### CRITICAL: Creating files — USE WORKSPACE PATTERN (prevents streaming timeouts)
**ALWAYS use workspace_write_file + workspace_commit for creating new files:**
1. \`workspace_write_file\` — stage each new file one at a time (path, content)
2. \`workspace_delete_file\` — stage file removals (if needed)
3. \`workspace_commit\` — push ALL staged files to branch \`${branch}\` in one atomic commit
4. \`github_create_pr\` — open PR on existing branch with ROADMAP/WORK_LOG patches

Each \`workspace_write_file\` call is tiny (just the file content as a tool argument), so there's no risk of streaming timeout. The commit happens server-side with no large payloads.

**If creating ≤3 small files** (<100 lines each): one \`github_create_pr\` with all changes is also OK.

### File splitting / extraction (if task requires it)
1. Stage new module files via \`workspace_write_file\` (one call per file), then \`workspace_commit\`
2. Updated original file with action "patch" — include in final github_create_pr:
   - ADD import statements for the new modules at the top
   - DELETE the extracted code (functions, constants, components) from the original file using patches
   - Re-export from the new modules if needed for backwards compatibility
   - **DO NOT leave dead code** — the extracted code MUST be removed, not renamed or commented out

### REFACTOR TASK INTERPRETATION — CRITICAL
If a task says "split", "extract", or "move" code into a new file, you MUST do ALL FOUR in ONE PR:
1. **CREATE** the new module file with the extracted code
2. **ADD** import statements to the source file
3. **DELETE** the original definitions from the source file
4. **UPDATE** imports in any OTHER files that referenced the extracted code from the source file
Locate code to extract by **function/const/component name**, not line number (line numbers shift after prior extractions). NEVER assume deletion is deferred to a later task. The source file's line count MUST drop significantly after a split. If it barely changed, you left dead code — go back and delete the extracted definitions.
When extracting React components/hooks: copy ALL required imports (useState, useEffect, context providers), prop types, and hook dependencies to the new file.

**After calling github_create_pr, CHECK THE RESULT.** If error (422, 403), fix and retry — push a fix commit to the SAME branch first. Only use a new branch as last resort (and re-include ALL changes, since new branches fork from main). NEVER claim success if the tool returned an error.
${params.hasSandbox ? `
## Step 3.5: VERIFY CODE (sandbox available)
Before creating the PR, use \`sandbox_exec\` to verify your changes work:
- Clone and checkout: \`["git clone https://github.com/${repo}.git repo && cd repo && git checkout ${branch}"]\`
- Run tests/build: \`["cd repo && npm test"]\` or the project's test/build command
- If tests fail, fix your code (patch the files again) and re-test. Do NOT submit a PR with failing tests.
- Keep sandbox calls focused — max 3-4 calls for verification.
` : ''}
## Step 4: REPORT
\`\`\`
ORCHESTRA_RESULT:
branch: {branch-name}
pr: {pr-url from tool result}
files: {comma-separated changed files}
summary: {one sentence}
\`\`\`

The \`pr:\` field MUST be a real GitHub URL. If PR creation failed, set \`pr: FAILED\`.
${historyContext}

## EXTRACTION + TEST QUALITY RULES
- If you extract code into a new module for testability, you MUST also update the production file to import from the new module and DELETE the inline duplicates. Never leave two copies of the same logic.
- Test fixtures MUST use real data shapes from the codebase. Read production data files first and use actual key names and value ranges (e.g. \`{en: 0.6}\` not \`{english: 0.9}\`).
- Only add dependencies strictly required for the task. No UI/dev-only packages unless explicitly requested.
- Commit hygiene: every commit must build/test. Do not create fixup commits — get it right the first time.

**IMPORTANT: Do NOT output a plan or outline. CALL tools directly. Your first action must be a github_read_file tool call.**

Begin now. Read the roadmap first.`;
}

/**
 * FULL run prompt (~3500 tokens).
 * For strong models (Claude, GPT-4o, Grok). Complete detailed rules,
 * file splitting guidance, audit trail enforcement, verification steps.
 */
function buildFullRunPrompt(params: BuildRunPromptParams): string {
  const { repo, modelAlias, previousTasks, specificTask, branchSlug, executionBrief } = params;
  const [owner, repoName] = repo.split('/');
  const branch = branchSlug || `{task-slug}-${modelAlias}`;

  // Format previous task context
  let historyContext = '';
  if (previousTasks.length > 0) {
    const recent = previousTasks.slice(-5);
    const lines = recent.map(t => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⏳';
      const pr = t.prUrl ? ` → ${t.prUrl}` : '';
      const sum = t.summary ? ` — ${t.summary.substring(0, 100)}` : '';
      return `  ${icon} [${t.branchName}] "${t.prompt.substring(0, 80)}"${pr}${sum}`;
    });
    historyContext = `\n\n## Recent Orchestra History\n${lines.join('\n')}\n\nAvoid duplicating work already done.`;
  }

  const taskSelection = executionBrief
    ? `The task has been PRE-RESOLVED from the roadmap. Execute this work item:\n\n${executionBrief}\n\nDo not switch to a different task unless this one is truly impossible.`
    : specificTask
    ? `The user has requested a SPECIFIC task: "${specificTask}"
Find this task (or the closest match) in the roadmap and execute it.
If the task is not in the roadmap, execute it anyway and add it to the roadmap as a completed item.`
    : `Find the NEXT uncompleted task in the roadmap:
- Look for the first \`- [ ]\` item whose dependencies are all satisfied (\`- [x]\`)
- If no roadmap exists, tell the user to run \`/orchestra init\` first
- If all tasks are completed, congratulate the user and suggest next steps`;

  return `# Orchestra RUN Mode

Execute the next task from the project roadmap for **${repo}**.

## CRITICAL RULES (breaking these will block your PR)
- Read each file AT MOST ONCE. Never call github_read_file on the same path twice.
- WORK_LOG.md is APPEND-ONLY. Read it first, then add ONE new row at the bottom matching the existing column format. Never add a row that already exists. Never delete or modify existing rows.
- ROADMAP.md: only change your task from \`- [ ]\` to \`- [x]\`. Never delete or modify other tasks. If the roadmap has a "current priority" or "next task" callout pointing at your task, update it to point to the next uncompleted task.
- Complete ALL code changes before updating ROADMAP.md or WORK_LOG.md. Code first, docs last.
- Do NOT regenerate entire files from memory — use "patch" action for edits.
- After calling github_create_pr, CHECK THE RESULT. If it returned an error, fix and retry. Never claim success if the tool returned an error.
- Always finish with a github_create_pr call + ORCHESTRA_RESULT block with a real PR URL. Use github_push_files to batch large changes before the PR.

${params.roadmapContent
    ? `## Step 1: SELECT TASK\nThe roadmap and work log are pre-loaded below — do NOT re-read them.\n${taskSelection}\n\n## Step 2: UNDERSTAND CODEBASE\nUse \`github_list_files\` and \`github_read_file\` to read files related to the task. Call multiple reads in parallel when possible.\nIf any source file exceeds ~${LARGE_FILE_WARNING_LINES} lines, you can split it as part of this task.\n${buildPrefetchedDocsSection(params)}`
    : `## Step 1: READ ROADMAP\nUse \`github_read_file\` with owner="${owner}" repo="${repoName}" to read the roadmap.\nCheck paths: ${ROADMAP_FILE_CANDIDATES.join(', ')}. Also read WORK_LOG.md if it exists.\nIf no roadmap found: "No roadmap found. Run \`/orchestra init ${repo} <description>\` first."\n\n## Step 2: SELECT TASK\n${taskSelection}\n\n## Step 3: UNDERSTAND CODEBASE\nUse \`github_list_files\` and \`github_read_file\` to read files related to the task.\nIf any source file exceeds ~${LARGE_FILE_WARNING_LINES} lines, you can split it as part of this task.`}

## Step ${params.roadmapContent ? '3' : '4'}: IMPLEMENT

**Use "patch" action for editing existing files (especially files >100 lines):**
- Read the file first with \`github_read_file\`
- Use action \`"patch"\` with \`"patches"\` array of \`{"find":"exact text","replace":"new text"}\` pairs
- Each "find" must match exactly once — copy the EXACT text from the file including whitespace
- This prevents syntax errors, encoding changes, and unwanted rewrites that happen with "update"
- Only use "update" (full file content) for small files (<100 lines) or when changes touch >50% of the file
- Use "create" for new files

Example patch: \`{"path":"src/App.jsx","action":"patch","patches":[{"find":"const data = [...]","replace":"import { data } from './data'"}]}\`

### CRITICAL: Creating files — USE WORKSPACE PATTERN (prevents streaming timeouts)
**ALWAYS use workspace_write_file + workspace_commit for creating new files:**
1. Call \`workspace_write_file\` for EACH new file (path, content). Each call is tiny — no streaming risk.
2. Call \`workspace_delete_file\` to stage file removals (if needed).
3. Call \`workspace_commit\` ONCE to push ALL staged files to branch \`${branch}\` in one atomic commit.
4. Call \`github_create_pr\` to open the PR on the existing branch with ROADMAP/WORK_LOG patches.

This is MUCH safer than github_push_files because each workspace_write_file sends only one file as a tool argument. No giant JSON arrays, no streaming timeout risk.

**If creating ≤3 small files** (<100 lines each): one \`github_create_pr\` with all changes is also OK.

**FILE SPLITTING — How to split a large file into modules:**
1. Read the original file with \`github_read_file\`
2. Plan the split: identify logical groups of functions/components to extract
3. Stage each new module file via \`workspace_write_file\`, then \`workspace_commit\`
4. Final \`github_create_pr\`: patch the original file + ROADMAP + WORK_LOG. The patches MUST:
   - ADD import statements for the new modules at the top
   - DELETE the extracted code from the original file (remove the actual functions/constants/components that were moved)
   - Re-export from new modules if needed for backwards compatibility
   - **NEVER leave dead code** — do NOT rename extracted code to _MOVED or comment it out. DELETE it entirely.
The identifier check allows splits: identifiers moved to other files on the same branch are not counted as lost.
**CRITICAL**: The original file's line count should DROP significantly after a split. If it barely changed, you left dead code.

**REFACTOR TASK INTERPRETATION — CRITICAL (prevents the #1 bot failure mode):**
If a task says "split", "extract", "move", or "refactor" code into new files, you MUST do ALL FOUR in ONE PR:
1. **CREATE** the new module file(s) with the extracted code
2. **ADD** import statements to the source file
3. **DELETE** the original definitions (functions, constants, components, data arrays) from the source file
4. **UPDATE** imports in any OTHER files that referenced the extracted code from the source file
Locate code to extract by **function/const/component name and signature**, not line number — line numbers shift after prior extractions. Re-read the file to find the exact current location before editing.
NEVER assume deletion will happen in a later task — even if the roadmap's dependency chain suggests it. Each extraction task MUST be self-contained: create + import + delete + update refs. If the source file's line count doesn't drop substantially, the task is NOT complete.
When extracting React components/hooks: copy ALL required imports (useState, useEffect, context providers, CSS modules), prop types, and hook dependencies to the new file. The component must work identically after extraction.

**Other rules:**
- Follow existing code conventions, proper types (no \`any\`)
- Do NOT regenerate entire files from memory — you WILL introduce syntax errors and encoding changes

If blocked (API errors): update WORK_LOG.md with status, report \`pr: FAILED\`.
${params.hasSandbox ? `
## Step 4.5: VERIFY CODE WITH SANDBOX
You have \`sandbox_exec\` available — use it to verify your changes before creating the PR:
1. Clone and checkout your branch: \`["git clone https://github.com/${repo}.git repo && cd repo && git checkout ${branch}"]\`
2. Run the project's test suite: \`["cd repo && npm test"]\` (or whatever test command the project uses)
3. Optionally run build/lint: \`["cd repo && npm run build"]\`
4. If tests or build fail, **fix the code** (push patches via workspace_write_file + workspace_commit), then re-test
5. Only proceed to create the PR once tests pass

**Guidelines:**
- Keep sandbox verification focused — typically 2-4 calls (clone, test, maybe build/lint, maybe re-test after fix)
- If no test suite exists, at least verify the code compiles/builds
- Report test results in the PR body
` : ''}
## Step 5: UPDATE ROADMAP & WORK LOG (in same PR)
- **ROADMAP.md**: Change ONLY your completed task from \`- [ ]\` to \`- [x]\`. Never delete tasks.
- **WORK_LOG.md**: Read the existing file first. KEEP ALL existing content BYTE-FOR-BYTE identical. APPEND exactly ONE new row at the bottom matching the EXISTING column format. Before appending, verify the row does not already exist in the file. Do NOT restructure the table or change column headers. If the existing format differs from what you expect, match it exactly.

## Step 6: CREATE PR
- Branch: \`${branch}\` (bot/ prefix added automatically)
- Title: under 70 chars, ends with [${modelAlias}]
- Body: summary + "Generated by: ${modelAlias}"
- **Verify the tool returned a PR URL** — if error (422, 403), push a fix commit to the SAME branch and retry the PR. Only create a new branch as last resort (re-include ALL changes since new branches fork from main). NEVER claim success if tool returned error.

## Step 7: REPORT
\`\`\`
ORCHESTRA_RESULT:
branch: {branch-name}
pr: {pr-url}
files: {comma-separated changed files}
summary: {1-2 sentence summary}
\`\`\`

## Rules
- **DO NOT ask for user confirmation or permission** — execute ALL steps immediately and autonomously
- Always create a PR. One task per run. Update ROADMAP.md + WORK_LOG.md in same PR.
- **USE "patch" ACTION for editing existing files** — never regenerate entire files from memory. Never delete work log entries or roadmap tasks.
- Use "${modelAlias}" in branch names and commit messages.
- You MUST produce an ORCHESTRA_RESULT: block with a real PR URL — the task is NOT complete without it
- **Do NOT output a plan, outline, or list of steps.** CALL tools directly. ${params.roadmapContent ? 'Your first action must be reading the code files needed for the task.' : 'Your first action must be a github_read_file tool call.'}

## EXTRACTION + TEST QUALITY (mandatory)
- **No surrogate testing:** If you extract code into a new module for testability, you MUST also update the production file to import from the new module and DELETE the original inline code. Tests that only verify a detached copy while the app runs different code are worthless.
- **Fixture realism:** Test fixtures MUST use real data shapes from the codebase. Read production data files FIRST. Use actual key names and value ranges (e.g. \`{en: 0.6}\` not \`{english: 0.9}\`). Invented fixture shapes miss real bugs.
- **Dependency hygiene:** Only add packages strictly required for the task. No UI/dev-only packages (e.g. @vitest/ui) unless explicitly requested. Every added dependency must be imported somewhere.
- **Atomic commits:** Every commit must build and pass tests independently. Do not create fixup commits — include dependencies, configs, and code in the same commit.
${historyContext}`;
}

// ============================================================
// LEGACY: buildOrchestraPrompt (kept for backward compat)
// ============================================================

/**
 * Build the orchestra system prompt (delegates to run mode).
 * @deprecated Use buildRunPrompt or buildInitPrompt directly.
 */
export function buildOrchestraPrompt(params: {
  repo: string;
  modelAlias: string;
  previousTasks: OrchestraTask[];
}): string {
  return buildRunPrompt(params);
}

// ============================================================
// Result parsing
// ============================================================

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
  // Try multiple patterns — models format this block inconsistently
  const match = response.match(/ORCHESTRA_RESULT:\s*\n([\s\S]*?)(?:```|$)/)
    || response.match(/ORCHESTRA_RESULT:\s*([\s\S]*?)(?:```|$)/)
    || response.match(/ORCHESTRA.RESULT[:\s]+([\s\S]*?)(?:```|$)/i);
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

  // Validate prUrl looks like a real URL — reject "attempted", "failed", placeholders
  const validPrUrl = prUrl.startsWith('https://') ? prUrl : '';

  return { branch, prUrl: validPrUrl, files, summary };
}

/**
 * Cross-reference a parsed orchestra result against tool output evidence.
 * Detects phantom PRs: model claims a PR URL but tool results show failures.
 *
 * @param result - Parsed orchestra result (from parseOrchestraResult)
 * @param fullOutput - The full task output including tool results
 * @returns Validated result with prUrl cleared if evidence contradicts the claim
 */
export function validateOrchestraResult(
  result: { branch: string; prUrl: string; files: string[]; summary: string },
  fullOutput: string,
): { branch: string; prUrl: string; files: string[]; summary: string; phantomPr: boolean } {
  if (!result.prUrl) {
    return { ...result, phantomPr: false };
  }

  // Evidence of github_create_pr failure in tool results
  const prFailurePatterns = [
    'PR NOT CREATED',
    'github_create_pr FAILED',
    'Destructive update blocked',
    'Full-rewrite blocked',
    'INCOMPLETE REFACTOR blocked',
    'DATA FABRICATION blocked',
    'NET DELETION blocked',
    'AUDIT TRAIL VIOLATION',
    'ROADMAP TAMPERING blocked',
    'FALSE COMPLETION blocked',
    'Error executing github_create_pr',
  ];

  const hasFailureEvidence = prFailurePatterns.some(pattern => fullOutput.includes(pattern));

  // Evidence of actual PR creation success
  // The tool returns "Pull Request created successfully!" + "PR: https://github.com/..."
  const hasSuccessEvidence =
    fullOutput.includes('Pull Request created successfully') ||
    fullOutput.includes(`PR: ${result.prUrl}`) ||
    fullOutput.includes(`"html_url":"${result.prUrl}"`);

  // If there's failure evidence AND no success evidence, this is a phantom PR
  if (hasFailureEvidence && !hasSuccessEvidence) {
    console.log(`[orchestra] Phantom PR detected: model claimed ${result.prUrl} but tool results show failure`);
    return {
      ...result,
      prUrl: '',
      summary: `⚠️ PHANTOM PR: Model claimed PR but github_create_pr failed. ${result.summary}`,
      phantomPr: true,
    };
  }

  return { ...result, phantomPr: false };
}

// ============================================================
// Helpers
// ============================================================

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
 *
 * Formats:
 *   /orchestra init owner/repo <project description>
 *   /orchestra run owner/repo [specific task]
 *   /orchestra history
 *   /orchestra owner/repo <prompt>  (legacy, treated as run)
 */
export function parseOrchestraCommand(args: string[]): {
  mode: 'init' | 'run';
  repo: string;
  prompt: string;
} | null {
  if (args.length < 2) return null;

  const first = args[0].toLowerCase();

  // /orchestra init owner/repo <description>
  if (first === 'init') {
    if (args.length < 3) return null;
    const repo = args[1];
    if (!isValidRepo(repo)) return null;
    const prompt = args.slice(2).join(' ').trim();
    if (!prompt) return null;
    return { mode: 'init', repo, prompt };
  }

  // /orchestra run owner/repo [specific task]
  if (first === 'run') {
    if (args.length < 2) return null;
    const repo = args[1];
    if (!isValidRepo(repo)) return null;
    // Prompt is optional for run mode (defaults to "next task")
    const prompt = args.length > 2 ? args.slice(2).join(' ').trim() : '';
    return { mode: 'run', repo, prompt };
  }

  // Legacy: /orchestra owner/repo <prompt> (treated as run)
  const repo = args[0];
  if (!isValidRepo(repo)) return null;
  const prompt = args.slice(1).join(' ').trim();
  if (!prompt) return null;
  return { mode: 'run', repo, prompt };
}

/** Validate owner/repo format */
function isValidRepo(repo: string): boolean {
  return /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo);
}

// ============================================================
// R2 History Management
// ============================================================

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

/** Threshold for marking a "started" task as stale (30 minutes). */
const STALE_TASK_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Clean up stale tasks in a user's orchestra history.
 * Tasks stuck in "started" status for more than 30 minutes are marked as "failed".
 * Returns the number of tasks cleaned up.
 */
export async function cleanupStaleTasks(
  r2: R2Bucket,
  userId: string,
  now: number = Date.now()
): Promise<number> {
  const key = `orchestra/${userId}/history.json`;

  let history: OrchestraHistory;
  try {
    const obj = await r2.get(key);
    if (!obj) return 0;
    history = await obj.json() as OrchestraHistory;
  } catch {
    return 0;
  }

  let cleaned = 0;
  for (const task of history.tasks) {
    if (task.status === 'started' && (now - task.timestamp) > STALE_TASK_THRESHOLD_MS) {
      task.status = 'failed';
      task.summary = `STALE: Task stuck in "started" for >${Math.round((now - task.timestamp) / 60000)}min — auto-failed`;
      cleaned++;
    }
  }

  if (cleaned > 0) {
    history.updatedAt = now;
    await r2.put(key, JSON.stringify(history));
  }

  return cleaned;
}

// ============================================================
// Historical Model Performance Stats
// ============================================================

/** Per-model completion stats derived from orchestra history. */
export interface ModelCompletionStats {
  alias: string;
  completed: number;
  failed: number;
  total: number;
  /** Bayesian-smoothed success rate (0-1). Starts at 0.5 with 2 pseudo-observations. */
  successRate: number;
}

/**
 * Compute per-model completion stats from all users' orchestra histories.
 * Uses a Bayesian prior (Beta(1,1) → start at 50% with 2 pseudo-obs) so that
 * models with few tasks don't dominate the ranking.
 */
export function getModelCompletionStats(
  histories: OrchestraHistory[]
): Map<string, ModelCompletionStats> {
  const raw = new Map<string, { completed: number; failed: number }>();

  for (const history of histories) {
    for (const task of history.tasks) {
      if (task.status !== 'completed' && task.status !== 'failed') continue;
      const entry = raw.get(task.modelAlias) ?? { completed: 0, failed: 0 };
      if (task.status === 'completed') entry.completed++;
      else entry.failed++;
      raw.set(task.modelAlias, entry);
    }
  }

  const stats = new Map<string, ModelCompletionStats>();
  for (const [alias, { completed, failed }] of raw) {
    const total = completed + failed;
    // Beta(1,1) prior → (completed + 1) / (total + 2)
    const successRate = (completed + 1) / (total + 2);
    stats.set(alias, { alias, completed, failed, total, successRate });
  }
  return stats;
}

/**
 * Load all orchestra histories from R2 for model stats aggregation.
 * Scans the orchestra/ prefix and loads all history.json files.
 * Returns at most 50 histories to bound R2 reads.
 */
export async function loadAllOrchestraHistories(
  r2: R2Bucket
): Promise<OrchestraHistory[]> {
  const histories: OrchestraHistory[] = [];
  try {
    const listed = await r2.list({ prefix: 'orchestra/', limit: 100 });
    const historyKeys = listed.objects
      .filter(o => o.key.endsWith('/history.json'))
      .slice(0, 50);

    for (const obj of historyKeys) {
      try {
        const data = await r2.get(obj.key);
        if (data) {
          histories.push(await data.json() as OrchestraHistory);
        }
      } catch { /* skip corrupt entries */ }
    }
  } catch { /* R2 unavailable — return empty */ }
  return histories;
}

/**
 * Format orchestra history for display to the user.
 */
export function formatOrchestraHistory(history: OrchestraHistory | null): string {
  if (!history || history.tasks.length === 0) {
    return '📋 No orchestra tasks yet.\n\nUsage:\n  /orchestra init owner/repo <project description>\n  /orchestra run owner/repo';
  }

  const lines: string[] = ['📋 Orchestra Task History\n'];

  for (const task of history.tasks.slice(-10).reverse()) {
    const status = task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : '⏳';
    const date = new Date(task.timestamp).toLocaleDateString();
    const modeTag = task.mode === 'init' ? ' [INIT]' : task.mode === 'redo' ? ' [REDO]' : '';
    const duration = task.durationMs
      ? ` | ⏱ ${task.durationMs >= 60000 ? `${Math.round(task.durationMs / 60000)}m` : `${Math.round(task.durationMs / 1000)}s`}`
      : '';
    const pr = task.prUrl ? `\n   PR: ${task.prUrl}` : '';
    const summary = task.summary ? `\n   ${task.summary}` : '';
    lines.push(
      `${status} ${task.repo}${modeTag} — ${task.prompt.substring(0, 60)}${task.prompt.length > 60 ? '...' : ''}` +
      `\n   🤖 /${task.modelAlias} | 🌿 ${task.branchName} | ${date}${duration}${pr}${summary}`
    );
  }

  return lines.join('\n\n');
}

// ============================================================
// Roadmap Status Display
// ============================================================

/**
 * Fetch the roadmap file from a GitHub repo.
 * Tries ROADMAP_FILE_CANDIDATES in order and returns the first found.
 */
export async function fetchRoadmapFromGitHub(
  owner: string,
  repo: string,
  githubToken?: string
): Promise<{ content: string; path: string }> {
  const headers: Record<string, string> = {
    'User-Agent': 'MoltworkerBot/1.0',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }

  for (const candidate of ROADMAP_FILE_CANDIDATES) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(candidate)}`;
    const response = await fetch(url, { headers });
    if (!response.ok) continue;

    const data = await response.json() as { content?: string; message?: string };
    if (!data.content) continue;

    // Decode base64 → UTF-8 (atob produces Latin-1, mangling multi-byte chars like →)
    const binary = atob(data.content.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const content = new TextDecoder().decode(bytes);
    return { content, path: candidate };
  }

  throw new Error('No roadmap file found. Run `/orch init` to create one.');
}

/** Single task in a roadmap phase — now with hierarchy metadata */
export interface RoadmapTask {
  title: string;
  done: boolean;
  /** Indentation level (0 = top-level, 2/4 = sub-task) */
  indent: number;
  /** Child sub-tasks nested under this task */
  children: RoadmapTask[];
  /** How the task was parsed */
  kind: 'checkbox' | 'numbered-checkbox' | 'numbered-plain';
  /** Line index in the original content (0-based) — used by reset/find */
  lineIndex: number;
}

/** Parsed phase from a roadmap */
export interface RoadmapPhase {
  name: string;
  /** Flat list of ALL tasks (top-level + children) — backwards-compatible */
  tasks: RoadmapTask[];
  /** Only top-level tasks (indent=0); children are nested in .children */
  topLevelTasks: RoadmapTask[];
}

/** Result from resolveNextRoadmapTask() */
export interface ResolvedTask {
  /** The primary task title */
  title: string;
  /** Phase this task belongs to */
  phase: string;
  /** Full task object */
  task: RoadmapTask;
  /** Parent task if this is a sub-task */
  parent?: RoadmapTask;
  /** Pending sub-tasks if this is a parent */
  pendingChildren: RoadmapTask[];
  /** Recently completed siblings for context */
  completedContext: string[];
  /** How concrete/actionable the task title is (0–10) */
  concreteScore: number;
  /** Ambiguity level */
  ambiguity: 'none' | 'low' | 'high';
  /** Structured execution brief for the model */
  executionBrief: string;
}

// ============================================================
// EXECUTION PROFILE — centralized classification for downstream consumers
// ============================================================

/** Ambiguity level derived from concreteness score */
export type TaskAmbiguity = 'none' | 'low' | 'high';

/**
 * Complexity tier — pre-execution scope classification.
 * Determined once in buildExecutionProfile() from task title signals.
 *
 * This classifies the *scope* of the task, not model capability.
 * Used for:
 * - Setting expected budgets (tool counts, wall-clock) for observability
 * - Triggering model escalation suggestions when actuals exceed expectations
 * - Informing the model about expected scope via system prompt
 *
 * NOT used for hard-killing tasks — stall detection handles that.
 *
 * trivial: typo, version bump, add comment, rename
 * small:   config change, simple bug fix, single-file edit
 * medium:  new feature, add route, single-file refactor
 * large:   multi-file refactor, migration, test suite
 */
export type ComplexityTier = 'trivial' | 'small' | 'medium' | 'large';

/**
 * Expected scope budgets per tier.
 * These are *expectations*, not hard limits. When exceeded, the system
 * suggests model escalation rather than aborting the task.
 */
export interface TierBudget {
  /** Expected max auto-resumes for this scope */
  expectedResumes: number;
  /** Expected max tool calls for this scope */
  expectedTools: number;
  /** Expected max wall-clock time (ms) for this scope */
  expectedWallClockMs: number;
}

/** Expected budgets by tier — used for escalation triggers, not hard kills.
 * Calibrated to Claude Code-like UX expectations:
 * - trivial should complete in under a minute (no resume needed)
 * - small should feel snappy (1-2 min, maybe one resume)
 * - medium is standard feature work (5-8 min, few resumes)
 * - large is the only tier where longer runs are expected
 */
export const TIER_BUDGETS: Record<ComplexityTier, TierBudget> = {
  trivial: { expectedResumes: 0, expectedTools: 5,  expectedWallClockMs: 60_000 },
  small:   { expectedResumes: 1, expectedTools: 15, expectedWallClockMs: 120_000 },
  medium:  { expectedResumes: 3, expectedTools: 40, expectedWallClockMs: 480_000 },
  large:   { expectedResumes: 6, expectedTools: 80, expectedWallClockMs: 900_000 },
};

/**
 * Centralized classification object computed once after task resolution.
 * Bundles all task signals so sandbox gate, resume policy, model floor,
 * and prompt tier react to the exact same data.
 */
export interface OrchestraExecutionProfile {
  /** A priori intent signals from task title + roadmap structure */
  intent: {
    concreteScore: number;       // 0–10 from scoreTaskConcreteness()
    ambiguity: TaskAmbiguity;
    isHeavyCoding: boolean;
    isSimple: boolean;
    pendingChildren: number;
  };

  /** Deterministic execution bounds derived from intent signals */
  bounds: {
    /** Whether to include sandbox verification in the prompt and expose the tool */
    requiresSandbox: boolean;
    /** Max auto-resumes before giving up */
    maxAutoResumes: number;
    /** Complexity tier — classifies task scope for observability and escalation */
    complexityTier: ComplexityTier;
    /** Expected resume count for this scope (soft limit — triggers escalation advice) */
    expectedResumes: number;
    /** Expected tool count for this scope (soft limit — triggers escalation advice) */
    expectedTools: number;
    /** Expected wall-clock time for this scope (soft limit — triggers escalation advice) */
    expectedWallClockMs: number;
  };

  /** Model routing directives */
  routing: {
    promptTier: 'minimal' | 'standard' | 'full';
    /** Force escalation if heavy task lands on a weak model */
    forceEscalation: boolean;
    /** Minimum IQ floor for this task type (0 = no floor) */
    modelFloor: number;
  };
}

/**
 * Classify a task into a complexity tier based on derived signals.
 * This is the single source of truth for scope-based budget expectations.
 *
 * Classification rules:
 * - trivial: simple + no ambiguity (typo, bump, rename, readme)
 * - large:   heavy coding OR 3+ pending children
 * - medium:  high ambiguity (non-heavy) OR low ambiguity (non-simple)
 * - small:   simple with some ambiguity OR concrete non-heavy tasks
 */
export function classifyComplexityTier(
  isSimple: boolean,
  isHeavyCoding: boolean,
  ambiguity: TaskAmbiguity,
  pendingChildren: number,
): ComplexityTier {
  // Trivial: explicitly simple + highly concrete (no ambiguity)
  if (isSimple && ambiguity === 'none') return 'trivial';

  // Large: heavy coding or parent with many children
  if (isHeavyCoding) return 'large';
  if (pendingChildren >= 3) return 'large';

  // Medium: high ambiguity (but not heavy) — unclear scope, not huge scope
  if (ambiguity === 'high') return 'medium';

  // Small: simple tasks with some ambiguity, or concrete non-coding tasks
  if (isSimple) return 'small';
  if (ambiguity === 'none' && pendingChildren === 0) return 'small';

  // Default: medium (low ambiguity, non-simple, non-heavy)
  return 'medium';
}

/**
 * Detect scope amplifiers — signals in the title and brief that predict
 * the task will be larger than the base tier suggests.
 *
 * Each amplifier is a pattern that, when present, indicates the task
 * likely involves more files/tools/time than a naive title-only
 * classification would predict. Returns the number of amplifiers matched.
 *
 * Examples of under-classified tasks this catches:
 * - "Add unit tests for financial calculations" → needs extraction + new module + vitest setup
 * - "Implement API endpoint" → might need tests + validation + types + route registration
 */
export function countScopeAmplifiers(title: string, executionBrief: string): number {
  const combined = `${title}\n${executionBrief}`.toLowerCase();
  let count = 0;

  // Testing signals: likely needs test infra, fixtures, possibly extraction
  if (/\b(unit tests?|test suite|add tests|write tests|testing)\b/.test(combined)) count++;

  // Extraction/splitting signals: moving code between files
  if (/\b(extract|split|separate|move .* to|into (its own|a new|separate))\b/.test(combined)) count++;

  // Multi-file signals: explicitly mentions multiple files or directories
  if (/\b(multiple files|several files|across files|new files?|new modules?)\b/.test(combined)) count++;

  // Infrastructure/tooling signals: package.json, config, CI changes
  if (/\bpackage\.json\b|vitest|jest|eslint|prettier|ci\/cd|dockerfile|docker|pipeline/.test(combined)) count++;

  // Integration signals: wiring up components, imports, exports
  if (/\b(integrat|wire\b|connect|register|hook up|plumb)/.test(combined)) count++;

  // Pending children in the brief suggest compound scope
  if (/sub-tasks|pending children|child tasks/.test(combined)) count++;

  return count;
}

/**
 * Build an execution profile from a resolved task and model info.
 * Called once in executeOrchestra() after resolveNextRoadmapTask(),
 * then passed through the entire pipeline.
 */
export function buildExecutionProfile(
  resolved: ResolvedTask,
  modelAlias: string,
): OrchestraExecutionProfile {
  const title = resolved.title;
  const isSimple = /add comment|update readme|rename|typo|config|bump|version/i.test(title);
  const isHeavyCoding = /refactor|split|migrat|rewrite|architect|complex|multi.?file|test suite/i.test(title);

  const model = getModel(modelAlias);
  const intelligenceIndex = model?.intelligenceIndex ?? (model?.isFree ? 20 : 50);

  // Prompt tier (same logic as getPromptTier but using already-resolved model)
  const promptTier: OrchestraExecutionProfile['routing']['promptTier'] =
    intelligenceIndex >= 45 ? 'full' :
    intelligenceIndex >= 28 ? 'standard' :
    'minimal';

  // Sandbox bypass: only skip if explicitly simple AND highly concrete
  const requiresSandbox = !(isSimple && resolved.ambiguity === 'none');

  // Complexity tier classifies task scope for observability and escalation.
  // This is SEPARATE from the resume cap — tier is about scope, resumes are about model reliability.
  const childrenCount = resolved.pendingChildren.length;
  let tier = classifyComplexityTier(isSimple, isHeavyCoding, resolved.ambiguity, childrenCount);

  // Scope amplifiers: if the title/brief contain signals of hidden complexity,
  // bump the tier up. This catches tasks like "add tests for X" that look small
  // but require extraction, new modules, tooling config, etc.
  const amplifiers = countScopeAmplifiers(title, resolved.executionBrief);
  if (amplifiers >= 2 && (tier === 'trivial' || tier === 'small')) {
    tier = 'medium';
  } else if (amplifiers >= 1 && tier === 'trivial') {
    tier = 'small';
  }

  const tierBudget = TIER_BUDGETS[tier];

  // Resume cap: based on ambiguity and task structure (not tier).
  // This controls how many chances the model gets, which is about reliability.
  const baseResumes = 6; // Orchestra default
  const maxAutoResumes =
    resolved.ambiguity === 'high' ? Math.min(baseResumes, 3) :
    resolved.ambiguity === 'low' ? Math.min(baseResumes, 4) :
    isHeavyCoding && intelligenceIndex >= 45 ? baseResumes + 2 :
    childrenCount >= 3 ? baseResumes + 1 :
    baseResumes;

  // Force escalation if heavy task on weak model
  const forceEscalation = isHeavyCoding && intelligenceIndex < 28;

  // Model floor: minimum IQ for this task type
  // Heavy coding requires at least IQ 28 (standard tier)
  // High-ambiguity tasks benefit from stronger models (IQ 35)
  const modelFloor =
    isHeavyCoding ? 28 :
    resolved.ambiguity === 'high' ? 35 :
    0; // no floor for simple/clear tasks

  return {
    intent: {
      concreteScore: resolved.concreteScore,
      ambiguity: resolved.ambiguity,
      isHeavyCoding,
      isSimple,
      pendingChildren: resolved.pendingChildren.length,
    },
    bounds: {
      requiresSandbox,
      maxAutoResumes,
      complexityTier: tier,
      expectedResumes: tierBudget.expectedResumes,
      expectedTools: tierBudget.expectedTools,
      expectedWallClockMs: tierBudget.expectedWallClockMs,
    },
    routing: {
      promptTier,
      forceEscalation,
      modelFloor,
    },
  };
}

// ─── Runtime Risk Profile (F.20) ────────────────────────────────────────────

/**
 * Risk level for runtime behavior classification.
 * Computed incrementally during tool execution in the DO.
 */
export type RuntimeRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Runtime risk profile — second-stage classification that observes
 * what the model actually does during execution, complementing the
 * pre-execution OrchestraExecutionProfile.
 *
 * Updated after every tool call batch in the DO loop.
 * Persisted in TaskState for survival across auto-resumes.
 */
export interface RuntimeRiskProfile {
  /** Current computed risk level */
  level: RuntimeRiskLevel;
  /** Numeric risk score (0–100). Drives the level. */
  score: number;

  /** File-based risk signals */
  files: {
    /** Total unique files modified (workspace_write, github_create_pr, github_push_files) */
    modifiedCount: number;
    /** Config/build/infra files touched (package.json, wrangler.jsonc, tsconfig, CI, Dockerfile, etc.) */
    configFilesTouched: string[];
    /** Whether task expanded from single-file to multi-file modification */
    scopeExpanded: boolean;
    /** Initial file count when first modification was observed */
    initialModifiedCount: number;
  };

  /** Error-based risk signals */
  errors: {
    /** Total tool errors */
    totalErrors: number;
    /** Consecutive error iterations (no successful tool call in an iteration) */
    consecutiveErrorIterations: number;
    /** Mutation tool errors (github_create_pr, github_push_files, github_api) */
    mutationErrors: number;
  };

  /** Scope drift: predicted vs actual complexity */
  drift: {
    /** Pre-execution profile predicted simple task */
    predictedSimple: boolean;
    /** Actual behavior contradicts prediction */
    driftDetected: boolean;
    /** Reason for drift detection */
    driftReason?: string;
  };

  /** Timestamps for observability */
  firstUpdate: number;
  lastUpdate: number;
}

/**
 * Patterns for files that indicate higher risk when modified.
 * These are infrastructure/config files where changes have broad impact.
 */
const HIGH_RISK_FILE_PATTERNS = [
  /package\.json$/,
  /package-lock\.json$/,
  /tsconfig(\.\w+)?\.json$/,
  /wrangler\.(jsonc?|toml)$/,
  /\.github\/workflows\//,
  /Dockerfile/,
  /docker-compose/,
  /\.env(\.\w+)?$/,
  /vitest\.config/,
  /eslint/,
  /prettier/,
  /\.gitignore$/,
  /jest\.config/,
  /webpack\.config/,
  /vite\.config/,
  /rollup\.config/,
  /Makefile$/,
  /\.npmrc$/,
  /\.nvmrc$/,
];

/**
 * Check if a file path matches high-risk patterns.
 */
export function isHighRiskFile(path: string): boolean {
  return HIGH_RISK_FILE_PATTERNS.some(pattern => pattern.test(path));
}

/**
 * Create an initial (empty) RuntimeRiskProfile.
 */
export function createRuntimeRiskProfile(predictedSimple: boolean): RuntimeRiskProfile {
  const now = Date.now();
  return {
    level: 'low',
    score: 0,
    files: {
      modifiedCount: 0,
      configFilesTouched: [],
      scopeExpanded: false,
      initialModifiedCount: 0,
    },
    errors: {
      totalErrors: 0,
      consecutiveErrorIterations: 0,
      mutationErrors: 0,
    },
    drift: {
      predictedSimple,
      driftDetected: false,
    },
    firstUpdate: now,
    lastUpdate: now,
  };
}

/** Mutation tools whose errors carry extra risk weight */
const MUTATION_TOOLS = new Set([
  'github_create_pr', 'github_push_files', 'github_api',
  'workspace_write_file', 'workspace_commit', 'workspace_delete_file',
  'sandbox_exec',
]);

/**
 * Update runtime risk profile after a batch of tool results.
 *
 * Called in the DO loop after all tool results in an iteration are processed.
 * Mutates the profile in place for efficiency (it's persisted on TaskState).
 *
 * @param profile - The runtime risk profile to update
 * @param toolResults - Array of {toolName, isError, isMutationError} from this iteration
 * @param filesModified - Current task.filesModified array
 */
export function updateRuntimeRisk(
  profile: RuntimeRiskProfile,
  toolResults: Array<{ toolName: string; isError: boolean }>,
  filesModified: string[],
): void {
  profile.lastUpdate = Date.now();

  // ─── File risk signals ───────────────────────────────────────────────
  const prevModified = profile.files.modifiedCount;
  profile.files.modifiedCount = filesModified.length;

  // Track initial modification count for scope expansion detection
  if (prevModified === 0 && filesModified.length > 0) {
    profile.files.initialModifiedCount = filesModified.length;
  }

  // Detect scope expansion: started with ≤2 files, now touching 5+
  if (!profile.files.scopeExpanded &&
      profile.files.initialModifiedCount > 0 &&
      profile.files.initialModifiedCount <= 2 &&
      filesModified.length >= 5) {
    profile.files.scopeExpanded = true;
  }

  // Check new files for high-risk patterns
  for (const filePath of filesModified) {
    if (isHighRiskFile(filePath) && !profile.files.configFilesTouched.includes(filePath)) {
      profile.files.configFilesTouched.push(filePath);
    }
  }

  // ─── Error risk signals ──────────────────────────────────────────────
  const iterationErrors = toolResults.filter(r => r.isError);
  profile.errors.totalErrors += iterationErrors.length;

  const mutationErrors = iterationErrors.filter(r => MUTATION_TOOLS.has(r.toolName));
  profile.errors.mutationErrors += mutationErrors.length;

  // Track consecutive error iterations
  if (iterationErrors.length > 0 && iterationErrors.length === toolResults.length) {
    // ALL tools in this iteration failed
    profile.errors.consecutiveErrorIterations++;
  } else if (iterationErrors.length < toolResults.length) {
    // At least one tool succeeded — reset consecutive counter
    profile.errors.consecutiveErrorIterations = 0;
  }

  // ─── Scope drift detection ──────────────────────────────────────────
  if (profile.drift.predictedSimple && !profile.drift.driftDetected) {
    if (filesModified.length >= 5) {
      profile.drift.driftDetected = true;
      profile.drift.driftReason = `simple task touching ${filesModified.length} files`;
    } else if (profile.files.configFilesTouched.length >= 2) {
      profile.drift.driftDetected = true;
      profile.drift.driftReason = `simple task modifying ${profile.files.configFilesTouched.length} config files: ${profile.files.configFilesTouched.join(', ')}`;
    } else if (profile.errors.totalErrors >= 5) {
      profile.drift.driftDetected = true;
      profile.drift.driftReason = `simple task with ${profile.errors.totalErrors} tool errors`;
    }
  }

  // ─── Compute score ──────────────────────────────────────────────────
  profile.score = computeRiskScore(profile);
  profile.level = scoreToLevel(profile.score);
}

/**
 * Compute a numeric risk score (0–100) from accumulated signals.
 */
function computeRiskScore(profile: RuntimeRiskProfile): number {
  let score = 0;

  // File risk: 0–35 points
  // Many files modified
  if (profile.files.modifiedCount >= 10) score += 15;
  else if (profile.files.modifiedCount >= 5) score += 8;
  else if (profile.files.modifiedCount >= 3) score += 3;

  // Config files touched (high impact per file)
  score += Math.min(profile.files.configFilesTouched.length * 8, 20);

  // Scope expansion detected
  if (profile.files.scopeExpanded) score += 10;

  // Error risk: 0–35 points
  // Total errors
  if (profile.errors.totalErrors >= 8) score += 15;
  else if (profile.errors.totalErrors >= 4) score += 8;
  else if (profile.errors.totalErrors >= 2) score += 3;

  // Mutation errors (extra weight)
  score += Math.min(profile.errors.mutationErrors * 5, 15);

  // Consecutive error iterations (model is stuck)
  if (profile.errors.consecutiveErrorIterations >= 3) score += 10;
  else if (profile.errors.consecutiveErrorIterations >= 2) score += 5;

  // Drift risk: 0–30 points
  if (profile.drift.driftDetected) score += 20;

  // Drift + config files = compound risk
  if (profile.drift.driftDetected && profile.files.configFilesTouched.length > 0) {
    score += 10;
  }

  return Math.min(score, 100);
}

/**
 * Map numeric score to risk level.
 */
function scoreToLevel(score: number): RuntimeRiskLevel {
  if (score >= 60) return 'critical';
  if (score >= 35) return 'high';
  if (score >= 15) return 'medium';
  return 'low';
}

/**
 * Format runtime risk for logging / Telegram status messages.
 */
export function formatRuntimeRisk(profile: RuntimeRiskProfile): string {
  const parts: string[] = [];
  parts.push(`Risk: ${profile.level} (${profile.score}/100)`);

  if (profile.files.modifiedCount > 0) {
    parts.push(`Files: ${profile.files.modifiedCount} modified`);
  }
  if (profile.files.configFilesTouched.length > 0) {
    parts.push(`Config: ${profile.files.configFilesTouched.join(', ')}`);
  }
  if (profile.files.scopeExpanded) {
    parts.push('Scope expanded');
  }
  if (profile.drift.driftDetected) {
    parts.push(`Drift: ${profile.drift.driftReason}`);
  }
  if (profile.errors.totalErrors > 0) {
    parts.push(`Errors: ${profile.errors.totalErrors} (${profile.errors.mutationErrors} mutation)`);
  }

  return parts.join(' | ');
}

/**
 * Score how concrete/actionable a task title is (0–10).
 * Higher = more specific, lower = generic boilerplate.
 */
export function scoreTaskConcreteness(title: string): number {
  let score = 0;

  // File paths or extensions → very concrete (frontend + backend)
  if (/\b(src\/|app\/|components\/|pages\/|lib\/|\.tsx?|\.jsx?|\.css|\.json|\.vue|\.svelte|\.py|\.go|\.rs|\.java|\.rb|\.php|\.sql|\.proto|\.yaml|\.yml|\.toml|\.sh)\b/.test(title)) score += 3;
  // Backtick-quoted identifiers (function names, components, etc.)
  if (/`[^`]+`/.test(title)) score += 3;
  // Numbered step labels like "Step 7", "Task 2.1"
  if (/\b(?:step|task|phase)\s+\d+(?:\.\d+)?\b/i.test(title)) score += 2;
  // Domain-specific nouns (component, hook, function, etc.)
  if (/\b(component|hook|function|class|schema|route|import|export|module|endpoint|middleware|model|controller|service|handler|migration|fixture|template|view)\b/i.test(title)) score += 2;
  // Longer titles tend to be more descriptive
  if (title.length > 80) score += 1;

  // Negative signals — generic boilerplate fragments
  // Only penalize when there are NO strong positive anchors (backticks or directory paths)
  const hasAnchors = /`[^`]+`|\b\w+\/\w+/.test(title);
  if (!hasAnchors) {
    if (/^create the new file/i.test(title)) score -= 4;
    if (/^add the import/i.test(title)) score -= 4;
    if (/^delete the original code/i.test(title)) score -= 4;
    if (/^verify the app still/i.test(title)) score -= 4;
    if (/^verify it still/i.test(title)) score -= 3;
  }
  // Very short titles are usually vague
  if (title.length < 24) score -= 1;

  return Math.max(0, Math.min(10, score));
}

/**
 * Parse a ROADMAP.md into phases and tasks.
 *
 * Now builds a hierarchy: indented checkboxes become children of the
 * nearest preceding top-level task. The flat `.tasks` array is preserved
 * for backwards compatibility; `.topLevelTasks` has the hierarchical view.
 *
 * Supports multiple formats:
 * - Standard: `### Phase N: Title` headers + `- [x]` task lines
 * - H2 headers: `## Phase N: Title` or `## Title`
 * - Numbered lists: `1. [x] Task title` or `1. Task title` (treated as done=false)
 * - Indented checkboxes: `  - [x] Task title` (children of nearest top-level task)
 * - Flat checklists: `- [x] Task` with no phase headers (grouped into "Tasks")
 */
export function parseRoadmapPhases(content: string): RoadmapPhase[] {
  type Accum = { name: string; flatTasks: RoadmapTask[]; topLevel: RoadmapTask[] };
  const accums: Accum[] = [];
  let current: Accum | null = null;

  // Indent stack for true N-level nesting.
  // Each entry is { indent, task } — the task at that indentation level.
  // When a new task arrives, we pop entries with indent >= the new task's indent,
  // then the top of the stack is the parent (or empty = top-level).
  let indentStack: { indent: number; task: RoadmapTask }[] = [];

  const lines = content.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    // Match phase headers:
    // "### Phase 1: Setup", "### Phase 1 — Setup", "### Setup" (any ### header)
    // "## Phase 1: Setup", "## Step 1: Setup", "## Setup" (any ## header)
    // "# Phase 1: Setup", "# Step 1 — Setup" (single # with Phase/Step/Sprint prefix only)
    const phaseMatch = line.match(/^###\s+(?:Phase\s+\d+\s*[:.—\-]\s*)?(.+)/i)
      || line.match(/^##\s+(?:(?:Phase|Step|Sprint)\s+\d+\s*[:.—\-]\s*)?(.+)/i)
      || line.match(/^#\s+(?:Phase|Step|Sprint)\s+\d+\s*[:.—\-]\s*(.+)/i);
    if (phaseMatch) {
      current = { name: phaseMatch[1].trim(), flatTasks: [], topLevel: [] };
      accums.push(current);
      indentStack = [];
      continue;
    }

    // Measure leading whitespace to determine nesting
    const indentMatch = line.match(/^(\t| +)/);
    const rawIndent = indentMatch ? (indentMatch[1] === '\t' ? 4 : indentMatch[1].length) : 0;

    // Match task lines: "- [x] Task", "* [ ] Task", "  - [x] Task", "\t- [ ] Task"
    const taskMatch = line.match(/^[\t ]{0,8}[-*]\s+\[([ xX])\]\s+(.+)/);
    if (taskMatch) {
      const done = taskMatch[1].toLowerCase() === 'x';
      const title = taskMatch[2]
        .replace(/^\*\*(?:Task\s+[\d.]+)?\*\*:?\s*/, '')
        .replace(/\*\*/g, '')
        .trim();
      const task: RoadmapTask = { title, done, indent: rawIndent, children: [], kind: 'checkbox', lineIndex: lineIdx };

      if (!current) {
        current = { name: 'Tasks', flatTasks: [], topLevel: [] };
        accums.push(current);
      }

      // Always add to flat list (backwards compat)
      current.flatTasks.push(task);

      // Hierarchy via indent stack
      nestTask(task, rawIndent, indentStack, current);
      continue;
    }

    // Match numbered list items with checkboxes: "1. [x] Task title"
    const numberedCheckboxMatch = line.match(/^[\t ]{0,8}\d+\.\s+\[([ xX])\]\s+(.+)/);
    if (numberedCheckboxMatch) {
      const done = numberedCheckboxMatch[1].toLowerCase() === 'x';
      const title = numberedCheckboxMatch[2]
        .replace(/^\*\*(?:Task\s+[\d.]+)?\*\*:?\s*/, '')
        .replace(/\*\*/g, '')
        .trim();
      const task: RoadmapTask = { title, done, indent: rawIndent, children: [], kind: 'numbered-checkbox', lineIndex: lineIdx };

      if (!current) {
        current = { name: 'Tasks', flatTasks: [], topLevel: [] };
        accums.push(current);
      }
      current.flatTasks.push(task);

      nestTask(task, rawIndent, indentStack, current);
      continue;
    }

    // Match plain numbered list items (no checkbox, treated as not done): "1. Task title"
    // Only match if we're already inside a phase (to avoid matching random numbered text)
    const numberedPlainMatch = line.match(/^[\t ]{0,8}\d+\.\s+(.+)/);
    if (numberedPlainMatch && current) {
      const title = numberedPlainMatch[1]
        .replace(/^\*\*(?:Task\s+[\d.]+)?\*\*:?\s*/, '')
        .replace(/\*\*/g, '')
        .trim();
      // Skip lines that look like sub-descriptions (start with lowercase, very short)
      if (title.length > 5) {
        const task: RoadmapTask = { title, done: false, indent: rawIndent, children: [], kind: 'numbered-plain', lineIndex: lineIdx };
        current.flatTasks.push(task);
        current.topLevel.push(task);
        indentStack = [{ indent: rawIndent, task }];
      }
    }
  }

  return accums
    .filter(p => p.flatTasks.length > 0)
    .map(p => ({ name: p.name, tasks: p.flatTasks, topLevelTasks: p.topLevel }));
}

/**
 * Nest a task into the hierarchy using an indent stack.
 * Pop entries with indent >= the new task's indent, then:
 * - If the stack is non-empty, the top entry is the parent → add as child
 * - If empty, it's a top-level task
 * Then push this task onto the stack.
 */
function nestTask(
  task: RoadmapTask,
  rawIndent: number,
  indentStack: { indent: number; task: RoadmapTask }[],
  current: { topLevel: RoadmapTask[] },
): void {
  // Pop tasks at same or deeper indent — they can't be parents
  while (indentStack.length > 0 && indentStack[indentStack.length - 1].indent >= rawIndent) {
    indentStack.pop();
  }

  if (indentStack.length > 0) {
    // Parent is the top of the stack (nearest less-indented task)
    indentStack[indentStack.length - 1].task.children.push(task);
  } else {
    // No parent → top-level
    current.topLevel.push(task);
  }

  indentStack.push({ indent: rawIndent, task });
}

/**
 * Resolve the best next task from parsed roadmap phases.
 *
 * Selection policy (in order):
 * 1. Prefer top-level unchecked tasks with high concreteness scores
 * 2. If only generic sub-tasks remain, bundle with parent context
 * 3. Skip completed parents whose children are just boilerplate
 * 4. Never return a high-ambiguity task without enriching it
 */
export function resolveNextRoadmapTask(phases: RoadmapPhase[]): ResolvedTask | null {
  // First pass: find the best concrete top-level task
  for (const phase of phases) {
    for (const task of phase.topLevelTasks) {
      // Skip numbered-plain items — they're notes/prose, not executable tasks
      if (task.kind === 'numbered-plain') continue;
      // Skip fully completed tasks (task + all children done)
      if (task.done && task.children.every(c => c.done)) continue;

      // Case 1: Top-level task itself is undone → check concreteness
      if (!task.done) {
        let score = scoreTaskConcreteness(task.title);
        // Boost score if children provide concrete context (file paths, identifiers)
        const pendingChildren = task.children.filter(c => !c.done);
        if (pendingChildren.some(c => scoreTaskConcreteness(c.title) >= 3)) {
          score = Math.max(score, 3); // Children anchor the task
        }
        if (score >= 3) {
          const completedContext = collectCompletedContext(phase);
          return buildResolvedTask(task, phase.name, score, pendingChildren, completedContext);
        }
      }

      // Case 2: Top-level task is undone but generic (score < 3)
      // → skip it, look for a better task downstream
      if (!task.done) continue;

      // Case 3: Top-level task is done but has pending children
      // These children are likely sub-steps of an already-started parent.
      // Bundle them under the parent for context.
      const pendingChildren = task.children.filter(c => !c.done);
      if (pendingChildren.length > 0) {
        // Check if the children are generic boilerplate
        const allGeneric = pendingChildren.every(c => scoreTaskConcreteness(c.title) < 3);
        if (allGeneric) {
          // Skip — these are orphaned boilerplate sub-steps of a completed parent
          continue;
        }
        // Some children are concrete — bundle under parent
        const bestChild = pendingChildren.reduce((best, c) =>
          scoreTaskConcreteness(c.title) > scoreTaskConcreteness(best.title) ? c : best
        );
        const score = scoreTaskConcreteness(bestChild.title);
        const completedContext = collectCompletedContext(phase);
        return buildResolvedTask(bestChild, phase.name, score, pendingChildren, completedContext, task);
      }
    }
  }

  // Second pass: no task scored ≥3. Pick the highest-scoring undone task
  // across all phases (prefer less-generic tasks even if they come later).
  // Also considers pending children of completed parents (Gemini Fix 3).
  let bestCandidate: { task: RoadmapTask; phase: RoadmapPhase; score: number; pendingChildren: RoadmapTask[]; parent?: RoadmapTask } | null = null;

  for (const phase of phases) {
    for (const task of phase.topLevelTasks) {
      // Skip numbered-plain items — they're notes/prose, not executable tasks
      if (task.kind === 'numbered-plain') continue;

      if (task.done && task.children.every(c => c.done)) continue;

      if (!task.done) {
        const score = scoreTaskConcreteness(task.title);
        const pendingChildren = task.children.filter(c => !c.done);
        if (!bestCandidate || score > bestCandidate.score) {
          bestCandidate = { task, phase, score, pendingChildren };
        }
      } else {
        // Parent is done but has pending children — evaluate the best child
        const pendingChildren = task.children.filter(c => !c.done && c.kind !== 'numbered-plain');
        if (pendingChildren.length > 0) {
          const bestChild = pendingChildren.reduce((best, c) =>
            scoreTaskConcreteness(c.title) > scoreTaskConcreteness(best.title) ? c : best
          );
          const score = scoreTaskConcreteness(bestChild.title);
          if (!bestCandidate || score > bestCandidate.score) {
            bestCandidate = { task: bestChild, phase, score, pendingChildren, parent: task };
          }
        }
      }
    }
  }

  if (bestCandidate) {
    const completedContext = collectCompletedContext(bestCandidate.phase);
    return buildResolvedTask(
      bestCandidate.task, bestCandidate.phase.name, bestCandidate.score,
      bestCandidate.pendingChildren, completedContext, bestCandidate.parent,
    );
  }

  return null;
}

/** Collect recently completed task titles for context injection */
function collectCompletedContext(phase: RoadmapPhase): string[] {
  return phase.topLevelTasks
    .filter(t => t.done)
    .map(t => t.title)
    .slice(-6); // Last 6 completed tasks
}

/** Build a ResolvedTask with execution brief */
function buildResolvedTask(
  task: RoadmapTask,
  phaseName: string,
  score: number,
  pendingChildren: RoadmapTask[],
  completedContext: string[],
  parent?: RoadmapTask,
): ResolvedTask {
  const ambiguity: ResolvedTask['ambiguity'] =
    score >= 5 ? 'none' : score >= 3 ? 'low' : 'high';

  // Build execution brief
  const briefLines: string[] = [];
  briefLines.push(`Phase: ${phaseName}`);
  if (parent) {
    briefLines.push(`Parent task (completed): ${parent.title}`);
  }
  briefLines.push(`Primary task: ${task.title}`);

  if (pendingChildren.length > 0) {
    briefLines.push('');
    briefLines.push('Sub-steps to complete:');
    for (const child of pendingChildren) {
      briefLines.push(`- ${child.title}`);
    }
  }

  if (completedContext.length > 0) {
    briefLines.push('');
    briefLines.push('Already completed in this phase:');
    for (const ctx of completedContext) {
      briefLines.push(`✅ ${ctx}`);
    }
  }

  if (ambiguity === 'high') {
    briefLines.push('');
    briefLines.push('⚠️ This task title is generic. Use the completed tasks above and the roadmap for full context. If it refers to code extraction, identify WHICH code from the existing codebase should be extracted based on completed steps.');
  }

  return {
    title: task.title,
    phase: phaseName,
    task,
    parent,
    pendingChildren,
    completedContext,
    concreteScore: score,
    ambiguity,
    executionBrief: briefLines.join('\n'),
  };
}

/**
 * Format roadmap content into a concise status display for Telegram.
 * Shows per-phase progress with task checkmarks.
 */
export function formatRoadmapStatus(content: string, repo: string, filePath: string): string {
  const phases = parseRoadmapPhases(content);

  if (phases.length === 0) {
    // No structured phases found — show raw content (truncated)
    const preview = content.length > 3000 ? content.slice(0, 3000) + '\n\n[Truncated]' : content;
    return `📋 Roadmap — ${repo}\n📄 ${filePath}\n\n${preview}`;
  }

  const lines: string[] = [`📋 Roadmap Status — ${repo}`];
  lines.push(`📄 ${filePath}\n`);

  let totalDone = 0;
  let totalTasks = 0;

  for (const phase of phases) {
    const done = phase.tasks.filter(t => t.done).length;
    const total = phase.tasks.length;
    totalDone += done;
    totalTasks += total;

    const phaseDone = total > 0 && done === total;
    const phaseIcon = phaseDone ? '✅' : done > 0 ? '🔨' : '⏳';
    lines.push(`${phaseIcon} ${phase.name} (${done}/${total})`);

    for (const task of phase.tasks) {
      lines.push(`  ${task.done ? '✅' : '⬜'} ${task.title}`);
    }
    lines.push('');
  }

  // Overall progress bar
  const pct = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0;
  const filled = Math.round(pct / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  lines.push(`━━━ Overall: ${totalDone}/${totalTasks} tasks (${pct}%)`);
  lines.push(`[${bar}]`);

  return lines.join('\n');
}

// ============================================================
// Roadmap Reset / Redo
// ============================================================

/**
 * Find tasks in roadmap content that match a query string.
 * Uses the same parsed AST as the resolver for consistent semantics.
 * Matches against task titles (case-insensitive, substring match).
 * Also matches "Phase N" to select all tasks in a phase.
 */
export function findMatchingTasks(
  content: string,
  query: string
): { lineIndex: number; title: string; done: boolean; phase: string }[] {
  const phases = parseRoadmapPhases(content);
  const matches: { lineIndex: number; title: string; done: boolean; phase: string }[] = [];
  const queryLower = query.toLowerCase().trim();
  const lines = content.split('\n');

  // Check if the query targets a whole phase (e.g. "Phase 2" or "phase 2")
  const phaseQuery = queryLower.match(/^phase\s+(\d+)$/i);

  // Collect all tasks (flat) from each phase, including children
  for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
    const phase = phases[phaseIdx];
    const phaseNum = phaseIdx + 1;

    // Recursively collect all tasks in phase order
    const allTasks: RoadmapTask[] = [];
    function collectTasks(tasks: RoadmapTask[]): void {
      for (const task of tasks) {
        allTasks.push(task);
        if (task.children.length > 0) {
          collectTasks(task.children);
        }
      }
    }
    collectTasks(phase.topLevelTasks);

    for (const task of allTasks) {
      const titleLower = task.title.toLowerCase();
      // For full-line matching, use the original source line
      const fullLineLower = lines[task.lineIndex]?.toLowerCase() ?? '';

      if (phaseQuery) {
        if (phaseNum === parseInt(phaseQuery[1], 10)) {
          matches.push({ lineIndex: task.lineIndex, title: task.title, done: task.done, phase: phase.name });
        }
      } else if (
        titleLower.includes(queryLower) ||
        fullLineLower.includes(queryLower)
      ) {
        matches.push({ lineIndex: task.lineIndex, title: task.title, done: task.done, phase: phase.name });
      }
    }
  }

  return matches;
}

/**
 * Reset (uncheck) matching tasks in roadmap content.
 * Returns modified content and info about what was reset.
 */
export function resetRoadmapTasks(
  content: string,
  query: string
): { modified: string; resetCount: number; taskNames: string[] } {
  const matches = findMatchingTasks(content, query);

  // Only reset tasks that are currently done
  const toReset = matches.filter(m => m.done);

  if (toReset.length === 0) {
    return { modified: content, resetCount: 0, taskNames: [] };
  }

  const lines = content.split('\n');
  const taskNames: string[] = [];

  for (const match of toReset) {
    // Replace [x] or [X] with [ ]
    lines[match.lineIndex] = lines[match.lineIndex].replace(/\[([xX])\]/, '[ ]');
    taskNames.push(match.title);
  }

  return {
    modified: lines.join('\n'),
    resetCount: toReset.length,
    taskNames,
  };
}

/**
 * Create a GitHub PR that resets roadmap task checkboxes.
 * Uses the GitHub Git Data API (same pattern as github_create_pr tool).
 */
export async function createRoadmapResetPR(params: {
  owner: string;
  repo: string;
  filePath: string;
  newContent: string;
  taskNames: string[];
  githubToken: string;
}): Promise<{ prUrl: string; branch: string }> {
  const { owner, repo, filePath, newContent, taskNames, githubToken } = params;

  const headers: Record<string, string> = {
    'User-Agent': 'MoltworkerBot/1.0',
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `Bearer ${githubToken}`,
    'Content-Type': 'application/json',
  };

  const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
  const branchName = `bot/roadmap-reset-${Date.now()}`;

  // Step 1: Get base branch SHA
  const refResponse = await fetch(`${apiBase}/git/ref/heads/main`, { headers });
  if (!refResponse.ok) {
    throw new Error(`Failed to get main branch: ${refResponse.status}`);
  }
  const refData = await refResponse.json() as { object: { sha: string } };
  const baseSha = refData.object.sha;

  // Step 2: Create blob with updated content
  const blobResponse = await fetch(`${apiBase}/git/blobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: newContent, encoding: 'utf-8' }),
  });
  if (!blobResponse.ok) {
    throw new Error(`Failed to create blob: ${blobResponse.status}`);
  }
  const blobData = await blobResponse.json() as { sha: string };

  // Step 3: Create tree
  const treeResponse = await fetch(`${apiBase}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_tree: baseSha,
      tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blobData.sha }],
    }),
  });
  if (!treeResponse.ok) {
    throw new Error(`Failed to create tree: ${treeResponse.status}`);
  }
  const treeData = await treeResponse.json() as { sha: string };

  // Step 4: Create commit
  const commitMsg = taskNames.length === 1
    ? `fix(roadmap): reset task "${taskNames[0]}"`
    : `fix(roadmap): reset ${taskNames.length} tasks`;
  const commitResponse = await fetch(`${apiBase}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: commitMsg, tree: treeData.sha, parents: [baseSha] }),
  });
  if (!commitResponse.ok) {
    throw new Error(`Failed to create commit: ${commitResponse.status}`);
  }
  const commitData = await commitResponse.json() as { sha: string };

  // Step 5: Create branch
  const createRefResponse = await fetch(`${apiBase}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: commitData.sha }),
  });
  if (!createRefResponse.ok) {
    throw new Error(`Failed to create branch: ${createRefResponse.status}`);
  }

  // Step 6: Create pull request
  const prBody = `Resetting roadmap tasks:\n${taskNames.map(t => `- [ ] ${t}`).join('\n')}\n\nThese tasks will be picked up by the next \`/orch next\` run.`;
  const prResponse = await fetch(`${apiBase}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: commitMsg,
      head: branchName,
      base: 'main',
      body: prBody,
    }),
  });
  if (!prResponse.ok) {
    throw new Error(`Failed to create PR: ${prResponse.status}`);
  }
  const prData = await prResponse.json() as { html_url: string };

  return { prUrl: prData.html_url, branch: branchName };
}

// ============================================================
// REDO MODE — Re-execute a previously completed task
// ============================================================

/**
 * Build the system prompt for /orchestra redo.
 * Like run mode, but instructs the model to treat the specified task
 * as incomplete and re-implement it, regardless of checkbox state.
 */
export function buildRedoPrompt(params: {
  repo: string;
  modelAlias: string;
  previousTasks: OrchestraTask[];
  taskToRedo: string;
}): string {
  const { repo, modelAlias, previousTasks, taskToRedo } = params;
  const [owner, repoName] = repo.split('/');

  let historyContext = '';
  if (previousTasks.length > 0) {
    const recent = previousTasks.slice(-5);
    const lines = recent.map(t => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⏳';
      const pr = t.prUrl ? ` → ${t.prUrl}` : '';
      const sum = t.summary ? ` — ${t.summary.substring(0, 100)}` : '';
      return `  ${icon} [${t.branchName}] "${t.prompt.substring(0, 80)}"${pr}${sum}`;
    });
    historyContext = `\n\n## Recent Orchestra History\n${lines.join('\n')}\n\nThe most recent attempt at this task may have been incorrect. Do NOT repeat the same mistakes.`;
  }

  return `# Orchestra REDO Mode — Re-implement a Task

You are RE-DOING a task that was previously attempted but needs correction.

## Target Repository
- Owner: ${owner}
- Repo: ${repoName}
- Full: ${repo}

## Task to Redo
"${taskToRedo}"

## CRITICAL INSTRUCTIONS
1. This task was previously attempted but the result was INCORRECT or INCOMPLETE.
2. Treat this task as UNCOMPLETED regardless of its checkbox state in the roadmap.
3. Read the EXISTING code carefully to understand what the previous attempt did wrong.
4. Re-implement the task PROPERLY from scratch if needed, or fix the existing attempt.

## Step 1: READ THE ROADMAP
- Use \`github_read_file\` to find and read the roadmap
- Check these paths in order: ${ROADMAP_FILE_CANDIDATES.join(', ')}
- Find the task matching: "${taskToRedo}"
- If the task is marked \`- [x]\`, change it back to \`- [ ]\` in your PR

## Step 2: UNDERSTAND CURRENT STATE
- Use \`github_list_files\` and \`github_read_file\` to examine:
  - The files that were modified by the previous attempt
  - The current state of the code
  - What is wrong or missing
  - Test failures if any

## Step 2.5: REPO HEALTH CHECK
Before re-implementing, check if the target file(s) are too large (>${LARGE_FILE_WARNING_LINES} lines / ~${LARGE_FILE_THRESHOLD_KB}KB of source code).
If so, split the large file into smaller modules FIRST (pure refactor, no behavior change), then proceed with the redo on the now-smaller files.
Use \`github_create_pr\` with ALL files (new modules + updated original) in a SINGLE call — the identifier check allows splits when moved identifiers are found in other files in the same PR.
Update the roadmap to reflect the split as a completed prerequisite task.

## Step 3: RE-IMPLEMENT
- Fix or rewrite the implementation
- Follow existing code conventions
- Include proper types (no \`any\`)
- Write/fix tests if the repo has a test pattern

### How to Edit Existing Files — USE PATCH ACTION
**CRITICAL: Use action \`"patch"\` for all edits to existing files, especially files >100 lines.**

The "patch" action applies surgical find/replace pairs WITHOUT regenerating the whole file:
1. **Read first**: Use \`github_read_file\` to get the exact current content
2. **Identify changes**: Determine the exact text sections that need to change
3. **Use patch action**: \`{"path":"file.js","action":"patch","patches":[{"find":"exact text to find","replace":"replacement text"}]}\`
4. Each "find" must match EXACTLY once — copy text verbatim from the file including whitespace and quotes

This prevents: syntax errors from imperfect regeneration, encoding changes (\u2019 → '), unwanted component rewrites, feature regressions.

Only use \`"update"\` (full content) for: small files (<100 lines), new files ("create"), or changes touching >50% of the file.

### CRITICAL — Surgical Edits Only
**NEVER regenerate or rewrite an entire file from scratch.** This is the most common failure mode.
- Make TARGETED, SURGICAL changes — add/modify/remove only the specific lines needed
- ALL existing exports, functions, classes, and variables MUST be preserved unless the task explicitly requires removing them
- If you cannot make targeted edits, STOP and do a file-splitting refactor first
- The \`github_create_pr\` tool will BLOCK updates that lose more than 60% of original identifiers (unless they moved to other files in the same PR)

### Handle Partial Failures
If you CANNOT complete the redo (file too large, complex dependencies):
1. Still create a PR with WORK_LOG.md update (\`⚠️ partial\` or \`❌ blocked\`)
2. Add a note to ROADMAP.md explaining the blocker (keep task as \`- [ ]\`)
3. Report clearly in ORCHESTRA_RESULT with \`pr: FAILED\` or partial PR URL

## Step 4: UPDATE ROADMAP & WORK LOG
In the SAME PR:

**ROADMAP.md update:**
- Mark the task as \`- [x]\` (completed)
- Add a note: "(redone)" next to the task

**WORK_LOG.md update:**
- Read the existing file first. KEEP ALL existing content BYTE-FOR-BYTE identical.
- APPEND a new row at the bottom matching the EXISTING column format exactly.
- Do NOT restructure the table or change column headers. Fill in columns that match what you have.
- **APPEND ONLY** — NEVER delete or modify existing work log rows (immutable audit trail)

## Step 5: CREATE PR
- Branch: \`redo-{task-slug}-${modelAlias}\` (bot/ prefix added automatically)
- PR title: "fix: redo {task title} [${modelAlias}]"
- PR body: explain what was wrong with the previous attempt and what was fixed, and a footer line: "Generated by: ${modelAlias}"
- Commit messages MUST include the model alias, e.g.: "fix(scope): redo description [${modelAlias}]"

## Step 5.5: VERIFY PR CREATION
**CRITICAL** — After calling \`github_create_pr\`, CHECK THE TOOL RESULT:
- If it returned a PR URL (https://github.com/...) → success, proceed to Step 6
- If it returned an error (422, 403, etc.) → FIX AND RETRY. If the error is about the PR (not the branch), push a fix commit to the SAME branch and retry the PR. Only use a different branch name as a last resort — and if you do, re-include ALL your changes (not just the fix), because a new branch forks from main and loses prior commits.
- **NEVER claim you created a PR if the tool returned an error.**

## Step 6: REPORT
\`\`\`
ORCHESTRA_RESULT:
branch: {branch-name}
pr: {pr-url}
files: {comma-separated list of changed files}
summary: {what was wrong and how it was fixed}
\`\`\`

The \`pr:\` field MUST be a real GitHub URL. If PR creation failed, set \`pr: FAILED\` and explain in the summary.

## Rules
- Always create a PR — never just describe what should be done
- Focus on FIXING the previous attempt, not starting from zero (unless necessary)
- ALWAYS update ROADMAP.md and WORK_LOG.md in the same PR
- Do NOT modify unrelated files
- **NEVER regenerate entire files** — make surgical, targeted edits only. Preserve all existing functions, exports, and business logic.
- **NEVER delete work log entries** — WORK_LOG.md is append-only. The tool will BLOCK deletion of existing rows.
- **NEVER delete roadmap tasks** — mark them [x] or add notes, but never remove entries. The tool will BLOCK this.
${historyContext}`;
}

// === Orchestra Event Observability ===

/** Lightweight event for R2-persisted orchestra observability. */
export interface OrchestraEvent {
  timestamp: number;
  taskId: string;
  userId?: string;
  modelAlias: string;
  eventType: 'stall_abort' | 'validation_fail' | 'task_abort' | 'task_complete' | 'deliverable_retry' | 'runtime_risk_escalation' | 'tier_scope_exceeded';
  details: Record<string, unknown>;
}

const MAX_EVENTS_PER_MONTH = 500;
const EVENT_RETENTION_MONTHS = 3; // Delete files older than this

/**
 * Append an orchestra event to R2 (monthly JSONL bucket).
 * Non-blocking: catches errors internally, never throws.
 */
export async function appendOrchestraEvent(
  r2: R2Bucket,
  event: OrchestraEvent,
): Promise<void> {
  const date = new Date(event.timestamp);
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = `orchestra-events/${month}.jsonl`;

  try {
    let lines: string[] = [];
    const existing = await r2.get(key);
    if (existing) {
      const text = await existing.text();
      lines = text.split('\n').filter(l => l.trim());
    }
    lines.push(JSON.stringify(event));
    if (lines.length > MAX_EVENTS_PER_MONTH) {
      lines = lines.slice(-MAX_EVENTS_PER_MONTH);
    }
    await r2.put(key, lines.join('\n') + '\n');
  } catch (err) {
    console.error('[OrchestraEvents] Failed to append event:', err);
  }
}

/**
 * Load recent orchestra events from R2 (last N months).
 * Returns events sorted newest-first.
 */
export async function getRecentOrchestraEvents(
  r2: R2Bucket,
  monthsBack: number = 2,
  modelFilter?: string,
  limit: number = 100,
): Promise<OrchestraEvent[]> {
  const events: OrchestraEvent[] = [];
  const now = new Date();

  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const key = `orchestra-events/${month}.jsonl`;

    try {
      const obj = await r2.get(key);
      if (!obj) continue;
      const text = await obj.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as OrchestraEvent;
          if (modelFilter && ev.modelAlias !== modelFilter) continue;
          events.push(ev);
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip missing months */ }
  }

  events.sort((a, b) => b.timestamp - a.timestamp);

  // Opportunistic cleanup — fire-and-forget, never blocks reads
  cleanupExpiredOrchestraEvents(r2).catch(() => {});

  return events.slice(0, limit);
}

/**
 * Aggregate orchestra event stats for display.
 */
export function aggregateOrchestraStats(events: OrchestraEvent[]): {
  total: number;
  successRate: number; // 0-100, overall task_complete / (task_complete + failures)
  byType: Record<string, number>;
  byModel: Record<string, { total: number; completions: number; failures: number }>;
} {
  const byType: Record<string, number> = {};
  const byModel: Record<string, { total: number; completions: number; failures: number }> = {};
  let completions = 0;
  let failures = 0;

  for (const ev of events) {
    byType[ev.eventType] = (byType[ev.eventType] || 0) + 1;

    if (!byModel[ev.modelAlias]) {
      byModel[ev.modelAlias] = { total: 0, completions: 0, failures: 0 };
    }
    byModel[ev.modelAlias].total++;
    if (ev.eventType === 'task_complete') {
      byModel[ev.modelAlias].completions++;
      completions++;
    } else if (ev.eventType === 'stall_abort' || ev.eventType === 'task_abort') {
      byModel[ev.modelAlias].failures++;
      failures++;
    }
  }

  const denominator = completions + failures;
  const successRate = denominator > 0 ? Math.round((completions / denominator) * 100) : 0;

  return { total: events.length, successRate, byType, byModel };
}

/**
 * Delete orchestra event files older than EVENT_RETENTION_MONTHS.
 * Call opportunistically (e.g. from getRecentOrchestraEvents) to prevent R2 bloat.
 * Returns the number of keys deleted.
 */
/** Per-model reliability scores derived from R2-persisted orchestra events. */
export interface EventBasedModelScore {
  alias: string;
  completions: number;
  failures: number;       // stall_abort + task_abort
  stalls: number;         // stall_abort only
  validationFails: number;
  retries: number;        // deliverable_retry
  total: number;          // terminal events: completions + failures
  successRate: number;    // Bayesian-smoothed: (completions + 1) / (total + 2)
  stallRate: number;      // stalls / total (0 if no terminal events)
}

/**
 * Compute per-model reliability scores from orchestra events.
 * Richer than getModelCompletionStats — captures stalls, validation failures,
 * and deliverable retries in addition to simple pass/fail.
 */
export function getEventBasedModelScores(
  events: OrchestraEvent[],
): Map<string, EventBasedModelScore> {
  const raw = new Map<string, Omit<EventBasedModelScore, 'successRate' | 'stallRate'>>();

  for (const ev of events) {
    let entry = raw.get(ev.modelAlias);
    if (!entry) {
      entry = { alias: ev.modelAlias, completions: 0, failures: 0, stalls: 0, validationFails: 0, retries: 0, total: 0 };
      raw.set(ev.modelAlias, entry);
    }

    switch (ev.eventType) {
      case 'task_complete':
        entry.completions++;
        entry.total++;
        break;
      case 'stall_abort':
        entry.failures++;
        entry.stalls++;
        entry.total++;
        break;
      case 'task_abort':
        entry.failures++;
        entry.total++;
        break;
      case 'validation_fail':
        entry.validationFails++;
        break;
      case 'deliverable_retry':
        entry.retries++;
        break;
    }
  }

  const scores = new Map<string, EventBasedModelScore>();
  for (const [alias, entry] of raw) {
    const successRate = (entry.completions + 1) / (entry.total + 2);
    const stallRate = entry.total > 0 ? entry.stalls / entry.total : 0;
    scores.set(alias, { ...entry, successRate, stallRate });
  }
  return scores;
}

export async function cleanupExpiredOrchestraEvents(r2: R2Bucket): Promise<number> {
  try {
    const listed = await r2.list({ prefix: 'orchestra-events/' });
    if (!listed.objects.length) return 0;

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - EVENT_RETENTION_MONTHS);
    const cutoffMonth = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;

    let deleted = 0;
    for (const obj of listed.objects) {
      // Key format: orchestra-events/YYYY-MM.jsonl
      const match = obj.key.match(/orchestra-events\/(\d{4}-\d{2})\.jsonl/);
      if (match && match[1] < cutoffMonth) {
        await r2.delete(obj.key);
        deleted++;
      }
    }
    return deleted;
  } catch (err) {
    console.error('[OrchestraEvents] Failed to cleanup expired events:', err);
    return 0;
  }
}

// ============================================================
// DRAFT COMMIT — Centralized PR creation from approved draft
// ============================================================

/**
 * Commit an approved draft roadmap — creates branch, writes files, opens PR.
 * No model call needed — uses GitHub API directly.
 *
 * @param params.githubToken - GitHub API token
 * @param params.draft - The approved draft to commit
 * @param params.userId - User ID for history tracking
 * @param params.r2 - Optional R2 bucket for storing orchestra history
 * @returns PR URL
 * @throws if baseSha has changed (stale draft) or GitHub API fails
 */
export async function commitDraftRoadmap(params: {
  githubToken: string;
  draft: OrchestraDraft;
  userId: string;
  r2?: R2Bucket;
}): Promise<string> {
  const { githubToken, draft, userId, r2 } = params;
  const [owner, repoName] = draft.repo.split('/');
  if (!owner || !repoName) throw new Error(`Invalid repo format: ${draft.repo}`);

  const GITHUB_API = 'https://api.github.com';
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'moltworker-orchestra',
    'Content-Type': 'application/json',
  };

  // Generate branch name
  const suffix = Date.now().toString(36).slice(-4);
  const branchName = `bot/roadmap-init-${draft.modelAlias}-${suffix}`;

  // 1. Get default branch SHA
  const repoResp = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}`, { headers });
  if (!repoResp.ok) throw new Error(`Failed to get repo info: ${repoResp.status}`);
  const repoData = await repoResp.json() as { default_branch: string };
  const defaultBranch = repoData.default_branch;

  const refResp = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/ref/heads/${defaultBranch}`, { headers });
  if (!refResp.ok) throw new Error(`Failed to get default branch SHA: ${refResp.status}`);
  const refData = await refResp.json() as { object: { sha: string } };
  const currentSha = refData.object.sha;

  // Freshness check: if draft stored a baseSha, verify repo hasn't changed
  if (draft.baseSha && draft.baseSha !== currentSha) {
    throw new Error(
      'Repository has changed since this draft was generated. ' +
      'Please regenerate the draft to avoid overwriting recent changes.'
    );
  }

  // 2. Create branch
  const createBranchResp = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: currentSha }),
  });
  if (!createBranchResp.ok && createBranchResp.status !== 422) {
    throw new Error(`Failed to create branch: ${createBranchResp.status}`);
  }

  // 3. Write files via Contents API
  const writeFile = async (path: string, content: string, message: string) => {
    let existingSha: string | undefined;
    const getResp = await fetch(
      `${GITHUB_API}/repos/${owner}/${repoName}/contents/${path}?ref=${encodeURIComponent(branchName)}`,
      { headers },
    );
    if (getResp.ok) {
      const data = await getResp.json() as { sha: string };
      existingSha = data.sha;
    }

    const body: Record<string, string> = {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch: branchName,
    };
    if (existingSha) body.sha = existingSha;

    const resp = await fetch(
      `${GITHUB_API}/repos/${owner}/${repoName}/contents/${path}`,
      { method: 'PUT', headers, body: JSON.stringify(body) },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to write ${path}: ${resp.status} ${errText.slice(0, 200)}`);
    }
  };

  await writeFile('ROADMAP.md', draft.roadmapContent, `feat: initialize project roadmap [${draft.modelAlias}]`);
  if (draft.workLogContent) {
    await writeFile('WORK_LOG.md', draft.workLogContent, `feat: initialize work log [${draft.modelAlias}]`);
  }

  // 4. Create PR
  const prBody = `## Roadmap Preview\n\n${draft.roadmapContent.slice(0, 3000)}\n\n---\nGenerated by Orchestra Mode (/${draft.modelAlias})\nApproved by user before commit.`;
  const prResp = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: `feat: initialize project roadmap [${draft.modelAlias}]`,
      body: prBody,
      head: branchName,
      base: defaultBranch,
    }),
  });
  if (!prResp.ok) {
    const errText = await prResp.text();
    throw new Error(`Failed to create PR: ${prResp.status} ${errText.slice(0, 200)}`);
  }

  const prData = await prResp.json() as { html_url: string };

  // 5. Store in orchestra history
  if (r2) {
    const orchestraTask: OrchestraTask = {
      taskId: `orch-${userId}-${Date.now()}`,
      timestamp: Date.now(),
      modelAlias: draft.modelAlias,
      repo: draft.repo,
      mode: 'init',
      prompt: draft.userPrompt.substring(0, 200),
      branchName,
      prUrl: prData.html_url,
      status: 'completed',
      filesChanged: draft.workLogContent ? ['ROADMAP.md', 'WORK_LOG.md'] : ['ROADMAP.md'],
      summary: 'Roadmap created via draft preview flow',
      durationMs: 0,
    };
    await storeOrchestraTask(r2, userId, orchestraTask);
  }

  return prData.html_url;
}
