/**
 * TaskProcessor Durable Object
 * Handles long-running AI tasks without time limits
 * Sends progress updates and results directly to Telegram
 */

import { DurableObject } from 'cloudflare:workers';
import { getSandbox, type Sandbox as SandboxClass } from '@cloudflare/sandbox';
import { createOpenRouterClient, parseSSEStream, type ChatMessage, type ResponseFormat } from '../openrouter/client';
import { executeTool, AVAILABLE_TOOLS, githubReadFile, encodeGitHubPath, type ToolContext, type ToolCall, type WorkspaceFile, TOOLS_WITHOUT_BROWSER, getToolsForPhase, modelSupportsTools, type ToolCapabilities } from '../openrouter/tools';
import { getModelId, getModel, getProvider, getProviderConfig, getReasoningParam, buildFallbackReasoningParam, detectReasoningLevel, isReasoningMandatoryError, getFreeToolModels, categorizeModel, clampMaxTokens, getTemperature, isAnthropicModel, registerDynamicModels, blockModels, getOrchestraRecommendations, type Provider, type ReasoningLevel, type ModelCategory } from '../openrouter/models';
import { recordUsage, formatCostFooter, type TokenUsage } from '../openrouter/costs';
import { injectCacheControl } from '../openrouter/prompt-cache';
import { buildAnthropicRequest, buildAnthropicHeaders, parseAnthropicSSEStream } from '../openrouter/anthropic-direct';
import { markdownToTelegramHtml } from '../utils/telegram-format';
import { extractLearning, storeLearning, storeLastTaskSummary, storeSessionSummary, type SessionSummary } from '../openrouter/learnings';
import { loadUserMemory, storeMemoryFact, buildExtractionPrompt, parseExtractionResponse, MIN_EXTRACTION_LENGTH, EXTRACTION_DEBOUNCE_MS } from '../openrouter/memory';
import { extractFilePaths, extractGitHubContext } from '../utils/file-path-extractor';
import { UserStorage } from '../openrouter/storage';
import { parseOrchestraResult, validateOrchestraResult, storeOrchestraTask, appendOrchestraEvent, parseDraftBlocks, formatDraftPreview, type OrchestraTask, type OrchestraEvent, type OrchestraExecutionProfile, type RuntimeRiskProfile, createRuntimeRiskProfile, updateRuntimeRisk, formatRuntimeRisk } from '../orchestra/orchestra';
import { releaseRepoLock } from '../concurrency/branch-lock';
import { runSkill } from '../skills/runtime';
import { initializeSkills } from '../skills/init';
import { renderForTelegram } from '../skills/renderers/telegram';
import type { SkillRequest, SkillResult } from '../skills/types';
import { createAcontextClient, toOpenAIMessages } from '../acontext/client';
import { estimateTokens, compressContextBudgeted, sanitizeToolPairs } from './context-budget';
import { checkPhaseBudget, PhaseBudgetExceededError, getPhaseBudget } from './phase-budget';
import { validateToolResult, createToolErrorTracker, trackToolError, generateCompletionWarning, adjustConfidence, type ToolErrorTracker } from '../guardrails/tool-validator';
import { scanToolCallForRisks } from '../guardrails/destructive-op-guard';
import { isExtractionTask, detectExtractionDetails, verifyExtraction, formatVerificationForContext, scanCrossFileReferences, type ExtractionCheck } from '../guardrails/extraction-verifier';
import { shouldVerify, verifyWorkPhase, formatVerificationFailures } from '../guardrails/cove-verification';
import { computeRunHealth, formatHealthFooter } from '../guardrails/run-health';
import { STRUCTURED_PLAN_PROMPT, parseStructuredPlan, prefetchPlanFiles, formatPlanSummary, awaitAndFormatPrefetchedFiles, type StructuredPlan } from './step-decomposition';
import { formatProgressMessage, extractToolContext, shouldSendUpdate, type ProgressState } from './progress-formatter';
import { createSpeculativeExecutor } from './speculative-tools';
import { selectReviewerModel, buildReviewMessages, parseReviewResponse, shouldUseMultiAgentReview } from '../openrouter/reviewer';

// Task phase type for structured task processing
export type TaskPhase = 'plan' | 'work' | 'review';

// Phase-aware prompts injected at each stage
// Legacy free-form prompt (kept for reference, replaced by STRUCTURED_PLAN_PROMPT from step-decomposition)
const PLAN_PHASE_PROMPT = 'Before starting, briefly outline your approach (2-3 bullet points): what tools you\'ll use and in what order. Then proceed immediately with execution.';

/**
 * Detect if the user's latest message is a simple query that doesn't need a planning phase.
 * Simple queries: short factual lookups, conversions, greetings, single-tool tasks.
 * Complex queries: multi-step coding tasks, analysis, research requiring multiple tools.
 */
function isSimpleQuery(messages: ChatMessage[]): boolean {
  // Find the last user message (the actual query)
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return false;
  const text = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '';
  // Skip plan-phase injection messages
  if (text.includes('[PLANNING PHASE]')) return false;

  // Short messages (under 150 chars) that are conversational/lookup are simple
  const trimmed = text.trim();
  if (trimmed.length < 150) {
    // Check for multi-step coding indicators
    const complexPatterns = /\b(implement|refactor|create .+ (app|project|service)|build .+ (system|feature)|write .+ (test|code)|debug|fix .+ (bug|issue)|review .+ (code|pr)|analyze .+ (codebase|repo))\b/i;
    // Repo-analysis queries require reading multiple files — must go through planning phase
    // to pre-declare which files to read instead of reactive discovery loops
    const repoAnalysisPatterns = /\b(top \d+ .*(files?|modules?|components?)|most important .*(files?|parts?)|summarize .*(repo|codebase|project)|overview .*(repo|codebase|project)|architecture|codebase structure|key files?)\b/i;
    if (!complexPatterns.test(trimmed) && !repoAnalysisPatterns.test(trimmed)) {
      return true;
    }
  }
  return false;
}
const REVIEW_PHASE_PROMPT = 'Before delivering your final answer, briefly verify: (1) Did you answer the complete question? (2) Are all data points current and accurate? (3) Is anything missing?';
const CODING_REVIEW_PROMPT = 'Before delivering your final answer, verify with evidence:\n(1) Did you answer the complete question? Cite specific tool outputs or file contents that support your answer.\n(2) If you made code changes, did you verify them with the relevant tool (github_read_file, web_fetch, etc.)? Do NOT claim changes were made unless a tool confirmed it.\n(3) If you ran commands or created PRs, check the tool result — did it actually succeed? If a tool returned an error, say so.\n(4) For any claim about repository state (files exist, code works, tests pass), you MUST have observed it from a tool output in this session. Do not assert repo state from memory.\n(5) If you could not fully complete the task, say what remains and why — do not claim completion.\nLabel your confidence: High (tool-verified), Medium (partially verified), or Low (inferred without tool confirmation).';
const ORCHESTRA_REVIEW_PROMPT = 'CRITICAL REVIEW — verify before reporting:\n(1) Did github_create_pr SUCCEED? Check the tool result — if it returned an error (422, 403, etc.), you MUST fix the issue and retry — push a fix commit to the SAME branch first (new branches fork from main and lose your prior work). Do NOT claim success if the PR was not created.\n(2) Does your ORCHESTRA_RESULT block contain a REAL PR URL (https://github.com/...)? If not, the task is NOT complete.\n(3) Did you update ROADMAP.md and WORK_LOG.md in the same PR?\n(4) INCOMPLETE REFACTOR CHECK — the #1 bot failure mode:\n    - If you created new module files (extracted code into separate files), did you ALSO:\n      a) Add import statements to the SOURCE file?\n      b) DELETE the original definitions (functions, constants, components, data arrays) from the source file?\n    - Check: did the source file\'s line count DROP significantly? If it barely changed or grew, you only added imports but never deleted the original code — the new modules are dead code duplicates.\n    - The task says "extract" or "split" — that means CREATE + IMPORT + DELETE in one PR. Not just create.\n    - Check the github_create_pr tool result for "INCOMPLETE REFACTOR" or "INCOMPLETE SPLIT" warnings.\n    - If the source file didn\'t shrink, go back and use patch action to DELETE the extracted definitions NOW.\n(5) CODE QUALITY SELF-CHECK — review the code you wrote for common bugs:\n    - Event handlers: if you added onKeyDown/onKeyPress, did you call e.preventDefault() for keys with default browser behavior (Space scrolls the page, Enter submits forms)?\n    - Imports: did you import everything you use? Did you remove imports for things you deleted?\n    - Props: if you added a new prop, does the parent component need to pass it? Check both sides.\n    - State: if you added useState/useEffect, are cleanup functions needed? Are dependencies correct?\n    - Edge cases: does the code handle empty/null/undefined inputs gracefully?\n    If you find an issue, fix it NOW by pushing a patch to the same branch.\n(6) SURROGATE TESTING CHECK — the #2 bot failure mode:\n    - If you created a new utility/module file to make functions testable, did you ALSO:\n      a) Update the PRODUCTION code (e.g. App.jsx) to import and USE the extracted functions?\n      b) DELETE the original inline logic from the production file?\n    - If tests only import from the new module but the app still uses inline code, you have "surrogate tests" — they verify a copy, not the running code. This is NOT acceptable.\n    - Fix: wire the extracted module into the production code NOW.\n(7) TEST FIXTURE REALISM CHECK:\n    - Do test fixtures use the REAL data shapes from the codebase? If production uses {en: 0.6, fr: 0.4}, tests MUST NOT use {english: 0.9, french: 0.3}.\n    - Read the actual production data files (e.g. destinations.js, config.js) and compare key names, value ranges, and object shapes against your test fixtures.\n    - If fixtures use invented keys or shapes, fix them NOW to match production data.\n(8) DEPENDENCY HYGIENE:\n    - Only add dependencies that are strictly required for the task. Do NOT add UI packages (e.g. @vitest/ui) when only headless testing was requested.\n    - If you added a dependency, verify it is actually imported somewhere in the code.\nIf any of these fail, fix the issue NOW before reporting.';

// Source-grounding guardrail — injected into coding/github tasks to prevent hallucination.
// This is a strict instruction that the model MUST NOT fabricate claims about repo state.
const SOURCE_GROUNDING_PROMPT =
  '\n\n--- EVIDENCE RULES (mandatory) ---\n' +
  '• Do NOT assert file contents, repo state, test results, or build status unless you observed them from a tool output in THIS session.\n' +
  '• If github_create_pr, sandbox_exec, or any git command returned an error, you MUST report the error — do NOT claim success.\n' +
  '• If you lack evidence for a claim, say "Unverified — I did not confirm this with a tool" rather than stating it as fact.\n' +
  '• When providing your final answer, include a brief "Evidence" section listing the tool outputs that support your key claims.\n' +
  '• End with "Confidence: High/Medium/Low" based on how much of your answer is tool-verified vs inferred.';

// Max characters for a single tool result before truncation.
// This is the fallback for models without maxContext metadata.
// For models with known context windows, getToolResultLimit() scales this up.
const DEFAULT_TOOL_RESULT_LENGTH = 8000; // ~2K tokens
// Upper cap even for large-context models — prevents single tool results
// from dominating the context window
const MAX_TOOL_RESULT_LENGTH = 50000; // ~12.5K tokens
// Compress context after this many tool calls
const COMPRESS_AFTER_TOOLS = 6; // Compress more frequently
// Max sandbox_exec calls per task — prevents infinite build/test loops
const MAX_SANDBOX_CALLS_PER_TASK = 15;
// Safety fallback for aliases without metadata
const DEFAULT_CONTEXT_BUDGET = 60000;

// Emergency core: highly reliable models that are tried last when all rotation fails.
// These are hardcoded and only changed by code deploy — the unhackable fallback.
const EMERGENCY_CORE_ALIASES = ['qwencoderfree', 'gptoss', 'devstral'];

// Read-only tools that are safe to execute in parallel (no side effects).
// Mutation tools (github_api, github_create_pr, sandbox_exec) must run sequentially.
// Note: browse_url is excluded from DO via TOOLS_WITHOUT_BROWSER. sandbox_exec is now
// conditionally available in DO when the Sandbox binding is present (capability-aware filtering).
// workspace_write_file and workspace_delete_file have side effects (staging files) so they're
// NOT parallel-safe (caching would skip the write). workspace_commit is a mutation (pushes to GitHub).
// All workspace tools run sequentially.
export const PARALLEL_SAFE_TOOLS = new Set([
  'fetch_url',
  'browse_url',
  'get_weather',
  'get_crypto',
  'web_search',
  'github_read_file',
  'github_list_files',
  'fetch_news',
  'convert_currency',
  'geolocate_ip',
  'url_metadata',
  'generate_chart',
  'read_saved_file',
  'list_saved_files',
]);

/**
 * Check if a specific tool call is safe for parallel execution / caching.
 * Extends PARALLEL_SAFE_TOOLS with action-level granularity:
 *   - cloudflare_api with action="search" is safe (read-only discovery)
 *   - cloudflare_api with action="execute" is NOT safe (mutations possible)
 */
export function isToolCallParallelSafe(toolCall: ToolCall): boolean {
  const toolName = toolCall.function.name;
  if (PARALLEL_SAFE_TOOLS.has(toolName)) return true;

  // Action-level check for cloudflare_api
  if (toolName === 'cloudflare_api') {
    try {
      const args = JSON.parse(toolCall.function.arguments) as Record<string, string>;
      return args.action === 'search';
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Strip reasoning_content from all but the most recent assistant message.
 * Reasoning traces (Kimi thinking, DeepSeek CoT) are one-shot: the model never
 * reads its own previous reasoning_content. Keeping them wastes 5-10K tokens per
 * iteration, which is the #1 cause of context exhaustion on Kimi/DeepSeek tasks.
 */
function stripOldReasoningContent(messages: ChatMessage[]): ChatMessage[] {
  // Find the last message with reasoning_content
  let lastReasoningIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].reasoning_content) {
      lastReasoningIdx = i;
      break;
    }
  }
  if (lastReasoningIdx <= 0) return messages; // Nothing to strip

  return messages.map((msg, i) => {
    if (i < lastReasoningIdx && msg.reasoning_content) {
      const { reasoning_content: _, ...rest } = msg;
      return rest as ChatMessage;
    }
    return msg;
  });
}

// Task category for capability-aware model rotation
type TaskCategory = 'coding' | 'reasoning' | 'general';

/**
 * Detect what capability the task primarily needs from the user message.
 */
function detectTaskCategory(messages: readonly ChatMessage[]): TaskCategory {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg || typeof lastUserMsg.content !== 'string') return 'general';
  const text = lastUserMsg.content.toLowerCase();

  if (/\b(code|implement|debug|fix|refactor|function|class|script|deploy|build|test|coding|programming|pr\b|pull.?request|repository|repo\b|commit|merge|branch)\b/.test(text)) {
    return 'coding';
  }
  if (/\b(research|analy[sz]e|compare|explain.{0,10}detail|reason|math|calculate|solve|prove|algorithm|investigate|comprehensive)\b/.test(text)) {
    return 'reasoning';
  }
  return 'general';
}

/**
 * Build a capability-aware rotation order for free models.
 * Prefers models matching the task category, then others, then emergency core.
 */
function buildRotationOrder(
  currentAlias: string,
  freeToolModels: string[],
  taskCategory: TaskCategory
): string[] {
  const preferred: string[] = [];
  const fallback: string[] = [];

  for (const alias of freeToolModels) {
    if (alias === currentAlias) continue;
    const model = getModel(alias);
    if (!model) continue;
    const modelCat: ModelCategory = categorizeModel(model.id, model.name);

    // Match task category to model category
    const isMatch =
      (taskCategory === 'coding' && modelCat === 'coding') ||
      (taskCategory === 'reasoning' && modelCat === 'reasoning') ||
      (taskCategory === 'general' && (modelCat === 'general' || modelCat === 'fast'));

    if (isMatch) {
      preferred.push(alias);
    } else {
      fallback.push(alias);
    }
  }

  // Append emergency core models if not already in the list
  const result = [...preferred, ...fallback];
  for (const emergencyAlias of EMERGENCY_CORE_ALIASES) {
    if (!result.includes(emergencyAlias) && emergencyAlias !== currentAlias) {
      const model = getModel(emergencyAlias);
      if (model?.isFree && model?.supportsTools) {
        result.push(emergencyAlias);
      }
    }
  }

  return result;
}

// Task state stored in DO
interface TaskState {
  taskId: string;
  chatId: number;
  userId: string;
  modelAlias: string;
  messages: ChatMessage[];
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  toolsUsed: string[];
  iterations: number;
  startTime: number;
  lastUpdate: number;
  result?: string;
  error?: string;
  statusMessageId?: number;
  telegramToken?: string; // Store for cancel
  openrouterKey?: string; // Store for alarm recovery
  githubToken?: string; // Store for alarm recovery
  braveSearchKey?: string; // Store for alarm recovery
  cloudflareApiToken?: string; // Store for alarm recovery
  // Direct provider API keys for alarm recovery
  dashscopeKey?: string;
  moonshotKey?: string;
  deepseekKey?: string;
  anthropicKey?: string;
  // Auto-resume settings
  autoResume?: boolean; // If true, automatically resume on timeout
  autoResumeCount?: number; // Number of auto-resumes so far
  // Cumulative iteration count across all resumes (task.iterations resets per cycle)
  totalIterations?: number;
  // Stall detection: track tool count at last resume to detect spinning
  toolCountAtLastResume?: number; // toolsUsed.length when last resume fired
  noProgressResumes?: number; // Consecutive resumes with no new tool calls
  // Cross-resume tool signature dedup: track unique tool call signatures (name:argsHash)
  // to detect when the model re-calls identical tools across resumes
  toolSignatures?: string[];
  // Track when context was last compressed to allow post-compression re-reads
  lastCompressionToolCount?: number;
  // Last few tool errors for user-facing progress messages (persisted across resumes)
  lastToolErrors?: string[];
  // Files involved in the task (extracted from tool calls for progress display)
  filesRead?: string[];
  filesModified?: string[];
  // Reasoning level override
  reasoningLevel?: ReasoningLevel;
  // Structured output format
  responseFormat?: ResponseFormat;
  // Structured task phases (plan → work → review)
  phase?: TaskPhase;
  phaseStartIteration?: number;
  // The actual answer from work phase, preserved so review doesn't replace it
  workPhaseContent?: string;
  // Structured plan steps from 7A.4 step decomposition
  structuredPlan?: StructuredPlan;
  // 7A.1: CoVe verification retry flag (only one retry allowed)
  coveRetried?: boolean;
  // 7A.2: Extraction verification retry flag (only one retry allowed)
  extractionRetried?: boolean;
  // 7A.2b: Persisted extraction metadata — survives message truncation on resume.
  // Populated on first extraction detection so verification doesn't depend on transient context.
  extractionMeta?: {
    repoOwner: string;
    repoName: string;
    branch: string;
    sourceFile: string;
    newFiles: string[];
    extractedNames: string[];
    sourceInitialLineCount: number | null;
    newFileLineCount: number | null;
  };
  // Post-completion deliverable validation retry count (escalating: 0→reminder, 1→strict, 2→abort)
  validationRetryCount?: number;
  // Whether this is an orchestra task (persisted so alarm handler can use tighter limits)
  isOrchestraTask?: boolean;
  // Centralized execution profile — drives resume caps, sandbox gating, prompt tier
  executionProfile?: OrchestraExecutionProfile;
  // F.20: Runtime risk profile — second-stage classification updated during execution
  runtimeRisk?: RuntimeRiskProfile;
  // F.23: Repo for branch-lock release on completion/failure (set for orchestra tasks)
  orchestraRepo?: string;
  // Draft init mode: DO stores roadmap draft in R2 + sends preview message with buttons
  isDraftInit?: boolean;
  // 5.1: Multi-agent review — which model reviewed the work
  reviewerAlias?: string;
  // Run health signals — tracked across the task lifetime
  sandboxStalled?: boolean; // Set true if any sandbox_exec detected stagnation
  prefetch404Count?: number; // Count of prefetch 404 errors
  // CPU budget yield: set when processTask proactively yields to get fresh CPU budget.
  // The alarm handler resumes immediately without stall detection or auto-resume counting.
  yieldPending?: boolean;
  // Set true after the first tier wall-clock advisory has been sent (prevents duplicate warnings)
  tierBudgetWarned?: boolean;
  // Set true after the first tier resume-count advisory has been sent
  tierResumeWarned?: boolean;
  // Set true when an API streaming response is in progress.
  // If watchdog finds isStreaming=true but isRunning=false, the DO was evicted mid-stream
  // — resume faster (90s) and don't count as a model stall.
  isStreaming?: boolean;
}

// Task request from the worker
export interface TaskRequest {
  taskId: string;
  chatId: number;
  userId: string;
  modelAlias: string;
  messages: ChatMessage[];
  telegramToken: string;
  openrouterKey: string;
  githubToken?: string;
  braveSearchKey?: string;
  // Direct API keys (optional)
  dashscopeKey?: string;   // For Qwen (DashScope/Alibaba)
  moonshotKey?: string;    // For Kimi (Moonshot)
  deepseekKey?: string;    // For DeepSeek
  anthropicKey?: string;   // For Claude (Anthropic direct)
  cloudflareApiToken?: string; // Cloudflare API token for Code Mode MCP
  // Auto-resume setting
  autoResume?: boolean;    // If true, auto-resume on timeout
  // Reasoning level override (from think:LEVEL prefix)
  reasoningLevel?: ReasoningLevel;
  // Structured output format (from json: prefix)
  responseFormat?: ResponseFormat;
  // Original user prompt (for checkpoint display)
  prompt?: string;
  // Acontext observability
  acontextKey?: string;
  acontextBaseUrl?: string;
  // Orchestra execution profile — centralized classification signals
  executionProfile?: OrchestraExecutionProfile;
  // F.23: Repo for branch-lock release (set for orchestra tasks)
  orchestraRepo?: string;
  // Draft init mode: model outputs roadmap in text, DO stores draft + sends preview
  isDraftInit?: boolean;
}

/**
 * Skill task request — dispatches a skill to run asynchronously in the DO.
 * Uses runSkill() from the Gecko Skills runtime.
 */
export interface SkillTaskRequest {
  kind: 'skill';
  taskId: string;
  chatId: number;
  userId: string;
  telegramToken: string;
  skillRequest: SkillRequest;
  openrouterKey?: string;
  githubToken?: string;
  braveSearchKey?: string;
  dashscopeKey?: string;
  moonshotKey?: string;
  deepseekKey?: string;
  anthropicKey?: string;
  cloudflareApiToken?: string;
}

/**
 * Discriminated union for /process endpoint.
 * Existing callers send TaskRequest (no `kind` field) — treated as chat/orchestra.
 * New skill callers send SkillTaskRequest with `kind: 'skill'`.
 */
export type TaskProcessorPayload = TaskRequest | SkillTaskRequest;

export function isSkillTaskRequest(payload: TaskProcessorPayload): payload is SkillTaskRequest {
  return 'kind' in payload && (payload as SkillTaskRequest).kind === 'skill';
}

// DO environment with R2 + Sandbox bindings
interface TaskProcessorEnv {
  MOLTBOT_BUCKET?: R2Bucket;
  Sandbox?: DurableObjectNamespace<SandboxClass>; // Sandbox container binding (for sandbox_exec in DO)
  SANDBOX_SLEEP_AFTER?: string; // Controls container keep-alive behavior
}

// Watchdog alarm interval (90 seconds)
const WATCHDOG_INTERVAL_MS = 90000;
// Max time without update before considering task stuck.
// Must be > max idle timeout (180s for 60K+ tokens) to avoid false positives.
// Free models: 150s — covers 120s max idle timeout + 30s buffer
// Paid models: 240s — covers 180s max idle timeout + 60s buffer (paid models
//   handle larger contexts and deserve more patience)
const STUCK_THRESHOLD_FREE_MS = 150000;
const STUCK_THRESHOLD_PAID_MS = 240000;
// Orphaned task threshold: when isRunning=false (DO was evicted), we KNOW the
// processing loop is dead. No need to wait the full provider-aware threshold
// — resume faster. Must still exceed one watchdog interval to avoid races.
/** @internal Exported for testing */
export const ORPHANED_THRESHOLD_FREE_MS = 120000;
/** @internal Exported for testing */
export const ORPHANED_THRESHOLD_PAID_MS = 180000;
// Save checkpoint every N tools (more frequent = less lost progress on crash)
const CHECKPOINT_EVERY_N_TOOLS = 3;
// Max iterations per event before yielding to a fresh alarm event.
// Empirically, streaming I/O does NOT count toward CF's 30s CPU limit —
// a Moonshot call streamed for 195s (1595 chunks) with no eviction.
// Yield exists only for extremely long multi-iteration runs to prevent
// wall-clock staleness, not for CPU budget reasons.
// All providers use the same threshold since streaming CPU is negligible.
const MAX_ITERATIONS_BEFORE_YIELD = 8;
// Safety net: yield if cumulative active time exceeds this regardless of
// iteration count. Only catches genuinely CPU-heavy iterations (e.g. massive
// JSON parsing, many tool executions). Streaming I/O doesn't count toward
// CF CPU limits, so this threshold is generous.
const MAX_ACTIVE_TIME_BEFORE_YIELD_MS = 120000;
// Always save checkpoint when total tools is at or below this threshold.
// Ensures small tasks (1-3 tool calls) are checkpointed before the watchdog fires.
const CHECKPOINT_EARLY_THRESHOLD = 3;
// Checkpoint schema version — bumped when checkpoint format changes.
// Checkpoints with a different version are skipped on resume to avoid crashes.
const CHECKPOINT_VERSION = 2;
// Max auto-resume attempts before requiring manual intervention
const MAX_AUTO_RESUMES_DEFAULT = 10; // Raised from 5 — complex refactors with slow-streaming models exhaust 5 resumes at 95% completion
const MAX_AUTO_RESUMES_FREE = 5; // Free tier stays conservative
// Orchestra-specific caps: tighter than general tasks because orchestra has
// structured deliverables — if a model can't finish in 6 resumes, it's thrashing.
const MAX_AUTO_RESUMES_ORCHESTRA = 6;
const MAX_AUTO_RESUMES_ORCHESTRA_FREE = 6;
// Elapsed time limits removed — other guards (max tool calls, stall detection,
// auto-resume limits) are sufficient to prevent runaway tasks.
// Max consecutive resumes with no new tool calls before declaring stall
const MAX_NO_PROGRESS_RESUMES = 3;
// Max consecutive iterations with no tool calls in main loop before stopping
const MAX_STALL_ITERATIONS = 5;
// Max times the model can call the exact same tool with the same args before we break the loop
const MAX_SAME_TOOL_REPEATS = 3;
// Max total tool calls before forcing a final answer (prevents excessive API usage)
const MAX_TOTAL_TOOLS_FREE = 50;
const MAX_TOTAL_TOOLS_PAID = 100;

/**
 * Provider-aware stream control policy.
 *
 * The old fixed 85s/120s split was designed around a default 30s CPU limit,
 * but with cpu_ms raised to 300s (wrangler.jsonc) and the fact that I/O wait
 * does NOT count toward CPU time, the original fears were overblown.
 *
 * Anthropic's reasoning models (Claude 3.7+) routinely spend 60-120s thinking
 * before emitting any output. The old 85s split killed streams during this
 * thinking phase, causing 499 "Client disconnected" errors, token waste from
 * repeated re-transmissions, and exhausted auto-resume budgets.
 *
 * New design:
 * - Anthropic direct: Generous soft split at 270s (graceful) + hard abort at
 *   300s. The soft split preserves partial output and triggers auto-resume;
 *   the hard abort is the absolute safety net. Sparse storage writes every 30s
 *   to reduce CPU overhead while keeping recovery fast on eviction.
 * - OpenRouter / other direct: Keep 85s/120s split (they stream fast, split
 *   is a useful safety net for their typical behavior).
 */
interface StreamPolicy {
  /** Interval between onKeepAlive calls in the SSE parser (ms) */
  keepAliveIntervalMs: number;
  /** How often to flush task state to DO storage during streaming (ms) */
  persistIntervalMs: number;
  /** Soft split timeout for text streaming (ms). */
  softSplitMs: number;
  /** Soft split timeout when tool calls are in-flight (ms). */
  softSplitToolMs: number;
  /** Hard wall-clock timeout that aborts the fetch (ms) */
  hardTimeoutMs: number;
}

/** @internal Exported for testing */
export function getStreamPolicy(provider: string, idleTimeoutMs: number): StreamPolicy {
  if (provider === 'anthropic') {
    // Anthropic direct: generous soft split, hard abort at 300s.
    // Reasoning models spend 60-120s+ thinking before first output — the old
    // 85s split killed streams during thinking.
    //
    // Timing contract: soft split must fire before hard abort. With keepalive
    // every 15s, the worst case is a keepalive at T=255s (continues) then next
    // at T=270s (splits). Hard abort at 300s gives 30s of safety margin.
    // Tool in-flight gets 285s — still 15s before hard abort, guaranteeing
    // at least one keepalive opportunity to trigger graceful split.
    //
    // Persistence at 30s is a clean multiple of keepalive (15s), so storage
    // writes fire every 2nd keepalive tick with zero harmonic drift.
    const keepAliveIntervalMs = 15_000;
    const hardTimeoutMs = 300_000;
    return {
      keepAliveIntervalMs,
      persistIntervalMs: 30_000,                               // 2× keepalive — no drift
      softSplitMs: hardTimeoutMs - 2 * keepAliveIntervalMs,    // 270s
      softSplitToolMs: hardTimeoutMs - keepAliveIntervalMs,    // 285s
      hardTimeoutMs,
    };
  }

  // OpenRouter and other direct providers: keep existing 85s/120s split.
  // These providers stream fast and the split is a useful safety net.
  return {
    keepAliveIntervalMs: 10_000,
    persistIntervalMs: 10_000,
    softSplitMs: 85_000,
    softSplitToolMs: 120_000,
    hardTimeoutMs: Math.min(Math.max(idleTimeoutMs * 3, 180_000), 300_000),
  };
}

// Legacy aliases for OpenRouter path (uses the default policy inline)
const STREAM_SPLIT_TIMEOUT_MS = 85_000;
const STREAM_SPLIT_MAX_MS = 120_000;

/**
 * Create a storage-safe copy of TaskState by stripping large transient fields.
 * Messages are stored in R2 checkpoints — keeping them in DO storage too
 * causes the value to exceed CF's 128KB storage.put() limit once context
 * grows past ~30K tokens (serializes to >131072 bytes).
 *
 * Also strips workPhaseContent (can be 19K+ tokens for large code generation)
 * and structuredPlan (serialised step descriptions can grow large).
 * These fields are only needed in-memory during processTask() and are
 * persisted in R2 checkpoints alongside messages.
 */
/** @internal Exported for testing */
export function taskForStorage(task: TaskState): Omit<TaskState, 'messages'> & { messages: never[] } {
  const { messages: _msgs, workPhaseContent: _wpc, structuredPlan: _sp, ...rest } = task;
  const result = { ...rest, messages: [] as never[] };
  // Guard against 128KB DO storage limit — truncate growable arrays if needed
  // IMPORTANT: Use actual UTF-8 byte length, not JS string length (char count ≠ byte count)
  const MAX_DO_VALUE_BYTES = 131072;
  const encoder = new TextEncoder();
  let serialized = JSON.stringify(result);
  let serializedBytes = encoder.encode(serialized).byteLength;
  if (serializedBytes > MAX_DO_VALUE_BYTES * 0.8) {
    console.log(`[TaskProcessor] WARNING: task storage near limit (${serializedBytes} bytes), trimming arrays`);
    // Trim the largest growable arrays to fit
    if (result.toolSignatures && result.toolSignatures.length > 20) {
      result.toolSignatures = result.toolSignatures.slice(-20);
    }
    if (result.lastToolErrors && result.lastToolErrors.length > 3) {
      result.lastToolErrors = result.lastToolErrors.slice(-3);
    }
    // Re-check after trimming to verify we're actually under the threshold
    serialized = JSON.stringify(result);
    serializedBytes = encoder.encode(serialized).byteLength;
    if (serializedBytes > MAX_DO_VALUE_BYTES * 0.8) {
      console.log(`[TaskProcessor] WARNING: still near limit after trim (${serializedBytes} bytes), aggressive truncation`);
      if (result.toolSignatures && result.toolSignatures.length > 5) {
        result.toolSignatures = result.toolSignatures.slice(-5);
      }
      if (result.lastToolErrors && result.lastToolErrors.length > 1) {
        result.lastToolErrors = result.lastToolErrors.slice(-1);
      }
      // Final verification: ensure we're actually under the hard limit after aggressive trim
      const finalBytes = encoder.encode(JSON.stringify(result)).byteLength;
      if (finalBytes > MAX_DO_VALUE_BYTES) {
        console.log(`[TaskProcessor] CRITICAL: still over hard limit after aggressive trim (${finalBytes} bytes), clearing arrays`);
        result.toolSignatures = [];
        result.lastToolErrors = [];
        // Truncate result text if it's the culprit
        if (result.result && encoder.encode(result.result).byteLength > 8000) {
          result.result = result.result.slice(0, 2000) + '\n\n[... truncated for storage limit ...]';
        }
      }
    }
  }
  return result;
}

/** Get the auto-resume limit based on model cost, task type, and execution profile */
function getAutoResumeLimit(modelAlias: string, isOrchestra = false, profile?: OrchestraExecutionProfile): number {
  // Profile-driven cap takes precedence for orchestra tasks
  if (profile) {
    return profile.bounds.maxAutoResumes;
  }
  const model = getModel(modelAlias);
  if (isOrchestra) {
    return model?.isFree ? MAX_AUTO_RESUMES_ORCHESTRA_FREE : MAX_AUTO_RESUMES_ORCHESTRA;
  }
  return model?.isFree ? MAX_AUTO_RESUMES_FREE : MAX_AUTO_RESUMES_DEFAULT;
}

/**
 * Parse a structured error from a provider API response.
 * Extracts error codes and request_ids for better diagnostics.
 */
function parseProviderError(status: number, rawText: string): { status: number; message: string } {
  let parsedMessage: string | undefined;
  try {
    const payload = JSON.parse(rawText) as {
      error?: { message?: string; code?: string | number } | string;
      message?: string;
      msg?: string;
      code?: string | number;
      request_id?: string;
    };
    if (typeof payload.error === 'string') {
      parsedMessage = payload.error;
    } else {
      parsedMessage = payload.error?.message ?? payload.message ?? payload.msg;
      if (payload.error?.code && parsedMessage) {
        parsedMessage = `${parsedMessage} (code: ${String(payload.error.code)})`;
      } else if (payload.code && parsedMessage) {
        parsedMessage = `${parsedMessage} (code: ${String(payload.code)})`;
      }
      if (payload.request_id && parsedMessage) {
        parsedMessage = `${parsedMessage} (request_id: ${payload.request_id})`;
      }
    }
  } catch {
    // non-JSON body
  }
  return { status, message: (parsedMessage || rawText).slice(0, 500) };
}

/**
 * Provider-aware watchdog stuck threshold.
 * Must exceed the maximum possible idle timeout for the model's provider,
 * otherwise the watchdog fires a false "stuck" alarm during long TTFT waits.
 */
/** @internal Exported for testing */
export function getWatchdogStuckThreshold(modelAlias: string): number {
  const isPaidModel = getModel(modelAlias)?.isFree !== true;
  const provider = getProvider(modelAlias);
  const providerMultiplier = provider === 'moonshot' ? 2.5
    : provider === 'deepseek' ? 1.8
    : provider === 'dashscope' ? 1.5
    : provider === 'anthropic' ? 1.5 // Was 3.0 — reduced since keepAliveSleep keeps storage fresh during pacing
    : 1.0;

  const baseThreshold = isPaidModel ? STUCK_THRESHOLD_PAID_MS : STUCK_THRESHOLD_FREE_MS;
  // Max idle timeout for this provider (180s base * multiplier for paid, or 180s * multiplier for free)
  const maxIdleTimeout = Math.max(180000 * providerMultiplier, isPaidModel ? 90000 : 45000);

  // Stuck threshold must exceed max idle timeout + buffer to avoid false alarms
  return Math.max(baseThreshold * providerMultiplier, maxIdleTimeout + 60000);
}

/**
 * Sanitize messages before sending to API providers.
 * Some providers (Moonshot/Kimi) reject assistant messages with empty content.
 * - Assistant messages with tool_calls: set content to null (valid per OpenAI spec)
 * - Assistant messages without tool_calls and empty content: set to "(empty)"
 */
function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(msg => {
    if (msg.role !== 'assistant') return msg;
    const content = msg.content;
    const isEmpty = content === '' || content === null || content === undefined;
    if (!isEmpty) return msg;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Tool-calling message: null content is valid per spec, but some providers
      // still reject it. Use a minimal placeholder.
      return { ...msg, content: '(calling tools)' };
    }
    // Non-tool assistant message with empty content
    return { ...msg, content: '(empty)' };
  });
}

/**
 * Ensure all assistant messages with tool_calls have reasoning_content.
 * Moonshot/Kimi requires reasoning_content on every assistant tool-call message
 * when thinking mode is enabled (reasoning: { enabled: true }). Without this,
 * the API returns 400: "thinking is enabled but reasoning_content is missing
 * in assistant tool call message at index N".
 *
 * This can happen when:
 * 1. stripOldReasoningContent() removed it during context compression
 * 2. A previous iteration produced tool calls without a thinking trace
 * 3. Messages were restored from a checkpoint that didn't preserve reasoning
 */
function ensureMoonshotReasoning(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(msg => {
    if (msg.role !== 'assistant') return msg;
    if (!msg.tool_calls || msg.tool_calls.length === 0) return msg;
    if (msg.reasoning_content) return msg;
    // Inject minimal reasoning_content to satisfy the API constraint
    return { ...msg, reasoning_content: '.' };
  });
}

/**
 * Truncate large tool results in checkpoint messages to prevent context saturation.
 *
 * Improvements over the original 15-head/5-tail approach:
 * 1. **Tool-type-aware** — different summarization for code files vs sandbox output vs web content
 * 2. **Deduplicates repeated reads** — if the same file was read 3 times, only the most recent survives
 * 3. **Structured summaries** — extracts file path, line range, key content instead of blind line slicing
 *
 * Only truncates non-recent messages (skips last KEEP_RECENT) to preserve active context.
 */
/** @internal Exported for testing */
export function truncateLargeToolResults(messages: ChatMessage[], maxChars: number): void {
  const KEEP_RECENT = 6;
  const cutoff = Math.max(0, messages.length - KEEP_RECENT);

  // Phase 1: Build tool_call_id → tool name+args map for tool-type awareness
  const toolCallInfo = new Map<string, { name: string; args: string }>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallInfo.set(tc.id, { name: tc.function.name, args: tc.function.arguments });
      }
    }
  }

  // Phase 2: Deduplicate — for github_read_file, find the LAST read of each file path.
  // Earlier reads of the same file are replaced with a one-line pointer.
  const fileReadLastIndex = new Map<string, number>(); // filePath → last message index
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool' || !msg.tool_call_id) continue;
    const info = toolCallInfo.get(msg.tool_call_id);
    if (!info || info.name !== 'github_read_file') continue;
    const filePath = extractFilePathFromArgs(info.args);
    if (filePath) {
      fileReadLastIndex.set(filePath, i);
    }
  }

  let truncated = 0;
  let deduplicated = 0;
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;

    const info = msg.tool_call_id ? toolCallInfo.get(msg.tool_call_id) : undefined;
    const toolName = info?.name ?? '';

    // Dedup: if this is a github_read_file and a later read of the same file exists, collapse
    if (toolName === 'github_read_file' && msg.tool_call_id) {
      const filePath = extractFilePathFromArgs(info!.args);
      if (filePath && fileReadLastIndex.get(filePath) !== i) {
        messages[i] = {
          ...msg,
          content: `[Superseded — file "${filePath}" was re-read later in conversation]`,
        };
        deduplicated++;
        continue;
      }
    }

    if (msg.content.length <= maxChars) continue;

    // Tool-type-aware truncation
    messages[i] = {
      ...msg,
      content: truncateToolResultForResume(msg.content, toolName, maxChars),
    };
    truncated++;
  }

  if (truncated > 0 || deduplicated > 0) {
    const parts: string[] = [];
    if (truncated > 0) parts.push(`truncated ${truncated} large result(s)`);
    if (deduplicated > 0) parts.push(`deduplicated ${deduplicated} repeated file read(s)`);
    console.log(`[TaskProcessor] Resume optimization: ${parts.join(', ')} (threshold: ${maxChars} chars)`);
  }
}

/** Extract file path from github_read_file tool call arguments. */
function extractFilePathFromArgs(argsJson: string): string | null {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    // github_read_file uses "path" parameter
    const path = args.path ?? args.file_path ?? args.filename;
    return typeof path === 'string' ? path : null;
  } catch {
    return null;
  }
}

/**
 * Truncate a single tool result with awareness of what kind of tool produced it.
 *
 * - **github_read_file**: Keep file header (path, lines), first 20 + last 10 lines of code
 * - **sandbox_exec / run_code**: Keep command line, exit status, first 8 + last 8 lines of output
 * - **fetch_url / browse_url / web_search**: Keep URL/title, first 300 chars of content
 * - **Default**: First 15 + last 5 lines (original behavior)
 */
/** @internal Exported for testing */
export function truncateToolResultForResume(content: string, toolName: string, maxChars: number): string {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (toolName === 'github_read_file') {
    // Code files: keep more head context (imports, exports, function signatures)
    // and a meaningful tail (closing braces, return statements)
    const headerLine = lines[0] || ''; // Usually "[path -- lines X-Y of Z total]"
    const HEAD = 20;
    const TAIL = 10;
    const headLines = lines.slice(0, HEAD + 1).join('\n'); // +1 to include header
    const tailLines = lines.slice(-TAIL).join('\n');
    const result = `${headLines}\n\n[... ${totalLines - HEAD - TAIL} lines truncated on resume — re-read file if needed ...]\n\n${tailLines}`;
    // If the structured version is still too large, fall back to char-based truncation
    return result.length <= maxChars ? result : charBasedTruncation(content, maxChars, totalLines);
  }

  if (toolName === 'sandbox_exec' || toolName === 'run_code') {
    // Execution output: command + exit status are critical, output is secondary
    const HEAD = 8;
    const TAIL = 8;
    const headLines = lines.slice(0, HEAD).join('\n');
    const tailLines = lines.slice(-TAIL).join('\n');
    return `${headLines}\n\n[... ${totalLines - HEAD - TAIL} lines of output truncated on resume ...]\n\n${tailLines}`;
  }

  if (toolName === 'fetch_url' || toolName === 'browse_url' || toolName === 'web_search') {
    // Web content: keep URL/title from first line, brief content summary
    const firstLine = lines[0] || '';
    const contentPreview = content.slice(firstLine.length + 1, firstLine.length + 500);
    return `${firstLine}\n${contentPreview}\n\n[... ${totalLines} lines of web content truncated on resume — re-fetch if needed ...]`;
  }

  // Default: original behavior with slightly more head context
  const HEAD = 15;
  const TAIL = 5;
  const headLines = lines.slice(0, HEAD).join('\n');
  const tailLines = lines.slice(-TAIL).join('\n');
  return `${headLines}\n\n[... ${totalLines - HEAD - TAIL} lines truncated on resume — re-read if needed ...]\n\n${tailLines}`;
}

/** Char-based fallback truncation for results that are still too large after line-based truncation. */
function charBasedTruncation(content: string, maxChars: number, totalLines: number): string {
  const halfLength = Math.floor(maxChars / 2) - 100;
  const head = content.slice(0, halfLength);
  const tail = content.slice(-halfLength);
  return `${head}\n\n[... ${totalLines} lines truncated on resume — re-read if needed ...]\n\n${tail}`;
}

/**
 * Extract repo owner, name, and branch from tool call arguments in conversation.
 * Scans for github_push_files, workspace_commit, or github_create_pr calls
 * that contain owner/repo/branch info.
 */
function extractRepoAndBranch(messages: readonly ChatMessage[]): {
  repoOwner: string | null;
  repoName: string | null;
  branch: string | null;
} {
  let repoOwner: string | null = null;
  let repoName: string | null = null;
  let branch: string | null = null;

  // Scan tool calls in reverse — most recent call has the final branch
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      if (name !== 'github_push_files' && name !== 'workspace_commit'
          && name !== 'github_create_pr') continue;
      try {
        const args = JSON.parse(tc.function.arguments);
        if (args.owner && args.repo && args.branch) {
          repoOwner = args.owner;
          repoName = args.repo;
          // Branch may have bot/ prefix added by the tool — use raw value
          branch = args.branch.startsWith('bot/') ? args.branch : `bot/${args.branch}`;
          return { repoOwner, repoName, branch };
        }
      } catch { /* ignore parse errors */ }
    }
  }

  return { repoOwner, repoName, branch };
}

export class TaskProcessor extends DurableObject<TaskProcessorEnv> {
  private doState: DurableObjectState;
  private r2?: R2Bucket;
  private toolResultCache = new Map<string, string>();
  private toolInFlightCache = new Map<string, Promise<{ tool_call_id: string; content: string }>>();
  private toolCacheHits = 0;
  private toolCacheMisses = 0;
  /** Pre-fetched file contents keyed by "owner/repo/path" (Phase 7B.3) */
  private prefetchPromises = new Map<string, Promise<string | null>>();
  private prefetchHits = 0;
  /**
   * In-memory execution lock.
   * Prevents the alarm handler from spawning a concurrent processTask() when the
   * original is still running (just slow on an await). Because DOs use cooperative
   * multitasking, any `await` yields the thread — if the alarm fires during that
   * yield and calls waitUntil(processTask()), two loops would interleave, corrupt
   * caches, overwrite checkpoints, and cause runaway token usage.
   *
   * This flag is set at the start of processTask() and cleared in its finally block.
   * If the DO is evicted/crashed, in-memory state is lost, so `isRunning` defaults
   * to false — making it safe for the alarm to resume from checkpoint.
   */
  private isRunning = false;
  /**
   * In-memory heartbeat timestamp. Updated by streaming onProgress callbacks
   * without hitting DO storage. The alarm handler checks this first — if it's
   * recent, the task is alive (streaming) and doesn't need a storage.put to
   * prove it. This eliminates ~90% of the storage writes during streaming.
   */
  private lastHeartbeatMs = 0;
  /**
   * In-memory cancellation flag. Set by the /cancel fetch handler so that
   * processTask() can break out of its loop immediately without waiting for
   * the next storage.get('task') round-trip. Prevents the race where
   * processTask's put() overwrites the cancellation status.
   */
  private isCancelled = false;
  /**
   * Pending steering messages injected by the /steer endpoint.
   * Consumed at the top of each iteration in processTask().
   */
  private steerMessages: string[] = [];

  /**
   * Get a workspace manager bound to a specific task ID.
   * Uses DO persistent storage (not in-memory) so workspace survives evictions
   * and auto-resumes. Each file is stored as a separate key with prefix
   * `ws:{taskId}:{path}` to respect CF's 128KB per-value limit.
   */
  private getWorkspaceManager(taskId: string) {
    const prefix = `ws:${taskId}:`;
    const storage = this.doState.storage;
    return {
      writeFile: async (file: WorkspaceFile) => {
        // Store action + content as JSON to preserve the action type
        const value = JSON.stringify({
          action: file.action,
          content: file.content,
        });
        // CF DO storage enforces 128KB per value. Catch oversized files gracefully
        // instead of crashing the entire TaskProcessor loop.
        const MAX_STORAGE_VALUE_BYTES = 128 * 1024;
        if (new TextEncoder().encode(value).byteLength > MAX_STORAGE_VALUE_BYTES) {
          throw new Error(
            `File "${file.path}" exceeds 128KB storage limit (${Math.round(file.content.length / 1024)}KB). ` +
            `Do NOT chunk the text. You must logically refactor this file into smaller discrete ` +
            `functional modules (e.g., extract separate hooks, utilities, or sub-components) ` +
            `and stage each module individually with workspace_write_file.`
          );
        }
        await storage.put(prefix + file.path, value);
        console.log(`[TaskProcessor] Workspace: staged ${file.action} "${file.path}" (${file.content.length} chars) [persistent]`);
      },
      listFiles: async (): Promise<WorkspaceFile[]> => {
        const entries = await storage.list<string>({ prefix });
        const files: WorkspaceFile[] = [];
        for (const [key, value] of entries.entries()) {
          const path = key.slice(prefix.length);
          const data = JSON.parse(value) as { action: WorkspaceFile['action']; content: string };
          files.push({ path, action: data.action, content: data.content });
        }
        return files;
      },
      clear: async () => {
        const entries = await storage.list({ prefix });
        if (entries.size > 0) {
          await storage.delete(Array.from(entries.keys()));
          console.log(`[TaskProcessor] Workspace: cleared ${entries.size} staged file(s) [persistent]`);
        }
      },
    };
  }

  constructor(state: DurableObjectState, env: TaskProcessorEnv) {
    super(state, env);
    this.doState = state;
    this.r2 = env.MOLTBOT_BUCKET;
  }

  /**
   * Sleep for `totalMs` in short intervals, updating storage + heartbeat every 10s.
   * Bare `setTimeout(58s)` gets killed when CF evicts idle DOs; this keeps the DO
   * pinned by performing periodic I/O (storage.put), preventing eviction.
   */
  private async keepAliveSleep(totalMs: number, task: TaskState): Promise<void> {
    const INTERVAL = 10_000; // 10s between heartbeats
    let remaining = totalMs;
    while (remaining > 0) {
      const chunk = Math.min(remaining, INTERVAL);
      await new Promise(r => setTimeout(r, chunk));
      remaining -= chunk;
      // Update heartbeat + storage to keep DO alive and prevent watchdog false alarm
      this.lastHeartbeatMs = Date.now();
      if (remaining > 0) {
        task.lastUpdate = Date.now();
        await this.doState.storage.put('task', taskForStorage(task));
      }
    }
  }

  getToolCacheStats(): { hits: number; misses: number; size: number; prefetchHits: number } {
    return {
      hits: this.toolCacheHits,
      misses: this.toolCacheMisses,
      size: this.toolResultCache.size,
      prefetchHits: this.prefetchHits,
    };
  }

  /**
   * Start pre-fetching files referenced in user messages (Phase 7B.3).
   * Runs in parallel with the first LLM call — results populate prefetchPromises.
   * When the LLM eventually calls github_read_file, the content is already available.
   */
  private startFilePrefetch(messages: ChatMessage[], githubToken?: string): void {
    if (!githubToken) return;

    // Find the last user message
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return;
    const userText = typeof lastUser.content === 'string' ? lastUser.content : '';

    // Extract file paths from user message
    const paths = extractFilePaths(userText);
    if (paths.length === 0) return;

    // Extract GitHub repo context from conversation
    const repo = extractGitHubContext(messages);
    if (!repo) return;

    console.log(`[TaskProcessor] Pre-fetching ${paths.length} files from ${repo.owner}/${repo.repo}: ${paths.join(', ')}`);

    // Fire off all fetches in parallel (non-blocking)
    for (const filePath of paths) {
      const prefetchKey = `${repo.owner}/${repo.repo}/${filePath}`;

      // Skip if already prefetching this file
      if (this.prefetchPromises.has(prefetchKey)) continue;

      const fetchPromise = githubReadFile(repo.owner, repo.repo, filePath, undefined, githubToken)
        .then(content => {
          console.log(`[TaskProcessor] Prefetched: ${prefetchKey} (${content.length} chars)`);
          return content;
        })
        .catch(err => {
          console.log(`[TaskProcessor] Prefetch failed: ${prefetchKey} — ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });

      this.prefetchPromises.set(prefetchKey, fetchPromise);
    }
  }

  private shouldCacheToolResult(content: string): boolean {
    return !/^error(?: executing)?/i.test(content.trimStart());
  }

  /** Check if a tool result indicates a rate limit (429/503) from an external API. */
  private isRateLimitError(content: string): boolean {
    return /\bHTTP[_ ](?:429|503)\b/i.test(content)
      || /\b(?:rate.?limit|too many requests|service unavailable)\b/i.test(content);
  }

  private async executeToolWithCache(
    toolCall: ToolCall,
    toolContext: ToolContext
  ): Promise<{ tool_call_id: string; content: string }> {
    const toolName = toolCall.function.name;
    const cacheKey = `${toolName}:${toolCall.function.arguments}`;
    const isCacheable = isToolCallParallelSafe(toolCall);

    // Phase 7B.3: Check prefetch cache for github_read_file (normalized key: owner/repo/path)
    if (toolName === 'github_read_file' && this.prefetchPromises.size > 0) {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        const prefetchKey = `${args.owner}/${args.repo}/${args.path}`;
        const pending = this.prefetchPromises.get(prefetchKey);
        if (pending) {
          const content = await pending;
          if (content !== null) {
            // Store in normal cache for future hits with exact same args
            this.toolResultCache.set(cacheKey, content);
            this.prefetchHits++;
            console.log(`[TaskProcessor] Prefetch HIT: ${prefetchKey} (${this.prefetchHits} total)`);
            return { tool_call_id: toolCall.id, content };
          }
        }
      } catch {
        // JSON parse failure — fall through to normal execution
      }
    }

    if (isCacheable) {
      // Check result cache
      const cached = this.toolResultCache.get(cacheKey);
      if (cached !== undefined) {
        this.toolCacheHits++;
        console.log(`[TaskProcessor] Tool cache HIT: ${toolName} (${this.toolResultCache.size} entries)`);
        return { tool_call_id: toolCall.id, content: cached };
      }

      // Check in-flight cache (dedup parallel identical calls)
      const inFlight = this.toolInFlightCache.get(cacheKey);
      if (inFlight) {
        this.toolCacheHits++;
        console.log(`[TaskProcessor] Tool cache HIT (in-flight): ${toolName}`);
        const shared = await inFlight;
        return { tool_call_id: toolCall.id, content: shared.content };
      }
    }

    // Destructive operation guard (Phase 7A.3): block critical/high-risk tool calls
    const riskCheck = scanToolCallForRisks(toolCall);
    if (riskCheck.blocked) {
      console.log(`[TaskProcessor] BLOCKED destructive op: ${toolName} — ${riskCheck.flags.map(f => f.category).join(', ')}`);
      return { tool_call_id: toolCall.id, content: riskCheck.message! };
    }

    // Execute the tool (wrapped in a promise for in-flight dedup)
    const executionPromise = (async (): Promise<{ tool_call_id: string; content: string }> => {
      // Retry loop for rate-limited external APIs (429/503).
      // Retries the tool call natively with backoff instead of burning an LLM
      // iteration to process the error and re-request the same tool.
      // Jitter is added to prevent thundering herd when parallel tool calls
      // all hit 429 simultaneously and would otherwise retry in lockstep.
      const maxToolRetries = 2;
      let result = await executeTool(toolCall, toolContext);

      for (let retry = 0; retry < maxToolRetries; retry++) {
        if (!this.isRateLimitError(result.content)) break;
        const jitter = Math.floor(Math.random() * 2000); // 0-2s random jitter
        const delay = (retry + 1) * 3000 + jitter; // 3-5s, 6-8s
        console.log(`[TaskProcessor] Tool ${toolName} rate-limited, retrying in ${delay}ms (${retry + 1}/${maxToolRetries})`);
        // Keep heartbeat alive during backoff to prevent watchdog false alarms
        this.lastHeartbeatMs = Date.now();
        await new Promise(r => setTimeout(r, delay));
        this.lastHeartbeatMs = Date.now();
        result = await executeTool(toolCall, toolContext);
      }

      if (isCacheable && this.shouldCacheToolResult(result.content)) {
        this.toolResultCache.set(cacheKey, result.content);
        this.toolCacheMisses++;
        console.log(`[TaskProcessor] Tool cache MISS: ${toolName} → stored (${this.toolResultCache.size} entries)`);
      }

      return { tool_call_id: result.tool_call_id, content: result.content };
    })();

    if (isCacheable) {
      this.toolInFlightCache.set(cacheKey, executionPromise);
    }

    try {
      return await executionPromise;
    } finally {
      if (isCacheable) {
        this.toolInFlightCache.delete(cacheKey);
      }
    }
  }

  /** Fire-and-forget orchestra event to R2. Never throws. */
  private emitOrchestraEvent(
    task: TaskState,
    eventType: OrchestraEvent['eventType'],
    details: Record<string, unknown>,
  ): void {
    if (!this.r2) return;
    const event: OrchestraEvent = {
      timestamp: Date.now(),
      taskId: task.taskId,
      userId: task.userId,
      modelAlias: task.modelAlias,
      eventType,
      details,
    };
    // Fire-and-forget — never block the task pipeline
    appendOrchestraEvent(this.r2, event).catch(() => {});
  }

  /**
   * Update R2 orchestra history when a task fails.
   * Without this, failed tasks stay at 'started' forever in the history.
   */
  private async updateOrchestraHistoryOnFailure(task: TaskState, failureReason: string): Promise<void> {
    if (!this.r2) return;
    try {
      // Detect if this was an orchestra task from the messages
      const systemMsg = task.messages.find(m => m.role === 'system');
      const sysContent = typeof systemMsg?.content === 'string' ? systemMsg.content : '';
      const isOrchestra = sysContent.includes('Orchestra INIT Mode') || sysContent.includes('Orchestra RUN Mode') || sysContent.includes('Orchestra REDO Mode') || sysContent.includes('Orchestra DO Mode');
      if (!isOrchestra) return;

      const orchestraMode = sysContent.includes('Orchestra INIT Mode') ? 'init' as const
        : sysContent.includes('Orchestra DO Mode') ? 'do' as const
        : sysContent.includes('Orchestra REDO Mode') ? 'redo' as const : 'run' as const;
      const repoMatch = sysContent.match(/Full:\s*([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
      const repo = repoMatch ? repoMatch[1] : 'unknown/unknown';
      const userMsg = task.messages.find(m => m.role === 'user');
      const prompt = typeof userMsg?.content === 'string' ? userMsg.content : '';

      // Try to extract branch from task result or messages
      const branchMatch = (task.result || '').match(/branch:\s*(\S+)/) || sysContent.match(/Branch:\s*`([^`]+)`/);
      const branch = branchMatch ? branchMatch[1] : '';

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
        durationMs: Date.now() - task.startTime,
      };
      await storeOrchestraTask(this.r2, task.userId, failedTask);
      console.log(`[TaskProcessor] Orchestra failure recorded: ${repo} — ${failureReason}`);
    } catch (orchErr) {
      console.error('[TaskProcessor] Failed to update orchestra history on failure:', orchErr);
    }
  }

  /**
   * Alarm handler - acts as a watchdog to detect stuck/crashed tasks
   * This fires even if the DO was terminated and restarted by Cloudflare
   */
  async alarm(): Promise<void> {
    console.log('[TaskProcessor] Watchdog alarm fired');
    try {
      await this.alarmInner();
    } catch (alarmError) {
      // Error boundary: if the alarm handler throws (R2 outage, Telegram rate limit,
      // storage error), Cloudflare will automatically retry it, potentially creating
      // a tight failure loop. Catch everything, log it, and reschedule gracefully.
      console.error('[TaskProcessor] Alarm handler error (rescheduling):', alarmError);
      try {
        await this.doState.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
      } catch {
        // If even setAlarm fails, we can't do anything — the DO is in bad shape.
        // Cloudflare will eventually retry the alarm or evict the DO.
        console.error('[TaskProcessor] Failed to reschedule alarm after error');
      }
    }
  }

  private async alarmInner(): Promise<void> {
    const task = await this.doState.storage.get<TaskState>('task');

    if (!task) {
      console.log('[TaskProcessor] No task found in alarm handler');
      return;
    }

    // If task is completed, failed, or cancelled, no need for watchdog
    if (task.status !== 'processing') {
      console.log(`[TaskProcessor] Task status is ${task.status}, stopping watchdog`);
      return;
    }

    // Stale task guard: if the task has been alive for > 1 hour, it's almost
    // certainly a zombie from a previous deployment. Abandon it to prevent
    // stale DO state from interfering with new code.
    const STALE_TASK_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
    if (Date.now() - task.startTime > STALE_TASK_THRESHOLD_MS) {
      console.log(`[TaskProcessor] Abandoning stale task (started ${Math.round((Date.now() - task.startTime) / 1000)}s ago)`);
      task.status = 'failed';
      task.error = 'Task abandoned: exceeded 1-hour lifetime (likely stale from previous deployment)';
      await this.doState.storage.put('task', taskForStorage(task));
      try { await this.getWorkspaceManager(task.taskId).clear(); } catch { /* best-effort */ }
      try { await this.doState.storage.delete(`originalMessages:${task.taskId}`); } catch { /* best-effort */ }
      // F.23: Release branch lock for stale tasks
      if (this.r2 && task.orchestraRepo) {
        releaseRepoLock(this.r2, task.userId, task.orchestraRepo, task.taskId).catch(() => {});
      }
      return;
    }

    // ─── Tier scope advisory: suggest escalation when wall-clock exceeds expected budget ─
    // This is NOT a hard kill — the task continues. It warns the user once that this
    // task is taking longer than expected for its scope tier, suggesting model escalation.
    if (task.executionProfile?.bounds.expectedWallClockMs && !task.tierBudgetWarned) {
      const wallClockElapsed = Date.now() - task.startTime;
      const expectedBudget = task.executionProfile.bounds.expectedWallClockMs;
      if (wallClockElapsed > expectedBudget) {
        const tier = task.executionProfile.bounds.complexityTier ?? 'unknown';
        const expectedSec = Math.round(expectedBudget / 1000);
        const actualSec = Math.round(wallClockElapsed / 1000);
        task.tierBudgetWarned = true;
        await this.doState.storage.put('task', taskForStorage(task));
        console.log(`[TaskProcessor] Tier scope advisory: ${actualSec}s > ${expectedSec}s expected for "${tier}" tier`);
        this.emitOrchestraEvent(task, 'tier_scope_exceeded', {
          tier, expectedMs: expectedBudget, actualMs: wallClockElapsed,
          tools: task.toolsUsed.length, resumes: task.autoResumeCount ?? 0,
        });
        if (task.telegramToken) {
          await this.sendTelegramMessage(
            task.telegramToken, task.chatId,
            `⏱️ Task running longer than expected for "${tier}" scope (${actualSec}s > ${expectedSec}s expected).\n` +
            `${task.toolsUsed.length} tools, ${task.autoResumeCount ?? 0} resumes so far.\n` +
            `💡 Consider a more capable model next time: ${this.getStallModelRecs()}`
          );
        }
      }
    }

    // CPU budget yield: processTask proactively yielded to get fresh CPU budget.
    // Resume immediately without stall detection, auto-resume counting, or notifications.
    if (task.yieldPending) {
      task.yieldPending = false;
      await this.doState.storage.put('task', taskForStorage(task));
      const elapsed = Math.round((Date.now() - task.startTime) / 1000);
      console.log(`[TaskProcessor] CPU budget yield resume — ${task.iterations} iterations, ${elapsed}s elapsed`);

      const taskRequest: TaskRequest = {
        taskId: task.taskId,
        chatId: task.chatId,
        userId: task.userId,
        modelAlias: task.modelAlias,
        messages: task.messages,
        telegramToken: task.telegramToken || '',
        openrouterKey: task.openrouterKey || '',
        githubToken: task.githubToken,
        braveSearchKey: task.braveSearchKey,
        cloudflareApiToken: task.cloudflareApiToken,
        dashscopeKey: task.dashscopeKey,
        moonshotKey: task.moonshotKey,
        deepseekKey: task.deepseekKey,
        anthropicKey: task.anthropicKey,
        autoResume: task.autoResume,
        reasoningLevel: task.reasoningLevel,
        responseFormat: task.responseFormat,
        orchestraRepo: task.orchestraRepo,
        // Preserve execution profile across CPU yield resumes
        executionProfile: task.executionProfile,
      };

      this.doState.waitUntil(this.processTask(taskRequest).catch(async (error) => {
        console.error('[TaskProcessor] Uncaught error in resumed processTask:', error);
        try {
          await this.doState.storage.deleteAlarm();
          const failedTask = await this.doState.storage.get<TaskState>('task');
          if (failedTask) {
            failedTask.status = 'failed';
            failedTask.error = `Resume error: ${error instanceof Error ? error.message : String(error)}`;
            await this.doState.storage.put('task', taskForStorage(failedTask));
          }
          await this.sendTelegramMessageWithButtons(
            taskRequest.telegramToken,
            taskRequest.chatId,
            `❌ Task crashed during resume: ${error instanceof Error ? error.message : 'Unknown error'}\n\n💡 Progress may be saved.`,
            [[{ text: '🔄 Resume', callback_data: 'resume:task' }]]
          );
        } catch (notifyError) {
          console.error('[TaskProcessor] Failed to notify about resume crash:', notifyError);
        }
      }));
      return;
    }

    const timeSinceUpdate = Date.now() - task.lastUpdate;
    // Use shorter threshold when we can prove the loop is dead:
    // - isStreaming: 15s flush means lastUpdate goes stale quickly after eviction → 90s
    // - isRunning=false checked below: DO was evicted → use orphaned threshold
    const baseThreshold = getWatchdogStuckThreshold(task.modelAlias);
    const orphanedThreshold = (getModel(task.modelAlias)?.isFree !== true)
      ? ORPHANED_THRESHOLD_PAID_MS : ORPHANED_THRESHOLD_FREE_MS;
    const stuckThreshold = task.isStreaming
      ? Math.min(baseThreshold, 90_000)
      : Math.min(baseThreshold, orphanedThreshold);
    const elapsedMs = Date.now() - task.startTime;
    const elapsed = Math.round(elapsedMs / 1000);
    console.log(`[TaskProcessor] Time since last update: ${timeSinceUpdate}ms, elapsed: ${elapsed}s (threshold: ${stuckThreshold / 1000}s${task.isStreaming ? ', streaming' : ''})`);

    // In-memory execution lock: if processTask() is still running in this DO instance,
    // the task is NOT stuck — it's just waiting on a slow external API call (await yields
    // the thread in cooperative multitasking). Do NOT spawn a concurrent processTask().
    if (this.isRunning) {
      console.log('[TaskProcessor] processTask() still running (isRunning=true), rescheduling watchdog');
      await this.doState.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
      return;
    }

    // Check in-memory heartbeat first (avoids false stuck detection when streaming
    // is active but task.lastUpdate in storage is stale because we stopped persisting
    // heartbeats to storage during streaming — see onProgress optimization).
    const timeSinceHeartbeat = this.lastHeartbeatMs > 0
      ? Date.now() - this.lastHeartbeatMs
      : Infinity; // No heartbeat recorded → fall through to storage check

    // If either the storage timestamp or in-memory heartbeat is recent, task is alive
    if (timeSinceUpdate < stuckThreshold || timeSinceHeartbeat < stuckThreshold) {
      const source = timeSinceHeartbeat < timeSinceUpdate ? 'in-memory heartbeat' : 'storage lastUpdate';
      console.log(`[TaskProcessor] Task still active (${source}), rescheduling watchdog`);
      await this.doState.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
      return;
    }

    // Distinguish stream eviction from true stuck state.
    // If isStreaming=true in storage but isRunning=false, the DO was evicted mid-stream
    // (Anthropic sees 499 "Client disconnected"). This is infrastructure failure, not model
    // failure — don't count as a stall and resume faster.
    const wasStreamingWhenEvicted = task.isStreaming === true;
    if (wasStreamingWhenEvicted) {
      console.log('[TaskProcessor] DO evicted mid-stream (isStreaming=true, isRunning=false)');
      task.isStreaming = false; // Clear for next resume
    } else {
      console.log('[TaskProcessor] Task appears stuck (isRunning=false, no recent updates)');
    }

    // Delete stale status message if it exists
    if (task.telegramToken && task.statusMessageId) {
      await this.deleteTelegramMessage(task.telegramToken, task.chatId, task.statusMessageId);
    }

    const resumeCount = task.autoResumeCount ?? 0;
    const maxResumes = getAutoResumeLimit(task.modelAlias, task.isOrchestraTask, task.executionProfile);

    // Check if auto-resume is enabled and under limit.
    // Direct-API models (DeepSeek, Moonshot, DashScope) may not have an OpenRouter key
    // — check for any provider key to avoid blocking auto-resume for direct providers.
    const hasAnyProviderKey = !!(task.openrouterKey || task.deepseekKey || task.moonshotKey || task.dashscopeKey || task.anthropicKey);
    if (task.autoResume && resumeCount < maxResumes && task.telegramToken && hasAnyProviderKey) {
      // --- STALL DETECTION ---
      // Two layers:
      // 1. Raw tool count: no new tool calls at all → obvious stall
      // 2. Tool signature dedup: new tool calls, but all are duplicates of previous
      //    calls → model is spinning (re-calling get_weather("Prague") each resume)
      // Stream evictions are NOT stalls — the model was actively producing output.
      const toolCountNow = task.toolsUsed.length;
      const toolCountAtLastResume = task.toolCountAtLastResume ?? 0;
      const newTools = toolCountNow - toolCountAtLastResume;
      let noProgressResumes = task.noProgressResumes ?? 0;

      // Check for duplicate tool signatures across resumes
      let allNewToolsDuplicate = false;
      if (newTools > 0 && task.toolSignatures && task.toolSignatures.length > newTools) {
        // Get the signatures added since last resume
        const recentSigs = task.toolSignatures.slice(-newTools);
        const priorSigs = new Set(task.toolSignatures.slice(0, -newTools));
        allNewToolsDuplicate = recentSigs.every(sig => priorSigs.has(sig));
        if (allNewToolsDuplicate) {
          console.log(`[TaskProcessor] All ${newTools} new tool calls are duplicates of prior calls`);
        }
      }

      // Allow duplicate reads after context compression — the model legitimately
      // needs to re-read files whose content was evicted during compression.
      // Only forgive duplicates once per compression event.
      const compressedSinceLastResume = (task.lastCompressionToolCount ?? 0) > toolCountAtLastResume;
      if (allNewToolsDuplicate && compressedSinceLastResume) {
        console.log(`[TaskProcessor] Allowing duplicate tool calls: context was compressed since last resume (compression at tool #${task.lastCompressionToolCount})`);
        allNewToolsDuplicate = false;
        // Clear compression marker so we don't forgive duplicates indefinitely
        task.lastCompressionToolCount = 0;
      }

      if ((newTools === 0 || allNewToolsDuplicate) && resumeCount > 0 && !wasStreamingWhenEvicted) {
        noProgressResumes++;
        const reason = allNewToolsDuplicate ? 'duplicate tools' : 'no new tools';
        console.log(`[TaskProcessor] No real progress since last resume: ${reason} (stall ${noProgressResumes}/${MAX_NO_PROGRESS_RESUMES})`);

        if (noProgressResumes >= MAX_NO_PROGRESS_RESUMES) {
          const stallReason = `Task stalled: no progress across ${noProgressResumes} auto-resumes (${task.iterations} iterations, ${toolCountNow} tools)`;
          console.log(`[TaskProcessor] ${stallReason}`);
          task.status = 'failed';
          task.error = `${stallReason}. The model may not be capable of this task.`;
          await this.doState.storage.put('task', taskForStorage(task));

          // Terminal state — clean up workspace staging to prevent storage leaks
          try { await this.getWorkspaceManager(task.taskId).clear(); } catch { /* best-effort */ }
      try { await this.doState.storage.delete(`originalMessages:${task.taskId}`); } catch { /* best-effort */ }

          // Update orchestra history so failed tasks don't stay at 'started' forever
          await this.updateOrchestraHistoryOnFailure(task, stallReason);
          this.emitOrchestraEvent(task, 'stall_abort', { reason: stallReason, resumes: noProgressResumes, iterations: task.iterations, tools: toolCountNow });
          // F.23: Release branch lock on stall abort
          if (this.r2 && task.orchestraRepo) {
            releaseRepoLock(this.r2, task.userId, task.orchestraRepo, task.taskId).catch(() => {});
          }

          if (task.telegramToken) {
            const stallProgress = this.buildProgressSummary(task);
            await this.sendTelegramMessageWithButtons(
              task.telegramToken,
              task.chatId,
              `🛑 Task stalled after ${noProgressResumes} resumes with no progress (${task.iterations} iter, ${toolCountNow} tools).${stallProgress}\n\n💡 Try a more capable model: ${this.getStallModelRecs()}\n\nProgress saved.`,
              [[{ text: '🔄 Resume', callback_data: 'resume:task' }]]
            );
          }
          return;
        }
      } else {
        noProgressResumes = 0; // Reset on progress
      }

      // Orchestra-specific stall: if we've used 3+ resumes but never called
      // github_create_pr, the model is stuck in a read/discover loop.
      // Abort early to prevent runaway token burn.
      if (task.isOrchestraTask && resumeCount >= 3
          && !task.toolsUsed.includes('github_create_pr')
          && !wasStreamingWhenEvicted) {
        const orchStallReason = `Orchestra stall: ${resumeCount} resumes with ${toolCountNow} tools but no PR attempted`;
        console.log(`[TaskProcessor] ${orchStallReason}`);
        task.status = 'failed';
        task.error = `${orchStallReason}. Model stuck in read loop — try a more capable model.`;
        await this.doState.storage.put('task', taskForStorage(task));
        try { await this.getWorkspaceManager(task.taskId).clear(); } catch { /* best-effort */ }
        try { await this.doState.storage.delete(`originalMessages:${task.taskId}`); } catch { /* best-effort */ }
        await this.updateOrchestraHistoryOnFailure(task, orchStallReason);
        this.emitOrchestraEvent(task, 'stall_abort', { reason: orchStallReason, resumes: resumeCount, tools: toolCountNow, orchestra: true });
        // F.23: Release branch lock on orchestra stall abort
        if (this.r2 && task.orchestraRepo) {
          releaseRepoLock(this.r2, task.userId, task.orchestraRepo, task.taskId).catch(() => {});
        }
        if (task.telegramToken) {
          const orchProgress = this.buildProgressSummary(task);
          await this.sendTelegramMessageWithButtons(
            task.telegramToken,
            task.chatId,
            `🛑 Orchestra stall: ${resumeCount} resumes, ${toolCountNow} tools, but no PR was ever attempted.${orchProgress}\n\n💡 Try: ${this.getStallModelRecs()}\n\nProgress saved.`,
            [[{ text: '🔄 Resume', callback_data: 'resume:task' }]]
          );
        }
        return;
      }

      // Update stall tracking
      task.toolCountAtLastResume = toolCountNow;
      task.noProgressResumes = noProgressResumes;

      console.log(`[TaskProcessor] Auto-resuming (attempt ${resumeCount + 1}/${maxResumes}, ${newTools} new tools since last resume)`);

      // Update resume count
      task.autoResumeCount = resumeCount + 1;
      task.status = 'processing'; // Keep processing status
      task.lastUpdate = Date.now();
      await this.doState.storage.put('task', taskForStorage(task));

      // Notify user about auto-resume with progress context.
      // Include scope advisory when resumes exceed tier expectation (one-time warning).
      const resumeTools = newTools > 0 ? `, ${newTools} new tools` : '';
      const expectedResumes = task.executionProfile?.bounds.expectedResumes;
      const tier = task.executionProfile?.bounds.complexityTier;
      const resumeAdvisory = (expectedResumes != null && tier && resumeCount + 1 > expectedResumes && !task.tierResumeWarned)
        ? `\n⚠️ Exceeds "${tier}" scope expectation (${expectedResumes} resumes). Consider a stronger model next time.`
        : '';
      if (resumeAdvisory) {
        task.tierResumeWarned = true;
        await this.doState.storage.put('task', taskForStorage(task));
      }
      await this.sendTelegramMessage(
        task.telegramToken,
        task.chatId,
        `🔄 Auto-resuming... (${resumeCount + 1}/${maxResumes})\n⏱️ ${elapsed}s elapsed, ${task.iterations} iterations${resumeTools}${resumeAdvisory}`
      );

      // Reconstruct TaskRequest and trigger resume.
      // task.messages is always [] (taskForStorage strips them to stay under 128KB).
      // Prefer the original request messages stored in DO storage — these contain
      // the system prompt and user message, which are essential for context.
      // processTask will overwrite these with checkpoint data from R2 if available,
      // but if no checkpoint exists yet (e.g. task died before first tool call),
      // having the originals prevents the model from losing all context.
      const storedOriginalMessages = await this.doState.storage.get<ChatMessage[]>(`originalMessages:${task.taskId}`);
      const resumeMessages = storedOriginalMessages && storedOriginalMessages.length > 0
        ? storedOriginalMessages
        : task.messages; // fallback to empty [] if originalMessages somehow missing
      const taskRequest: TaskRequest = {
        taskId: task.taskId,
        chatId: task.chatId,
        userId: task.userId,
        modelAlias: task.modelAlias,
        messages: resumeMessages,
        telegramToken: task.telegramToken,
        openrouterKey: task.openrouterKey || '',
        githubToken: task.githubToken,
        braveSearchKey: task.braveSearchKey,
        cloudflareApiToken: task.cloudflareApiToken,
        // Include direct provider API keys for resume
        dashscopeKey: task.dashscopeKey,
        moonshotKey: task.moonshotKey,
        deepseekKey: task.deepseekKey,
        anthropicKey: task.anthropicKey,
        autoResume: task.autoResume,
        reasoningLevel: task.reasoningLevel,
        responseFormat: task.responseFormat,
        orchestraRepo: task.orchestraRepo,
        // Preserve execution profile across resumes so resume cap stays consistent
        executionProfile: task.executionProfile,
      };

      // Use waitUntil to trigger resume without blocking alarm
      this.doState.waitUntil(this.processTask(taskRequest));
      return;
    }

    // Auto-resume disabled or limit reached - mark as failed and notify user
    const failureReason = resumeCount >= maxResumes
      ? `Auto-resume limit (${maxResumes}) reached after ${elapsed}s`
      : `Task stopped unexpectedly after ${elapsed}s (no auto-resume)`;
    task.status = 'failed';
    task.error = failureReason;
    await this.doState.storage.put('task', taskForStorage(task));

    // Terminal state — clean up workspace staging to prevent storage leaks
    try { await this.getWorkspaceManager(task.taskId).clear(); } catch { /* best-effort */ }

    // Update orchestra history so failed tasks don't stay at 'started' forever
    await this.updateOrchestraHistoryOnFailure(task, failureReason);
    this.emitOrchestraEvent(task, 'task_abort', { reason: failureReason, resumes: resumeCount, maxResumes, elapsed });
    // F.23: Release branch lock on task abort
    if (this.r2 && task.orchestraRepo) {
      releaseRepoLock(this.r2, task.userId, task.orchestraRepo, task.taskId).catch(() => {});
    }

    if (task.telegramToken) {
      const limitReachedMsg = resumeCount >= maxResumes
        ? `\n\n⚠️ Auto-resume limit (${maxResumes}) reached.`
        : '';
      const stopProgress = this.buildProgressSummary(task);
      await this.sendTelegramMessageWithButtons(
        task.telegramToken,
        task.chatId,
        `⚠️ Task stopped unexpectedly after ${elapsed}s (${task.iterations} iterations, ${task.toolsUsed.length} tools).${stopProgress}${limitReachedMsg}\n\n💡 Progress saved. Tap Resume to continue.`,
        [[{ text: '🔄 Resume', callback_data: 'resume:task' }]]
      );
    }
  }

  /**
   * Get the tool result truncation limit for the current model.
   * Models with larger context windows can handle longer tool results.
   * Scales from 8K chars (default) up to 50K chars (cap).
   *
   * @param batchSize Number of tool results in this batch. When >1, the per-result
   *   limit is divided so that the TOTAL doesn't overwhelm the context. Without this,
   *   5 parallel file reads × 26K = 130K chars — causing multi-minute API responses,
   *   DO evictions, and cascading auto-resumes.
   */
  private getToolResultLimit(modelAlias?: string, batchSize = 1): number {
    // Use getContextBudget (which has a DO-safe cap) instead of raw model context.
    // Without this, Sonnet's 1M context allows 50KB per result × 5 reads = 250KB
    // per iteration, which bloats checkpoints and causes the read-loop stall.
    const contextBudget = this.getContextBudget(modelAlias);
    // Total budget: ~25% of context budget in chars (~4 chars/token), shared across all results.
    // Increased from 20% → 25%: reasoning_content stripping frees up context space,
    // and orchestra/coding tasks need more room for code file contents.
    // 100K budget → 100K total → 20K each for 5 tools, 50K each for 2 tools
    const totalBudget = Math.floor(contextBudget * 0.25 * 4);
    const perResult = Math.floor(totalBudget / Math.max(1, batchSize));
    return Math.min(MAX_TOOL_RESULT_LENGTH, Math.max(4000, perResult));
  }

  /**
   * Truncate a tool result if it's too long
   */
  private truncateToolResult(content: string, toolName: string, modelAlias?: string, batchSize = 1): string {
    const limit = this.getToolResultLimit(modelAlias, batchSize);
    if (content.length <= limit) {
      return content;
    }

    // For file contents, keep beginning and end
    const halfLength = Math.floor(limit / 2) - 100;
    const beginning = content.slice(0, halfLength);
    const ending = content.slice(-halfLength);

    return `${beginning}\n\n... [TRUNCATED ${content.length - limit} chars from ${toolName}] ...\n\n${ending}`;
  }

  /**
   * Estimate token count using the improved heuristic from context-budget module.
   * Accounts for message overhead, tool call metadata, and code patterns.
   */
  private estimateTokens(messages: ChatMessage[]): number {
    return estimateTokens(messages);
  }

  private getContextBudget(modelAlias?: string): number {
    const modelContext = modelAlias ? getModel(modelAlias)?.maxContext : undefined;
    if (!modelContext || modelContext <= 0) {
      return DEFAULT_CONTEXT_BUDGET;
    }

    // Reserve room for completion + overhead to avoid hitting hard context limits.
    const budget = Math.floor(modelContext * 0.75);
    // Hard cap: even if the model supports 1M tokens, the Cloudflare DO can't
    // realistically handle prompts larger than ~100K tokens — Anthropic/OpenRouter
    // API latency with huge prompts causes DO evictions before the response arrives.
    // Without this cap, Sonnet (1M context) gets a 750K budget, compression never
    // triggers, checkpoints store 250KB+ of file reads, and every resume cycle
    // re-reads the same files (the "read-only loop" stall pattern).
    const DO_CONTEXT_CAP = 100000;
    return Math.max(16000, Math.min(budget, DO_CONTEXT_CAP));
  }

  /**
   * Save checkpoint to R2
   * @param slotName - Optional slot name (default: 'latest')
   * @param completed - If true, marks checkpoint as completed (won't auto-resume)
   */
  private async saveCheckpoint(
    r2: R2Bucket,
    userId: string,
    taskId: string,
    messages: ChatMessage[],
    toolsUsed: string[],
    iterations: number,
    taskPrompt?: string,
    slotName: string = 'latest',
    completed: boolean = false,
    phase?: TaskPhase,
    modelAlias?: string
  ): Promise<void> {
    const checkpoint = {
      version: CHECKPOINT_VERSION,
      taskId,
      messages,
      toolsUsed,
      iterations,
      savedAt: Date.now(),
      taskPrompt: taskPrompt?.substring(0, 200), // Store first 200 chars for display
      completed, // If true, this checkpoint won't be used for auto-resume
      phase, // Structured task phase for resume
      modelAlias, // Model used at checkpoint time (for resume escalation)
    };
    const key = `checkpoints/${userId}/${slotName}.json`;
    await r2.put(key, JSON.stringify(checkpoint));
    console.log(`[TaskProcessor] Saved checkpoint '${slotName}': ${iterations} iterations, ${messages.length} messages${completed ? ' (completed)' : ''}`);
  }

  /**
   * Load checkpoint from R2
   * @param slotName - Optional slot name (default: 'latest')
   * @param includeCompleted - If false (default), skip completed checkpoints
   */
  private async loadCheckpoint(
    r2: R2Bucket,
    userId: string,
    slotName: string = 'latest',
    includeCompleted: boolean = false
  ): Promise<{ messages: ChatMessage[]; toolsUsed: string[]; iterations: number; savedAt: number; taskPrompt?: string; completed?: boolean; phase?: TaskPhase } | null> {
    const key = `checkpoints/${userId}/${slotName}.json`;
    const obj = await r2.get(key);
    if (!obj) return null;

    try {
      const checkpoint = JSON.parse(await obj.text());
      // Skip checkpoints from incompatible versions to prevent crashes on resume
      if (checkpoint.version !== CHECKPOINT_VERSION) {
        console.log(`[TaskProcessor] Skipping checkpoint '${slotName}': version ${checkpoint.version ?? 'none'} !== ${CHECKPOINT_VERSION}`);
        return null;
      }
      // Skip completed checkpoints unless explicitly requested (for /saveas)
      if (checkpoint.completed && !includeCompleted) {
        console.log(`[TaskProcessor] Skipping completed checkpoint '${slotName}'`);
        return null;
      }
      console.log(`[TaskProcessor] Loaded checkpoint '${slotName}': ${checkpoint.iterations} iterations${checkpoint.completed ? ' (completed)' : ''}`);
      return {
        messages: checkpoint.messages,
        toolsUsed: checkpoint.toolsUsed,
        iterations: checkpoint.iterations,
        savedAt: checkpoint.savedAt,
        taskPrompt: checkpoint.taskPrompt,
        completed: checkpoint.completed,
        phase: checkpoint.phase,
      };
    } catch {
      // Ignore parse errors
    }
    return null;
  }

  /**
   * Clear checkpoint from R2
   * @param slotName - Optional slot name (default: 'latest')
   */
  private async clearCheckpoint(r2: R2Bucket, userId: string, slotName: string = 'latest'): Promise<void> {
    const key = `checkpoints/${userId}/${slotName}.json`;
    await r2.delete(key);
  }

  /**
   * Token-budgeted context compression.
   *
   * Replaces the old fixed-window compressContext with a smarter system that:
   * - Estimates tokens per message (not just chars/4)
   * - Prioritizes recent messages, tool results, and system/user prompts
   * - Summarizes evicted messages instead of dropping them silently
   * - Maintains valid tool_call/result pairing for API compatibility
   *
   * @param messages - Full conversation messages
   * @param keepRecent - Minimum recent messages to always keep (default: 6)
   */
  private compressContext(messages: ChatMessage[], modelAlias: string, keepRecent: number = 6): ChatMessage[] {
    // Strip reasoning_content from older messages before compression.
    // Reasoning traces (Kimi/DeepSeek thinking) are never sent back to the model
    // and can be 5-10K tokens each, massively bloating context across iterations.
    // Keep only the most recent reasoning trace for continuity.
    const stripped = stripOldReasoningContent(messages);
    const compressed = compressContextBudgeted(stripped, this.getContextBudget(modelAlias), keepRecent);
    // Ensure tool message pairs remain valid after compression
    return sanitizeToolPairs(compressed);
  }

  /**
   * 5.1: Multi-agent review — call a different model to review the work.
   * Makes a single streaming API call to the reviewer model via OpenRouter.
   * Returns the reviewer's raw response text, or null if the call fails.
   */
  private async executeMultiAgentReview(
    reviewerAlias: string,
    reviewMessages: ChatMessage[],
    openrouterKey: string,
    task: TaskState,
  ): Promise<string | null> {
    try {
      const client = createOpenRouterClient(openrouterKey, 'https://moltworker.dev');
      const result = await client.chatCompletionStreamingWithTools(
        reviewerAlias,
        reviewMessages,
        {
          maxTokens: 4096,
          temperature: 0.3, // Low temperature for focused review
          // No tools — reviewer just analyzes text
          idleTimeoutMs: 30000,
          onProgress: () => {
            // Keep watchdog alive during reviewer call (in-memory only)
            this.lastHeartbeatMs = Date.now();
          },
        },
      );

      const content = result.choices?.[0]?.message?.content;
      if (!content) return null;

      // Track reviewer token usage
      if (result.usage) {
        console.log(`[TaskProcessor] 5.1 Reviewer (${reviewerAlias}): ${result.usage.prompt_tokens}+${result.usage.completion_tokens} tokens`);
      }

      return content;
    } catch (err) {
      console.error(`[TaskProcessor] 5.1 Multi-agent review failed (${reviewerAlias}):`, err);
      return null; // Fall back to same-model review
    }
  }

  /**
   * Construct a fallback response from tool results when model returns empty.
   * Extracts useful data instead of showing "No response generated."
   */
  private constructFallbackResponse(messages: ChatMessage[], toolsUsed: string[]): string {
    // Look for the last meaningful assistant content (might exist from earlier iteration)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.content && typeof msg.content === 'string' && msg.content.trim().length > 100) {
        // Skip compression summaries (they start with "[Previous work:")
        if (msg.content.startsWith('[Previous work:')) continue;
        return `${msg.content.trim()}\n\n_(Recovered from partial response)_`;
      }
    }

    // Extract key data from the most recent tool results
    const toolResults: string[] = [];
    for (let i = messages.length - 1; i >= 0 && toolResults.length < 3; i--) {
      const msg = messages[i];
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.trim()) {
        const snippet = msg.content.trim().slice(0, 500);
        toolResults.unshift(snippet);
      }
    }

    if (toolResults.length > 0) {
      const uniqueTools = [...new Set(toolsUsed)];
      return `I used ${toolsUsed.length} tools (${uniqueTools.join(', ')}) to research this. Here are the key findings:\n\n${toolResults.join('\n\n---\n\n')}\n\n_(The model couldn't generate a summary. Try a different model with /models)_`;
    }

    return `Task completed with ${toolsUsed.length} tool calls but the model couldn't generate a final response. Try again or use a different model with /models.`;
  }

  /**
   * Build a concise summary of the last actions before checkpoint, so the model
   * knows exactly where it left off after context compression.
   * Extracts: last assistant text, last tool calls, and last tool results.
   */
  private buildLastActionSummary(messages: ChatMessage[], toolsUsed: string[]): string {
    const parts: string[] = ['[LAST ACTIONS BEFORE CHECKPOINT]'];

    // Find last assistant message with meaningful content
    let lastAssistantText = '';
    let lastToolCalls: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant') {
        if (msg.content && typeof msg.content === 'string' && msg.content.trim().length > 10
            && !msg.content.startsWith('[Previous work:') && !msg.content.startsWith('[SYSTEM')) {
          lastAssistantText = msg.content.trim().slice(0, 500);
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          lastToolCalls = msg.tool_calls.map(tc => {
            const args = typeof tc.function?.arguments === 'string'
              ? tc.function.arguments.slice(0, 100)
              : '';
            return `${tc.function?.name || 'unknown'}(${args}${args.length >= 100 ? '...' : ''})`;
          });
        }
        if (lastAssistantText || lastToolCalls.length > 0) break;
      }
    }

    // Find last tool results
    const lastToolResults: string[] = [];
    for (let i = messages.length - 1; i >= 0 && lastToolResults.length < 2; i--) {
      const msg = messages[i];
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.trim()) {
        lastToolResults.unshift(msg.content.trim().slice(0, 200));
      }
    }

    if (lastAssistantText) {
      parts.push(`Last response: ${lastAssistantText}`);
    }
    if (lastToolCalls.length > 0) {
      parts.push(`Last tool calls: ${lastToolCalls.join(', ')}`);
    }
    if (lastToolResults.length > 0) {
      parts.push(`Last tool results (truncated): ${lastToolResults.join(' | ')}`);
    }
    parts.push(`Total tools used so far: ${toolsUsed.length} (${[...new Set(toolsUsed)].join(', ')})`);

    return parts.join('\n');
  }

  /**
   * Process a skill task asynchronously (S3.7).
   *
   * Isolated from the orchestra/chat processTask() loop.
   * Calls runSkill() and sends the result to Telegram.
   */
  private async processSkillTask(request: SkillTaskRequest): Promise<void> {
    const start = Date.now();
    console.log(`[TaskProcessor] Starting skill task ${request.taskId} for skill ${request.skillRequest.skillId}`);

    // Store minimal state for /status queries
    const skillState: TaskState = {
      taskId: request.taskId,
      chatId: request.chatId,
      userId: request.userId,
      modelAlias: request.skillRequest.modelAlias ?? 'flash',
      messages: [],
      status: 'processing',
      toolsUsed: [],
      iterations: 0,
      startTime: start,
      lastUpdate: start,
      telegramToken: request.telegramToken,
      openrouterKey: request.openrouterKey ?? '',
    };
    await this.doState.storage.put('task', skillState);

    try {
      // Initialize skills registry
      initializeSkills();

      // Populate the skill request env with keys from the DO request
      const enrichedRequest: SkillRequest = {
        ...request.skillRequest,
        env: {
          ...request.skillRequest.env,
          OPENROUTER_API_KEY: request.openrouterKey,
          GITHUB_TOKEN: request.githubToken,
          BRAVE_SEARCH_KEY: request.braveSearchKey,
          CLOUDFLARE_API_TOKEN: request.cloudflareApiToken,
        } as SkillRequest['env'],
      };

      // Run the skill
      const result = await runSkill(enrichedRequest);

      // Render and send to Telegram
      const chunks = renderForTelegram(result);
      for (const chunk of chunks) {
        await this.sendTelegramMessage(request.telegramToken, request.chatId, chunk.text);
      }

      // Mark completed
      skillState.status = 'completed';
      skillState.result = result.body.slice(0, 5000);
      skillState.lastUpdate = Date.now();
      skillState.iterations = result.telemetry.llmCalls;
      skillState.toolsUsed = Array.from({ length: result.telemetry.toolCalls }, (_, i) => `tool-${i + 1}`);
      await this.doState.storage.put('task', skillState);

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[TaskProcessor] Skill task ${request.taskId} completed in ${elapsed}s`);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[TaskProcessor] Skill task ${request.taskId} failed:`, message);

      // Notify user
      await this.sendTelegramMessage(
        request.telegramToken,
        request.chatId,
        `❌ Research failed: ${message}`,
      );

      // Mark failed
      skillState.status = 'failed';
      skillState.error = message;
      skillState.lastUpdate = Date.now();
      await this.doState.storage.put('task', skillState);
    }
  }

  /**
   * Handle incoming requests to the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/process' && request.method === 'POST') {
      const payload = await request.json() as TaskProcessorPayload;

      // --- Skill task path (S3.7) ---
      if (isSkillTaskRequest(payload)) {
        const skillPromise = this.processSkillTask(payload).catch(async (error) => {
          console.error('[TaskProcessor] Uncaught error in processSkillTask:', error);
          try {
            await this.doState.storage.deleteAlarm();
            await this.sendTelegramMessage(
              payload.telegramToken,
              payload.chatId,
              `❌ Research failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          } catch (notifyError) {
            console.error('[TaskProcessor] Failed to notify user of skill error:', notifyError);
          }
        });
        this.doState.waitUntil(skillPromise);

        return new Response(JSON.stringify({
          status: 'started',
          taskId: payload.taskId,
          kind: 'skill',
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      // --- Existing chat/orchestra task path ---
      const taskRequest = payload as TaskRequest;

      // Start processing in the background with global error catching.
      // waitUntil prevents DO eviction (without it, Cloudflare may GC the DO
      // after the POST response is sent, killing in-flight streaming fetches).
      // The 30s CPU limit per event is managed by the CPU budget yield mechanism
      // which proactively yields every ~12s of active time and resumes via alarm.
      const processPromise = this.processTask(taskRequest).catch(async (error) => {
        console.error('[TaskProcessor] Uncaught error in processTask:', error);
        try {
          // Cancel watchdog alarm
          await this.doState.storage.deleteAlarm();

          // Try to save checkpoint and notify user
          const task = await this.doState.storage.get<TaskState>('task');
          if (task) {
            task.status = 'failed';
            task.error = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
            await this.doState.storage.put('task', taskForStorage(task));
          }
          const crashProgress = task ? this.buildProgressSummary(task) : '';
          await this.sendTelegramMessageWithButtons(
            taskRequest.telegramToken,
            taskRequest.chatId,
            `❌ Task crashed: ${error instanceof Error ? error.message : 'Unknown error'}${crashProgress}\n\n💡 Progress may be saved.`,
            [[{ text: '🔄 Resume', callback_data: 'resume:task' }]]
          );
        } catch (notifyError) {
          console.error('[TaskProcessor] Failed to notify user:', notifyError);
        }
      });
      this.doState.waitUntil(processPromise);

      return new Response(JSON.stringify({
        status: 'started',
        taskId: taskRequest.taskId
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      const task = await this.doState.storage.get<TaskState>('task');
      if (!task) {
        return new Response(JSON.stringify({ status: 'not_found' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      // Strip secrets from status response — these are stored for alarm recovery
      // but must never be exposed via the status API
      const { telegramToken, openrouterKey, githubToken, braveSearchKey,
              cloudflareApiToken, dashscopeKey, moonshotKey, deepseekKey, anthropicKey,
              ...safeTask } = task;
      return new Response(JSON.stringify(safeTask), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/usage' && request.method === 'GET') {
      // Return usage data from the in-memory store
      const userId = url.searchParams.get('userId') || '';
      const days = parseInt(url.searchParams.get('days') || '1');
      const { getUsage, getUsageRange, formatUsageSummary, formatWeekSummary } = await import('../openrouter/costs');

      if (days > 1) {
        const records = getUsageRange(userId, days);
        return new Response(JSON.stringify({ summary: formatWeekSummary(records) }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const record = getUsage(userId);
      return new Response(JSON.stringify({ summary: formatUsageSummary(record) }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/cancel' && request.method === 'POST') {
      const task = await this.doState.storage.get<TaskState>('task');
      if (task && task.status === 'processing') {
        task.status = 'cancelled';
        task.error = 'Cancelled by user';
        await this.doState.storage.put('task', taskForStorage(task));
        // Set in-memory flag so processTask() can break out immediately
        // without waiting for its next storage.get() round-trip
        this.isCancelled = true;

        // Cancel watchdog alarm
        await this.doState.storage.deleteAlarm();

        // Clean up any orphaned workspace files
        try {
          const ws = this.getWorkspaceManager(task.taskId);
          await ws.clear();
        } catch { /* best-effort */ }

        // Try to send cancellation message
        if (task.telegramToken && task.chatId) {
          if (task.statusMessageId) {
            await this.deleteTelegramMessage(task.telegramToken, task.chatId, task.statusMessageId);
          }
          const cancelElapsed = Math.round((Date.now() - task.startTime) / 1000);
          const cancelProgress = this.buildProgressSummary(task);
          await this.sendTelegramMessage(task.telegramToken, task.chatId,
            `🛑 Task cancelled after ${cancelElapsed}s (${task.iterations} iter, ${task.toolsUsed.length} tools).${cancelProgress}`);
        }

        return new Response(JSON.stringify({ status: 'cancelled' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ status: 'not_processing', current: task?.status }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/steer' && request.method === 'POST') {
      const task = await this.doState.storage.get<TaskState>('task');
      if (!task || task.status !== 'processing') {
        return new Response(JSON.stringify({ status: 'not_processing', current: task?.status }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = await request.json() as { instruction?: string };
      const instruction = body.instruction?.trim();
      if (!instruction) {
        return new Response(JSON.stringify({ error: 'Missing instruction' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Queue the steering message in memory — processTask reads it on next iteration
      this.steerMessages.push(instruction);
      console.log(`[TaskProcessor] Steer message queued: "${instruction.slice(0, 80)}..."`);
      return new Response(JSON.stringify({ status: 'steered', queued: this.steerMessages.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Process the AI task with unlimited time
   */
  private async processTask(request: TaskRequest): Promise<void> {
    // Execution lock: prevent concurrent processTask() from alarm handler
    this.isRunning = true;
    this.isCancelled = false; // Reset for new/resumed task
    this.lastHeartbeatMs = Date.now(); // Initialize heartbeat
    let cumulativeActiveMs = 0; // Accumulated non-sleep CPU work time for yield decisions

    // Check if this is a resume of the same task (used for cache + state preservation)
    const existingTask = await this.doState.storage.get<TaskState>('task');
    const isResumingSameTask = existingTask?.taskId === request.taskId;

    // Only reset tool cache for NEW tasks — preserve cache on auto-resume
    // so the model doesn't re-fetch the same data (weather, crypto, etc.)
    if (!isResumingSameTask) {
      this.toolResultCache.clear();
      this.toolInFlightCache.clear();
      this.toolCacheHits = 0;
      this.toolCacheMisses = 0;
      this.prefetchPromises.clear();
      this.prefetchHits = 0;
    } else {
      console.log(`[TaskProcessor] Preserving tool cache for resume (${this.toolResultCache.size} entries)`);
      // If DO was evicted, in-memory cache is empty — will be rebuilt from checkpoint messages below
    }

    const task: TaskState = {
      taskId: request.taskId,
      chatId: request.chatId,
      userId: request.userId,
      modelAlias: request.modelAlias,
      messages: [...request.messages],
      status: 'processing',
      toolsUsed: [],
      iterations: 0,
      startTime: Date.now(),
      lastUpdate: Date.now(),
    };

    // Store credentials for cancel and alarm recovery
    task.telegramToken = request.telegramToken;
    task.openrouterKey = request.openrouterKey;
    task.githubToken = request.githubToken;
    task.braveSearchKey = request.braveSearchKey;
    task.cloudflareApiToken = request.cloudflareApiToken;
    // Store direct provider API keys for alarm recovery
    task.dashscopeKey = request.dashscopeKey;
    task.moonshotKey = request.moonshotKey;
    task.deepseekKey = request.deepseekKey;
    task.anthropicKey = request.anthropicKey;
    // Preserve auto-resume setting (and count if resuming)
    task.autoResume = request.autoResume;
    task.reasoningLevel = request.reasoningLevel;
    task.responseFormat = request.responseFormat;
    task.executionProfile = request.executionProfile;
    // F.23: Persist orchestraRepo for lock release on completion/failure
    if (request.orchestraRepo) {
      task.orchestraRepo = request.orchestraRepo;
    }
    // F.20: Initialize runtime risk profile for second-stage classification
    if (!task.runtimeRisk) {
      const predictedSimple = request.executionProfile?.intent.isSimple ?? false;
      task.runtimeRisk = createRuntimeRiskProfile(predictedSimple);
    }
    // Initialize structured task phase — skip plan for simple queries
    const skipPlan = isSimpleQuery(request.messages);
    task.phase = skipPlan ? 'work' : 'plan';
    task.phaseStartIteration = 0;
    if (skipPlan) {
      console.log('[TaskProcessor] Simple query detected — skipping plan phase');
    }
    // Keep existing resume/stall counters only if resuming the SAME task
    // (existingTask was already fetched above for cache preservation)
    if (isResumingSameTask && existingTask) {
      if (existingTask.autoResumeCount !== undefined) {
        task.autoResumeCount = existingTask.autoResumeCount;
      }
      // Preserve original startTime for accurate elapsed time logging across resumes.
      if (existingTask.startTime) {
        task.startTime = existingTask.startTime;
      }
      // Preserve stall detection state across resumes
      task.toolCountAtLastResume = existingTask.toolCountAtLastResume;
      task.noProgressResumes = existingTask.noProgressResumes;
      // Preserve tool signatures for cross-resume duplicate detection
      task.toolSignatures = existingTask.toolSignatures;
      // Preserve runtime risk profile across resumes
      if (existingTask.runtimeRisk) {
        task.runtimeRisk = existingTask.runtimeRisk;
      }
      // F.23: Preserve orchestraRepo for lock release across resumes
      if (existingTask.orchestraRepo) {
        task.orchestraRepo = existingTask.orchestraRepo;
      }
    }
    await this.doState.storage.put('task', taskForStorage(task));

    // Persist the original request messages (system prompt + user message) so
    // the alarm handler can reconstruct context even if no R2 checkpoint was
    // saved yet (e.g. model outputs a plan on iteration 1 with no tool calls,
    // then DO gets evicted before any checkpoint is written).
    // taskForStorage() strips messages to [] to stay under 128KB, so without
    // this the alarm handler would pass empty messages → no system prompt.
    if (!isResumingSameTask) {
      await this.doState.storage.put(`originalMessages:${task.taskId}`, request.messages);
    }

    // Set watchdog alarm to detect if DO is terminated
    await this.doState.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
    console.log('[TaskProcessor] Watchdog alarm set');

    // Send initial status to Telegram
    const statusMessageId = await this.sendTelegramMessage(
      request.telegramToken,
      request.chatId,
      skipPlan ? '⏳ 🔨 Working…' : '⏳ 📋 Planning…'
    );

    // Store status message ID for cancel cleanup
    task.statusMessageId = statusMessageId || undefined;
    await this.doState.storage.put('task', taskForStorage(task));

    const client = createOpenRouterClient(request.openrouterKey);
    // Workspace manager persists staged files in DO storage (survives evictions/auto-resumes)
    const workspace = this.getWorkspaceManager(task.taskId);

    // Initialize sandbox if the Sandbox DO binding is available.
    // getSandbox() returns a thin RPC stub — safe to call from inside a DO.
    let sandbox: import('../openrouter/tools').SandboxLike | undefined;
    if (this.env.Sandbox) {
      try {
        const sleepAfter = this.env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
        const sandboxOptions = sleepAfter === 'never'
          ? { keepAlive: true as const }
          : { sleepAfter };
        sandbox = getSandbox(this.env.Sandbox, 'moltbot', sandboxOptions);
        console.log(`[TaskProcessor] Sandbox initialized for task ${task.taskId}`);
      } catch (err) {
        console.error(`[TaskProcessor] Failed to initialize sandbox:`, err);
      }
    }

    // Capability flags for tool filtering — sandbox_exec only if sandbox is ready
    // AND execution profile doesn't explicitly disable it (simple+concrete tasks skip sandbox)
    const profileAllowsSandbox = request.executionProfile?.bounds.requiresSandbox ?? true;
    const toolCaps: ToolCapabilities = {
      browser: false, // Browser Rendering binding not available in DOs
      sandbox: !!sandbox && profileAllowsSandbox,
    };
    if (sandbox && !profileAllowsSandbox) {
      console.log('[TaskProcessor] Sandbox available but profile says requiresSandbox=false — sandbox_exec removed from tool set');
    }

    const toolContext: ToolContext = {
      githubToken: request.githubToken,
      braveSearchKey: request.braveSearchKey,
      cloudflareApiToken: request.cloudflareApiToken,
      sandbox, // Sandbox container for sandbox_exec tool (undefined if binding unavailable)
      acontextClient: createAcontextClient(request.acontextKey, request.acontextBaseUrl),
      acontextSessionId: task.taskId,
      r2Bucket: this.r2, // R2 bucket for persistent file storage
      r2FilePrefix: `files/${request.userId}/`, // Per-user file scoping
      // Workspace callbacks — persist to DO storage, not in-memory
      workspaceWrite: (file: WorkspaceFile) => workspace.writeFile(file),
      workspaceList: () => workspace.listFiles(),
      workspaceClear: () => workspace.clear(),
    };

    // Load dynamic + auto-synced model catalogs from R2 so the DO knows about
    // models registered via /syncmodels or full-catalog sync (not just curated MODELS).
    // Without this, any non-curated model alias falls through to the free-model fallback.
    if (this.r2) {
      try {
        const { UserStorage } = await import('../openrouter/storage');
        const storage = new UserStorage(this.r2);
        const data = await storage.loadDynamicModels();
        if (data) {
          if (data.models && Object.keys(data.models).length > 0) {
            registerDynamicModels(data.models);
            console.log(`[TaskProcessor] Loaded ${Object.keys(data.models).length} dynamic models from R2`);
          }
          if (data.blocked && data.blocked.length > 0) {
            blockModels(data.blocked);
          }
        }
      } catch (err) {
        console.error('[TaskProcessor] Failed to load dynamic models:', err);
      }
      try {
        const { loadAutoSyncedModels } = await import('../openrouter/model-sync/sync');
        const count = await loadAutoSyncedModels(this.r2);
        if (count > 0) {
          console.log(`[TaskProcessor] Loaded ${count} auto-synced models from R2`);
        }
      } catch (err) {
        console.error('[TaskProcessor] Failed to load auto-synced models:', err);
      }
    }

    // Pre-validate: if the requested model no longer exists, switch to a free model
    // instead of waiting for a 404 from OpenRouter (which wastes an API round-trip).
    if (!getModel(task.modelAlias)) {
      const oldAlias = task.modelAlias;
      const freeAlternatives = getFreeToolModels();
      if (freeAlternatives.length > 0) {
        task.modelAlias = freeAlternatives[0];
      } else {
        // All free models down — fall back to auto (OpenRouter's dynamic router)
        console.log(`[TaskProcessor] No free models available, falling back to /auto`);
        task.modelAlias = 'auto';
      }
      await this.doState.storage.put('task', taskForStorage(task));
      console.log(`[TaskProcessor] Model /${oldAlias} no longer available, pre-switching to /${task.modelAlias}`);
      if (statusMessageId) {
        try {
          await this.editTelegramMessage(
            request.telegramToken, request.chatId, statusMessageId,
            `⚠️ /${oldAlias} unavailable. Using /${task.modelAlias} (free)`
          );
        } catch { /* non-fatal */ }
      }
    }

    // Capability-aware free model rotation: prioritize models matching the task type
    const freeModels = getFreeToolModels();
    const taskCategory = detectTaskCategory(request.messages);
    const rotationOrder = buildRotationOrder(task.modelAlias, freeModels, taskCategory);
    let rotationIndex = 0;
    const MAX_FREE_ROTATIONS = rotationOrder.length;
    console.log(`[TaskProcessor] Task category: ${taskCategory}, rotation order: ${rotationOrder.join(', ')} (${MAX_FREE_ROTATIONS} candidates)`);
    let emptyContentRetries = 0;
    const MAX_EMPTY_RETRIES = 2;
    // Stall detection: consecutive iterations where model produces no tool calls
    let consecutiveNoToolIterations = 0;
    // Same-tool loop detection: track recent tool call signatures (name+args)
    const recentToolSignatures: string[] = [];
    // Invalid JSON args tracking: consecutive iterations where ALL tool calls have invalid JSON
    let consecutiveInvalidArgsIterations = 0;
    const MAX_INVALID_ARGS_NUDGE = 4; // After 4 iterations with all-invalid args, inject nudge
    const MAX_INVALID_ARGS_BAIL = 8; // After 8, bail out — model can't format tool calls
    // Stream split death loop tracking: consecutive splits with 0 complete tool calls.
    // When a model generates oversized tool calls (e.g. full 30KB file in workspace_write_file),
    // the stream gets truncated every time, producing 0 tools. Without escalating nudges,
    // the model repeats the same oversized call indefinitely, exhausting all auto-resumes.
    let consecutiveEmptySplits = 0;
    const MAX_EMPTY_SPLITS_NUDGE = 2; // After 2 empty splits, tell model to use smaller operations
    const MAX_EMPTY_SPLITS_BAIL = 5; // After 5, bail — model can't adapt
    // P2 guardrails: track tool errors for "No Fake Success" enforcement
    const toolErrorTracker = createToolErrorTracker();
    // Error threshold guardrail: if the same tool returns the same error 3 consecutive times,
    // force-abort the tool to prevent burning iterations on a static validation error.
    let lastToolErrorSig = '';
    let consecutiveIdenticalErrors = 0;
    const MAX_IDENTICAL_ERRORS = 3;

    let conversationMessages: ChatMessage[] = [...request.messages];
    const maxIterations = 100; // Very high limit for complex tasks
    let lastProgressUpdate = Date.now();
    let lastCheckpoint = Date.now();
    // Phase budget circuit breaker: track when the current phase started
    let phaseStartTime = Date.now();

    // Try to resume from checkpoint if available
    let resumedFromCheckpoint = false;
    if (this.r2) {
      const checkpoint = await this.loadCheckpoint(this.r2, request.userId);
      if (checkpoint && checkpoint.iterations > 0) {
        // Resume from checkpoint — sanitize to fix any orphaned tool_calls from interrupted checkpoints
        conversationMessages = sanitizeToolPairs(checkpoint.messages);

        // Truncate stale large tool results to prevent context saturation.
        // By the 3rd resume, 30KB github_read_file payloads accumulate and crowd out
        // new tool results. Replace with truncated summaries showing first/last lines.
        // Use 16KB (not 4KB) — aggressive truncation causes models to re-read the same
        // files on resume because they see "[... N lines truncated ...]" and think they
        // need the full content. 16KB preserves enough to avoid re-read loops.
        truncateLargeToolResults(conversationMessages, 16384);

        task.toolsUsed = checkpoint.toolsUsed;
        // Accumulate total iterations across all resumes before resetting
        task.totalIterations = (task.totalIterations ?? 0) + (checkpoint.iterations ?? task.iterations);
        // Reset iteration counter to 0 — give a fresh budget of maxIterations.
        // The checkpoint preserves conversation state and tool results, so work
        // isn't lost. Without this reset, resumed tasks immediately re-hit the
        // iteration limit because checkpoint.iterations is close to maxIterations.
        task.iterations = 0;
        // Restore phase from checkpoint, or default to 'work' (plan is already done)
        task.phase = checkpoint.phase || 'work';
        task.phaseStartIteration = 0;
        phaseStartTime = Date.now(); // Reset phase budget clock for resumed phase
        // Sync stall tracking to checkpoint state — prevents negative tool counts
        // when checkpoint has fewer tools than the pre-resume toolCountAtLastResume
        task.toolCountAtLastResume = checkpoint.toolsUsed.length;
        resumedFromCheckpoint = true;
        await this.doState.storage.put('task', taskForStorage(task));

        // CRITICAL: Add resume instruction to break the "re-read rules" loop
        // The model tends to re-acknowledge on every resume; this prevents it.
        // Deduplicate: remove any prior [SYSTEM RESUME NOTICE] to prevent token
        // accumulation across multiple resumes (each adds ~250 tokens).
        const resumeNoticePrefix = '[SYSTEM RESUME NOTICE]';
        for (let i = conversationMessages.length - 1; i >= 0; i--) {
          const msg = conversationMessages[i];
          if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith(resumeNoticePrefix)) {
            conversationMessages.splice(i, 1);
          }
        }

        // Build a "last action summary" from the conversation tail BEFORE compression.
        // This tells the model exactly what it was doing when interrupted, so it doesn't
        // waste iterations re-reading files to rediscover its own progress.
        const lastActionSummary = this.buildLastActionSummary(conversationMessages, checkpoint.toolsUsed);

        conversationMessages.push({
          role: 'user',
          content: `[SYSTEM RESUME NOTICE] You are resuming from a checkpoint. Your previous work is preserved in this conversation. Do NOT re-read rules or re-acknowledge the task. Continue EXACTLY where you left off. If you were in the middle of creating files, continue creating them. If you showed "Ready to start", that phase is DONE - proceed to implementation immediately.\n\n${lastActionSummary}`,
        });

        // Update status to show we're resuming
        if (statusMessageId) {
          await this.editTelegramMessage(
            request.telegramToken,
            request.chatId,
            statusMessageId,
            `⏳ 🔄 Resuming from checkpoint (${checkpoint.iterations} iterations)…`
          );
        }
        console.log(`[TaskProcessor] Resumed from checkpoint: ${checkpoint.iterations} iterations`);

        // Rebuild tool cache from checkpoint messages if DO was evicted (in-memory cache lost)
        if (this.toolResultCache.size === 0) {
          const toolCallMap = new Map<string, { name: string; arguments: string }>();
          for (const msg of conversationMessages) {
            if (msg.role === 'assistant' && msg.tool_calls) {
              for (const tc of msg.tool_calls) {
                toolCallMap.set(tc.id, { name: tc.function.name, arguments: tc.function.arguments });
              }
            }
            if (msg.role === 'tool' && msg.tool_call_id) {
              const tc = toolCallMap.get(msg.tool_call_id);
              if (tc && typeof msg.content === 'string' && this.shouldCacheToolResult(msg.content)) {
                const cacheKey = `${tc.name}:${tc.arguments}`;
                this.toolResultCache.set(cacheKey, msg.content);
              }
            }
          }
          if (this.toolResultCache.size > 0) {
            console.log(`[TaskProcessor] Rebuilt tool cache from checkpoint: ${this.toolResultCache.size} entries`);
          }
        }

        // Force-compress context after checkpoint restore.
        // Checkpoints accumulate context across iterations. Without compression,
        // context grows unbounded (e.g. 53K → 60K → 70K → 86K → crash).
        // Use 50% of context budget as target — leaves room for new tool results.
        // Note: compressContextBudgeted returns as-is if under budget, so we must
        // pass the TARGET budget, not the full context budget.
        const resumeTokens = this.estimateTokens(conversationMessages);
        const resumeTargetBudget = Math.floor(this.getContextBudget(task.modelAlias) * 0.5);
        if (resumeTokens > resumeTargetBudget) {
          const beforeCount = conversationMessages.length;
          const compressed = sanitizeToolPairs(
            compressContextBudgeted(conversationMessages, resumeTargetBudget, 8)
          );
          conversationMessages.length = 0;
          conversationMessages.push(...compressed);
          const afterTokens = this.estimateTokens(conversationMessages);
          console.log(`[TaskProcessor] Post-restore compression: ${beforeCount} → ${compressed.length} messages, ${resumeTokens} → ${afterTokens} tokens (target: ${resumeTargetBudget})`);
        }
      }

      // STICKY CONTEXT ANCHOR: On orchestra resumes, re-inject pending deliverables
      // at the bottom of context. Context compression can drop the atomic refactor rules
      // and administrative instructions from the initial system prompt — this ensures
      // the model sees its remaining obligations on every single resume.
      if (task.autoResumeCount && task.autoResumeCount > 0) {
        const sysMsg = conversationMessages.find(m => m.role === 'system');
        const sysTxt = typeof sysMsg?.content === 'string' ? sysMsg.content : '';
        const isOrchResumed = sysTxt.includes('Orchestra RUN') || sysTxt.includes('Orchestra INIT') || sysTxt.includes('Orchestra REDO');
        if (isOrchResumed) {
          const hasPr = task.toolsUsed.includes('github_create_pr');
          const hasRoadmapPatch = conversationMessages.some(m =>
            m.role === 'tool' && typeof m.content === 'string' && m.content.includes('ROADMAP.md')
          );
          const hasWorkLogPatch = conversationMessages.some(m =>
            m.role === 'tool' && typeof m.content === 'string' && m.content.includes('WORK_LOG.md')
          );

          const pending: string[] = [];
          if (!hasPr) pending.push('Create PR via github_create_pr (or workspace_commit + github_create_pr)');
          if (!hasRoadmapPatch) pending.push('Update ROADMAP.md (mark task as [x] done)');
          if (!hasWorkLogPatch) pending.push('Update WORK_LOG.md (append new row)');
          if (!hasPr) pending.push('Output ORCHESTRA_RESULT block with real PR URL');

          if (pending.length > 0) {
            conversationMessages.push({
              role: 'user',
              content: `[SYSTEM: Pending Deliverables — you MUST complete ALL before finishing]\n${pending.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nIMPORTANT: If extracting/splitting code, the source file MUST shrink (CREATE + IMPORT + DELETE in one PR). Do NOT output success until all deliverables are verified.`,
            });
            console.log(`[TaskProcessor] Sticky context anchor injected: ${pending.length} pending deliverables (resume #${task.autoResumeCount})`);
          }
        }
      }
    }

    // Inject source-grounding guardrail for coding/github tasks into the system message.
    // This prevents models from hallucinating repo state or claiming success without evidence.
    if (taskCategory === 'coding' && conversationMessages.length > 0 && conversationMessages[0].role === 'system') {
      const sysContent = typeof conversationMessages[0].content === 'string' ? conversationMessages[0].content : '';
      if (!sysContent.includes('EVIDENCE RULES')) {
        conversationMessages[0] = {
          ...conversationMessages[0],
          content: sysContent + SOURCE_GROUNDING_PROMPT,
        };
        console.log('[TaskProcessor] Source-grounding guardrail injected for coding task');
      }
    }

    // Detect and persist orchestra flag for alarm handler (tighter resume limits)
    if (!task.isOrchestraTask && conversationMessages.length > 0) {
      const sysMsg0 = conversationMessages[0];
      const sys0 = typeof sysMsg0?.content === 'string' ? sysMsg0.content : '';
      if (sys0.includes('Orchestra RUN') || sys0.includes('Orchestra INIT') || sys0.includes('Orchestra REDO') || sys0.includes('Orchestra DRAFT')) {
        task.isOrchestraTask = true;
        if (sys0.includes('Orchestra DRAFT') || request.isDraftInit) {
          task.isDraftInit = true;
        }
        await this.doState.storage.put('task', taskForStorage(task));
      }
    }

    // Inject structured planning prompt for fresh tasks (not resumed from checkpoint, not simple queries)
    // 7A.4: Uses structured JSON plan prompt instead of free-form text
    if (!resumedFromCheckpoint && !skipPlan) {
      conversationMessages.push({
        role: 'user',
        content: STRUCTURED_PLAN_PROMPT,
      });
    }

    // Phase 7B.3: Pre-fetch files referenced in user message (runs in parallel with first LLM call)
    this.startFilePrefetch(conversationMessages, request.githubToken);

    // Track cumulative token usage across all iterations
    const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };

    // Anthropic rate limit pacing: track input tokens consumed in the current minute window
    let anthropicWindowStart = Date.now();
    let anthropicWindowTokens = 0;

    // Progress tracking state (7B.5: Streaming User Feedback)
    let currentTool: string | null = null;
    let currentToolContext: string | null = null;

    /** Build a snapshot of progress state for the formatter. */
    const getProgressState = (): ProgressState => ({
      phase: task.phase || 'work',
      iterations: task.iterations,
      toolsUsed: task.toolsUsed,
      startTime: task.startTime,
      currentTool,
      currentToolContext,
      structuredPlan: task.structuredPlan || null,
      workPhaseStartIteration: task.phaseStartIteration || 0,
      coveRetrying: task.coveRetried === true && task.phase === 'work',
      reviewerAlias: task.reviewerAlias || null,
    });

    /** Send a throttled progress update to Telegram (non-fatal). */
    const sendProgressUpdate = async (force?: boolean): Promise<void> => {
      if (!statusMessageId) return;
      if (!force && !shouldSendUpdate(lastProgressUpdate)) return;
      try {
        lastProgressUpdate = Date.now();
        await this.editTelegramMessage(
          request.telegramToken,
          request.chatId,
          statusMessageId,
          formatProgressMessage(getProgressState()),
        );
      } catch (updateError) {
        console.log('[TaskProcessor] Progress update failed (non-fatal):', updateError);
      }
    };

    try {
      while (task.iterations < maxIterations) {
        // Check if cancelled — in-memory flag is set by /cancel handler instantly,
        // no storage round-trip needed. Prevents processTask from overwriting
        // the cancellation with its own put() after a tool finishes.
        if (this.isCancelled) {
          console.log('[TaskProcessor] Cancelled via in-memory flag, exiting loop');
          return; // Exit silently - cancel handler already notified user
        }

        // CPU budget yield: Cloudflare DOs have a ~30s CPU time limit per event.
        // Check BEFORE starting a new iteration to yield if we've done enough work.
        // Streaming I/O doesn't count toward CF CPU limits (empirically tested:
        // 195s streaming with no eviction), so yield is only needed for very long
        // multi-iteration runs to prevent wall-clock staleness.
        // Only yield if R2 is available (needed to save/load checkpoint for resume).
        const shouldYield = this.r2
          && (task.iterations >= MAX_ITERATIONS_BEFORE_YIELD
            || cumulativeActiveMs > MAX_ACTIVE_TIME_BEFORE_YIELD_MS)
          && task.iterations > 0;
        if (shouldYield) {
          console.log(`[TaskProcessor] CPU budget yield: ${task.iterations} iterations, ${Math.round(cumulativeActiveMs / 1000)}s active time`);
          // Save checkpoint to R2 — processTask loads from R2 on resume, so we
          // don't need to store messages in task state (which may exceed 128KB).
          await this.saveCheckpoint(
            this.r2!, request.userId, request.taskId,
            conversationMessages, task.toolsUsed, task.iterations,
            request.prompt, 'latest', false, task.phase, task.modelAlias
          );
          // Store minimal task state (no messages) with yield flag.
          // Reset stall counter: CPU yield proves real work happened, so if the
          // post-yield resume gets evicted, it shouldn't count against stall limit.
          task.lastUpdate = Date.now();
          task.yieldPending = true;
          task.noProgressResumes = 0;
          task.toolCountAtLastResume = task.toolsUsed.length;
          await this.doState.storage.put('task', taskForStorage(task));
          // Schedule immediate alarm for resume with fresh CPU budget
          await this.doState.storage.setAlarm(Date.now() + 100);
          this.isRunning = false;
          return; // Exit processTask — alarm will resume with fresh CPU budget
        }

        // Inject pending steering messages from /steer endpoint as system messages.
        // Using 'system' role gives them higher priority in context compression
        // (45 + position vs 40 + position for user role), making them resistant
        // to eviction during long task loops.
        if (this.steerMessages.length > 0) {
          const instructions = this.steerMessages.splice(0); // drain queue
          for (const instruction of instructions) {
            console.log(`[TaskProcessor] Injecting steer message: "${instruction.slice(0, 80)}"`);
            conversationMessages.push({
              role: 'system',
              content: `[USER OVERRIDE] ${instruction}`,
            });
          }
        }

        task.iterations++;
        task.lastUpdate = Date.now();
        currentTool = null;
        currentToolContext = null;
        await this.doState.storage.put('task', taskForStorage(task));

        // Send progress update (throttled to every 15s)
        await sendProgressUpdate();

        const iterStartTime = Date.now();
        let iterSleepMs = 0; // Track time spent sleeping (pacing, rate limit waits)
        let iterApiWallMs = 0; // Track time spent waiting on API (streaming is not CPU work)
        console.log(`[TaskProcessor] Iteration ${task.iterations} START - tools: ${task.toolsUsed.length}, messages: ${conversationMessages.length}`);

        // Note: Checkpoint is saved after tool execution, not before API call
        // This reduces CPU usage from redundant JSON.stringify operations

        // Determine which provider/API to use (uses task.modelAlias for rotation support)
        const provider = getProvider(task.modelAlias);
        const providerConfig = getProviderConfig(task.modelAlias);

        // Get the appropriate API key for the provider
        let apiKey: string;
        switch (provider) {
          case 'dashscope':
            apiKey = request.dashscopeKey || '';
            break;
          case 'moonshot':
            apiKey = request.moonshotKey || '';
            break;
          case 'deepseek':
            apiKey = request.deepseekKey || '';
            break;
          case 'anthropic':
            apiKey = request.anthropicKey || '';
            break;
          default:
            apiKey = request.openrouterKey;
        }

        if (!apiKey) {
          throw new Error(`No API key configured for provider: ${provider}. Set ${providerConfig.envKey} in Cloudflare.`);
        }

        // Build headers based on provider
        const headers: Record<string, string> = provider === 'anthropic'
          ? buildAnthropicHeaders(apiKey)
          : {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            };

        // OpenRouter-specific headers
        if (provider === 'openrouter') {
          headers['HTTP-Referer'] = 'https://moltworker.dev';
          headers['X-Title'] = 'Moltworker Telegram Bot';
        }

        console.log(`[TaskProcessor] Using provider: ${provider}, URL: ${providerConfig.baseUrl}`);

        // Check if current model supports tools (conditional injection)
        // Use modelSupportsTools() which checks both the flag and a hardcoded fallback list,
        // so tools work even if getModel() returns undefined for an unknown alias.
        const currentModel = getModel(task.modelAlias);
        const useTools = modelSupportsTools(task.modelAlias);

        // Phase budget circuit breaker: check before API call
        // Pass provider so slow APIs (Moonshot/Kimi, DeepSeek) get scaled budgets
        if (task.phase) {
          checkPhaseBudget(task.phase, phaseStartTime, provider);
        }

        // Anthropic rate limit pacing: with a 30K input tokens/min limit,
        // blasting 4 iterations (~38K tokens) in 15 seconds guarantees a 429.
        // Track cumulative tokens per window and proactively sleep before hitting the limit.
        if (provider === 'anthropic' && anthropicWindowTokens > 0) {
          const elapsedInWindow = Date.now() - anthropicWindowStart;
          const ANTHROPIC_INPUT_TPM = 30000;
          const estimatedNext = this.estimateTokens(conversationMessages);
          if (anthropicWindowTokens + estimatedNext > ANTHROPIC_INPUT_TPM * 0.85 && elapsedInWindow < 60000) {
            const waitMs = Math.min(60000 - elapsedInWindow + 2000, 65000);
            console.log(`[TaskProcessor] Anthropic rate limit pacing: ${anthropicWindowTokens} tokens used in ${Math.round(elapsedInWindow / 1000)}s, next ~${estimatedNext} tokens — waiting ${Math.round(waitMs / 1000)}s`);
            task.lastUpdate = Date.now();
            await this.doState.storage.put('task', taskForStorage(task));
            iterSleepMs += waitMs; // Track sleep time for CPU budget accounting
            await this.keepAliveSleep(waitMs, task);
            // Reset window after waiting
            anthropicWindowStart = Date.now();
            anthropicWindowTokens = 0;
          } else if (elapsedInWindow >= 60000) {
            // Window expired, reset
            anthropicWindowStart = Date.now();
            anthropicWindowTokens = 0;
          }
        }

        // Retry loop for API calls
        const MAX_API_RETRIES = 3;
        let rateLimitRetries = 0;
        const MAX_RATE_LIMIT_RETRIES = 5;
        let result: {
          choices: Array<{
            message: {
              role: string;
              content: string | null;
              tool_calls?: ToolCall[];
              reasoning_content?: string;
            };
            finish_reason: string;
          }>;
          usage?: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
            /** DeepSeek: tokens served from prefix cache */
            prompt_cache_hit_tokens?: number;
            /** DeepSeek: tokens not served from cache */
            prompt_cache_miss_tokens?: number;
          };
        } | null = null;
        let lastError: Error | null = null;

        // Pre-flight compression: if context already exceeds ~92% of provider budget,
        // compress before the API call to avoid a wasted round-trip + 400 error.
        const estimatedCtx = this.estimateTokens(conversationMessages);
        const contextBudget = this.getContextBudget(task.modelAlias);
        if (estimatedCtx > Math.floor(contextBudget * 0.92)) {
          const compressed = this.compressContext(conversationMessages, task.modelAlias, 4);
          if (compressed.length < conversationMessages.length) {
            console.log(`[TaskProcessor] Preflight compression: ${conversationMessages.length}->${compressed.length} msgs (~${estimatedCtx} tokens, budget: ${contextBudget})`);
            conversationMessages.length = 0;
            conversationMessages.push(...compressed);
          }
        }

        // Scale SSE idle timeout based on context size AND model.
        // Large prompts (60K+ tokens) cause slower first-token latency, especially on
        // DeepSeek V3.2 through OpenRouter where routing adds overhead.
        // Default 45s is fine for <30K tokens but causes STREAM_READ_TIMEOUT on resumes
        // where checkpoint context is 60-80K tokens.
        //
        // Paid models get more generous timeouts because:
        // 1. Users are paying — don't waste their money on premature timeouts
        // 2. Paid models often handle larger/harder tasks with more context
        // 3. DeepSeek V3.2 via OpenRouter routinely needs >120s for 60K+ tokens
        // (re-estimate after possible preflight compression)
        const estimatedCtxAfter = this.estimateTokens(conversationMessages);
        const isPaid = getModel(task.modelAlias)?.isFree !== true;
        const baseTimeout = estimatedCtxAfter > 60000 ? 180000  // 3min for 60K+ tokens
          : estimatedCtxAfter > 30000 ? 120000                  // 2min for 30K-60K tokens
          : estimatedCtxAfter > 15000 ? 90000                   // 90s for 15K-30K tokens
          : 45000;                                               // 45s default
        // Provider-aware multiplier: some direct APIs (Moonshot/Kimi, DashScope/Qwen)
        // have high time-to-first-token due to deep reasoning. Without this, their
        // inter-chunk pauses exceed the idle timeout, causing STREAM_READ_TIMEOUT
        // on every iteration and exhausting auto-resume budget with minimal progress.
        const providerMultiplier = provider === 'moonshot' ? 2.5
          : provider === 'deepseek' ? 1.8
          : provider === 'anthropic' ? 1.5  // Direct API: high TTFT + reasoning latency
          : provider === 'dashscope' ? 1.5
          : 1.0;
        // Apply provider multiplier to both free and paid models — free direct
        // providers (DeepSeek, Moonshot) can also have long first-token delays.
        const scaledTimeout = baseTimeout * providerMultiplier;
        // Paid models: minimum 90s even for small contexts (they handle complex tasks)
        const idleTimeout = isPaid ? Math.max(scaledTimeout, 90000) : scaledTimeout;
        if (idleTimeout > 45000) {
          console.log(`[TaskProcessor] Scaled idle timeout: ${idleTimeout / 1000}s (estimated ${estimatedCtxAfter} tokens, ${isPaid ? 'paid' : 'free'}${providerMultiplier > 1 ? `, ${provider} ×${providerMultiplier}` : ''})`);
        }

        // 7B.1: Create speculative executor for this iteration
        // Safe read-only tools will be started during streaming, before the full response arrives
        const specExec = createSpeculativeExecutor(
          isToolCallParallelSafe,
          (tc) => this.executeToolWithCache(tc, toolContext),
        );

        // Mutable reasoning override — set by the "reasoning mandatory" 400 handler
        // so the next retry attempt injects the param into the request body.
        let reasoningOverride: ReturnType<typeof buildFallbackReasoningParam> | undefined;

        for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
          const apiCallStart = Date.now();
          try {
            console.log(`[TaskProcessor] Starting API call (attempt ${attempt}/${MAX_API_RETRIES})...`);

            // Use streaming for OpenRouter to avoid response.text() hangs
            // SSE streaming reads chunks incrementally, bypassing the hang issue
            if (provider === 'openrouter') {
              const client = createOpenRouterClient(apiKey, 'https://moltworker.dev');

              // Use streaming with progress callback for heartbeat
              let progressCount = 0;
              task.isStreaming = true;
              task.lastUpdate = Date.now();
              await this.doState.storage.put('task', taskForStorage(task));
              const streamStartMs = Date.now();

              // Hard stream timeout for OpenRouter — same as direct API path.
              // Prevents runaway streams that keep dribbling chunks.
              const orHardTimeoutMs = Math.min(Math.max(idleTimeout * 3, 180_000), 300_000);
              try {
                result = await Promise.race([
                  client.chatCompletionStreamingWithTools(
                    task.modelAlias, // Pass alias - method will resolve to model ID (supports rotation)
                    sanitizeMessages(conversationMessages),
                    {
                      maxTokens: isPaid ? 32768 : 16384,
                      temperature: getTemperature(task.modelAlias),
                      tools: useTools ? getToolsForPhase(task.phase, toolCaps) : undefined,
                      toolChoice: useTools && task.phase !== 'review' ? 'auto' : undefined,
                      idleTimeoutMs: idleTimeout, // Scaled by context size (45s-120s)
                      reasoningLevel: request.reasoningLevel,
                      responseFormat: request.responseFormat,
                      onProgress: () => {
                        progressCount++;
                        this.lastHeartbeatMs = Date.now();
                        if (progressCount % 100 === 0) {
                          console.log(`[TaskProcessor] Streaming progress: ${progressCount} chunks received`);
                        }
                      },
                      onToolCallReady: useTools ? specExec.onToolCallReady : undefined,
                      // Keepalive + stream split: update storage periodically to keep
                      // watchdog happy, and signal graceful stop after STREAM_SPLIT_TIMEOUT_MS.
                      // CF evicts DOs during long streams regardless of I/O — this controlled
                      // split returns partial results before eviction can happen.
                      onKeepAlive: async (ctx: { hasInFlightToolCalls: boolean }) => {
                        task.lastUpdate = Date.now();
                        await this.doState.storage.put('task', taskForStorage(task));
                        const elapsed = Date.now() - streamStartMs;
                        // Elastic timeout: expand to STREAM_SPLIT_MAX_MS (120s) when tool calls
                        // are in-flight to avoid the truncation trap where slow models get split
                        // mid-tool-call repeatedly. 85s base for standard text.
                        const effectiveTimeout = ctx.hasInFlightToolCalls
                          ? STREAM_SPLIT_MAX_MS
                          : STREAM_SPLIT_TIMEOUT_MS;
                        console.log(`[TaskProcessor] Streaming keepalive (${progressCount} chunks, ${Math.round(elapsed / 1000)}s${ctx.hasInFlightToolCalls ? ', tool in-flight' : ''})`);
                        return elapsed < effectiveTimeout;
                      },
                    }
                  ),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`OpenRouter hard stream timeout (${Math.round(orHardTimeoutMs / 1000)}s)`)), orHardTimeoutMs)
                  ),
                ]);
              } finally {
                task.isStreaming = false;
              }

              console.log(`[TaskProcessor] Streaming completed: ${progressCount} total chunks${specExec.startedCount() > 0 ? `, ${specExec.startedCount()} tools started speculatively` : ''}`);
              break; // Success! Exit retry loop

            } else {
              // Non-OpenRouter providers: use SSE streaming
              // This prevents DO termination during long API calls
              const abortController = new AbortController();
              const fetchTimeout = setTimeout(() => abortController.abort(), idleTimeout + 30000);

              // Inject cache_control on system messages for Anthropic models (prompt caching)
              let sanitized = sanitizeMessages(conversationMessages);
              // Moonshot/Kimi requires reasoning_content on all assistant tool-call messages
              // when thinking mode is enabled — inject placeholder where missing
              if (provider === 'moonshot') {
                sanitized = ensureMoonshotReasoning(sanitized);
              }
              const finalMessages = isAnthropicModel(task.modelAlias) ? injectCacheControl(sanitized) : sanitized;

              // Build request body — Anthropic uses a different format (Messages API)
              let requestBody: Record<string, unknown>;
              const maxTokens = clampMaxTokens(task.modelAlias, isPaid ? 32768 : 16384);

              if (provider === 'anthropic') {
                // Anthropic Messages API: different structure from OpenAI format
                const reasoningLevel = request.reasoningLevel ?? detectReasoningLevel(conversationMessages);
                const reasoningParam = reasoningOverride || getReasoningParam(task.modelAlias, reasoningLevel) || undefined;
                requestBody = buildAnthropicRequest({
                  modelId: getModelId(task.modelAlias),
                  messages: finalMessages,
                  maxTokens,
                  temperature: getTemperature(task.modelAlias),
                  tools: useTools ? getToolsForPhase(task.phase, toolCaps) : undefined,
                  toolChoice: useTools && task.phase !== 'review' ? 'auto' : undefined,
                  reasoning: reasoningParam,
                }) as unknown as Record<string, unknown>;
              } else {
                // OpenAI-compatible direct APIs (DeepSeek, Moonshot, DashScope)
                requestBody = {
                  model: getModelId(task.modelAlias),
                  messages: finalMessages,
                  max_tokens: maxTokens,
                  temperature: getTemperature(task.modelAlias),
                  stream: true,
                  // Include usage data in stream — parity with OpenRouter path
                  stream_options: { include_usage: true },
                };
                if (useTools) {
                  const phaseTools = getToolsForPhase(task.phase, toolCaps);
                  if (phaseTools.length > 0) {
                    requestBody.tools = phaseTools;
                    requestBody.tool_choice = 'auto';
                  }
                }
                if (request.responseFormat) {
                  requestBody.response_format = request.responseFormat;
                }

                // Inject reasoning parameter for direct API models (DeepSeek V3.2, etc.)
                if (reasoningOverride) {
                  requestBody.reasoning = reasoningOverride;
                } else {
                  const reasoningLevel = request.reasoningLevel ?? detectReasoningLevel(conversationMessages);
                  const reasoningParam = getReasoningParam(task.modelAlias, reasoningLevel);
                  if (reasoningParam) {
                    requestBody.reasoning = reasoningParam;
                  }
                }
              }

              // Start heartbeat BEFORE fetch — covers TTFT blind spot where
              // watchdog sees stale lastUpdate during 10-30s wait for first byte.
              const preFetchHeartbeat = setInterval(() => {
                task.lastUpdate = Date.now();
                this.lastHeartbeatMs = Date.now();
                this.doState.storage.put('task', taskForStorage(task)).catch(() => {});
              }, 15000);

              let response: Response;
              try {
                response = await fetch(providerConfig.baseUrl, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify(requestBody),
                  signal: abortController.signal,
                });
                // Clear connect timeout after headers arrive — don't kill active streams
                clearTimeout(fetchTimeout);
                console.log(`[TaskProcessor] ${provider} streaming response: ${response.status}`);
              } catch (fetchError) {
                clearTimeout(fetchTimeout);
                clearInterval(preFetchHeartbeat);
                if (fetchError instanceof DOMException && fetchError.name === 'AbortError') {
                  throw new Error(`${provider} API timeout (${Math.round((idleTimeout + 30000) / 1000)}s) — connection aborted`);
                }
                throw fetchError;
              }

              if (!response.ok) {
                clearInterval(preFetchHeartbeat);
                const errorText = await response.text().catch(() => 'unknown error');
                const providerErr = parseProviderError(response.status, errorText);
                throw new Error(`${provider} API error (${providerErr.status}): ${providerErr.message}`);
              }

              if (!response.body) {
                clearInterval(preFetchHeartbeat);
                throw new Error(`${provider} API returned no response body`);
              }
              // Keep preFetchHeartbeat running until first chunk arrives.
              // Anthropic can return headers quickly but delay first SSE event
              // during reasoning — without this, watchdog sees stale lastUpdate.

              // Parse SSE stream — Anthropic uses different event format
              let directProgressCount = 0;
              let sawFirstChunk = false;
              const onStreamProgress = () => {
                directProgressCount++;
                this.lastHeartbeatMs = Date.now();
                if (!sawFirstChunk) {
                  sawFirstChunk = true;
                  clearInterval(preFetchHeartbeat);
                }
                if (directProgressCount % 100 === 0) {
                  console.log(`[TaskProcessor] ${provider} streaming: ${directProgressCount} chunks`);
                }
              };

              // Mark streaming in storage so watchdog can distinguish
              // "evicted mid-stream" from "model stuck" — enables faster detection
              // and smarter stall handling (stream eviction ≠ model failure).
              task.isStreaming = true;
              task.lastUpdate = Date.now();
              await this.doState.storage.put('task', taskForStorage(task));
              const directStreamStartMs = Date.now();

              // Provider-aware stream control: Anthropic gets generous 270s soft split
              // (vs 85s for fast-streaming providers). The soft split preserves partial
              // output for auto-resume; the hard abort at 300s is the absolute safety net.
              const streamPolicy = getStreamPolicy(provider, idleTimeout);
              let lastPersistMs = Date.now();
              const onKeepAlive = async (ctx: { hasInFlightToolCalls: boolean }): Promise<boolean> => {
                const now = Date.now();
                task.lastUpdate = now;

                // Throttled storage persistence — reduces CPU overhead during long streams.
                // Anthropic: every 30s. Others: every 10s (unchanged).
                if (now - lastPersistMs >= streamPolicy.persistIntervalMs) {
                  await this.doState.storage.put('task', taskForStorage(task));
                  lastPersistMs = now;
                }

                const elapsed = now - directStreamStartMs;
                // Elastic soft split: expand timeout when tool calls are in-flight
                const effectiveTimeout = ctx.hasInFlightToolCalls
                  ? streamPolicy.softSplitToolMs
                  : streamPolicy.softSplitMs;
                console.log(`[TaskProcessor] ${provider} keepalive (${directProgressCount} chunks, ${Math.round(elapsed / 1000)}s/${Math.round(effectiveTimeout / 1000)}s${ctx.hasInFlightToolCalls ? ', tool in-flight' : ''})`);
                return elapsed < effectiveTimeout;
              };

              // Hard stream timeout — absolute wall-clock guardrail.
              // Anthropic: 300s (5 min). Others: 3× idle timeout, clamped 180s-300s.
              const hardStreamTimeoutMs = streamPolicy.hardTimeoutMs;
              const hardStreamTimeout = setTimeout(() => {
                console.log(`[TaskProcessor] Hard stream timeout (${Math.round(hardStreamTimeoutMs / 1000)}s) — aborting`);
                abortController.abort();
              }, hardStreamTimeoutMs);

              try {
                if (provider === 'anthropic') {
                  result = await parseAnthropicSSEStream(
                    response.body, idleTimeout, onStreamProgress,
                    useTools ? specExec.onToolCallReady : undefined,
                    onKeepAlive,
                    streamPolicy.keepAliveIntervalMs,
                  );
                } else {
                  result = await parseSSEStream(
                    response.body, idleTimeout, onStreamProgress,
                    useTools ? specExec.onToolCallReady : undefined,
                    onKeepAlive,
                  );
                }
              } finally {
                clearTimeout(hardStreamTimeout);
                clearInterval(preFetchHeartbeat); // Safety: clear if no chunks arrived
                task.isStreaming = false;
              }

              console.log(`[TaskProcessor] ${provider} streaming complete: ${directProgressCount} chunks${specExec.startedCount() > 0 ? `, ${specExec.startedCount()} tools started speculatively` : ''}`);
              break; // Success!
            }

          } catch (apiError) {
            lastError = apiError instanceof Error ? apiError : new Error(String(apiError));
            console.log(`[TaskProcessor] API call failed (attempt ${attempt}): ${lastError.message}`);

            // 429 rate limit on paid model — distinguish daily vs per-minute limits.
            // Daily (TPD) limits won't reset with short waits — fail fast and suggest alternatives.
            // Per-minute (TPM/RPM) limits are transient — backoff and retry.
            if (/\b429\b/.test(lastError.message) && !(getModel(task.modelAlias)?.isFree === true)) {
              // Detect daily/quota limits: Moonshot uses "TPD rate limit", others may use similar patterns
              const isDailyLimit = /\bTPD\b|tokens?.per.day|daily.*(limit|quota|cap)|quota.*exceeded/i.test(lastError.message);
              if (isDailyLimit) {
                console.log(`[TaskProcessor] 429 DAILY rate limit for ${task.modelAlias} — failing fast (no point retrying)`);
                // Surface a clear error so the user knows to switch models
                lastError = new Error(`${task.modelAlias} daily token quota exceeded (${lastError.message}). Try /kimi (OpenRouter) or another model.`);
                break;
              }

              if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                rateLimitRetries++;
                const waitSecs = Math.min(15 * Math.pow(2, rateLimitRetries - 1), 60);
                console.log(`[TaskProcessor] 429 rate limit on paid model — waiting ${waitSecs}s (rate limit retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})`);
                // Keep heartbeat and storage alive during rate limit sleep
                // to prevent watchdog from triggering false auto-resume
                task.lastUpdate = Date.now();
                await this.doState.storage.put('task', taskForStorage(task));
                iterSleepMs += waitSecs * 1000; // Track sleep time for CPU budget accounting
                await this.keepAliveSleep(waitSecs * 1000, task);
                attempt--; // Don't consume the attempt slot for rate limits
                continue;
              }
              console.log('[TaskProcessor] 429 rate limit retries exhausted — failing');
              break;
            }

            // 402 = payment required / quota exceeded — fail fast, don't retry
            if (/\b402\b/.test(lastError.message)) {
              console.log('[TaskProcessor] 402 Payment Required — failing fast');
              break;
            }

            // 400 content filter (DashScope/Alibaba) — deterministic, don't retry
            if (/\b400\b/.test(lastError.message) && /inappropriate.?content|data_inspection_failed/i.test(lastError.message)) {
              console.log('[TaskProcessor] Content filter 400 — failing fast (will try rotation)');
              break;
            }

            // 400 "Reasoning is mandatory" — force-enable reasoning and retry once.
            // For OpenRouter: chatCompletionStreamingWithTools handles this internally.
            // For direct API: set reasoningOverride so the next attempt includes it.
            if (/\b400\b/.test(lastError.message) && isReasoningMandatoryError(lastError.message)) {
              if (!reasoningOverride) {
                console.log(`[TaskProcessor] Reasoning mandatory for ${task.modelAlias} — retrying with reasoning enabled`);
                reasoningOverride = buildFallbackReasoningParam(task.modelAlias);
                continue; // Retry with reasoning injected (same attempt slot)
              }
              // Already tried with reasoning override — something else is wrong
              console.log('[TaskProcessor] Already had reasoning override, still rejected — failing');
              break;
            }

            // 400 "Input validation error" — context too large for provider.
            // Compress conversation and retry once instead of failing immediately.
            if (/\b400\b/.test(lastError.message) && /input.?validation|too.?long|too.?many.?tokens|context.?length|max.?tokens|maximum.?context|prompt is too long|reduce the length/i.test(lastError.message)) {
              const beforeLen = conversationMessages.length;
              const beforeTokens = this.estimateTokens(conversationMessages);
              const compressed = this.compressContext(conversationMessages, task.modelAlias, 4);
              const afterTokens = this.estimateTokens(compressed);
              console.log(`[TaskProcessor] 400 Input validation — compressing context: ${beforeLen}→${compressed.length} msgs, ~${beforeTokens}→${afterTokens} tokens`);

              if (compressed.length < beforeLen || afterTokens < beforeTokens) {
                // Context was compressible (fewer messages or fewer tokens) — replace and retry
                conversationMessages.length = 0;
                conversationMessages.push(...compressed);
                continue; // Retry with compressed context (same attempt slot)
              }
              // Standard compression didn't help — try aggressive fallback (60% budget, keepRecent=2)
              const forcedBudget = Math.max(8000, Math.floor(this.getContextBudget(task.modelAlias) * 0.6));
              const aggressivelyCompressed = sanitizeToolPairs(
                compressContextBudgeted(conversationMessages, forcedBudget, 2)
              );
              const aggressiveTokens = this.estimateTokens(aggressivelyCompressed);
              if (aggressiveTokens < beforeTokens) {
                console.log(`[TaskProcessor] Aggressive compression fallback: ~${beforeTokens}→${aggressiveTokens} tokens`);
                conversationMessages.length = 0;
                conversationMessages.push(...aggressivelyCompressed);
                continue;
              }
              // Already minimal — nothing more to compress, fail fast
              console.log('[TaskProcessor] Context already minimal, cannot compress further — failing');
              break;
            }

            if (attempt < MAX_API_RETRIES) {
              console.log(`[TaskProcessor] Retrying in 2 seconds...`);
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            // All retries exhausted — don't throw yet, try model rotation below
          } finally {
            // Track API wall time (streaming wait is NOT CPU work)
            iterApiWallMs += Math.max(0, Date.now() - apiCallStart);
          }
        }

        // If API call failed after all retries, try rotating to another free model
        if (!result && lastError) {
          const isRateLimited = /429|503|rate.?limit|overloaded|capacity|busy/i.test(lastError.message);
          const isQuotaExceeded = /\b402\b/.test(lastError.message);
          const isModelGone = /\b404\b/.test(lastError.message);
          const isContentFilter = /inappropriate.?content|data_inspection_failed/i.test(lastError.message);
          const isInputValidation = /\b400\b/.test(lastError.message) && /input.?validation|too.?long|too.?many.?tokens|context.?length/i.test(lastError.message);
          const currentIsFree = getModel(task.modelAlias)?.isFree === true;

          if ((isRateLimited || isQuotaExceeded || isModelGone || isContentFilter || isInputValidation) && currentIsFree && rotationIndex < MAX_FREE_ROTATIONS) {
            // Use capability-aware rotation order (preferred category first, emergency core last)
            const nextAlias = rotationOrder[rotationIndex];
            rotationIndex++;

            const prevAlias = task.modelAlias;
            task.modelAlias = nextAlias;
            task.lastUpdate = Date.now();
            await this.doState.storage.put('task', taskForStorage(task));

            const reason = isInputValidation ? 'context too large (400)' : isContentFilter ? 'content filtered' : isModelGone ? 'unavailable (404)' : 'busy';
            const isEmergency = EMERGENCY_CORE_ALIASES.includes(nextAlias) && rotationIndex > MAX_FREE_ROTATIONS - EMERGENCY_CORE_ALIASES.length;
            console.log(`[TaskProcessor] Rotating from /${prevAlias} to /${nextAlias} — ${reason} (${rotationIndex}/${MAX_FREE_ROTATIONS}${isEmergency ? ', emergency core' : ''}, task: ${taskCategory})`);

            // Notify user about model switch
            if (statusMessageId) {
              try {
                await this.editTelegramMessage(
                  request.telegramToken, request.chatId, statusMessageId,
                  `🔄 /${prevAlias} ${reason}. Switching to /${nextAlias}... (${task.iterations} iter)`
                );
              } catch { /* non-fatal */ }
            }

            continue; // Retry the iteration with the new model
          }

          // Can't rotate — all models exhausted (including emergency core)
          if (isQuotaExceeded) {
            const suggestions = EMERGENCY_CORE_ALIASES.map(a => `/${a}`).join(', ');
            throw new Error(`All free models quota-exhausted (tried ${rotationIndex} rotations). Emergency core: ${suggestions}`);
          }
          if (isModelGone) {
            const suggestions = EMERGENCY_CORE_ALIASES.map(a => `/${a}`).join(', ');
            throw new Error(`All free models unavailable (tried ${rotationIndex} rotations). Emergency core: ${suggestions}`);
          }
          throw lastError;
        }

        if (!result || !result.choices || !result.choices[0]) {
          throw new Error('Invalid API response: no choices returned');
        }

        console.log(`[TaskProcessor] API call completed in ${Date.now() - iterStartTime}ms`);

        // Track token usage and costs
        if (result.usage) {
          // Extract DeepSeek prefix cache metrics (automatic, no code changes needed to enable)
          const cacheInfo = (result.usage.prompt_cache_hit_tokens !== undefined)
            ? {
                cacheHitTokens: result.usage.prompt_cache_hit_tokens,
                cacheMissTokens: result.usage.prompt_cache_miss_tokens ?? result.usage.prompt_tokens,
              }
            : undefined;

          const iterationUsage = recordUsage(
            request.userId,
            task.modelAlias,
            result.usage.prompt_tokens,
            result.usage.completion_tokens,
            cacheInfo
          );
          totalUsage.promptTokens += iterationUsage.promptTokens;
          totalUsage.completionTokens += iterationUsage.completionTokens;
          totalUsage.totalTokens += iterationUsage.totalTokens;
          totalUsage.costUsd += iterationUsage.costUsd;
          totalUsage.cacheHitTokens = (totalUsage.cacheHitTokens ?? 0) + (iterationUsage.cacheHitTokens ?? 0);
          totalUsage.cacheMissTokens = (totalUsage.cacheMissTokens ?? 0) + (iterationUsage.cacheMissTokens ?? 0);
          const cacheLog = cacheInfo ? `, cache: ${cacheInfo.cacheHitTokens} hit/${cacheInfo.cacheMissTokens} miss` : '';
          console.log(`[TaskProcessor] Usage: ${result.usage.prompt_tokens}+${result.usage.completion_tokens} tokens, $${iterationUsage.costUsd.toFixed(4)}${cacheLog}`);

          // Track Anthropic input tokens for rate limit pacing
          if (provider === 'anthropic') {
            anthropicWindowTokens += result.usage.prompt_tokens;
          }
        }

        const choice = result.choices[0];

        // Handle finish_reason: length — tool_calls may be truncated with invalid JSON
        if (choice.finish_reason === 'length' && choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          // Validate each tool_call's arguments — truncated streams produce incomplete JSON
          const validToolCalls = choice.message.tool_calls.filter(tc => {
            try {
              JSON.parse(tc.function.arguments);
              return true;
            } catch {
              console.log(`[TaskProcessor] Dropping truncated tool_call ${tc.function.name}: invalid JSON args`);
              return false;
            }
          });

          if (validToolCalls.length === 0) {
            // All tool_calls truncated — compress and retry with nudge
            const truncatedToolName = choice.message.tool_calls[0]?.function?.name || 'unknown';
            console.log(`[TaskProcessor] All tool_calls truncated (finish_reason: length, tool: ${truncatedToolName}) — compressing and retrying`);
            const compressed = this.compressContext(conversationMessages, task.modelAlias, 4);
            conversationMessages.length = 0;
            conversationMessages.push(...compressed);

            // Orchestra-aware nudge: if github_create_pr was truncated, guide the model
            // to use patch actions and avoid regenerating full file contents.
            // The generic "break into smaller steps" contradicts the orchestra prompt's
            // "ONE github_create_pr call" requirement and confuses the model.
            let truncNudge: string;
            if (truncatedToolName === 'github_create_pr') {
              truncNudge = '[Your github_create_pr call was too large and got cut off. To fit within the output limit:\n'
                + '1. Use "patch" action (not "update") for existing files — only send the changed lines, not the whole file\n'
                + '2. For new files, keep content minimal — only include the necessary code\n'
                + '3. If the PR has many files, prioritize the most important changes\n'
                + 'Try the github_create_pr call again with these optimizations.]';
            } else {
              truncNudge = '[Your last response was cut off. Please try again with a shorter tool call or break it into smaller steps.]';
            }
            conversationMessages.push({
              role: 'user',
              content: truncNudge,
            });
            continue;
          }

          // Replace with only the valid tool_calls
          choice.message.tool_calls = validToolCalls;
        }

        // Handle finish_reason: length for text-only responses (no tool calls).
        // During orchestra work phase, the model may be writing the ORCHESTRA_RESULT
        // block or a long explanation when output is truncated. Without this handler,
        // the truncated text is treated as a complete response and transitions to review
        // with a broken/missing PR URL.
        if (choice.finish_reason === 'length' && (!choice.message.tool_calls || choice.message.tool_calls.length === 0)) {
          const sysMsg = request.messages.find(m => m.role === 'system');
          const sysContent = typeof sysMsg?.content === 'string' ? sysMsg.content : '';
          const isOrch = sysContent.includes('Orchestra RUN') || sysContent.includes('Orchestra INIT') || sysContent.includes('Orchestra REDO');
          if (isOrch && task.phase === 'work') {
            console.log(`[TaskProcessor] Text-only truncation in orchestra work phase — nudging model to continue`);
            conversationMessages.push({
              role: 'assistant',
              content: choice.message.content || '',
            });
            conversationMessages.push({
              role: 'user',
              content: '[Your text response was cut off (output limit reached). Continue EXACTLY where you left off. If you were writing the ORCHESTRA_RESULT block, complete it now. If you haven\'t called github_create_pr yet, call it now using "patch" actions to keep the output small.]',
            });
            continue;
          }
        }

        // Handle stream_split — the stream was gracefully stopped before CF could
        // evict the DO. The parser already filtered incomplete tool calls. If there
        // are valid complete tool calls, process them normally (they'll be executed
        // below). If there are none, nudge the model to continue.
        if (choice.finish_reason === 'stream_split') {
          console.log(`[TaskProcessor] Stream split — ` +
            `content: ${(choice.message.content || '').length} chars, ` +
            `tools: ${choice.message.tool_calls?.length ?? 0}`);

          if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
            consecutiveEmptySplits++;
            console.log(`[TaskProcessor] Empty stream split ${consecutiveEmptySplits}/${MAX_EMPTY_SPLITS_BAIL}`);

            // Bail out if the model can't adapt after repeated splits
            if (consecutiveEmptySplits >= MAX_EMPTY_SPLITS_BAIL) {
              console.log(`[TaskProcessor] Stream split death loop: ${consecutiveEmptySplits} consecutive empty splits — bailing out`);
              task.status = 'failed';
              task.error = `Model generates oversized tool calls that exceed streaming limits (${consecutiveEmptySplits} consecutive truncations). ` +
                `The model keeps trying to write full file content instead of using patch action. Try a different model.`;
              task.result = `Stream split death loop: model cannot generate tool calls small enough to fit within streaming limits.`;
              await this.doState.storage.put('task', taskForStorage(task));
              if (task.telegramToken) {
                await this.sendTelegramMessageWithButtons(
                  task.telegramToken,
                  task.chatId,
                  `❌ Task failed: streaming death loop.\n\n${task.modelAlias} keeps generating tool calls too large for the stream limit (${consecutiveEmptySplits}× truncated).\n\n` +
                  `This usually means the model is trying to write/rewrite a large file instead of using patch action.\n\n💡 Try: /deep, /sonnet, or /flash`,
                  [[{ text: '🔄 Resume', callback_data: 'resume:task' }]]
                );
              }
              return;
            }

            // Add partial text if any
            const partialText = choice.message.content || '';
            if (partialText) {
              conversationMessages.push({
                role: 'assistant',
                content: partialText,
              });
            }

            // Escalating nudge based on split count
            let nudge: string;
            if (consecutiveEmptySplits >= MAX_EMPTY_SPLITS_NUDGE) {
              // Escalated nudge: explicitly tell model about the size constraint
              nudge = `[SYSTEM: STREAMING LIMIT — YOUR TOOL CALL WAS TOO LARGE AND GOT TRUNCATED (attempt ${consecutiveEmptySplits}/${MAX_EMPTY_SPLITS_BAIL}).

Your last tool call exceeded the streaming token limit and was discarded. This will keep happening if you try the same approach.

YOU MUST CHANGE YOUR APPROACH:
- Do NOT write entire file contents. Do NOT use workspace_write_file or github_push_files with full file content for files >100 lines.
- For editing existing files: use github_create_pr or github_push_files with action "patch" and small, targeted {"find":"exact text","replace":"new text"} pairs.
- For creating new files: use workspace_write_file with ONLY the new file (small), then workspace_commit, then patch the original file separately via github_create_pr.
- Break large operations into multiple small tool calls.

If you already created the new file and just need to patch the original, call github_create_pr now with action "patch" for the original file.]`;
            } else {
              // First split: gentle nudge
              const tail = partialText.length > 300
                ? partialText.slice(-300)
                : partialText;
              nudge = tail
                ? `[Your response was cut short by a streaming limit. Your tool call was too large and got discarded. Use SMALLER tool calls — for existing files, use action "patch" with targeted find/replace pairs instead of writing full file content. Your last output ended with:\n\n${tail}\n\nContinue with a smaller operation.]`
                : '[Your response was cut short by a streaming limit. Your tool call was too large and got discarded. Use SMALLER tool calls — for existing files, use action "patch" with targeted find/replace pairs instead of writing full file content. Call a tool now with a smaller payload.]';
            }
            conversationMessages.push({
              role: 'user',
              content: nudge,
            });
            continue;
          }
          // Has complete tool calls — reset split counter and fall through to normal tool execution.
          consecutiveEmptySplits = 0;
        }

        // Phase transition: plan → work after first model response
        if (task.phase === 'plan') {
          task.phase = 'work';
          task.phaseStartIteration = task.iterations;
          phaseStartTime = Date.now(); // Reset phase budget clock

          // 7A.4: Parse structured steps from the plan response and pre-load referenced files
          const planContent = choice.message.content || '';
          const structuredPlan = parseStructuredPlan(planContent);
          if (structuredPlan) {
            task.structuredPlan = structuredPlan;
            console.log(`[TaskProcessor] Structured plan parsed: ${structuredPlan.steps.length} steps\n${formatPlanSummary(structuredPlan)}`);

            // Pre-load all files referenced in the plan (merges into existing prefetch cache)
            const planPrefetch = prefetchPlanFiles(structuredPlan, conversationMessages, request.githubToken);
            for (const [key, promise] of planPrefetch) {
              if (!this.prefetchPromises.has(key)) {
                this.prefetchPromises.set(key, promise);
              }
            }
            if (planPrefetch.size > 0) {
              console.log(`[TaskProcessor] Plan prefetch: ${planPrefetch.size} files queued`);
            }

            // 7B.4: Await prefetch results and inject file contents into context.
            // This eliminates the need for the model to call github_read_file for planned files,
            // reducing iteration count from ~8 to 3-4 on typical multi-file tasks.
            if (this.prefetchPromises.size > 0) {
              const injection = await awaitAndFormatPrefetchedFiles(this.prefetchPromises);
              if (injection.loadedCount > 0) {
                conversationMessages.push({
                  role: 'user',
                  content: injection.contextMessage,
                });
                console.log(`[TaskProcessor] 7B.4 file injection: ${injection.loadedCount} files loaded into context (${injection.skippedCount} skipped): ${injection.loadedFiles.join(', ')}`);
              }
            }
          } else {
            console.log('[TaskProcessor] No structured plan parsed from response (free-form fallback)');

            // 7B.4: Even without a structured plan, inject any files from user-message prefetch (7B.3)
            if (this.prefetchPromises.size > 0) {
              const injection = await awaitAndFormatPrefetchedFiles(this.prefetchPromises);
              if (injection.loadedCount > 0) {
                conversationMessages.push({
                  role: 'user',
                  content: injection.contextMessage,
                });
                console.log(`[TaskProcessor] 7B.4 file injection (free-form): ${injection.loadedCount} files loaded: ${injection.loadedFiles.join(', ')}`);
              }
            }
          }

          await this.doState.storage.put('task', taskForStorage(task));
          console.log(`[TaskProcessor] Phase transition: plan → work (iteration ${task.iterations})`);
        }

        // Check if model wants to call tools
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          // NOTE: stall counter reset moved after tool execution — only reset
          // if at least one tool call had valid arguments (see below)

          // Add assistant message with tool calls (preserve reasoning_content for Moonshot thinking mode)
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: choice.message.content || null,
            tool_calls: choice.message.tool_calls,
          };
          if (choice.message.reasoning_content) {
            assistantMsg.reasoning_content = choice.message.reasoning_content;
          }
          conversationMessages.push(assistantMsg);

          // Phase budget circuit breaker: check before tool execution
          if (task.phase) {
            checkPhaseBudget(task.phase, phaseStartTime, provider);
          }

          const toolNames = choice.message.tool_calls.map(tc => tc.function.name);
          task.toolsUsed.push(...toolNames);

          // Safety: cap sandbox_exec calls per task to prevent infinite build/test loops
          const sandboxCallCount = task.toolsUsed.filter(t => t === 'sandbox_exec').length;
          if (sandboxCallCount > MAX_SANDBOX_CALLS_PER_TASK) {
            // Strip sandbox_exec from this batch — let other tools proceed
            const filtered = choice.message.tool_calls.filter(tc => tc.function.name !== 'sandbox_exec');
            if (filtered.length === 0) {
              // All calls were sandbox — inject a warning as if it were a tool result
              conversationMessages.push({
                role: 'tool',
                tool_call_id: choice.message.tool_calls[0].id,
                content: `⚠️ sandbox_exec limit reached (${MAX_SANDBOX_CALLS_PER_TASK} calls). No more shell commands allowed in this task. Summarize your findings and finish.`,
              });
              // Also add dummy results for remaining tool_calls to keep message pairing valid
              for (let i = 1; i < choice.message.tool_calls.length; i++) {
                conversationMessages.push({
                  role: 'tool',
                  tool_call_id: choice.message.tool_calls[i].id,
                  content: 'Skipped — sandbox limit reached.',
                });
              }
              console.log(`[TaskProcessor] Sandbox call limit (${MAX_SANDBOX_CALLS_PER_TASK}) reached for task ${task.taskId}`);
              continue;
            }
            // Some non-sandbox tools remain — replace tool_calls with filtered set
            // and add a sandbox limit warning for the blocked calls
            const blockedCalls = choice.message.tool_calls.filter(tc => tc.function.name === 'sandbox_exec');
            choice.message.tool_calls = filtered;
            for (const blocked of blockedCalls) {
              conversationMessages.push({
                role: 'tool',
                tool_call_id: blocked.id,
                content: `⚠️ sandbox_exec limit reached (${MAX_SANDBOX_CALLS_PER_TASK} calls). No more shell commands allowed.`,
              });
            }
          }

          // Track unique tool call signatures for cross-resume stall detection.
          // If the model keeps calling get_weather("Prague") across resumes, the
          // alarm handler can detect this as spinning even though tool count increases.
          if (!task.toolSignatures) task.toolSignatures = [];
          for (const tc of choice.message.tool_calls) {
            // Hash arguments to avoid storing large payloads (e.g. patch_file diffs)
            const argsStr = tc.function.arguments || '';
            let hash = 0;
            for (let i = 0; i < argsStr.length; i++) {
              hash = ((hash << 5) - hash + argsStr.charCodeAt(i)) | 0;
            }
            task.toolSignatures.push(`${tc.function.name}:${hash.toString(36)}`);
          }
          // Cap at 100 to avoid unbounded growth in long tasks
          if (task.toolSignatures.length > 100) {
            task.toolSignatures = task.toolSignatures.slice(-100);
          }

          // Determine execution strategy: parallel (safe read-only tools) vs sequential (mutation tools)
          const modelInfo = getModel(task.modelAlias);
          const allToolsSafe = choice.message.tool_calls.every(tc => isToolCallParallelSafe(tc));
          const useParallel = allToolsSafe && modelInfo?.parallelCalls === true && choice.message.tool_calls.length > 1;

          const parallelStart = Date.now();
          let toolResults: Array<{ toolName: string; toolResult: { tool_call_id: string; content: string } }>;

          // 7B.1: Count how many tools have speculative results already available
          const speculativeHits = choice.message.tool_calls.filter(tc => specExec.getResult(tc.id)).length;
          if (speculativeHits > 0) {
            console.log(`[TaskProcessor] 7B.1: ${speculativeHits}/${choice.message.tool_calls.length} tool results from speculative execution`);
          }

          if (useParallel) {
            // 7B.5: Show parallel tool names in progress
            const parallelToolNames = choice.message.tool_calls.map(tc => tc.function.name);
            currentTool = parallelToolNames.length > 1
              ? parallelToolNames.slice(0, 3).join(', ')
              : parallelToolNames[0];
            currentToolContext = `${parallelToolNames.length} tools in parallel`;
            await sendProgressUpdate(true);

            // Parallel path: Promise.allSettled — one failure doesn't cancel others
            const settled = await Promise.allSettled(
              choice.message.tool_calls.map(async (toolCall) => {
                const toolStartTime = Date.now();
                const toolName = toolCall.function.name;

                // 7B.1: Use speculative result if already started during streaming
                const specResult = specExec.getResult(toolCall.id);
                if (specResult) {
                  const toolResult = await specResult;
                  console.log(`[TaskProcessor] Tool ${toolName} from speculative cache in ${Date.now() - toolStartTime}ms, result size: ${toolResult.content.length} chars`);
                  return { toolName, toolResult };
                }

                const toolPromise = this.executeToolWithCache(toolCall, toolContext);
                let toolTimeoutId: ReturnType<typeof setTimeout>;
                const toolTimeoutPromise = new Promise<never>((_, reject) => {
                  toolTimeoutId = setTimeout(() => reject(new Error(`Tool ${toolName} timeout (60s)`)), 60000);
                });
                try {
                  const toolResult = await Promise.race([toolPromise, toolTimeoutPromise]);
                  return { toolName, toolResult };
                } finally {
                  clearTimeout(toolTimeoutId!);
                }
              })
            );

            // Map settled results: fulfilled → value, rejected → error message
            toolResults = settled.map((outcome, idx) => {
              if (outcome.status === 'fulfilled') {
                return outcome.value;
              }
              const toolCall = choice.message.tool_calls![idx];
              const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
              return {
                toolName: toolCall.function.name,
                toolResult: {
                  tool_call_id: toolCall.id,
                  content: `Error: ${errorMsg}`,
                },
              };
            });
            console.log(`[TaskProcessor] ${toolResults.length} tools executed in parallel (allSettled) in ${Date.now() - parallelStart}ms`);
          } else {
            // Sequential path: mutation/unsafe tools or mixed batches
            toolResults = [];
            for (const toolCall of choice.message.tool_calls) {
              const toolStartTime = Date.now();
              const toolName = toolCall.function.name;

              // 7B.5: Track current tool for progress display
              currentTool = toolName;
              currentToolContext = extractToolContext(toolName, toolCall.function.arguments);
              await sendProgressUpdate();

              let toolResult;

              // 7B.1: Use speculative result for safe tools even in sequential path
              const specResult = specExec.getResult(toolCall.id);
              if (specResult) {
                toolResult = await specResult;
                console.log(`[TaskProcessor] Tool ${toolName} from speculative cache in ${Date.now() - toolStartTime}ms, result size: ${toolResult.content.length} chars`);
              } else {
                let seqTimeoutId: ReturnType<typeof setTimeout>;
                try {
                  const toolPromise = this.executeToolWithCache(toolCall, toolContext);
                  const toolTimeoutPromise = new Promise<never>((_, reject) => {
                    seqTimeoutId = setTimeout(() => reject(new Error(`Tool ${toolName} timeout (60s)`)), 60000);
                  });
                  toolResult = await Promise.race([toolPromise, toolTimeoutPromise]);
                } catch (toolError) {
                  toolResult = {
                    tool_call_id: toolCall.id,
                    content: `Error: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
                  };
                } finally {
                  clearTimeout(seqTimeoutId!);
                }
                console.log(`[TaskProcessor] Tool ${toolName} completed in ${Date.now() - toolStartTime}ms, result size: ${toolResult.content.length} chars`);
              }

              toolResults.push({ toolName, toolResult });
            }
            console.log(`[TaskProcessor] ${toolResults.length} tools executed sequentially in ${Date.now() - parallelStart}ms`);
          }

          // 7B.5: Clear tool tracking after execution completes
          currentTool = null;
          currentToolContext = null;

          // Add all tool results to conversation (preserving order, with truncation + validation)
          // Pass batchSize so per-result limit shrinks when many tools ran in parallel —
          // prevents 5 large file reads from creating 130K chars of context.
          const batchSize = toolResults.length;
          for (const { toolName, toolResult } of toolResults) {
            const truncatedContent = this.truncateToolResult(toolResult.content, toolName, task.modelAlias, batchSize);
            conversationMessages.push({
              role: 'tool',
              content: truncatedContent,
              tool_call_id: toolResult.tool_call_id,
            });

            // Detect sandbox stagnation from successful result text
            if (toolName === 'sandbox_exec' && toolResult.content.includes('Process stalled')) {
              task.sandboxStalled = true;
            }

            // P2 guardrails: validate and track tool errors
            const toolCall = choice.message.tool_calls!.find(tc => tc.id === toolResult.tool_call_id);
            const validation = validateToolResult(toolName, toolResult.content);
            if (validation.isError) {
              trackToolError(toolErrorTracker, toolName, validation, task.iterations, toolCall?.function.arguments || '');
              console.log(`[TaskProcessor] Tool error tracked: ${toolName} (${validation.errorType}, ${validation.severity})`);
              // Track last errors for user-facing messages
              if (!task.lastToolErrors) task.lastToolErrors = [];
              const shortError = toolResult.content.slice(0, 120).replace(/\n/g, ' ');
              task.lastToolErrors.push(`${toolName}: ${shortError}`);
              if (task.lastToolErrors.length > 5) task.lastToolErrors = task.lastToolErrors.slice(-5);

              // Track prefetch 404s for run health
              if (validation.errorType === 'not_found' && toolName === 'github_read_file') {
                task.prefetch404Count = (task.prefetch404Count ?? 0) + 1;
              }
              // Track sandbox stalls for run health
              if (toolName === 'sandbox_exec' && validation.errorType === 'timeout') {
                task.sandboxStalled = true;
              }

              // Error threshold guardrail: detect identical errors repeating
              const errorSig = `${toolName}:${toolResult.content.slice(0, 200)}`;
              if (errorSig === lastToolErrorSig) {
                consecutiveIdenticalErrors++;
                if (consecutiveIdenticalErrors >= MAX_IDENTICAL_ERRORS) {
                  console.log(`[TaskProcessor] Error threshold hit: ${toolName} returned same error ${consecutiveIdenticalErrors} times — symmetrical pruning`);

                  // Symmetrical pruning: surgically remove failed tool calls while
                  // maintaining tool_call_id parity required by the API.
                  //
                  // A flat splice would break parallel tool call sequences where one
                  // tool succeeds but another fails — deleting the tool result orphans
                  // the ID in the assistant message (→ 400), and deleting the assistant
                  // message orphans successful tool results (→ 400).
                  //
                  // Instead: collect failed tool_call_ids, then for each message either
                  // remove it (tool result) or mutate it (assistant tool_calls array).
                  const failedToolName = toolName;
                  const failedErrorPrefix = toolResult.content.slice(0, 80);
                  const failedToolCallIds = new Set<string>();

                  // Pass 1: identify tool result messages that match the error pattern
                  for (const msg of conversationMessages) {
                    if (msg.role === 'tool' && msg.tool_call_id &&
                        typeof msg.content === 'string' &&
                        msg.content.startsWith(failedErrorPrefix)) {
                      failedToolCallIds.add(msg.tool_call_id);
                    }
                  }

                  if (failedToolCallIds.size > 0) {
                    // Pass 2: prune — iterate backward for safe in-place mutation
                    let removedToolResults = 0;
                    let mutatedAssistantMsgs = 0;
                    let removedAssistantMsgs = 0;

                    for (let i = conversationMessages.length - 1; i >= 0; i--) {
                      const msg = conversationMessages[i];

                      // Remove matching tool result messages
                      if (msg.role === 'tool' && msg.tool_call_id &&
                          failedToolCallIds.has(msg.tool_call_id)) {
                        conversationMessages.splice(i, 1);
                        removedToolResults++;
                        continue;
                      }

                      // Mutate assistant messages: remove failed tool_call entries
                      if (msg.role === 'assistant' && msg.tool_calls) {
                        const before = msg.tool_calls.length;
                        msg.tool_calls = msg.tool_calls.filter(
                          (tc: ToolCall) => !failedToolCallIds.has(tc.id)
                        );

                        if (msg.tool_calls.length < before) {
                          mutatedAssistantMsgs++;
                          // If tool_calls is now empty AND no text content, remove entire message
                          if (msg.tool_calls.length === 0) {
                            const hasContent = msg.content && (typeof msg.content === 'string'
                              ? msg.content.trim() !== ''
                              : true);
                            if (!hasContent) {
                              conversationMessages.splice(i, 1);
                              removedAssistantMsgs++;
                            } else {
                              // Keep message for its text content, drop empty tool_calls
                              msg.tool_calls = undefined;
                            }
                          }
                        }
                      }
                    }

                    console.log(`[TaskProcessor] Symmetrical prune: removed ${removedToolResults} tool results, mutated ${mutatedAssistantMsgs} assistant msgs (${removedAssistantMsgs} fully removed), pruned ${failedToolCallIds.size} ${failedToolName} call IDs`);
                  }

                  // Append redirect prompt on the clean slate
                  conversationMessages.push({
                    role: 'user',
                    content: `[SYSTEM] Your previous ${consecutiveIdenticalErrors} attempts to call ${failedToolName} all failed with: "${shortError}". Those failed calls have been removed from context. You must use a DIFFERENT approach. Do NOT retry ${failedToolName} with the same arguments. If you need to create files, ensure you pass all required parameters. If you cannot proceed, provide your best answer with information gathered so far.`,
                  });

                  consecutiveIdenticalErrors = 0;
                  lastToolErrorSig = '';
                }
              } else {
                lastToolErrorSig = errorSig;
                consecutiveIdenticalErrors = 1;
              }
            } else {
              // Successful tool call — reset error tracking
              consecutiveIdenticalErrors = 0;
              lastToolErrorSig = '';
            }

            // Track files read/modified for progress display
            if (toolCall) {
              try {
                const args = JSON.parse(toolCall.function.arguments);
                if (toolName === 'github_read_file' && args.path) {
                  if (!task.filesRead) task.filesRead = [];
                  if (!task.filesRead.includes(args.path)) task.filesRead.push(args.path);
                } else if ((toolName === 'workspace_write_file' || toolName === 'workspace_delete_file') && args.path) {
                  if (!task.filesModified) task.filesModified = [];
                  if (!task.filesModified.includes(args.path)) task.filesModified.push(args.path);
                } else if (toolName === 'github_create_pr' && args.changes) {
                  if (!task.filesModified) task.filesModified = [];
                  const changes = typeof args.changes === 'string' ? JSON.parse(args.changes) : args.changes;
                  if (Array.isArray(changes)) {
                    for (const c of changes) {
                      if (c.path && !task.filesModified.includes(c.path)) task.filesModified.push(c.path);
                    }
                  }
                }
              } catch { /* ignore parse errors for tracking */ }
            }
          }

          // F.20: Update runtime risk profile after each tool batch
          if (task.runtimeRisk) {
            const prevLevel = task.runtimeRisk.level;
            // Build tool result summaries for risk assessment
            const riskToolResults = toolResults.map(({ toolName, toolResult }) => {
              const validation = validateToolResult(toolName, toolResult.content);
              return { toolName, isError: validation.isError };
            });
            updateRuntimeRisk(task.runtimeRisk, riskToolResults, task.filesModified || []);

            // Log risk changes at medium+ levels
            if (task.runtimeRisk.level !== 'low') {
              console.log(`[TaskProcessor] Runtime risk: ${formatRuntimeRisk(task.runtimeRisk)}`);
            }

            // ─── Risk-triggered actions (only on level transitions) ──────
            const newLevel = task.runtimeRisk.level;
            if (newLevel !== prevLevel) {
              // HIGH: inject caution message into context to make model more careful
              if (newLevel === 'high' || newLevel === 'critical') {
                const cautionParts: string[] = [
                  '⚠️ RUNTIME RISK ELEVATED:',
                ];
                if (task.runtimeRisk.drift.driftDetected) {
                  cautionParts.push(`Scope drift detected: ${task.runtimeRisk.drift.driftReason}.`);
                }
                if (task.runtimeRisk.files.configFilesTouched.length > 0) {
                  cautionParts.push(`Config files modified: ${task.runtimeRisk.files.configFilesTouched.join(', ')}.`);
                }
                if (task.runtimeRisk.files.scopeExpanded) {
                  cautionParts.push(`Task scope expanded from ${task.runtimeRisk.files.initialModifiedCount} to ${task.runtimeRisk.files.modifiedCount} files.`);
                }
                cautionParts.push(
                  'Proceed carefully: verify each change is necessary. ' +
                  'Do NOT modify config/build files unless the task explicitly requires it. ' +
                  'Prefer minimal, targeted changes.',
                );
                conversationMessages.push({
                  role: 'user',
                  content: cautionParts.join(' '),
                });
                console.log(`[TaskProcessor] Injected caution message at risk level ${newLevel}`);
              }

              // CRITICAL: notify user via Telegram
              if (newLevel === 'critical') {
                try {
                  await this.sendTelegramMessage(
                    request.telegramToken,
                    request.chatId,
                    `⚠️ High runtime risk detected for task ${task.taskId.slice(0, 8)}:\n` +
                    formatRuntimeRisk(task.runtimeRisk) +
                    '\n\nTask continues but review carefully before merging.',
                  );
                } catch { /* non-fatal */ }
              }

              // Emit orchestra event for observability (high + critical)
              if (task.isOrchestraTask) {
                this.emitOrchestraEvent(task, 'runtime_risk_escalation', {
                  fromLevel: prevLevel,
                  toLevel: newLevel,
                  score: task.runtimeRisk.score,
                  configFiles: task.runtimeRisk.files.configFilesTouched,
                  filesModified: task.runtimeRisk.files.modifiedCount,
                  scopeExpanded: task.runtimeRisk.files.scopeExpanded,
                  driftDetected: task.runtimeRisk.drift.driftDetected,
                  driftReason: task.runtimeRisk.drift.driftReason,
                });
              }
            }
          }

          // Invalid JSON args tracking: detect models that can't format tool calls
          const invalidArgResults = toolResults.filter(
            tr => tr.toolResult.content.startsWith('Error: Invalid JSON arguments:')
          );
          if (invalidArgResults.length === toolResults.length && toolResults.length > 0) {
            // ALL tool calls in this iteration had invalid JSON
            consecutiveInvalidArgsIterations++;
            // Don't reset stall counter — invalid args don't count as progress
            console.log(`[TaskProcessor] All ${toolResults.length} tool calls had invalid JSON args (${consecutiveInvalidArgsIterations}/${MAX_INVALID_ARGS_BAIL} before bail)`);

            if (consecutiveInvalidArgsIterations >= MAX_INVALID_ARGS_BAIL) {
              console.log(`[TaskProcessor] Bailing out: ${consecutiveInvalidArgsIterations} consecutive iterations with all-invalid tool call args`);
              task.status = 'failed';
              task.error = `Model cannot format tool call arguments correctly (${consecutiveInvalidArgsIterations} consecutive failures). Try a more capable model like /flash, /sonnet, or /deep.`;
              task.result = `Tool calling failed: the model produced invalid JSON arguments for ${consecutiveInvalidArgsIterations} consecutive iterations. No tools were successfully executed.`;
              await this.doState.storage.put('task', taskForStorage(task));

              if (task.telegramToken) {
                await this.sendTelegramMessageWithButtons(
                  task.telegramToken,
                  task.chatId,
                  `❌ Task failed: model can't format tool calls.\n\n${task.modelAlias} produced invalid JSON arguments ${consecutiveInvalidArgsIterations} times in a row.\n\n💡 Try a more capable model: /flash, /sonnet, or /deep`,
                  [[{ text: '🔄 Resume', callback_data: 'resume:task' }]]
                );
              }
              return;
            }

            if (consecutiveInvalidArgsIterations >= MAX_INVALID_ARGS_NUDGE) {
              conversationMessages.push({
                role: 'user',
                content: `[SYSTEM] Your last ${consecutiveInvalidArgsIterations} tool calls ALL had invalid JSON arguments. You MUST format arguments as valid JSON. Example: {"owner": "PetrAnto", "repo": "wagmi", "path": "ROADMAP.md"}. Use double quotes for keys and values. No trailing commas. No comments.`,
              });
            }
          } else {
            // At least one tool call succeeded — reset both counters
            consecutiveInvalidArgsIterations = 0;
            consecutiveNoToolIterations = 0;
          }

          // Same-tool loop detection: check if model is calling identical tools repeatedly
          for (const tc of choice.message.tool_calls!) {
            const sig = `${tc.function.name}:${tc.function.arguments}`;
            recentToolSignatures.push(sig);
          }
          // Keep only last 20 signatures to avoid unbounded growth
          while (recentToolSignatures.length > 20) {
            recentToolSignatures.shift();
          }
          // Check for repeats: count how many times the most recent signature appears
          const lastSig = recentToolSignatures[recentToolSignatures.length - 1];
          const repeatCount = recentToolSignatures.filter(s => s === lastSig).length;
          if (repeatCount >= MAX_SAME_TOOL_REPEATS) {
            const toolName = choice.message.tool_calls![choice.message.tool_calls!.length - 1].function.name;
            console.log(`[TaskProcessor] Same-tool loop detected: ${toolName} called ${repeatCount} times with identical args`);
            // Inject a nudge to break the loop instead of hard-failing
            conversationMessages.push({
              role: 'user',
              content: `[SYSTEM] You have called ${toolName} ${repeatCount} times with the same arguments and gotten the same result. This approach is not working. Try a DIFFERENT tool or a DIFFERENT approach to accomplish your task. If you cannot proceed, provide your best answer with the information you have.`,
            });
            // Clear signatures so we give the model a fresh chance
            recentToolSignatures.length = 0;
          }

          // Compress context if it's getting too large
          const estimatedTokens = this.estimateTokens(conversationMessages);
          if (task.toolsUsed.length > 0 && task.toolsUsed.length % COMPRESS_AFTER_TOOLS === 0) {
            const beforeCount = conversationMessages.length;
            const compressed = this.compressContext(conversationMessages, task.modelAlias);
            conversationMessages.length = 0;
            conversationMessages.push(...compressed);
            task.lastCompressionToolCount = task.toolsUsed.length;
            console.log(`[TaskProcessor] Compressed context: ${beforeCount} -> ${compressed.length} messages`);
          } else if (estimatedTokens > this.getContextBudget(task.modelAlias)) {
            // Force compression if tokens too high
            const compressed = this.compressContext(conversationMessages, task.modelAlias, 4);
            conversationMessages.length = 0;
            conversationMessages.push(...compressed);
            task.lastCompressionToolCount = task.toolsUsed.length;
            console.log(`[TaskProcessor] Force compressed due to ${estimatedTokens} estimated tokens`);
          }

          // Save checkpoint periodically (not every tool - saves CPU)
          // Trade-off: may lose up to N tool results on crash
          // Always save for the first few tool calls (CHECKPOINT_EARLY_THRESHOLD) so
          // small tasks are checkpointed before the watchdog alarm fires.
          const shouldCheckpoint = task.toolsUsed.length <= CHECKPOINT_EARLY_THRESHOLD
            || task.toolsUsed.length % CHECKPOINT_EVERY_N_TOOLS === 0
            || isPaid; // Paid models: checkpoint every iteration to prevent losing expensive work
          if (this.r2 && shouldCheckpoint) {
            // Pre-checkpoint compression: ensure context is compact before R2 write.
            // Without this, early checkpoints (before COMPRESS_AFTER_TOOLS triggers)
            // store uncompressed context that bloats on each resume restoration.
            const preCheckpointTokens = this.estimateTokens(conversationMessages);
            const budget = this.getContextBudget(task.modelAlias);
            if (preCheckpointTokens > budget * 0.8) {
              const beforeCount = conversationMessages.length;
              const compressed = this.compressContext(conversationMessages, task.modelAlias, 4);
              conversationMessages.length = 0;
              conversationMessages.push(...compressed);
              console.log(`[TaskProcessor] Pre-checkpoint compression: ${beforeCount} -> ${compressed.length} messages (${preCheckpointTokens} tokens > 80% budget)`);
            }
            await this.saveCheckpoint(
              this.r2,
              request.userId,
              request.taskId,
              conversationMessages,
              task.toolsUsed,
              task.iterations,
              request.prompt,
              'latest',
              false,
              task.phase,
              request.modelAlias
            );
          }

          // Check cancellation before persisting — prevents overwriting
          // the 'cancelled' status that /cancel handler may have set during
          // a slow tool execution
          if (this.isCancelled) {
            console.log('[TaskProcessor] Cancelled after tool execution, exiting');
            return;
          }

          // Update lastUpdate and refresh watchdog alarm
          task.lastUpdate = Date.now();
          await this.doState.storage.put('task', taskForStorage(task));
          await this.doState.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);

          const iterDurationMs = Date.now() - iterStartTime;
          const iterActiveMs = Math.max(0, iterDurationMs - iterSleepMs - iterApiWallMs);
          console.log(`[TaskProcessor] Iteration ${task.iterations} COMPLETE - total time: ${iterDurationMs}ms (active: ${iterActiveMs}ms, api: ${iterApiWallMs}ms)`);

          // Accumulate active time for CPU budget tracking (excludes pacing sleeps)
          cumulativeActiveMs += iterActiveMs;

          // Check total tool call limit — prevents excessive API usage on runaway tasks.
          // Hard limit from model tier (free/paid) always enforced.
          const maxTotalTools = (getModel(task.modelAlias)?.isFree === true) ? MAX_TOTAL_TOOLS_FREE : MAX_TOTAL_TOOLS_PAID;
          if (task.toolsUsed.length >= maxTotalTools) {
            console.log(`[TaskProcessor] Total tool call limit reached: ${task.toolsUsed.length} >= ${maxTotalTools}`);
            conversationMessages.push({
              role: 'user',
              content: `[SYSTEM] You have used ${task.toolsUsed.length} tool calls, which is the maximum allowed for this task. You MUST now provide your final answer using the information you have gathered so far. Do NOT call any more tools.`,
            });
          }
          // Soft tier advisory: if expected tool count exceeded, nudge the model to wrap up.
          // This doesn't block tools — it just encourages the model to be more focused.
          const expectedTools = task.executionProfile?.bounds.expectedTools;
          if (expectedTools && task.toolsUsed.length === expectedTools && task.toolsUsed.length < maxTotalTools) {
            const tier = task.executionProfile?.bounds.complexityTier ?? 'unknown';
            console.log(`[TaskProcessor] Tier tool advisory: reached ${expectedTools} expected tools for "${tier}" scope`);
            conversationMessages.push({
              role: 'user',
              content: `[ADVISORY] You have used ${expectedTools} tool calls, which is the expected limit for a "${tier}" scope task. Try to wrap up soon — focus on completing the remaining work efficiently.`,
            });
          }

          // Continue loop for next iteration
          continue;
        }

        // No more tool calls — increment stall counter
        // This catches models that spin without using tools or producing final answers
        consecutiveNoToolIterations++;
        // Stall if: (a) model never called tools, or (b) model stopped calling tools
        // for MAX_STALL_ITERATIONS consecutive iterations (even if it used tools earlier).
        // Higher threshold when tools were previously used — model may be composing a response.
        const stallThreshold = task.toolsUsed.length === 0 ? MAX_STALL_ITERATIONS : MAX_STALL_ITERATIONS * 2;
        if (consecutiveNoToolIterations >= stallThreshold) {
          // Model is generating text endlessly without using tools
          console.log(`[TaskProcessor] Stall detected: ${consecutiveNoToolIterations} consecutive iterations with no tool calls (${task.toolsUsed.length} tools used total)`);
          const content = choice.message.content || '';
          if (content.trim()) {
            // Use whatever content we have as the final response
            task.status = 'completed';
            task.result = content.trim() + '\n\n_(Model did not use tools — response may be incomplete)_';
            await this.doState.storage.put('task', taskForStorage(task));
            await this.doState.storage.deleteAlarm();
            try { await workspace.clear(); } catch { /* best-effort */ }
            try { await this.doState.storage.delete(`originalMessages:${task.taskId}`); } catch { /* best-effort */ }
            if (statusMessageId) {
              await this.deleteTelegramMessage(request.telegramToken, request.chatId, statusMessageId);
            }
            const elapsed = Math.round((Date.now() - task.startTime) / 1000);
            const modelInfo = `🤖 /${task.modelAlias}`;
            await this.sendLongMessage(request.telegramToken, request.chatId,
              `${task.result}\n\n${modelInfo} | ⏱️ ${elapsed}s (${(task.totalIterations ?? 0) + task.iterations} iter)`
            );
            // Save assistant response to conversation history
            if (this.r2 && task.result) {
              try {
                const storage = new UserStorage(this.r2);
                await storage.addMessage(request.userId, 'assistant', task.result);
              } catch (e) {
                console.error('[TaskProcessor] Failed to save assistant message to conversation:', e);
              }
            }
            return;
          }
          // No content at all after N iterations — fail
          task.status = 'failed';
          task.error = `Model stalled: ${consecutiveNoToolIterations} iterations without tool calls or useful output.`;
          await this.doState.storage.put('task', taskForStorage(task));
          await this.doState.storage.deleteAlarm();
          if (statusMessageId) {
            await this.deleteTelegramMessage(request.telegramToken, request.chatId, statusMessageId);
          }
          const noToolProgress = this.buildProgressSummary(task);
          await this.sendTelegramMessageWithButtons(
            request.telegramToken, request.chatId,
            `🛑 Model stalled after ${task.iterations} iterations without using tools.${noToolProgress}\n\n💡 Try a more capable model: ${this.getStallModelRecs()}`,
            [[{ text: '🔄 Resume', callback_data: 'resume:task' }]]
          );
          return;
        }

        // No more tool calls - check if we have actual content
        const hasContent = choice.message.content && choice.message.content.trim() !== '';

        // Orchestra zero-tool nudge: if the model returned text (e.g. a "plan") without
        // ever calling any tools, push it back to actually execute. This catches models
        // like Qwen3 Coder that output JSON plans instead of calling tools.
        // Allow up to 2 nudges before giving up (stall detection handles the rest).
        if (hasContent && task.toolsUsed.length === 0 && consecutiveNoToolIterations <= 2) {
          const systemMsg0chk = request.messages.find(m => m.role === 'system');
          const sysTextChk = typeof systemMsg0chk?.content === 'string' ? systemMsg0chk.content : '';
          const isOrchestraChk = sysTextChk.includes('Orchestra RUN Mode') || sysTextChk.includes('Orchestra INIT Mode') || sysTextChk.includes('Orchestra REDO Mode') || sysTextChk.includes('Orchestra DO Mode');
          if (isOrchestraChk) {
            console.log(`[TaskProcessor] Orchestra zero-tool nudge (attempt ${consecutiveNoToolIterations}): model returned text without calling any tools — nudging`);
            conversationMessages.push({
              role: 'assistant',
              content: choice.message.content || '',
            });
            conversationMessages.push({
              role: 'user',
              content: '[STOP PLANNING. You MUST call tools, not describe steps. Call github_read_file RIGHT NOW to read the roadmap. Do NOT output any text — only tool calls.]',
            });
            // Save checkpoint before continuing — without this, a DO eviction after
            // a non-tool iteration (e.g. plan output) loses all conversation state
            // because checkpoints were only saved inside the tool execution block.
            if (this.r2) {
              await this.saveCheckpoint(this.r2, request.userId, request.taskId,
                conversationMessages, task.toolsUsed, task.iterations, request.prompt,
                'latest', false, task.phase, request.modelAlias);
            }
            continue;
          }
        }

        if (!hasContent && task.toolsUsed.length > 0) {
          // --- EMPTY RESPONSE RECOVERY ---
          // Model returned empty after tool calls. This usually means the context
          // is too large for the model to process. Recovery strategy:
          // 1. Aggressive compression + nudge retry (2x)
          // 2. Rotate to another free model
          // 3. Construct fallback from tool data

          // a. Try empty retries with aggressive compression
          if (emptyContentRetries < MAX_EMPTY_RETRIES) {
            emptyContentRetries++;
            console.log(`[TaskProcessor] Empty content after ${task.toolsUsed.length} tools — retry ${emptyContentRetries}/${MAX_EMPTY_RETRIES}`);

            // Aggressively compress context before retry — keep only 2 recent messages
            const compressed = this.compressContext(conversationMessages, task.modelAlias, 2);
            conversationMessages.length = 0;
            conversationMessages.push(...compressed);
            console.log(`[TaskProcessor] Aggressive compression before retry: ${conversationMessages.length} messages`);

            conversationMessages.push({
              role: 'user',
              content: '[Your last response was empty. Please provide a concise answer based on the tool results above. Keep it brief and focused.]',
            });
            if (this.r2) {
              await this.saveCheckpoint(this.r2, request.userId, request.taskId,
                conversationMessages, task.toolsUsed, task.iterations, request.prompt,
                'latest', false, task.phase, request.modelAlias);
            }
            continue;
          }

          // b. Try model rotation for free models (empty response = model can't handle context)
          const emptyCurrentIsFree = getModel(task.modelAlias)?.isFree === true;
          if (emptyCurrentIsFree && rotationIndex < MAX_FREE_ROTATIONS) {
            const nextAlias = rotationOrder[rotationIndex];
            rotationIndex++;

            const prevAlias = task.modelAlias;
            task.modelAlias = nextAlias;
            task.lastUpdate = Date.now();
            emptyContentRetries = 0; // Reset retries for new model
            await this.doState.storage.put('task', taskForStorage(task));

            console.log(`[TaskProcessor] Empty response rotation: /${prevAlias} → /${nextAlias} (${rotationIndex}/${MAX_FREE_ROTATIONS}, task: ${taskCategory})`);

            if (statusMessageId) {
              try {
                await this.editTelegramMessage(
                  request.telegramToken, request.chatId, statusMessageId,
                  `🔄 /${prevAlias} couldn't summarize results. Trying /${nextAlias}...`
                );
              } catch { /* non-fatal */ }
            }

            // Compress for the new model
            const compressed = this.compressContext(conversationMessages, task.modelAlias, 2);
            conversationMessages.length = 0;
            conversationMessages.push(...compressed);

            conversationMessages.push({
              role: 'user',
              content: '[Please provide a concise answer based on the tool results summarized above.]',
            });
            continue;
          }

          // c. All retries and rotations exhausted — will use fallback below
          console.log(`[TaskProcessor] All empty response recovery exhausted — constructing fallback`);
        }

        // Phase transition: work → review when tools were used and model produced content
        // Skip review if content is empty — nothing to review, adding more prompts won't help
        //
        // Guard: For multi-step tasks (especially orchestra), don't transition to review
        // too early if the model's content indicates incomplete/failed work. Push it back
        // to continue working instead.
        const workIterations = task.iterations - (task.phaseStartIteration || 0);
        const contentText = choice.message.content || '';
        const systemMsg0 = request.messages.find(m => m.role === 'system');
        const sysText = typeof systemMsg0?.content === 'string' ? systemMsg0.content : '';
        const isOrchestraRun = sysText.includes('Orchestra RUN Mode') || sysText.includes('Orchestra INIT Mode') || sysText.includes('Orchestra REDO Mode') || sysText.includes('Orchestra DO Mode');
        const looksIncomplete = /\b(unable to|could not|couldn't|not found|no .*(roadmap|file|task)|I (need|should) to .*(check|try|search|look|examine)|let me (try|check|search)|calling tools|please confirm|would you like|shall I|do you want me to|if you'?d like|awaiting.*confirm|let me know if|ready to (start|proceed|begin))\b/i.test(contentText);
        // For orchestra tasks, also check if the required ORCHESTRA_RESULT: block is missing.
        // Only applies when the model hasn't yet called github_create_pr — once the PR
        // tool has been called, the model should be composing the result block, not
        // getting pushed back to work. Previous `toolsUsed.length < 8` heuristic broke
        // on resume because re-reads inflated the count past 8 without a PR being created.
        const orchestraResultMissing = isOrchestraRun
          && !contentText.includes('ORCHESTRA_RESULT:')
          && !task.toolsUsed.includes('github_create_pr');

        // For orchestra tasks, require at least 3 work-phase iterations or non-failure content
        // before transitioning to review. This prevents premature review when the model
        // only tried one file path out of many.
        if (hasContent && task.phase === 'work' && task.toolsUsed.length > 0
            && isOrchestraRun && workIterations < 3 && (looksIncomplete || orchestraResultMissing)) {
          // Check what specific progress is missing to give a targeted nudge
          const hasCalledCreatePr = task.toolsUsed.includes('github_create_pr');
          const hasReadFiles = task.toolsUsed.some(t => t === 'github_read_file');
          let nudge: string;
          if (!hasReadFiles) {
            nudge = '[CONTINUE] You need to READ the files first. Use github_read_file to read the source files you need to modify, then use github_create_pr to implement the changes. Do NOT just output a plan — call the tools NOW.';
          } else if (!hasCalledCreatePr) {
            nudge = '[CONTINUE] You have read the files — now IMPLEMENT the changes. Call github_create_pr with your file changes (use "create" for new files, "patch" for edits). Include ROADMAP.md and WORK_LOG.md updates in the SAME PR. Do NOT describe what you will do — call the tool NOW.';
          } else {
            nudge = '[CONTINUE] Your work is NOT complete — you MUST produce an ORCHESTRA_RESULT: block with the real PR URL that was returned by github_create_pr. Format:\nORCHESTRA_RESULT:\nbranch: {branch}\npr: {url}\nfiles: {files}\nsummary: {summary}';
          }
          console.log(`[TaskProcessor] Deferring work→review: orchestra task with only ${workIterations} work iterations (readFiles=${hasReadFiles}, createdPr=${hasCalledCreatePr}) — nudging model`);
          conversationMessages.push({
            role: 'assistant',
            content: contentText,
          });
          conversationMessages.push({
            role: 'user',
            content: nudge,
          });
          await this.doState.storage.put('task', taskForStorage(task));
          continue;
        }

        if (hasContent && task.phase === 'work' && task.toolsUsed.length > 0) {
          // 7A.1: CoVe verification — check tool results for unacknowledged failures
          // before transitioning to review. One retry allowed if failures detected.
          if (!task.coveRetried && shouldVerify(task.toolsUsed, taskCategory)) {
            const verification = verifyWorkPhase(conversationMessages, choice.message.content || '');
            if (!verification.passed) {
              task.coveRetried = true;
              await this.doState.storage.put('task', taskForStorage(task));
              console.log(`[TaskProcessor] CoVe verification FAILED: ${verification.failures.length} issue(s) — retrying work phase`);
              for (const f of verification.failures) {
                console.log(`[TaskProcessor]   [${f.type}] ${f.tool}: ${f.message.substring(0, 100)}`);
              }
              // Inject the model's response + verification failures for retry
              conversationMessages.push({
                role: 'assistant',
                content: choice.message.content || '',
              });
              conversationMessages.push({
                role: 'user',
                content: formatVerificationFailures(verification.failures),
              });
              continue; // One more work iteration to fix issues
            } else {
              console.log('[TaskProcessor] CoVe verification PASSED');
            }
          }

          // 7A.2: Post-execution extraction verification for orchestra tasks.
          // Reads actual files from the branch to ground the model's summary in reality.
          // BLOCKING: if verification fails, model gets one retry to fix the issues
          // before transitioning to review.
          // Detection uses persisted extractionMeta (survives resume truncation) with
          // message-based detection as the primary source on first encounter.
          if (isOrchestraRun && (isExtractionTask(task.toolsUsed, conversationMessages) || task.extractionMeta) && request.githubToken) {
            // Prefer message-based detection (freshest), fall back to persisted metadata
            const extraction = detectExtractionDetails(conversationMessages) || (task.extractionMeta ? {
              sourceFile: task.extractionMeta.sourceFile,
              newFiles: task.extractionMeta.newFiles,
              extractedNames: task.extractionMeta.extractedNames,
              sourceInitialLineCount: task.extractionMeta.sourceInitialLineCount,
              newFileLineCount: task.extractionMeta.newFileLineCount,
            } as ExtractionCheck : null);
            if (extraction) {
              // Resolve repo/branch: try persisted metadata first, fall back to message scan
              let repoOwner: string | null = task.extractionMeta?.repoOwner ?? null;
              let extractedRepo: string | null = task.extractionMeta?.repoName ?? null;
              let extractedBranch: string | null = task.extractionMeta?.branch ?? null;
              if (!repoOwner || !extractedRepo || !extractedBranch) {
                const fromMessages = extractRepoAndBranch(conversationMessages);
                repoOwner = fromMessages.repoOwner;
                extractedRepo = fromMessages.repoName;
                extractedBranch = fromMessages.branch;
              }

              // Persist extraction metadata on first detection so it survives resume truncation
              if (!task.extractionMeta && repoOwner && extractedRepo && extractedBranch) {
                task.extractionMeta = {
                  repoOwner,
                  repoName: extractedRepo,
                  branch: extractedBranch,
                  sourceFile: extraction.sourceFile,
                  newFiles: extraction.newFiles,
                  extractedNames: extraction.extractedNames,
                  sourceInitialLineCount: extraction.sourceInitialLineCount,
                  newFileLineCount: extraction.newFileLineCount,
                };
                await this.doState.storage.put('task', taskForStorage(task));
              }

              if (repoOwner && extractedRepo && extractedBranch) {
                try {
                  const token = request.githubToken;
                  const readFile = async (path: string): Promise<string | null> => {
                    try {
                      return await githubReadFile(repoOwner, extractedRepo, path, extractedBranch, token);
                    } catch {
                      return null;
                    }
                  };
                  const listFiles = async (dir: string): Promise<string[]> => {
                    try {
                      const url = `https://api.github.com/repos/${repoOwner}/${extractedRepo}/contents/${encodeGitHubPath(dir)}?ref=${encodeURIComponent(extractedBranch)}`;
                      const resp = await fetch(url, {
                        headers: {
                          'User-Agent': 'MoltworkerBot/1.0',
                          'Authorization': `Bearer ${token}`,
                          'Accept': 'application/vnd.github.v3+json',
                        },
                      });
                      if (!resp.ok) return [];
                      const items = await resp.json() as Array<{ path: string; type: string }>;
                      return Array.isArray(items) ? items.filter(i => i.type === 'file').map(i => i.path) : [];
                    } catch {
                      return [];
                    }
                  };
                  const extractionResult = await verifyExtraction(extraction, readFile);

                  // Also run cross-file reference scan (lightweight — reads up to 5 sibling files)
                  const crossFileWarnings = await scanCrossFileReferences(extraction, readFile, listFiles);
                  if (crossFileWarnings.length > 0) {
                    for (const w of crossFileWarnings) extractionResult.issues.push(w);
                    extractionResult.passed = false;
                    extractionResult.summary += '\n' + crossFileWarnings.join('\n');
                  }

                  console.log(`[TaskProcessor] Extraction verification: ${extractionResult.passed ? 'PASSED' : 'ISSUES'} ` +
                    `(${extractionResult.issues.length} issue(s)) for ${extraction.sourceFile}`);

                  if (!extractionResult.passed && !task.extractionRetried) {
                    // BLOCKING: inject failures and let the model retry
                    task.extractionRetried = true;

                    // Escalate to a reasoning model if the current model lacks spatial reasoning
                    // capability. This prevents burning tokens retrying with an inadequate model.
                    const currentModel = getModel(task.modelAlias);
                    const hasReasoning = currentModel?.reasoning === 'configurable' || currentModel?.reasoning === 'fixed';
                    if (!hasReasoning) {
                      const escalationTargets = ['sonnet', 'o4mini', 'deepseek'];
                      for (const target of escalationTargets) {
                        const candidate = getModel(target);
                        if (candidate && candidate.supportsTools && (candidate.reasoning === 'configurable' || candidate.reasoning === 'fixed')) {
                          const prevAlias = task.modelAlias;
                          task.modelAlias = target;
                          console.log(`[TaskProcessor] Extraction escalation: /${prevAlias} → /${target} (reasoning model for spatial fix)`);
                          break;
                        }
                      }
                    }

                    await this.doState.storage.put('task', taskForStorage(task));
                    console.log('[TaskProcessor] Extraction verification FAILED — retrying work phase');
                    for (const issue of extractionResult.issues) {
                      console.log(`[TaskProcessor]   ${issue.substring(0, 120)}`);
                    }
                    conversationMessages.push({
                      role: 'assistant',
                      content: choice.message.content || '',
                    });
                    // Determine if issues are purely stale-reference (import fix only)
                    const hasStaleRefs = extractionResult.issues.some(i => i.includes('STALE REFERENCES'));
                    const staleRefOnly = extractionResult.issues.every(i =>
                      i.includes('STALE REFERENCES') || i.includes('import'));

                    conversationMessages.push({
                      role: 'user',
                      content: `[EXTRACTION VERIFICATION FAILED — FIX REQUIRED]\n` +
                        `The deterministic post-edit file check found these issues on branch "${extractedBranch}":\n\n` +
                        extractionResult.issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n') + '\n\n' +
                        (hasStaleRefs && staleRefOnly
                          ? `This is a SIMPLE import fix. Do NOT re-extract, re-create, or re-write files. ` +
                            `The ONLY fix needed is updating the import statement(s) in the consumer file(s) listed above. ` +
                            `Use github_push_files with a single "patch" action to fix the import line. ` +
                            `The exact import line and fix are provided above — apply the patch and report ORCHESTRA_RESULT.\n\n`
                          : '') +
                        `You MUST fix these issues before reporting ORCHESTRA_RESULT. ` +
                        `Push a corrective commit to the same branch using github_push_files with patch action, ` +
                        `then report your result. The source file on the branch was READ just now — ` +
                        `trust this verification over your cached memory of the file.`,
                    });
                    continue; // One more work iteration to fix issues
                  }

                  // Inject verification context (even if passed) so the model's summary is grounded
                  const contextMsg = formatVerificationForContext(extractionResult);
                  conversationMessages.push({
                    role: 'assistant',
                    content: choice.message.content || '',
                  });
                  conversationMessages.push({
                    role: 'user',
                    content: contextMsg,
                  });
                } catch (verifyErr) {
                  console.log(`[TaskProcessor] Extraction verification error (non-fatal): ${verifyErr}`);
                }
              }
            }
          }

          // POST-COMPLETION DELIVERABLE VALIDATION for orchestra tasks.
          // Multi-turn escalating validator: Turn 0 = standard reminder, Turn 1 = strict
          // enforcement with UPPERCASE emphasis, Turn 2+ = abort as FAILED_DELIVERABLE.
          // Validation prompts bypass compressContextBudgeted by being injected at the
          // bottom of the message array (compression preserves recent messages).
          if (isOrchestraRun) {
            const retryCount = task.validationRetryCount ?? 0;
            const hasPrCall = task.toolsUsed.includes('github_create_pr');
            const toolOutputs = conversationMessages
              .filter(m => m.role === 'tool')
              .map(m => typeof m.content === 'string' ? m.content : '');
            const prSucceeded = toolOutputs.some(o => o.includes('Pull Request created successfully'));
            const roadmapUpdated = toolOutputs.some(o =>
              o.includes('ROADMAP.md') || (o.includes('Pull Request created') && o.includes('ROADMAP'))
            );
            const workLogUpdated = toolOutputs.some(o =>
              o.includes('WORK_LOG.md') || (o.includes('Pull Request created') && o.includes('WORK_LOG'))
            );

            // For extraction tasks, also check that source file shrank
            const isExtraction = isExtractionTask(task.toolsUsed, conversationMessages);
            const sourceShrank = !isExtraction || toolOutputs.some(o =>
              /source.*shrank|line count.*drop|deleted.*from.*source|EXTRACTION.*PASS/i.test(o)
            );

            // Surrogate testing check: if test files were created alongside a new
            // utility module, verify the production file was updated to import it.
            // Pattern: model creates foo.js + foo.test.js but never patches App.jsx
            // to import from foo.js — tests verify a copy, not the running code.
            const allToolContent = conversationMessages
              .map(m => typeof m.content === 'string' ? m.content : '')
              .join('\n');
            const createdTestFiles = /\.(test|spec)\.(js|ts|jsx|tsx)/.test(allToolContent);
            const createdUtilModule = toolOutputs.some(o =>
              /action.*create.*\.(js|ts)/.test(o) && !/\.(test|spec|config)\.(js|ts)/.test(o)
            );
            const productionFilePatched = toolOutputs.some(o =>
              /action.*patch/.test(o) && /import.*from/.test(o)
            );
            const isSurrogateTesting = createdTestFiles && createdUtilModule && !productionFilePatched && !isExtraction;

            const missing: string[] = [];
            if (!hasPrCall) missing.push('github_create_pr was never called — no PR exists');
            else if (!prSucceeded) missing.push('github_create_pr was called but FAILED — check the error and retry');
            if (!roadmapUpdated) missing.push('ROADMAP.md was not updated (task must be marked as [x] done)');
            if (!workLogUpdated) missing.push('WORK_LOG.md was not updated (append a new row with your changes)');
            if (isExtraction && !sourceShrank) missing.push('Source file did NOT shrink — you created the new file but FORGOT to DELETE the extracted code from the original. Use patch action to DELETE now.');
            if (isSurrogateTesting) missing.push('SURROGATE TESTING: You created a new utility module and tests for it, but the PRODUCTION code (e.g. App.jsx) still has the SAME logic inline. You MUST patch the production file to import from your new module and DELETE the inline duplicates. Tests that verify a detached copy while the app runs different code are worthless.');

            if (missing.length > 0) {
              // Turn 2+: Abort — model is incapable of completing deliverables
              if (retryCount >= 2) {
                console.log(`[TaskProcessor] Deliverable validation ABORT after ${retryCount} retries — marking FAILED_DELIVERABLE`);
                task.status = 'failed';
                task.error = `FAILED_DELIVERABLE: ${missing.length} deliverable(s) still missing after ${retryCount} retries: ${missing.join('; ')}`;
                await this.doState.storage.put('task', taskForStorage(task));
                this.emitOrchestraEvent(task, 'validation_fail', { retries: retryCount, missing });
                // Skip review phase — go straight to task completion as failed
                break;
              }

              task.validationRetryCount = retryCount + 1;
              await this.doState.storage.put('task', taskForStorage(task));
              this.emitOrchestraEvent(task, 'deliverable_retry', { attempt: retryCount + 1, missing });
              console.log(`[TaskProcessor] Deliverable validation FAILED (attempt ${retryCount + 1}/2): ${missing.length} missing`);
              for (const m of missing) console.log(`[TaskProcessor]   - ${m}`);

              conversationMessages.push({
                role: 'assistant',
                content: choice.message.content || '',
              });

              // Escalating prompt: Turn 0 = reminder, Turn 1 = strict/uppercase
              const prompt = retryCount === 0
                ? `[DELIVERABLE VALIDATION FAILED — COMPLETE THESE NOW]\n` +
                  `Your work is NOT done. The following required deliverables are missing:\n\n` +
                  missing.map((m, i) => `${i + 1}. ${m}`).join('\n') + '\n\n' +
                  `Fix ALL of these NOW. Include ROADMAP.md and WORK_LOG.md updates in the PR. ` +
                  `After the PR is created successfully, output the ORCHESTRA_RESULT block with the real PR URL.`
                : `[CRITICAL — FINAL ATTEMPT — TASK WILL BE MARKED FAILED IF YOU DO NOT COMPLY]\n` +
                  `YOU HAVE FAILED TO COMPLETE REQUIRED DELIVERABLES. THIS IS YOUR LAST CHANCE.\n\n` +
                  missing.map((m, i) => `${i + 1}. **${m.toUpperCase()}**`).join('\n') + '\n\n' +
                  `CALL THE TOOLS NOW. Do NOT explain, do NOT plan, do NOT describe — EXECUTE.\n` +
                  `If github_create_pr failed before, use a DIFFERENT branch name.\n` +
                  `If ROADMAP.md/WORK_LOG.md are missing from the PR, add them as patch actions.`;

              conversationMessages.push({
                role: 'user',
                content: prompt,
              });
              continue; // Retry work iteration
            }
          }

          // Save the work-phase answer before review
          task.workPhaseContent = choice.message.content || '';

          // 5.1: Multi-agent review — route to a different model for independent verification.
          // Only for complex tasks where a second opinion adds value.
          const reviewerAlias = shouldUseMultiAgentReview(task.toolsUsed, taskCategory, task.iterations)
            ? selectReviewerModel(task.modelAlias, taskCategory)
            : null;

          if (reviewerAlias) {
            console.log(`[TaskProcessor] 5.1 Multi-agent review: ${task.modelAlias} → ${reviewerAlias}`);
            task.phase = 'review';
            task.phaseStartIteration = task.iterations;
            task.reviewerAlias = reviewerAlias;
            phaseStartTime = Date.now();
            await this.doState.storage.put('task', taskForStorage(task));

            // Send progress update showing reviewer model
            currentTool = null;
            currentToolContext = null;
            await sendProgressUpdate(true);

            // Build focused review context and call reviewer model
            const reviewMessages = buildReviewMessages(conversationMessages, task.workPhaseContent, taskCategory, isOrchestraRun);
            const reviewContent = await this.executeMultiAgentReview(
              reviewerAlias, reviewMessages, request.openrouterKey, task,
            );

            if (reviewContent) {
              const reviewResult = parseReviewResponse(reviewContent, reviewerAlias);
              console.log(`[TaskProcessor] 5.1 Review decision: ${reviewResult.decision} (by ${reviewerAlias})`);

              if (reviewResult.decision === 'approve') {
                // Reviewer approved — use work-phase answer directly, skip self-review loop
                task.result = task.workPhaseContent;
                task.status = 'completed';
              } else {
                // Reviewer revised — use their version
                task.result = reviewResult.content;
                task.status = 'completed';
              }
              // Fall through to task completion below (status = 'completed' exits the while loop)
            } else {
              // Reviewer call failed — fall through to same-model review below
              console.log('[TaskProcessor] 5.1 Review failed — falling back to self-review');
              task.reviewerAlias = undefined;
            }
          }

          // Same-model review fallback (existing behavior) — used when:
          // - Task is too simple for multi-agent review
          // - No reviewer model is available
          // - Reviewer API call failed
          if (task.status !== 'completed') {
            task.phase = 'review';
            task.phaseStartIteration = task.iterations;
            phaseStartTime = Date.now();
            await this.doState.storage.put('task', taskForStorage(task));
            console.log(`[TaskProcessor] Phase transition: work → review (iteration ${task.iterations})`);

            // Select review prompt: orchestra > coding > general
            const systemMsg = request.messages.find(m => m.role === 'system');
            const sysContent = typeof systemMsg?.content === 'string' ? systemMsg.content : '';
            const isOrchestraTask = sysContent.includes('Orchestra INIT Mode') || sysContent.includes('Orchestra RUN Mode') || sysContent.includes('Orchestra REDO Mode') || sysContent.includes('Orchestra DO Mode');
            const reviewPrompt = isOrchestraTask ? ORCHESTRA_REVIEW_PROMPT
              : taskCategory === 'coding' ? CODING_REVIEW_PROMPT
              : REVIEW_PHASE_PROMPT;

            // Add the model's current response and inject review prompt
            conversationMessages.push({
              role: 'assistant',
              content: choice.message.content || '',
            });
            conversationMessages.push({
              role: 'user',
              content: `[REVIEW PHASE] ${reviewPrompt}\n\nIMPORTANT: If everything checks out, respond with exactly "LGTM". If there are issues, provide a REVISED version of your complete answer (not a review checklist). Do NOT output a review checklist — either say "LGTM" or give the corrected answer.`,
            });
            // Checkpoint before review iteration — preserves work-phase output
            if (this.r2) {
              await this.saveCheckpoint(this.r2, request.userId, request.taskId,
                conversationMessages, task.toolsUsed, task.iterations, request.prompt,
                'latest', false, task.phase, request.modelAlias);
            }
            continue; // One more iteration for the review response
          }
        }

        // Final response
        task.status = 'completed';
        if (task.result) {
          // Already set by multi-agent review (5.1) — skip result assignment
        } else if (!hasContent && task.toolsUsed.length > 0) {
          // Construct fallback from tool data instead of "No response generated"
          task.result = this.constructFallbackResponse(conversationMessages, task.toolsUsed);
        } else if (task.phase === 'review' && task.workPhaseContent) {
          // Review phase completed — decide whether to use the work-phase answer or the revised one
          const reviewContent = (choice.message.content || '').trim();
          const isLgtm = /^\s*"?LGTM"?\s*\.?\s*$/i.test(reviewContent) || reviewContent.length < 20;
          if (isLgtm) {
            // Review approved — use the original work-phase answer
            task.result = task.workPhaseContent;
          } else {
            // Review produced a revised answer — use the revision
            let content = reviewContent;
            content = content.replace(/<tool_call>\s*\{[\s\S]*?(?:\}\s*<\/tool_call>|\}[\s\S]*$)/g, '').trim();
            task.result = content || task.workPhaseContent;
          }
        } else {
          // Strip raw tool_call markup that weak models emit as text instead of using function calling
          let content = choice.message.content || 'No response generated.';
          content = content.replace(/<tool_call>\s*\{[\s\S]*?(?:\}\s*<\/tool_call>|\}[\s\S]*$)/g, '').trim();
          task.result = content || 'No response generated.';
        }

        // P2 guardrails: append "No Fake Success" warning if mutation tools failed
        const completionWarning = generateCompletionWarning(toolErrorTracker);
        if (completionWarning && task.result) {
          task.result += completionWarning;
        }

        // Log tool error stats for observability
        if (toolErrorTracker.totalErrors > 0) {
          console.log(`[TaskProcessor] P2 guardrails: ${toolErrorTracker.totalErrors} tool errors (${toolErrorTracker.mutationErrors} mutation) across ${task.iterations} iterations`);
        }

        // Append system confidence label for coding tasks if the model didn't include one.
        // Enhanced with P2 guardrails: mutation tool failures downgrade confidence.
        if (taskCategory === 'coding' && task.result && !task.result.includes('Confidence:')) {
          const hasToolEvidence = task.toolsUsed.length >= 2;
          const hasGitActions = task.toolsUsed.some(t => t.startsWith('github_'));
          const hadErrors = conversationMessages.some(m =>
            m.role === 'tool' && typeof m.content === 'string' && /\b(error|failed|404|403|422|500)\b/i.test(m.content)
          );
          let baseConfidence: 'High' | 'Medium' | 'Low' = hasToolEvidence && !hadErrors ? 'High'
            : hasToolEvidence && hadErrors ? 'Medium'
            : 'Low';
          let reason = !hasToolEvidence ? 'few tool verifications'
            : hadErrors ? 'some tool errors occurred'
            : hasGitActions ? 'tool-verified with GitHub operations' : 'tool-verified';

          // P2: adjust confidence based on structured tool error tracking
          const adjusted = adjustConfidence(baseConfidence, toolErrorTracker);
          if (adjusted.reason) {
            baseConfidence = adjusted.confidence;
            reason = adjusted.reason;
          }

          task.result += `\n\n📊 Confidence: ${baseConfidence} (${reason})`;
        }

        // 5.1: Append reviewer attribution if multi-agent review was used
        if (task.reviewerAlias && task.result) {
          const reviewerModel = getModel(task.reviewerAlias);
          const reviewerName = reviewerModel?.name || task.reviewerAlias;
          task.result += `\n🔍 Reviewed by ${reviewerName}`;
        }

        await this.doState.storage.put('task', taskForStorage(task));

        // Cancel watchdog alarm - task completed successfully
        await this.doState.storage.deleteAlarm();

        // Terminal state — clean up workspace staging to prevent storage leaks
        try { await workspace.clear(); } catch { /* best-effort */ }
        try { await this.doState.storage.delete(`originalMessages:${task.taskId}`); } catch { /* best-effort */ }

        // Save final checkpoint (marked as completed) so user can /saveas it
        if (this.r2) {
          await this.saveCheckpoint(
            this.r2,
            request.userId,
            request.taskId,
            conversationMessages,
            task.toolsUsed,
            task.iterations,
            request.prompt,
            'latest',
            true, // completed flag
            task.phase,
            request.modelAlias
          );
        }

        // Extract and store learning (non-blocking, failure-safe)
        if (this.r2) {
          try {
            const userMsg = request.messages.find(m => m.role === 'user');
            const userMessage = typeof userMsg?.content === 'string' ? userMsg.content : '';
            const learning = extractLearning({
              taskId: task.taskId,
              modelAlias: task.modelAlias,
              toolsUsed: task.toolsUsed,
              iterations: task.iterations,
              durationMs: Date.now() - task.startTime,
              success: true,
              userMessage,
            });
            const resultSummary = (task.result || '').substring(0, 500);
            await storeLearning(this.r2, task.userId, learning);
            await storeLastTaskSummary(this.r2, task.userId, learning, resultSummary);

            // Store session summary for cross-session continuity (Phase 4.4)
            const sessionSummary: SessionSummary = {
              sessionId: task.taskId,
              timestamp: learning.timestamp,
              topic: learning.taskSummary,
              resultSummary,
              category: learning.category,
              toolsUsed: learning.uniqueTools,
              success: true,
              modelAlias: task.modelAlias,
            };
            await storeSessionSummary(this.r2, task.userId, sessionSummary);
            console.log(`[TaskProcessor] Learning + session stored: ${learning.category}, ${learning.uniqueTools.length} unique tools`);

            // Extract memory facts from conversation (F.8 — non-blocking)
            if (userMessage.length >= MIN_EXTRACTION_LENGTH && learning.category !== 'simple_chat') {
              try {
                const existingMemory = await loadUserMemory(this.r2, task.userId);
                const existingFacts = existingMemory?.facts || [];
                // Debounce: skip if last extraction was recent
                const lastExtraction = existingMemory?.updatedAt || 0;
                if (Date.now() - lastExtraction > EXTRACTION_DEBOUNCE_MS) {
                  const extractionPrompt = buildExtractionPrompt(userMessage, resultSummary, existingFacts);
                  // Use flash model via OpenRouter for cheap/fast extraction
                  const extractionResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                      'Authorization': `Bearer ${request.openrouterKey}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      model: 'google/gemini-3-flash-preview',
                      messages: [{ role: 'user', content: extractionPrompt }],
                      max_tokens: 512,
                      temperature: 0.3,
                    }),
                  });
                  if (extractionResp.ok) {
                    const extractionData = await extractionResp.json() as { choices: Array<{ message: { content: string } }> };
                    const extractedText = extractionData.choices?.[0]?.message?.content || '';
                    const facts = parseExtractionResponse(extractedText);
                    let storedCount = 0;
                    for (const { fact, category, confidence } of facts) {
                      const res = await storeMemoryFact(this.r2, task.userId, fact, category, 'extracted', confidence);
                      if (res.stored) storedCount++;
                    }
                    if (storedCount > 0) {
                      console.log(`[TaskProcessor] Memory: stored ${storedCount} new fact(s) for user ${task.userId}`);
                    }
                  }
                }
              } catch (memErr) {
                console.error('[TaskProcessor] Memory extraction failed (non-fatal):', memErr);
              }
            }
          } catch (learnErr) {
            console.error('[TaskProcessor] Failed to store learning:', learnErr);
          }
        }

        // Acontext observability: store task as a session for replay and analysis
        if (request.acontextKey) {
          try {
            const acontext = createAcontextClient(request.acontextKey, request.acontextBaseUrl);
            if (acontext) {
              const elapsed = Math.round((Date.now() - task.startTime) / 1000);
              const session = await acontext.createSession({
                user: request.userId,
                configs: {
                  model: task.modelAlias,
                  prompt: (request.prompt || '').substring(0, 300),
                  toolsUsed: task.toolsUsed.length,
                  uniqueTools: [...new Set(task.toolsUsed)],
                  iterations: task.iterations,
                  durationSec: elapsed,
                  success: true,
                  phase: task.phase || null,
                  source: 'moltworker',
                },
              });
              // Store conversation messages (non-blocking partial failures OK)
              const openaiMessages = toOpenAIMessages(conversationMessages);
              const { stored, errors } = await acontext.storeMessages(session.id, openaiMessages, {
                taskId: task.taskId,
                modelAlias: task.modelAlias,
              });
              console.log(`[TaskProcessor] Acontext session ${session.id}: ${stored} msgs stored, ${errors} errors`);
            }
          } catch (acErr) {
            console.error('[TaskProcessor] Failed to store Acontext session:', acErr);
          }
        }

        // Orchestra result tracking: if the response contains ORCHESTRA_RESULT, update history.
        // Also fallback to extracting PR URLs from tool results when model doesn't produce the block.
        if (this.r2 && task.result) {
          try {
            let rawOrchestraResult = parseOrchestraResult(task.result);

            // Fallback: if no ORCHESTRA_RESULT block but tool results contain a successful PR URL,
            // construct a synthetic result so orchestra history gets updated
            if (!rawOrchestraResult) {
              const toolOutputs = conversationMessages
                .filter(m => m.role === 'tool')
                .map(m => typeof m.content === 'string' ? m.content : '');
              const prSuccessOutput = toolOutputs.find(o => o.includes('Pull Request created successfully'));
              if (prSuccessOutput) {
                const prUrlMatch = prSuccessOutput.match(/PR:\s*(https:\/\/github\.com\/[^\s]+)/);
                const branchMatch = prSuccessOutput.match(/Branch:\s*(\S+)/);
                if (prUrlMatch) {
                  console.log('[TaskProcessor] Fallback orchestra result: extracted PR URL from tool output');
                  rawOrchestraResult = {
                    branch: branchMatch ? branchMatch[1] : '',
                    prUrl: prUrlMatch[1],
                    files: [],
                    summary: '(Auto-extracted from tool output — model did not produce ORCHESTRA_RESULT block)',
                  };
                }
              }
            }

            if (rawOrchestraResult) {
              // Fix 3: Cross-reference tool results — detect phantom PRs where model
              // claims success but github_create_pr actually failed
              const fullTaskOutput = conversationMessages
                .filter(m => m.role === 'tool')
                .map(m => typeof m.content === 'string' ? m.content : '')
                .join('\n');
              const orchestraResult = validateOrchestraResult(rawOrchestraResult, fullTaskOutput);

              // Find the orchestra task entry to update (or create a new completed entry)
              const systemMsg = request.messages.find(m => m.role === 'system');
              const systemContent = typeof systemMsg?.content === 'string' ? systemMsg.content : '';
              const isOrchestra = systemContent.includes('Orchestra INIT Mode') || systemContent.includes('Orchestra RUN Mode') || systemContent.includes('Orchestra REDO Mode') || systemContent.includes('Orchestra DO Mode');
              if (isOrchestra) {
                // Detect init vs run vs redo vs do from system prompt
                const orchestraMode = systemContent.includes('Orchestra INIT Mode') ? 'init' as const
                  : systemContent.includes('Orchestra DO Mode') ? 'do' as const
                  : systemContent.includes('Orchestra REDO Mode') ? 'redo' as const : 'run' as const;
                // Extract repo from system prompt
                const repoMatch = systemContent.match(/Full:\s*([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
                const repo = repoMatch ? repoMatch[1] : 'unknown/unknown';
                const userMsg = request.messages.find(m => m.role === 'user');
                const prompt = typeof userMsg?.content === 'string' ? userMsg.content : '';

                // Mark as failed if no valid PR URL — the model claimed success but didn't create a PR
                const hasValidPr = orchestraResult.prUrl.startsWith('https://');

                // Detect guardrail violations in tool results
                const hasIncompleteRefactor = task.result.includes('INCOMPLETE REFACTOR');
                const hasNetDeletionWarning = task.result.includes('NET DELETION WARNING');
                const hasAuditViolation = task.result.includes('AUDIT TRAIL VIOLATION');
                const hasRoadmapTampering = task.result.includes('ROADMAP TAMPERING');

                // Determine final status and summary
                let taskStatus: 'completed' | 'failed';
                let taskSummary = orchestraResult.summary || '';
                let failureReason = '';

                if (orchestraResult.phantomPr) {
                  taskStatus = 'failed';
                  failureReason = 'Phantom PR — model claimed PR but github_create_pr failed';
                } else if (!hasValidPr) {
                  taskStatus = 'failed';
                  failureReason = 'No PR created';
                } else if (hasIncompleteRefactor) {
                  taskStatus = 'failed';
                  failureReason = 'Incomplete refactor — new modules created but source file not updated (dead code)';
                } else if (hasAuditViolation) {
                  taskStatus = 'failed';
                  failureReason = 'Audit trail violation — attempted to delete work log entries';
                } else if (hasRoadmapTampering) {
                  taskStatus = 'failed';
                  failureReason = 'Roadmap tampering — attempted to silently delete roadmap tasks';
                } else if (hasNetDeletionWarning) {
                  // Net deletion warning doesn't auto-fail but is flagged prominently
                  taskStatus = 'completed';
                  taskSummary = `⚠️ NET DELETION WARNING — review carefully. ${orchestraResult.summary || ''}`.trim();
                } else {
                  taskStatus = 'completed';
                  taskSummary = orchestraResult.summary;
                }

                if (failureReason) {
                  taskSummary = `FAILED: ${failureReason}. ${orchestraResult.summary || ''}`.trim();
                }

                // Fix 1: Post-execution PR verification — if we still have a claimed PR URL,
                // verify it actually exists via GitHub API (catches edge cases Fix 3 might miss)
                let verifiedPrUrl = orchestraResult.prUrl;
                if (taskStatus === 'completed' && orchestraResult.prUrl && request.githubToken) {
                  try {
                    // Extract PR number from URL: https://github.com/owner/repo/pull/123
                    const prMatch = orchestraResult.prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
                    if (prMatch) {
                      const [, prRepo, prNumber] = prMatch;
                      const prCheckResponse = await fetch(
                        `https://api.github.com/repos/${prRepo}/pulls/${prNumber}`,
                        {
                          headers: {
                            'User-Agent': 'MoltworkerBot/1.0',
                            'Authorization': `Bearer ${request.githubToken}`,
                            'Accept': 'application/vnd.github.v3+json',
                          },
                        },
                      );
                      if (!prCheckResponse.ok) {
                        console.log(`[TaskProcessor] PR verification FAILED: ${orchestraResult.prUrl} → ${prCheckResponse.status}`);
                        taskStatus = 'failed';
                        failureReason = `Phantom PR — claimed ${orchestraResult.prUrl} but GitHub returned ${prCheckResponse.status}`;
                        taskSummary = `FAILED: ${failureReason}. ${orchestraResult.summary || ''}`.trim();
                        verifiedPrUrl = '';
                      } else {
                        console.log(`[TaskProcessor] PR verification OK: ${orchestraResult.prUrl}`);
                      }
                    }
                  } catch (verifyErr) {
                    // Non-fatal — if we can't verify, keep the claimed URL
                    console.log(`[TaskProcessor] PR verification error (non-fatal): ${verifyErr}`);
                  }
                }

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
                  durationMs: Date.now() - task.startTime,
                };
                await storeOrchestraTask(this.r2, task.userId, completedTask);
                // Compute run health for event metadata
                const orchResumeCount = task.autoResumeCount ?? 0;
                const orchRunHealth = computeRunHealth({
                  resumeCount: orchResumeCount,
                  toolErrors: toolErrorTracker,
                  sandboxStalled: !!task.sandboxStalled,
                  prefetch404Count: task.prefetch404Count ?? 0,
                  taskSucceeded: taskStatus === 'completed',
                  runtimeRisk: task.runtimeRisk,
                });
                this.emitOrchestraEvent(task, taskStatus === 'completed' ? 'task_complete' : 'task_abort', {
                  repo, mode: orchestraMode, branch: orchestraResult.branch,
                  prUrl: verifiedPrUrl, durationMs: Date.now() - task.startTime,
                  runHealth: orchRunHealth.level,
                  runHealthIssues: orchRunHealth.issues.length,
                  resumes: orchResumeCount,
                  ...(taskStatus !== 'completed' && failureReason ? { reason: failureReason } : {}),
                });
                const statusLabel = taskStatus === 'completed'
                  ? (hasNetDeletionWarning ? 'completed (⚠️ net deletion)' : 'completed')
                  : `FAILED (${failureReason})`;
                console.log(`[TaskProcessor] Orchestra task ${statusLabel}: ${orchestraResult.branch} → ${orchestraResult.prUrl || 'none'}`);
              }
            }
          } catch (orchErr) {
            console.error('[TaskProcessor] Failed to store orchestra result:', orchErr);
          }
        }

        // Delete status message
        if (statusMessageId) {
          await this.deleteTelegramMessage(request.telegramToken, request.chatId, statusMessageId);
        }

        // ─── Draft init mode: store draft + send preview with buttons ────────
        if (task.isDraftInit && task.result && this.r2) {
          const draftBlocks = parseDraftBlocks(task.result);
          if (draftBlocks) {
            try {
              const storage = new UserStorage(this.r2);

              // Fetch current HEAD SHA for freshness check on approve
              let baseSha: string | undefined;
              if (task.githubToken && task.orchestraRepo) {
                try {
                  const [owner, repoName] = task.orchestraRepo.split('/');
                  const ghHeaders = {
                    Authorization: `Bearer ${task.githubToken}`,
                    Accept: 'application/vnd.github.v3+json',
                    'User-Agent': 'moltworker-orchestra',
                  };
                  const repoResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, { headers: ghHeaders });
                  if (repoResp.ok) {
                    const repoData = await repoResp.json() as { default_branch: string };
                    const refResp = await fetch(
                      `https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/${repoData.default_branch}`,
                      { headers: ghHeaders },
                    );
                    if (refResp.ok) {
                      const refData = await refResp.json() as { object: { sha: string } };
                      baseSha = refData.object.sha;
                    }
                  }
                } catch (shaErr) {
                  console.error('[TaskProcessor] Failed to fetch baseSha for draft:', shaErr);
                }
              }

              await storage.setOrchestraDraft(request.userId, request.chatId, {
                repo: task.orchestraRepo || '',
                chatId: request.chatId,
                modelAlias: task.modelAlias,
                userPrompt: request.prompt || '',
                roadmapContent: draftBlocks.roadmap,
                workLogContent: draftBlocks.workLog,
                revisions: [],
                revisionCount: 0,
                status: 'draft',
                baseSha,
              });

              const elapsed = Math.round((Date.now() - task.startTime) / 1000);
              const preview = formatDraftPreview(draftBlocks.roadmap);
              await this.sendTelegramMessageWithButtons(
                request.telegramToken,
                request.chatId,
                `📋 **Roadmap Draft** (${elapsed}s, /${task.modelAlias})\n\n${preview}`,
                [
                  [
                    { text: '✅ Approve & Create PR', callback_data: 'orchdraft:approve' },
                    { text: '✏️ Revise', callback_data: 'orchdraft:revise' },
                  ],
                  [
                    { text: '📄 Full Preview', callback_data: 'orchdraft:full' },
                    { text: '❌ Cancel', callback_data: 'orchdraft:cancel' },
                  ],
                ]
              );
              console.log(`[TaskProcessor] Draft init: stored roadmap draft (${draftBlocks.roadmap.length} chars) for user ${request.userId}`);
            } catch (draftErr) {
              console.error('[TaskProcessor] Failed to store draft:', draftErr);
              // Fall through to normal response
            }
            // Clean up and return — skip normal final response
            if (this.r2 && task.orchestraRepo) {
              releaseRepoLock(this.r2, task.userId, task.orchestraRepo, task.taskId).catch(() => {});
            }
            return;
          }
          // If draft blocks weren't found, fall through to normal response
          console.log('[TaskProcessor] Draft init: DRAFT_ROADMAP block not found in response, falling back to normal flow');
        }

        // Build final response
        let finalResponse = task.result;
        if (task.toolsUsed.length > 0) {
          const uniqueTools = [...new Set(task.toolsUsed)];
          finalResponse = `[Used ${task.toolsUsed.length} tool(s): ${uniqueTools.join(', ')}]\n\n${finalResponse}`;
        }

        const elapsed = Math.round((Date.now() - task.startTime) / 1000);
        const modelInfo = task.modelAlias !== request.modelAlias
          ? `🤖 /${task.modelAlias} (rotated from /${request.modelAlias})`
          : `🤖 /${task.modelAlias}`;
        const cumulativeIter = (task.totalIterations ?? 0) + task.iterations;
        finalResponse += `\n\n${modelInfo} | ⏱️ ${elapsed}s (${cumulativeIter} iter)`;
        if (totalUsage.totalTokens > 0) {
          finalResponse += ` | ${formatCostFooter(totalUsage, task.modelAlias)}`;
        }

        // Run health footer — distinguishes task success from platform health
        if (isOrchestraRun || task.autoResumeCount || toolErrorTracker.totalErrors > 0) {
          const resumeCount = task.autoResumeCount ?? 0;
          const runHealth = computeRunHealth({
            resumeCount,
            toolErrors: toolErrorTracker,
            sandboxStalled: !!task.sandboxStalled,
            prefetch404Count: task.prefetch404Count ?? 0,
            taskSucceeded: task.status === 'completed',
            runtimeRisk: task.runtimeRisk,
          });
          finalResponse += `\n${formatHealthFooter(runHealth, resumeCount)}`;

          // Log for observability
          console.log(`[TaskProcessor] Run health: ${runHealth.level} (${runHealth.issues.length} issue(s), ${resumeCount} resumes)`);
        }

        // Send final result (split if too long)
        await this.sendLongMessage(request.telegramToken, request.chatId, finalResponse);

        // Save assistant response to conversation history so subsequent messages have context
        if (this.r2 && task.result) {
          try {
            const storage = new UserStorage(this.r2);
            await storage.addMessage(request.userId, 'assistant', task.result);
          } catch (e) {
            console.error('[TaskProcessor] Failed to save assistant message to conversation:', e);
          }
        }

        return;
      }

      // If the task was already marked as failed (e.g., FAILED_DELIVERABLE),
      // respect that status — don't overwrite with 'completed' or offer Resume.
      if (task.status === 'failed') {
        console.log(`[TaskProcessor] Task already failed: ${task.error}`);

        // Terminal state — clean up
        try { await workspace.clear(); } catch { /* best-effort */ }
        try { await this.doState.storage.delete(`originalMessages:${task.taskId}`); } catch { /* best-effort */ }
        await this.doState.storage.deleteAlarm();

        if (statusMessageId) {
          await this.deleteTelegramMessage(request.telegramToken, request.chatId, statusMessageId);
        }

        const failProgress = this.buildProgressSummary(task);
        const failResumeCount = task.autoResumeCount ?? 0;
        const failRunHealth = computeRunHealth({
          resumeCount: failResumeCount,
          toolErrors: toolErrorTracker,
          sandboxStalled: !!task.sandboxStalled,
          prefetch404Count: task.prefetch404Count ?? 0,
          taskSucceeded: false,
          runtimeRisk: task.runtimeRisk,
        });
        await this.sendTelegramMessage(
          request.telegramToken,
          request.chatId,
          `❌ Task failed: ${task.error}${failProgress}\n\n` +
          `${task.toolsUsed.length} tools used across ${(task.totalIterations ?? 0) + task.iterations} iterations.\n` +
          formatHealthFooter(failRunHealth, failResumeCount),
        );
      } else {
        // Hit iteration limit — save checkpoint so resume can continue from here
        if (this.r2) {
          await this.saveCheckpoint(
            this.r2,
            request.userId,
            request.taskId,
            conversationMessages,
            task.toolsUsed,
            task.iterations,
            request.prompt,
            'latest',
            false, // NOT completed — allow resume to pick this up
            task.phase,
            request.modelAlias
          );
        }

        task.status = 'completed';
        task.result = 'Task hit iteration limit (100). Last response may be incomplete.';
        await this.doState.storage.put('task', taskForStorage(task));

        // Terminal state — clean up workspace staging to prevent storage leaks
        try { await workspace.clear(); } catch { /* best-effort */ }
        try { await this.doState.storage.delete(`originalMessages:${task.taskId}`); } catch { /* best-effort */ }

        // Cancel watchdog alarm
        await this.doState.storage.deleteAlarm();

        if (statusMessageId) {
          await this.deleteTelegramMessage(request.telegramToken, request.chatId, statusMessageId);
        }

        const limitProgress = this.buildProgressSummary(task);
        const limitResumeCount = task.autoResumeCount ?? 0;
        const limitRunHealth = computeRunHealth({
          resumeCount: limitResumeCount,
          toolErrors: toolErrorTracker,
          sandboxStalled: !!task.sandboxStalled,
          prefetch404Count: task.prefetch404Count ?? 0,
          taskSucceeded: false,
          runtimeRisk: task.runtimeRisk,
        });
        await this.sendTelegramMessageWithButtons(
          request.telegramToken,
          request.chatId,
          `⚠️ Task reached iteration limit (${maxIterations}). ${task.toolsUsed.length} tools used across ${(task.totalIterations ?? 0) + task.iterations} iterations.${limitProgress}\n${formatHealthFooter(limitRunHealth, limitResumeCount)}\n\n💡 Progress saved. Tap Resume to continue from checkpoint.`,
          [[{ text: '🔄 Resume', callback_data: 'resume:task' }]]
        );
      }

    } catch (error) {
      // Phase budget circuit breaker: save checkpoint and let watchdog auto-resume
      if (error instanceof PhaseBudgetExceededError) {
        console.log(`[TaskProcessor] Phase budget exceeded: ${error.phase} (${error.elapsedMs}ms > ${error.budgetMs}ms)`);
        // Do NOT increment autoResumeCount here — the alarm handler owns that counter.
        // Previously both incremented it, causing double-counting (each cycle burned 2 slots).
        //
        // CRITICAL: Backdate lastUpdate so the next watchdog alarm triggers auto-resume
        // immediately. Without this, lastUpdate = Date.now() means the watchdog needs
        // 3 × 90s intervals (270s!) before timeSinceUpdate exceeds the 240s stuck threshold.
        // Backdating by stuckThreshold ensures the very next alarm (≤90s) fires auto-resume.
        const stuckThreshold = getWatchdogStuckThreshold(task.modelAlias);
        task.lastUpdate = Date.now() - stuckThreshold;
        try {
          await this.doState.storage.put('task', taskForStorage(task));
        } catch (storageErr) {
          console.error('[TaskProcessor] Phase budget: failed to persist state:', storageErr);
        }

        // Save checkpoint so alarm handler can resume from here
        // Sanitize messages to fix orphaned tool_calls from budget interruption
        if (this.r2) {
          await this.saveCheckpoint(
            this.r2,
            request.userId,
            request.taskId,
            sanitizeToolPairs(conversationMessages),
            task.toolsUsed,
            task.iterations,
            request.prompt,
            'latest',
            false,
            task.phase,
            task.modelAlias
          );
        }
        // Schedule a fast alarm for quick auto-resume instead of waiting for
        // the regular 90s watchdog interval. The backdated lastUpdate ensures the
        // alarm handler recognizes this as stuck and proceeds to auto-resume.
        await this.doState.storage.setAlarm(Date.now() + 15_000);
        return;
      }

      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);

      // Terminal state — clean up workspace staging to prevent storage leaks
      try { await workspace.clear(); } catch { /* best-effort */ }
      try { await this.doState.storage.delete(`originalMessages:${task.taskId}`); } catch { /* best-effort */ }

      // Wrap storage writes in try/catch to prevent zombie loops:
      // If the original error was QuotaExceededError, blindly calling storage.put
      // here would throw the same exception, crash the isolate, and the alarm
      // would restart us into the same crash → infinite loop.
      try {
        await this.doState.storage.put('task', taskForStorage(task));
      } catch (storageErr) {
        console.error('[TaskProcessor] Failed to persist error state, writing minimal fallback:', storageErr);
        // Write a minimal task object that fits in any storage budget
        try {
          await this.doState.storage.put('task', {
            taskId: task.taskId,
            userId: task.userId,
            status: 'failed' as const,
            error: (task.error || 'unknown').substring(0, 500),
            startTime: task.startTime,
            lastUpdate: Date.now(),
            isRunning: false,
          });
        } catch {
          console.error('[TaskProcessor] Even minimal state write failed — clearing storage');
          await this.doState.storage.deleteAll().catch(() => {});
        }
      }

      // Cancel watchdog alarm - we're handling the error here
      try {
        await this.doState.storage.deleteAlarm();
      } catch {
        // If alarm deletion fails, it's not fatal — the alarm handler
        // will see status='failed' and skip processing
      }

      // Update orchestra history so failed tasks don't stay at 'started' forever
      await this.updateOrchestraHistoryOnFailure(task, task.error);

      // Store failure learning (only if task made progress)
      if (this.r2 && task.iterations > 0) {
        try {
          const userMsg = request.messages.find(m => m.role === 'user');
          const userMessage = typeof userMsg?.content === 'string' ? userMsg.content : '';
          const learning = extractLearning({
            taskId: task.taskId,
            modelAlias: task.modelAlias,
            toolsUsed: task.toolsUsed,
            iterations: task.iterations,
            durationMs: Date.now() - task.startTime,
            success: false,
            userMessage,
          });
          const failResultSummary = (task.error || task.result || '').substring(0, 500);
          await storeLearning(this.r2, task.userId, learning);

          // Store failed session for cross-session continuity (Phase 4.4)
          const failSessionSummary: SessionSummary = {
            sessionId: task.taskId,
            timestamp: learning.timestamp,
            topic: learning.taskSummary,
            resultSummary: failResultSummary,
            category: learning.category,
            toolsUsed: learning.uniqueTools,
            success: false,
            modelAlias: task.modelAlias,
          };
          await storeSessionSummary(this.r2, task.userId, failSessionSummary);
          console.log(`[TaskProcessor] Failure learning + session stored: ${learning.category}`);
        } catch (learnErr) {
          console.error('[TaskProcessor] Failed to store failure learning:', learnErr);
        }
      }

      // Save checkpoint so we can resume later
      if (this.r2 && task.iterations > 0) {
        await this.saveCheckpoint(
          this.r2,
          request.userId,
          request.taskId,
          conversationMessages,
          task.toolsUsed,
          task.iterations,
          request.prompt,
          'latest',
          false,
          task.phase,
          request.modelAlias
        );
      }

      // Delete status message and send error
      if (statusMessageId) {
        await this.deleteTelegramMessage(request.telegramToken, request.chatId, statusMessageId);
      }

      if (task.iterations > 0) {
        // Send error with resume button and progress summary
        const failProgress = this.buildProgressSummary(task);
        await this.sendTelegramMessageWithButtons(
          request.telegramToken,
          request.chatId,
          `❌ Task failed: ${task.error}${failProgress}\n\n💡 Progress saved (${(task.totalIterations ?? 0) + task.iterations} iterations).`,
          [[{ text: '🔄 Resume', callback_data: 'resume:task' }]]
        );
      } else {
        await this.sendTelegramMessage(
          request.telegramToken,
          request.chatId,
          `❌ Task failed: ${task.error}`
        );
      }
    } finally {
      this.isRunning = false;
      // F.23: Release branch-level concurrency lock for orchestra tasks.
      // Runs on all terminal paths (success, failure, error) to prevent deadlocks.
      if (this.r2 && task.orchestraRepo && task.status !== 'processing') {
        releaseRepoLock(this.r2, task.userId, task.orchestraRepo, task.taskId).catch(err => {
          console.error(`[TaskProcessor] Failed to release repo lock for ${task.orchestraRepo}:`, err);
        });
      }
    }
  }

  /**
   * Get dynamic model recommendations for stall messages.
   */
  private getStallModelRecs(): string {
    try {
      const recs = getOrchestraRecommendations();
      const top = [...recs.paid.slice(0, 2), ...recs.free.slice(0, 1)];
      if (top.length > 0) {
        return top.map(r => `/${r.alias}`).join(', ');
      }
    } catch {
      // Fall through to default
    }
    return '/sonnet, /deep, or /grok';
  }

  /**
   * Build a concise progress summary for Telegram messages.
   * Shows what was accomplished and what errors occurred.
   */
  private buildProgressSummary(task: TaskState): string {
    const parts: string[] = [];

    // Phase info
    if (task.phase) {
      parts.push(`Phase: ${task.phase}`);
    }

    // Tool usage breakdown
    if (task.toolsUsed.length > 0) {
      const toolCounts = new Map<string, number>();
      for (const t of task.toolsUsed) {
        toolCounts.set(t, (toolCounts.get(t) || 0) + 1);
      }
      const toolSummary = [...toolCounts.entries()]
        .map(([name, count]) => count > 1 ? `${name}×${count}` : name)
        .join(', ');
      parts.push(`Tools: ${toolSummary}`);
    }

    // Files read
    if (task.filesRead && task.filesRead.length > 0) {
      const unique = [...new Set(task.filesRead)];
      const display = unique.length <= 5
        ? unique.join(', ')
        : `${unique.slice(0, 4).join(', ')} +${unique.length - 4} more`;
      parts.push(`Files read: ${display}`);
    }

    // Files modified (from github_create_pr)
    if (task.filesModified && task.filesModified.length > 0) {
      parts.push(`Files modified: ${task.filesModified.join(', ')}`);
    }

    // Recent errors
    if (task.lastToolErrors && task.lastToolErrors.length > 0) {
      const recent = task.lastToolErrors.slice(-3);
      parts.push(`Errors: ${recent.join('; ')}`);
    }

    return parts.length > 0 ? '\n\n📋 Progress:\n' + parts.join('\n') : '';
  }

  /**
   * Send a message to Telegram
   */
  private async sendTelegramMessage(
    token: string,
    chatId: number,
    text: string
  ): Promise<number | null> {
    try {
      // Try HTML parse mode first for rendered markdown
      const html = markdownToTelegramHtml(text);
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: html.slice(0, 4000),
          parse_mode: 'HTML',
        }),
      });

      const result = await response.json() as { ok: boolean; result?: { message_id: number } };
      if (result.ok) {
        return result.result?.message_id || null;
      }

      // Fallback: send as plain text if HTML parsing failed
      const fallback = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.slice(0, 4000),
        }),
      });
      const fbResult = await fallback.json() as { ok: boolean; result?: { message_id: number } };
      return fbResult.ok ? fbResult.result?.message_id || null : null;
    } catch {
      return null;
    }
  }

  /**
   * Send a message with inline buttons to Telegram
   */
  private async sendTelegramMessageWithButtons(
    token: string,
    chatId: number,
    text: string,
    buttons: Array<Array<{ text: string; callback_data: string }>>
  ): Promise<number | null> {
    try {
      const html = markdownToTelegramHtml(text);
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: html.slice(0, 4000),
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: buttons,
          },
        }),
      });

      const result = await response.json() as { ok: boolean; result?: { message_id: number } };
      if (result.ok) {
        return result.result?.message_id || null;
      }

      // Fallback: plain text without parse_mode
      const fallback = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.slice(0, 4000),
          reply_markup: {
            inline_keyboard: buttons,
          },
        }),
      });
      const fbResult = await fallback.json() as { ok: boolean; result?: { message_id: number } };
      return fbResult.ok ? fbResult.result?.message_id || null : null;
    } catch {
      return null;
    }
  }

  /**
   * Edit a Telegram message
   */
  private async editTelegramMessage(
    token: string,
    chatId: number,
    messageId: number,
    text: string
  ): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: text.slice(0, 4000),
        }),
      });
    } catch {
      // Ignore edit failures
    }
  }

  /**
   * Delete a Telegram message
   */
  private async deleteTelegramMessage(
    token: string,
    chatId: number,
    messageId: number
  ): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
        }),
      });
    } catch {
      // Ignore delete failures
    }
  }

  /**
   * Send a long message (split into chunks if needed)
   */
  private async sendLongMessage(
    token: string,
    chatId: number,
    text: string
  ): Promise<void> {
    const maxLength = 4000;

    if (text.length <= maxLength) {
      await this.sendTelegramMessage(token, chatId, text);
      return;
    }

    // Split into chunks
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        await this.sendTelegramMessage(token, chatId, remaining);
        break;
      }

      // Find good split point
      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = maxLength;
      }

      await this.sendTelegramMessage(token, chatId, remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trim();

      // Small delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
