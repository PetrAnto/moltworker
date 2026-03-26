/**
 * Telegram Webhook Handler
 * Handles incoming Telegram updates and routes to appropriate handlers
 */

import { OpenRouterClient, createOpenRouterClient, extractTextResponse, type ChatMessage } from '../openrouter/client';
import { UserStorage, createUserStorage, SkillStorage, createSkillStorage } from '../openrouter/storage';
import { modelSupportsTools, generateDailyBriefing, geocodeCity, type SandboxLike, r2ListFiles, r2ReadFile, r2DeleteFile, validateSavedFileName, sanitizeSavedFileName, githubMergePr } from '../openrouter/tools';
import { getUsage, getUsageRange, formatUsageSummary, formatWeekSummary } from '../openrouter/costs';
import { loadLearnings, getRelevantLearnings, formatLearningsForPrompt, formatLearningSummary, loadLastTaskSummary, formatLastTaskForPrompt, loadSessionHistory, getRelevantSessions, formatSessionsForPrompt } from '../openrouter/learnings';
import { getMemoryContext, loadUserMemory, addManualFact, deleteMemoryFact, clearUserMemory, formatMemoryDisplay } from '../openrouter/memory';
import { createAcontextClient, formatSessionsList } from '../acontext/client';
import {
  buildInitPrompt,
  buildRunPrompt,
  buildRedoPrompt,
  buildDoPrompt,
  parseOrchestraCommand,
  parseOrchestraResult,
  generateTaskSlug,
  loadOrchestraHistory,
  loadAllOrchestraHistories,
  getModelCompletionStats,
  storeOrchestraTask,
  cleanupStaleTasks,
  formatOrchestraHistory,
  fetchRoadmapFromGitHub,
  formatRoadmapStatus,
  findMatchingTasks,
  resetRoadmapTasks,
  createRoadmapResetPR,
  parseRoadmapPhases,
  resolveNextRoadmapTask,
  type OrchestraTask,
  type ResolvedTask,
  getRecentOrchestraEvents,
  aggregateOrchestraStats,
  getEventBasedModelScores,
  buildExecutionProfile,
  buildDraftInitPrompt,
  commitDraftRoadmap,
  type OrchestraExecutionProfile,
} from '../orchestra/orchestra';
import type { OrchestraDraft, OrchestraPlanState } from '../openrouter/storage';
import type { TaskProcessor, TaskRequest } from '../durable-objects/task-processor';
import { fetchDOWithRetry } from '../utils/do-retry';
import { acquireRepoLock, forceReleaseRepoLock } from '../concurrency/branch-lock';
import { runSmokeTests, formatTestResults, getTestNames } from './smoke-tests';
import { classifyTaskComplexity } from '../utils/task-classifier';
import { routeByComplexity } from '../openrouter/model-router';
import { parseCommandMessage } from '../skills/command-map';
import { runSkill } from '../skills/runtime';
import { isSkillRegistered } from '../skills/registry';
import { initializeSkills } from '../skills/init';
import { renderForTelegram } from '../skills/renderers/telegram';
import type { SkillRequest } from '../skills/types';
import { markdownToTelegramHtml, escapeHtml } from '../utils/telegram-format';
import {
  MODELS,
  getModel,
  getAllModels,
  getModelId,
  formatModelsList,
  formatModelInfoCard,
  formatModelHub,
  formatModelRanking,
  getTopModelPicks,
  supportsVision,
  isImageGenModel,
  DEFAULT_MODEL,
  parseReasoningOverride,
  parseJsonPrefix,
  supportsStructuredOutput,
  registerDynamicModels,
  getDynamicModelCount,
  getAutoSyncedModelCount,
  blockModels,
  unblockModels,
  getBlockedAliases,
  applyModelOverrides,
  removeModelOverride,
  getAllModelOverrides,
  isCuratedModel,
  resolveToAlias,
  getBaseModel,
  detectToolIntent,
  getFreeToolModels,
  formatOrchestraModelRecs,
  getOrchestraRecommendations,
  getRankedOrchestraModels,
  categorizeModel,
  getValueTier,
  resolveTaskModel,
  isDirectApi,
  getProvider,
  type ModelInfo,
  type ReasoningLevel,
  type RouterCheckpointMeta,
} from '../openrouter/models';
import type { ResponseFormat } from '../openrouter/client';

// Telegram Types
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  photo?: TelegramPhotoSize[];
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// Inline keyboard types
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * Telegram Bot API client
 */
export class TelegramBot {
  private token: string;
  private baseUrl: string;

  constructor(token: string) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  /**
   * Send a message to a chat
   */
  async sendMessage(chatId: number, text: string, options?: {
    parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
    replyToMessageId?: number;
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  }): Promise<TelegramMessage> {
    // Truncate if too long (Telegram limit is 4096)
    if (text.length > 4000) {
      text = text.slice(0, 3997) + '...';
    }

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: options?.parseMode,
        reply_to_message_id: options?.replyToMessageId,
        reply_markup: options?.reply_markup,
      }),
    });

    const result = await response.json() as { ok: boolean; result?: TelegramMessage; description?: string };
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description}`);
    }

    return result.result!;
  }

  /**
   * Send a "typing" action
   */
  async sendChatAction(chatId: number, action: 'typing' | 'upload_photo' = 'typing'): Promise<void> {
    await fetch(`${this.baseUrl}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        action,
      }),
    });
  }

  /**
   * Send a photo from URL
   */
  async sendPhoto(chatId: number, photoUrl: string, caption?: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
      }),
    });

    const result = await response.json() as { ok: boolean; description?: string };
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description}`);
    }
  }

  /**
   * Send a photo from base64 data
   */
  async sendPhotoBase64(chatId: number, base64Data: string, caption?: string): Promise<void> {
    // Extract the actual base64 content (remove data:image/xxx;base64, prefix)
    const base64Match = base64Data.match(/^data:image\/([^;]+);base64,(.+)$/);
    if (!base64Match) {
      throw new Error('Invalid base64 image data');
    }

    const mimeType = base64Match[1];
    const base64Content = base64Match[2];

    // Convert base64 to binary
    const binaryString = atob(base64Content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Create FormData for multipart upload
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('photo', new Blob([bytes], { type: `image/${mimeType}` }), `image.${mimeType}`);
    if (caption) {
      formData.append('caption', caption);
    }

    const response = await fetch(`${this.baseUrl}/sendPhoto`, {
      method: 'POST',
      body: formData,
    });

    const result = await response.json() as { ok: boolean; description?: string };
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description}`);
    }
  }

  /**
   * Get file info
   */
  async getFile(fileId: string): Promise<TelegramFile> {
    const response = await fetch(`${this.baseUrl}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });

    const result = await response.json() as { ok: boolean; result?: TelegramFile; description?: string };
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description}`);
    }

    return result.result!;
  }

  /**
   * Download a file and return as base64
   */
  async downloadFileBase64(filePath: string): Promise<string> {
    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return base64;
  }

  /**
   * Edit a message
   */
  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    // Truncate if too long (Telegram limit is 4096)
    if (text.length > 4000) {
      text = text.slice(0, 3997) + '...';
    }

    await fetch(`${this.baseUrl}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
      }),
    });
  }

  /**
   * Edit a message with inline keyboard buttons
   */
  async editMessageWithButtons(
    chatId: number,
    messageId: number,
    text: string,
    buttons: InlineKeyboardButton[][] | null
  ): Promise<void> {
    if (text.length > 4000) {
      text = text.slice(0, 3997) + '...';
    }

    await fetch(`${this.baseUrl}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
      }),
    });
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await fetch(`${this.baseUrl}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    });
  }

  /**
   * Set webhook URL
   */
  async setWebhook(url: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const result = await response.json() as { ok: boolean; description?: string };
    return result.ok;
  }

  /**
   * Set bot menu commands visible in Telegram UI
   */
  async setMyCommands(commands: { command: string; description: string }[]): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });

    const result = await response.json() as { ok: boolean; description?: string };
    return result.ok;
  }

  /**
   * Send a message with inline keyboard buttons
   */
  async sendMessageWithButtons(
    chatId: number,
    text: string,
    buttons: InlineKeyboardButton[][],
    options?: { parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML' }
  ): Promise<TelegramMessage> {
    // Truncate if too long
    if (text.length > 4000) {
      text = text.slice(0, 3997) + '...';
    }

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: options?.parseMode,
        reply_markup: {
          inline_keyboard: buttons,
        },
      }),
    });

    const result = await response.json() as { ok: boolean; result?: TelegramMessage; description?: string };
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description}`);
    }

    return result.result!;
  }

  /**
   * Answer a callback query (acknowledge button press)
   */
  async answerCallbackQuery(
    callbackQueryId: string,
    options?: { text?: string; showAlert?: boolean }
  ): Promise<void> {
    await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: options?.text,
        show_alert: options?.showAlert,
      }),
    });
  }

  /**
   * Edit message reply markup (update buttons)
   */
  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    buttons: InlineKeyboardButton[][] | null
  ): Promise<void> {
    await fetch(`${this.baseUrl}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
      }),
    });
  }
}

/**
 * Sync session state for interactive /syncmodels picker (persisted in R2)
 */
interface SyncModelCandidate {
  alias: string;
  name: string;
  modelId: string;
  contextK: number;
  vision: boolean;
  tools?: boolean;
  reasoning?: boolean;
  category?: 'coding' | 'reasoning' | 'fast' | 'general';
  description?: string;
}

/** A replacement recommendation: new model is better than existing one in same category */
interface SyncReplacement {
  newAlias: string;
  oldAlias: string;
  reason: string;
}

interface SyncSession {
  newModels: SyncModelCandidate[];
  staleModels: SyncModelCandidate[];
  replacements: SyncReplacement[];
  selectedAdd: string[];
  selectedRemove: string[];
  selectedReplace: string[]; // newAlias values — each replace = add new + block old
  chatId: number;
  messageId: number;
}

/**
 * Main handler for Telegram updates
 */
export class TelegramHandler {
  private bot: TelegramBot;
  private openrouter: OpenRouterClient;
  private storage: UserStorage;
  private skills: SkillStorage;
  private r2Bucket: R2Bucket;
  private defaultSkill: string;
  private cachedSkillPrompt: string | null = null;
  private allowedUsers: Set<string> | null = null; // null = allow all, Set = allowlist
  private githubToken?: string; // GitHub token for tool calls
  private telegramToken: string; // Store for DO
  private openrouterKey: string; // Store for DO
  private braveSearchKey?: string; // Brave Search API key for web_search tool
  private taskProcessor?: DurableObjectNamespace<TaskProcessor>; // For long-running tasks
  private browser?: Fetcher; // Browser binding for browse_url tool
  private sandbox?: SandboxLike; // Sandbox container for sandbox_exec tool
  // Direct API keys
  private dashscopeKey?: string;
  private moonshotKey?: string;
  private deepseekKey?: string;
  private anthropicKey?: string;
  // Acontext observability
  private acontextKey?: string;
  private acontextBaseUrl?: string;
  private cloudflareApiToken?: string; // Cloudflare API token for Code Mode MCP
  private aaKey?: string; // Artificial Analysis API key for benchmark data
  private nexusKv?: KVNamespace; // KV namespace for Nexus research cache
  private dynamicModelsReady: Promise<void>; // Resolves when dynamic models are loaded from R2
  // (sync sessions now persisted in R2 via storage.saveSyncSession)

  constructor(
    telegramToken: string,
    openrouterKey: string,
    r2Bucket: R2Bucket,
    workerUrl?: string,
    defaultSkill: string = 'storia-orchestrator',
    allowedUserIds?: string[], // Pass user IDs to restrict access
    githubToken?: string, // GitHub token for tool authentication
    braveSearchKey?: string, // Brave Search API key
    taskProcessor?: DurableObjectNamespace<TaskProcessor>, // DO for long tasks
    browser?: Fetcher, // Browser binding for browse_url tool
    dashscopeKey?: string, // DashScope API key (Qwen)
    moonshotKey?: string, // Moonshot API key (Kimi)
    deepseekKey?: string, // DeepSeek API key
    anthropicKey?: string, // Anthropic API key (Claude direct)
    sandbox?: SandboxLike, // Sandbox container for code execution
    acontextKey?: string, // Acontext API key for observability
    acontextBaseUrl?: string, // Acontext API base URL
    cloudflareApiToken?: string, // Cloudflare API token for Code Mode MCP
    aaKey?: string, // Artificial Analysis API key for benchmark data
    nexusKv?: KVNamespace, // KV namespace for Nexus research cache
  ) {
    this.bot = new TelegramBot(telegramToken);
    this.openrouter = createOpenRouterClient(openrouterKey, workerUrl);
    this.storage = createUserStorage(r2Bucket);
    this.skills = createSkillStorage(r2Bucket);
    this.r2Bucket = r2Bucket;
    this.defaultSkill = defaultSkill;
    this.githubToken = githubToken;
    this.telegramToken = telegramToken;
    this.openrouterKey = openrouterKey;
    this.braveSearchKey = braveSearchKey;
    this.taskProcessor = taskProcessor;
    this.browser = browser;
    this.sandbox = sandbox;
    this.dashscopeKey = dashscopeKey;
    this.moonshotKey = moonshotKey;
    this.deepseekKey = deepseekKey;
    this.anthropicKey = anthropicKey;
    this.acontextKey = acontextKey;
    this.acontextBaseUrl = acontextBaseUrl;
    this.cloudflareApiToken = cloudflareApiToken;
    this.aaKey = aaKey;
    this.nexusKv = nexusKv;
    if (allowedUserIds && allowedUserIds.length > 0) {
      this.allowedUsers = new Set(allowedUserIds);
    }
    // Load dynamic models from R2 (async, non-blocking — awaited before model checks)
    this.dynamicModelsReady = this.loadDynamicModelsFromR2();
  }

  /**
   * Replace the bot instance. Used by /simulate endpoint to inject a CapturingBot
   * that records all outputs instead of making Telegram API calls.
   * @internal
   */
  _setBot(bot: TelegramBot): void {
    this.bot = bot;
  }

  /**
   * Load previously synced dynamic models and blocked list from R2 into runtime.
   * Also loads auto-synced full catalog models.
   */
  private async loadDynamicModelsFromR2(): Promise<void> {
    try {
      const data = await this.storage.loadDynamicModels();
      if (data) {
        if (data.models && Object.keys(data.models).length > 0) {
          registerDynamicModels(data.models);
          console.log(`[Telegram] Loaded ${Object.keys(data.models).length} dynamic models from R2`);
        }
        if (data.blocked && data.blocked.length > 0) {
          blockModels(data.blocked);
          console.log(`[Telegram] Loaded ${data.blocked.length} blocked models from R2`);
        }
      }
    } catch (error) {
      console.error('[Telegram] Failed to load dynamic models from R2:', error);
    }

    // Also load auto-synced full catalog models
    try {
      const { loadAutoSyncedModels } = await import('../openrouter/model-sync/sync');
      const count = await loadAutoSyncedModels(this.r2Bucket);
      if (count > 0) {
        console.log(`[Telegram] Loaded ${count} auto-synced models from R2`);
      }
    } catch (error) {
      console.error('[Telegram] Failed to load auto-synced models from R2:', error);
    }

    // Load enrichment data (AA benchmark scores, orchestra readiness)
    try {
      const { loadAndApplyEnrichment } = await import('../openrouter/model-sync/enrich');
      const enriched = await loadAndApplyEnrichment(this.r2Bucket);
      if (enriched > 0) {
        console.log(`[Telegram] Applied ${enriched} enrichment patches from R2`);
      }
    } catch (error) {
      console.error('[Telegram] Failed to load enrichment data from R2:', error);
    }

    // Load model overrides (patches to curated models, e.g. from /modelupdate).
    // Must run AFTER dynamic models since applyModelOverrides writes to DYNAMIC_MODELS.
    try {
      const overrideData = await this.storage.loadModelOverrides();
      if (overrideData && Object.keys(overrideData.overrides).length > 0) {
        const applied = applyModelOverrides(overrideData.overrides);
        console.log(`[Telegram] Applied ${applied} model overrides from R2`);
      }
    } catch (error) {
      console.error('[Telegram] Failed to load model overrides from R2:', error);
    }
  }

  /**
   * Check if a user is allowed to use the bot
   */
  private isUserAllowed(userId: string): boolean {
    if (this.allowedUsers === null) {
      return true; // No allowlist = allow everyone
    }
    return this.allowedUsers.has(userId);
  }

  /**
   * Get the system prompt from the skill (cached)
   */
  private async getSystemPrompt(): Promise<string> {
    if (this.cachedSkillPrompt) {
      return this.cachedSkillPrompt;
    }

    const skillContent = await this.skills.getSkill(this.defaultSkill);
    if (skillContent) {
      this.cachedSkillPrompt = skillContent;
      return skillContent;
    }

    // Fallback default prompt
    return 'You are a helpful AI assistant. Be concise but thorough. Use markdown formatting when appropriate.';
  }

  /**
   * Get relevant past learnings formatted for system prompt injection.
   * Returns empty string if no relevant learnings found or on error.
   */
  private async getLearningsHint(userId: string, userMessage: string): Promise<string> {
    try {
      const history = await loadLearnings(this.r2Bucket, userId);
      if (!history) return '';
      const relevant = getRelevantLearnings(history, userMessage);
      return formatLearningsForPrompt(relevant);
    } catch {
      return ''; // Non-fatal: skip learnings on error
    }
  }

  /**
   * Get the last completed task summary for cross-task context.
   * Returns empty string if no recent task or on error.
   */
  private async getLastTaskHint(userId: string): Promise<string> {
    try {
      const summary = await loadLastTaskSummary(this.r2Bucket, userId);
      return formatLastTaskForPrompt(summary);
    } catch {
      return ''; // Non-fatal: skip on error
    }
  }

  /**
   * Get relevant session history for cross-session context continuity.
   * Returns empty string if no relevant sessions or on error.
   */
  private async getSessionContext(userId: string, userMessage: string): Promise<string> {
    try {
      const history = await loadSessionHistory(this.r2Bucket, userId);
      if (!history) return '';
      const relevant = getRelevantSessions(history, userMessage);
      return formatSessionsForPrompt(relevant);
    } catch {
      return ''; // Non-fatal: skip on error
    }
  }

  /**
   * Get persistent user memory context for system prompt injection (F.8).
   * Returns empty string if no memories found or on error.
   */
  private async getMemoryHint(userId: string): Promise<string> {
    try {
      return await getMemoryContext(this.r2Bucket, userId);
    } catch {
      return ''; // Non-fatal: skip on error
    }
  }

  /**
   * Handle an incoming update
   */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    try {
      if (update.message) {
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        await this.handleCallback(update.callback_query);
      }
    } catch (error) {
      console.error('[Telegram] Error handling update:', error);
      // Try to send error message if we have a chat
      const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
      if (chatId) {
        try {
          await this.bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } catch {
          // Ignore send errors
        }
      }
    }
  }

  /**
   * Handle a message
   */
  private async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);
    const username = message.from?.username;
    const text = message.text || message.caption || '';

    console.log(`[Telegram] Message from ${userId} (${username}): ${text.slice(0, 100)}`);

    // Check if user is allowed
    if (!this.isUserAllowed(userId)) {
      console.log(`[Telegram] Unauthorized user ${userId} (${username}) blocked`);
      await this.bot.sendMessage(chatId, '⛔ Access denied. This bot is private.');
      return;
    }

    // Check for commands
    if (text.startsWith('/')) {
      await this.handleCommand(message, text);
      return;
    }

    // Check for photo with caption (vision)
    if (message.photo && message.photo.length > 0) {
      await this.handleVision(message);
      return;
    }

    // Detect "continue" keyword — route through resume path instead of regular chat.
    // When a task hits the iteration limit, it tells the user to send "continue".
    // Without this, "continue" creates a brand-new task that immediately re-hits the limit.
    if (text.trim().toLowerCase() === 'continue' && this.taskProcessor) {
      await this.handleContinueResume(message);
      return;
    }

    // Draft revision mode: user's message is revision feedback for the current draft
    // Keyed by userId+chatId — only intercepts in the originating chat
    const activeDraft = await this.storage.getOrchestraDraft(userId, chatId);
    if (activeDraft?.pendingRevision) {
      // Clear revision flag and re-run with feedback
      activeDraft.pendingRevision = false;
      activeDraft.revisions.push(text);
      activeDraft.revisionCount++;
      await this.storage.setOrchestraDraft(userId, chatId, activeDraft);
      // Re-run draft generation with revision context
      return this.executeOrchestraDraftRevision(chatId, userId, activeDraft, text);
    }

    // /orch plan mode: capture messages as requirements
    // Keyed by userId+chatId — only intercepts in the originating chat
    const activePlan = await this.storage.getOrchestraPlan(userId, chatId);
    if (activePlan) {
      activePlan.requirements.push(text);
      await this.storage.setOrchestraPlan(userId, chatId, activePlan);
      const count = activePlan.requirements.length;
      await this.bot.sendMessage(chatId, `📝 Got it (${count} requirement${count > 1 ? 's' : ''} so far). Send more, or tap Generate Draft when ready.`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📝 Generate Draft', callback_data: 'orchplan:generate' },
              { text: '❌ Cancel', callback_data: 'orchplan:cancel' },
            ],
          ],
        },
      });
      return;
    }

    // Regular text message - chat with AI
    if (text) {
      await this.handleChat(message, text);
    }
  }

  /**
   * Handle commands
   */
  private async handleCommand(message: TelegramMessage, text: string): Promise<void> {
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);
    const username = message.from?.username;

    // --- Gecko Skills routing ---
    // Check if this command is mapped to a skill handler.
    // In Phase 0, orchestra is registered but still uses the legacy path below
    // because it needs full Telegram bot context (DOs, callbacks, etc.).
    // Future skills (lyra, spark, nexus) will be handled entirely here.
    initializeSkills();
    const skillParsed = parseCommandMessage(text);
    if (skillParsed && skillParsed.mapping.skillId !== 'orchestra' && isSkillRegistered(skillParsed.mapping.skillId)) {
      const skillEnv = {
        MOLTBOT_BUCKET: this.r2Bucket,
        OPENROUTER_API_KEY: this.openrouterKey,
        GITHUB_TOKEN: this.githubToken,
        BRAVE_SEARCH_KEY: this.braveSearchKey,
        TASK_PROCESSOR: this.taskProcessor,
        NEXUS_KV: this.nexusKv,
      } as import('../types').MoltbotEnv;
      const skillRequest: SkillRequest = {
        skillId: skillParsed.mapping.skillId,
        subcommand: skillParsed.subcommand,
        text: skillParsed.text,
        flags: skillParsed.flags,
        transport: 'telegram',
        userId,
        chatId,
        modelAlias: await this.storage.getUserModel(userId),
        env: skillEnv,
        context: { telegramToken: this.telegramToken },
      };
      const result = await runSkill(skillRequest);
      const chunks = renderForTelegram(result);
      for (const chunk of chunks) {
        await this.bot.sendMessage(chatId, chunk.text, chunk.parseMode ? { parseMode: chunk.parseMode } : undefined);
      }
      return;
    }
    // --- End Gecko Skills routing ---

    const [command, ...args] = text.split(/\s+/);
    const cmd = command.toLowerCase().replace(/@.*$/, ''); // Remove bot username if present

    switch (cmd) {
      case '/start':
        await this.sendStartMenu(chatId);
        break;
      case '/help':
        await this.bot.sendMessage(chatId, this.getHelpMessage());
        break;

      case '/models':
        // Legacy alias — now redirects to /model rank (ranked + buttons)
        await this.sendModelRanking(chatId);
        break;

      case '/use':
        // Legacy alias — same as /model use
        await this.handleUseCommand(chatId, userId, username, args);
        break;

      case '/model':
        await this.handleModelCommand(chatId, userId, username, args);
        break;

      case '/clear':
        await this.storage.clearConversation(userId);
        await this.bot.sendMessage(chatId, 'Conversation history cleared.');
        break;

      case '/img':
        await this.handleImageCommand(chatId, args.join(' '));
        break;

      case '/credits':
        try {
          const credits = await this.openrouter.getCredits();
          await this.bot.sendMessage(
            chatId,
            `OpenRouter Credits\n` +
            `Remaining: $${credits.credits.toFixed(4)}\n` +
            `Used: $${credits.usage.toFixed(4)}`
          );
        } catch (error) {
          await this.bot.sendMessage(chatId, `Failed to get credits: ${error}`);
        }
        break;

      case '/skill':
        await this.handleSkillCommand(chatId, args);
        break;

      case '/ping':
        const startTime = Date.now();
        const pingMsg = await this.bot.sendMessage(chatId, '🏓 Pong!');
        const latency = Date.now() - startTime;
        await this.bot.editMessage(chatId, pingMsg.message_id, `🏓 Pong! (${latency}ms)`);
        break;

      case '/status':
      case '/info':
        const statusModel = await this.storage.getUserModel(userId);
        const statusModelInfo = getModel(statusModel);
        const statusHistory = await this.storage.getConversation(userId, 100);
        const statusAutoResume = await this.storage.getUserAutoResume(userId);
        const statusAutoRoute = await this.storage.getUserAutoRoute(userId);
        const hasGithub = !!this.githubToken;
        const hasBrowser = !!this.browser;
        const hasSandbox = !!this.sandbox;
        const statusIsDirect = isDirectApi(statusModel);
        const statusProvider = getProvider(statusModel);
        const statusApiSource = statusIsDirect
          ? `Direct API (${statusProvider})`
          : 'OpenRouter';
        const statusResumeLimit = statusModelInfo?.isFree ? '5x free' : '10x paid';
        await this.bot.sendMessage(
          chatId,
          `📊 Bot Status\n\n` +
          `Model: ${statusModelInfo?.name || statusModel}\n` +
          `API: ${statusApiSource}\n` +
          `Conversation: ${statusHistory.length} messages\n` +
          `Auto-resume: ${statusAutoResume ? `✓ Enabled (${statusResumeLimit})` : '✗ Disabled'}\n` +
          `Auto-route: ${statusAutoRoute ? '✓ Simple queries → fast model' : '✗ Disabled'}\n` +
          `GitHub Tools: ${hasGithub ? '✓ Configured (read + PR creation)' : '✗ Not configured'}\n` +
          `Browser Tools: ${hasBrowser ? '✓ Configured' : '✗ Not configured'}\n` +
          `Sandbox: ${hasSandbox ? '✓ Available (code execution)' : '✗ Not available'}\n` +
          `Skill: ${this.defaultSkill}\n\n` +
          `Use /automode to toggle auto-resume\n` +
          `Use /autoroute to toggle fast-model routing\n` +
          `Use /clear to reset conversation\n` +
          `Use /models to see available models`
        );
        break;

      case '/new':
        // Alias for /clear - fresh conversation
        await this.storage.clearConversation(userId);
        await this.bot.sendMessage(chatId, '🆕 New conversation started. How can I help you?');
        break;

      case '/automode':
      case '/autoresume':
      case '/ar':
        // Toggle auto-resume mode
        const currentAutoResume = await this.storage.getUserAutoResume(userId);
        const newAutoResume = !currentAutoResume;
        await this.storage.setUserAutoResume(userId, newAutoResume);
        await this.bot.sendMessage(
          chatId,
          newAutoResume
            ? '✓ Auto-resume enabled. Tasks will automatically retry on timeout (up to 10x paid, 15x free).'
            : '✗ Auto-resume disabled. You will need to manually tap Resume when tasks timeout.'
        );
        break;

      case '/autoroute': {
        // Toggle auto-routing of simple queries to fast models
        const currentAutoRoute = await this.storage.getUserAutoRoute(userId);
        const newAutoRoute = !currentAutoRoute;
        await this.storage.setUserAutoRoute(userId, newAutoRoute);
        await this.bot.sendMessage(
          chatId,
          newAutoRoute
            ? '✓ Auto-routing enabled. Simple queries (weather, greetings, crypto) will use a fast model for lower latency.'
            : '✗ Auto-routing disabled. All queries will use your selected model.'
        );
        break;
      }

      case '/learnings': {
        // Show task history and learning summary
        const learningHistory = await loadLearnings(this.r2Bucket, userId);
        if (!learningHistory || learningHistory.learnings.length === 0) {
          await this.bot.sendMessage(chatId, '📚 No task history yet. Complete some tasks and check back!');
          break;
        }
        const summary = formatLearningSummary(learningHistory);
        await this.bot.sendMessage(chatId, summary);
        break;
      }

      case '/sessions': {
        // Show recent Acontext sessions
        if (!this.acontextKey) {
          await this.bot.sendMessage(chatId, '⚠️ Acontext not configured. Set ACONTEXT_API_KEY to enable session tracking.');
          break;
        }
        try {
          const acontext = createAcontextClient(this.acontextKey, this.acontextBaseUrl);
          if (!acontext) {
            await this.bot.sendMessage(chatId, '⚠️ Failed to create Acontext client.');
            break;
          }
          const response = await acontext.listSessions({ user: userId, limit: 10, timeDesc: true });
          const formatted = formatSessionsList(response.items);
          await this.bot.sendMessage(chatId, formatted);
        } catch (err) {
          console.error('[Telegram] Failed to list Acontext sessions:', err);
          await this.bot.sendMessage(chatId, '⚠️ Failed to fetch sessions. Try again later.');
        }
        break;
      }

      case '/memory': {
        // Long-term user memory management (F.8)
        const memoryArgs = text.slice('/memory'.length).trim();

        if (memoryArgs.startsWith('add ')) {
          const factText = memoryArgs.slice('add '.length).trim();
          if (!factText) {
            await this.bot.sendMessage(chatId, '⚠️ Usage: /memory add <fact>\nExample: /memory add I prefer Python for APIs');
            break;
          }
          const addResult = await addManualFact(this.r2Bucket, userId, factText);
          if (addResult.stored) {
            await this.bot.sendMessage(chatId, `🧠 Remembered: "${factText}"`);
          } else {
            await this.bot.sendMessage(chatId, `⚠️ Not stored: ${addResult.reason}`);
          }
          break;
        }

        if (memoryArgs.startsWith('remove ')) {
          const factId = memoryArgs.slice('remove '.length).trim();
          if (!factId) {
            await this.bot.sendMessage(chatId, '⚠️ Usage: /memory remove <id>');
            break;
          }
          const removed = await deleteMemoryFact(this.r2Bucket, userId, factId);
          if (removed) {
            await this.bot.sendMessage(chatId, `🧠 Fact ${factId} removed.`);
          } else {
            await this.bot.sendMessage(chatId, `⚠️ Fact not found: ${factId}`);
          }
          break;
        }

        if (memoryArgs === 'clear') {
          await clearUserMemory(this.r2Bucket, userId);
          await this.bot.sendMessage(chatId, '🧠 All memories cleared.');
          break;
        }

        // Default: show all memories
        const userMemory = await loadUserMemory(this.r2Bucket, userId);
        if (!userMemory || userMemory.facts.length === 0) {
          await this.bot.sendMessage(chatId, '🧠 No memories stored yet. I\'ll learn about you as we chat, or use /memory add <fact> to add manually.');
          break;
        }
        await this.bot.sendMessage(chatId, formatMemoryDisplay(userMemory));
        break;
      }

      case '/files': {
        // Persistent file management (F.4) — R2-backed per-user storage
        const fileArgs = text.slice('/files'.length).trim();
        const r2Prefix = `files/${userId}/`;

        if (!fileArgs || fileArgs === 'list') {
          // List all files
          const files = await r2ListFiles(this.r2Bucket, r2Prefix);
          if (files.length === 0) {
            await this.bot.sendMessage(chatId, '📁 No saved files yet.\nModels can save files during tool-calling via the save_file tool.');
            break;
          }
          const totalSize = files.reduce((sum, f) => sum + f.size, 0);
          const lines = files
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(f => `  ${f.name} (${f.size} bytes)`);
          await this.bot.sendMessage(chatId, `📁 Your files (${files.length}, ${(totalSize / 1024).toFixed(1)}KB):\n${lines.join('\n')}\n\nUse /files get <name> or /files delete <name>`);
          break;
        }

        if (fileArgs.startsWith('get ')) {
          const fileName = fileArgs.slice('get '.length).trim();
          if (!fileName) {
            await this.bot.sendMessage(chatId, '⚠️ Usage: /files get <name>');
            break;
          }
          const nameError = validateSavedFileName(fileName);
          if (nameError) {
            await this.bot.sendMessage(chatId, `⚠️ ${nameError}`);
            break;
          }
          const content = await r2ReadFile(this.r2Bucket, r2Prefix, sanitizeSavedFileName(fileName));
          if (content.startsWith('File not found:')) {
            await this.bot.sendMessage(chatId, `⚠️ ${content}`);
          } else {
            // Truncate for Telegram (4096 char limit)
            const contentBytes = new TextEncoder().encode(content).byteLength;
            const display = content.length > 3800
              ? content.slice(0, 3800) + `\n\n... (truncated, ${contentBytes} bytes total)`
              : content;
            const safeName = escapeHtml(sanitizeSavedFileName(fileName));
            const safeContent = escapeHtml(display);
            await this.bot.sendMessage(chatId, `📄 <b>${safeName}</b>:\n<pre>${safeContent}</pre>`, { parseMode: 'HTML' });
          }
          break;
        }

        if (fileArgs.startsWith('delete ')) {
          const fileName = fileArgs.slice('delete '.length).trim();
          if (!fileName) {
            await this.bot.sendMessage(chatId, '⚠️ Usage: /files delete <name>');
            break;
          }
          const nameError = validateSavedFileName(fileName);
          if (nameError) {
            await this.bot.sendMessage(chatId, `⚠️ ${nameError}`);
            break;
          }
          const deleted = await r2DeleteFile(this.r2Bucket, r2Prefix, sanitizeSavedFileName(fileName));
          await this.bot.sendMessage(chatId, deleted ? `🗑️ Deleted: ${sanitizeSavedFileName(fileName)}` : `⚠️ File not found: ${sanitizeSavedFileName(fileName)}`);
          break;
        }

        if (fileArgs === 'clear') {
          const files = await r2ListFiles(this.r2Bucket, r2Prefix);
          if (files.length === 0) {
            await this.bot.sendMessage(chatId, '📁 No files to clear.');
            break;
          }
          await this.r2Bucket.delete(files.map(f => `${r2Prefix}${f.name}`));
          await this.bot.sendMessage(chatId, `🗑️ Cleared ${files.length} files.`);
          break;
        }

        // Usage
        await this.bot.sendMessage(chatId, '📁 <b>File Management</b>\n\n/files — list all files\n/files get &lt;name&gt; — show file content\n/files delete &lt;name&gt; — delete a file\n/files clear — delete all files\n\nModels can also save/read files via save_file, read_saved_file tools during conversations.', { parseMode: 'HTML' });
        break;
      }

      case '/resume':
        // Resume from checkpoint with optional model override
        if (!this.taskProcessor) {
          await this.bot.sendMessage(chatId, '⚠️ Task processor not available.');
          break;
        }
        await this.handleResumeCommand(chatId, userId, args);
        break;

      case '/pick':
        // Legacy alias — now redirects to /model rank (ranked + buttons)
        await this.sendModelRanking(chatId);
        break;

      case '/cancel':
        // Cancel any running task AND clear all interactive orchestra state
        if (this.taskProcessor) {
          try {
            const doId = this.taskProcessor.idFromName(userId);
            const doStub = this.taskProcessor.get(doId);
            const response = await fetchDOWithRetry(doStub, new Request('https://do/cancel', { method: 'POST' }));
            const result = await response.json() as { status: string };
            if (result.status === 'cancelled') {
              // Message already sent by DO
            } else {
              await this.bot.sendMessage(chatId, 'No task is currently running.');
            }
            // F.23: Always release branch locks on /cancel — even when "no task running".
            // Handles stranded locks from DO eviction, completed tasks, or race conditions.
            if (this.r2Bucket) {
              try {
                const history = await loadOrchestraHistory(this.r2Bucket, userId);
                if (history) {
                  for (const t of history.tasks) {
                    if (t.status === 'started') {
                      await forceReleaseRepoLock(this.r2Bucket, userId, t.repo);
                    }
                  }
                }
              } catch { /* best-effort lock cleanup */ }
            }
          } catch (error) {
            await this.bot.sendMessage(chatId, 'Failed to cancel task.');
          }
        } else {
          await this.bot.sendMessage(chatId, 'Task processor not available.');
        }
        // Clear all interactive orchestra state (draft, plan, pending revision)
        // so normal messages aren't accidentally captured after /cancel
        await this.storage.clearAllOrchestraState(userId, chatId);
        break;

      case '/steer': {
        // Inject a steering message into a running task
        const steerInstruction = args.join(' ').trim();
        if (!steerInstruction) {
          await this.bot.sendMessage(chatId,
            '🧭 *Steer a running task*\n\n' +
            'Usage: `/steer <instruction>`\n' +
            'Example: `/steer Use TypeScript instead of Python`\n\n' +
            'The instruction is injected on the next iteration.',
            { parseMode: 'Markdown' }
          );
          break;
        }
        if (this.taskProcessor) {
          try {
            const doId = this.taskProcessor.idFromName(userId);
            const doStub = this.taskProcessor.get(doId);
            const response = await fetchDOWithRetry(doStub, new Request('https://do/steer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ instruction: steerInstruction }),
            }));
            const result = await response.json() as { status: string; queued?: number; error?: string };
            if (result.status === 'steered') {
              await this.bot.sendMessage(chatId, `🧭 Steering message queued. The task will pick it up on its next iteration.`);
            } else if (result.status === 'not_processing') {
              await this.bot.sendMessage(chatId, 'No task is currently running.');
            } else {
              await this.bot.sendMessage(chatId, `Failed to steer: ${result.error || 'unknown'}`);
            }
          } catch (error) {
            await this.bot.sendMessage(chatId, 'Failed to send steering message.');
          }
        } else {
          await this.bot.sendMessage(chatId, 'Task processor not available.');
        }
        break;
      }

      case '/cloudflare':
      case '/cf': {
        // Cloudflare API via Code Mode MCP
        const cfQuery = args.join(' ').trim();
        if (!cfQuery) {
          await this.bot.sendMessage(chatId,
            '☁️ *Cloudflare Code Mode MCP*\n\n' +
            'Access the entire Cloudflare API (2500+ endpoints) in ~1k tokens.\n\n' +
            '*Usage:*\n' +
            '`/cloudflare search list R2 buckets`\n' +
            '`/cloudflare execute <typescript code>`\n' +
            '`/cf search workers list`\n\n' +
            `*Status:* ${this.cloudflareApiToken ? '✅ Token configured' : '❌ CLOUDFLARE_API_TOKEN not set'}`
          );
          break;
        }

        if (!this.cloudflareApiToken) {
          await this.bot.sendMessage(chatId, '❌ CLOUDFLARE_API_TOKEN is not configured. Set it in your environment variables.');
          break;
        }

        // Parse action: first word can be "search" or "execute", default to "search"
        const cfParts = cfQuery.split(/\s+/);
        let cfAction: 'search' | 'execute' = 'search';
        let cfArg = cfQuery;
        if (cfParts[0] === 'search' || cfParts[0] === 'execute') {
          cfAction = cfParts[0] as 'search' | 'execute';
          cfArg = cfParts.slice(1).join(' ');
        }

        if (!cfArg) {
          await this.bot.sendMessage(chatId, '❌ Please provide a query or code after the action.');
          break;
        }

        await this.bot.sendMessage(chatId, cfAction === 'search'
          ? `🔍 Searching Cloudflare API: "${cfArg}"...`
          : '⚡ Executing against Cloudflare API...');

        try {
          const { cloudflareApi: cfApiCall } = await import('../openrouter/tools-cloudflare');
          const cfResult = await cfApiCall(cfAction, cfAction === 'search' ? cfArg : undefined, cfAction === 'execute' ? cfArg : undefined, this.cloudflareApiToken);
          // Truncate for Telegram (max 4096 chars)
          const truncated = cfResult.length > 3900 ? cfResult.slice(0, 3900) + '\n...(truncated)' : cfResult;
          await this.bot.sendMessage(chatId, `☁️ *Cloudflare ${cfAction}:*\n\`\`\`\n${truncated}\n\`\`\``);
        } catch (error) {
          await this.bot.sendMessage(chatId, `❌ Cloudflare API error: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }

      case '/saves':
      case '/checkpoints': {
        // List all saved checkpoints
        const checkpoints = await this.storage.listCheckpoints(userId);
        if (checkpoints.length === 0) {
          await this.bot.sendMessage(chatId, '📭 No saved checkpoints found.\n\nCheckpoints are automatically created during long-running tasks.');
          break;
        }

        let msg = '💾 *Saved Checkpoints:*\n\n';
        for (const cp of checkpoints) {
          const age = this.formatAge(cp.savedAt);
          const status = cp.completed ? '✅' : '⏸️';
          const prompt = cp.taskPrompt ? `\n   _${this.escapeMarkdown(cp.taskPrompt.substring(0, 50))}${cp.taskPrompt.length > 50 ? '...' : ''}_` : '';
          const modelTag = cp.modelAlias ? ` [${cp.modelAlias}]` : '';
          msg += `${status} \`${cp.slotName}\` - ${cp.iterations} iters, ${cp.toolsUsed} tools${modelTag} (${age})${prompt}\n`;
        }
        msg += '\n✅=completed ⏸️=interrupted\n_Use /delsave <name> to delete, /saveas <name> to backup_';
        await this.bot.sendMessage(chatId, msg, { parseMode: 'Markdown' });
        break;
      }

      case '/saveinfo':
      case '/save': {
        // Show checkpoint details + AI-generated conversation summary
        const slotName = args[0] || 'latest';
        const info = await this.storage.getCheckpointInfo(userId, slotName);
        if (!info) {
          await this.bot.sendMessage(chatId, `📭 No checkpoint found for slot: \`${slotName}\``, { parseMode: 'Markdown' });
          break;
        }

        const age = this.formatAge(info.savedAt);
        const savedDate = new Date(info.savedAt).toLocaleString();
        const statusEmoji = info.completed ? '✅' : '⏸️';
        const statusText = info.completed ? 'Completed' : 'Interrupted';
        let msg = `💾 Checkpoint: ${info.slotName} ${statusEmoji}\n\n`;
        msg += `Iterations: ${info.iterations}\n`;
        msg += `Tools used: ${info.toolsUsed}\n`;
        msg += `Status: ${statusText}\n`;
        msg += `Saved: ${savedDate} (${age})\n`;
        if (info.taskPrompt) {
          msg += `\nTask: ${info.taskPrompt}\n`;
        }

        // Generate a brief AI summary of the conversation content
        try {
          const conversation = await this.storage.getCheckpointConversation(userId, slotName, 15);
          if (conversation && conversation.length > 0) {
            const conversationText = conversation
              .map(m => `${m.role}: ${m.content}`)
              .join('\n');

            const summaryResponse = await this.openrouter.chatCompletion('auto', [
              { role: 'system', content: 'Summarize this conversation in 2-3 short sentences. Focus on what the user asked and what was accomplished. Be concise.' },
              { role: 'user', content: conversationText },
            ], { maxTokens: 150 });

            const summary = extractTextResponse(summaryResponse);
            if (summary) {
              msg += `\n--- Conversation Summary ---\n${summary}`;
            }
          }
        } catch {
          // Summary generation failed, just show metadata
        }

        await this.bot.sendMessage(chatId, msg);
        break;
      }

      case '/delsave':
      case '/delcheckpoint': {
        // Delete a checkpoint
        const slotToDelete = args[0];
        if (!slotToDelete) {
          await this.bot.sendMessage(chatId, '⚠️ Please specify a slot name.\nUsage: `/delsave <name>`\n\nUse `/saves` to see available checkpoints.', { parseMode: 'Markdown' });
          break;
        }

        const deleted = await this.storage.deleteCheckpoint(userId, slotToDelete);
        if (deleted) {
          await this.bot.sendMessage(chatId, `✅ Deleted checkpoint: \`${slotToDelete}\``, { parseMode: 'Markdown' });
        } else {
          await this.bot.sendMessage(chatId, `❌ Checkpoint not found: \`${slotToDelete}\``, { parseMode: 'Markdown' });
        }
        break;
      }

      case '/saveas': {
        // Copy current checkpoint to a named slot (backup)
        const newSlotName = args[0];
        if (!newSlotName) {
          await this.bot.sendMessage(chatId, '⚠️ Please specify a name for the backup.\nUsage: `/saveas <name>`\n\nExample: `/saveas myproject`', { parseMode: 'Markdown' });
          break;
        }

        // Validate slot name (alphanumeric + dash/underscore only)
        if (!/^[a-zA-Z0-9_-]+$/.test(newSlotName)) {
          await this.bot.sendMessage(chatId, '❌ Invalid slot name. Use only letters, numbers, dash, and underscore.');
          break;
        }

        const copied = await this.storage.copyCheckpoint(userId, 'latest', newSlotName);
        if (copied) {
          await this.bot.sendMessage(chatId, `✅ Current progress backed up to: \`${newSlotName}\`\n\nUse \`/load ${newSlotName}\` to restore later.`, { parseMode: 'Markdown' });
        } else {
          await this.bot.sendMessage(chatId, '❌ No current checkpoint to backup. Start a long-running task first.');
        }
        break;
      }

      case '/load': {
        // Copy a named slot back to latest (restore)
        const slotToLoad = args[0];
        if (!slotToLoad) {
          await this.bot.sendMessage(chatId, '⚠️ Please specify a slot name to load.\nUsage: `/load <name>`\n\nUse `/saves` to see available checkpoints.', { parseMode: 'Markdown' });
          break;
        }

        const info = await this.storage.getCheckpointInfo(userId, slotToLoad);
        if (!info) {
          await this.bot.sendMessage(chatId, `❌ Checkpoint not found: \`${slotToLoad}\``, { parseMode: 'Markdown' });
          break;
        }

        const loaded = await this.storage.copyCheckpoint(userId, slotToLoad, 'latest');
        if (loaded) {
          await this.bot.sendMessage(
            chatId,
            `✅ Loaded checkpoint: \`${slotToLoad}\`\n\n📊 ${info.iterations} iterations, ${info.toolsUsed} tools\n\nUse Resume button or start a new task to continue.`,
            { parseMode: 'Markdown' }
          );
        } else {
          await this.bot.sendMessage(chatId, '❌ Failed to load checkpoint.');
        }
        break;
      }

      case '/orchestra':
      case '/orch':
        await this.handleOrchestraCommand(message, chatId, userId, args);
        break;

      case '/briefing':
      case '/brief':
        await this.handleBriefingCommand(chatId, userId, args);
        break;

      case '/costs':
      case '/usage':
        await this.handleCostsCommand(chatId, userId, args);
        break;

      case '/syncmodels':
      case '/sync':
        // Legacy alias — same as /model sync
        await this.handleSyncModelsCommand(chatId, userId);
        break;

      case '/syncall':
        // Legacy alias — same as /model syncall
        await this.handleSyncAllCommand(chatId, userId);
        break;

      case '/synccheck':
        // Legacy alias — same as /model check
        await this.handleSyncCheckCommand(chatId);
        break;

      case '/modelinfo':
        // Legacy alias — same as /model info
        await this.handleModelInfoCommand(chatId, args);
        break;

      case '/enrich':
        // Legacy alias — same as /model enrich
        await this.handleEnrichCommand(chatId);
        break;

      case '/syncreset':
        // Legacy alias — same as /model reset
        await this.handleModelCommand(chatId, userId, username, ['reset']);
        break;

      case '/modelupdate':
        // Legacy alias — same as /model update
        await this.handleModelUpdateCommand(chatId, args);
        break;

      case '/test': {
        // Run smoke tests against TaskProcessor DO
        if (!this.taskProcessor) {
          await this.bot.sendMessage(chatId, 'Task processor not available.');
          break;
        }

        const testFilter = args.length > 0 ? args[0] : undefined;

        if (testFilter === 'list') {
          const names = getTestNames();
          await this.bot.sendMessage(chatId,
            'Available smoke tests:\n\n' + names.map(n => `  ${n}`).join('\n') +
            '\n\nUsage: /test [name] — run one test, or /test to run all'
          );
          break;
        }

        await this.bot.sendMessage(chatId,
          `Running smoke tests${testFilter ? ` (filter: ${testFilter})` : ''}...\nThis may take up to 2 minutes.`
        );

        try {
          const results = await runSmokeTests({
            taskProcessor: this.taskProcessor,
            userId,
            chatId,
            telegramToken: this.telegramToken,
            openrouterKey: this.openrouterKey,
            githubToken: this.githubToken,
            braveSearchKey: this.braveSearchKey,
          }, testFilter);

          const summary = formatTestResults(results);
          await this.bot.sendMessage(chatId, summary);
        } catch (err) {
          console.error('[Telegram] Smoke test error:', err);
          await this.bot.sendMessage(chatId, `Smoke test runner failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      default:
        // Check if it's a model alias command (e.g., /deep, /gpt)
        // Ensure auto-synced models are loaded first (may not be ready on cold start)
        await this.dynamicModelsReady;
        const modelAlias = cmd.slice(1); // Remove leading /
        if (getModel(modelAlias)) {
          await this.handleUseCommand(chatId, userId, username, [modelAlias]);
        } else {
          await this.bot.sendMessage(chatId, `Unknown command: ${cmd}\nType /help for available commands.`);
        }
    }
  }

  /**
   * Handle /use command
   */
  private async handleUseCommand(
    chatId: number,
    userId: string,
    username: string | undefined,
    args: string[]
  ): Promise<void> {
    if (args.length === 0) {
      const currentModel = await this.storage.getUserModel(userId);
      await this.bot.sendMessage(
        chatId,
        `Usage: /use <alias>\nCurrent model: ${currentModel}\n\nExample: /use deep`
      );
      return;
    }

    const alias = args[0].toLowerCase();
    // Ensure auto-synced models are loaded (may not be ready on cold start)
    await this.dynamicModelsReady;
    const model = getModel(alias);

    if (!model) {
      await this.bot.sendMessage(
        chatId,
        `Unknown model: ${alias}\nType /models to see available models.\nTip: you can use the full OpenRouter ID (e.g. /use openai/gpt-4o)`
      );
      return;
    }

    // Store canonical alias (from model definition), not the user's raw input.
    // This ensures exact-match lookups on subsequent requests.
    const canonicalAlias = model.alias;
    await this.storage.setUserModel(userId, canonicalAlias, username);
    await this.bot.sendMessage(
      chatId,
      `Model set to: ${model.name}\n` +
      `Alias: /${canonicalAlias}\n` +
      `${model.specialty}\n` +
      `Cost: ${model.cost}`
    );
  }

  /**
   * Handle /skill command
   */
  private async handleSkillCommand(chatId: number, args: string[]): Promise<void> {
    if (args.length === 0 || args[0] === 'info') {
      // Show current skill info
      const hasSkill = await this.skills.hasSkill(this.defaultSkill);
      const availableSkills = await this.skills.listSkills();

      await this.bot.sendMessage(
        chatId,
        `Current skill: ${this.defaultSkill}\n` +
        `Status: ${hasSkill ? '✓ Loaded from R2' : '✗ Not found (using fallback)'}\n` +
        `Cached: ${this.cachedSkillPrompt ? 'Yes' : 'No'}\n` +
        `\nAvailable skills in R2:\n${availableSkills.length > 0 ? availableSkills.map(s => `  - ${s}`).join('\n') : '  (none found)'}`
      );
      return;
    }

    if (args[0] === 'reload') {
      // Clear cache and reload
      this.cachedSkillPrompt = null;
      const prompt = await this.getSystemPrompt();
      const loaded = prompt !== 'You are a helpful AI assistant. Be concise but thorough. Use markdown formatting when appropriate.';
      await this.bot.sendMessage(
        chatId,
        loaded
          ? `✓ Skill "${this.defaultSkill}" reloaded (${prompt.length} chars)`
          : `✗ Skill "${this.defaultSkill}" not found in R2, using fallback prompt`
      );
      return;
    }

    if (args[0] === 'preview') {
      // Show first 500 chars of the skill prompt
      const prompt = await this.getSystemPrompt();
      const preview = prompt.length > 500 ? prompt.slice(0, 500) + '...' : prompt;
      await this.bot.sendMessage(chatId, `Skill preview:\n\n${preview}`);
      return;
    }

    await this.bot.sendMessage(
      chatId,
      `Usage:\n` +
      `/skill - Show current skill info\n` +
      `/skill reload - Reload skill from R2\n` +
      `/skill preview - Preview skill content`
    );
  }

  /**
   * Handle /img command
   * Usage: /img <prompt> or /img <model> <prompt>
   * Example: /img a cat in space
   * Example: /img fluxmax a detailed portrait
   */
  private async handleImageCommand(chatId: number, promptInput: string): Promise<void> {
    if (!promptInput) {
      await this.bot.sendMessage(
        chatId,
        '🎨 Image Generation\n\n' +
        'Usage: /img <prompt>\n' +
        'Or: /img <model> <prompt>\n\n' +
        'Available models:\n' +
        '  fluxklein - FLUX.2 Klein (fastest, cheapest)\n' +
        '  fluxpro - FLUX.2 Pro (default, balanced)\n' +
        '  fluxflex - FLUX.2 Flex (best for text)\n' +
        '  fluxmax - FLUX.2 Max (highest quality)\n\n' +
        'Examples:\n' +
        '  /img a cat in a basket\n' +
        '  /img fluxmax detailed portrait of a wizard\n' +
        '  /img fluxflex logo with text "HELLO"'
      );
      return;
    }

    // Check if first word is a model alias
    const words = promptInput.split(/\s+/);
    let modelAlias: string | undefined;
    let prompt: string;

    if (words.length > 1 && isImageGenModel(words[0].toLowerCase())) {
      modelAlias = words[0].toLowerCase();
      prompt = words.slice(1).join(' ');
    } else {
      prompt = promptInput;
    }

    await this.bot.sendChatAction(chatId, 'upload_photo');

    try {
      const result = await this.openrouter.generateImage(prompt, modelAlias);
      const imageUrl = result.data[0]?.url;

      if (imageUrl) {
        const caption = modelAlias ? `[${modelAlias}] ${prompt}` : prompt;
        // Check if it's a base64 data URL or regular URL
        if (imageUrl.startsWith('data:image/')) {
          await this.bot.sendPhotoBase64(chatId, imageUrl, caption);
        } else {
          await this.bot.sendPhoto(chatId, imageUrl, caption);
        }
      } else if (result.data[0]?.b64_json) {
        // Handle raw b64_json format
        const caption = modelAlias ? `[${modelAlias}] ${prompt}` : prompt;
        await this.bot.sendPhotoBase64(chatId, `data:image/png;base64,${result.data[0].b64_json}`, caption);
      } else {
        await this.bot.sendMessage(chatId, 'No image was generated. Try a different prompt.');
      }
    } catch (error) {
      await this.bot.sendMessage(chatId, `Image generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle /orchestra (/orch) command
   *
   * Subcommands:
   *   /orch set owner/repo  — Lock default repo
   *   /orch unset           — Clear locked repo
   *   /orch do [repo] <description>   — One-shot task (no roadmap)
   *   /orch init [repo] <description> — Create roadmap (planning only, no code)
   *   /orch run [repo] [task]         — Execute specific task
   *   /orch next [task]               — Execute next task (uses locked repo)
   *   /orch merge <PR#> [method]      — Merge a PR (squash/merge/rebase)
   *   /orch history                   — Show past tasks
   *   /orch roadmap [repo]            — Display roadmap status
   *   /orch                           — Show help
   */
  private async handleOrchestraCommand(
    message: TelegramMessage,
    chatId: number,
    userId: string,
    args: string[]
  ): Promise<void> {
    const sub = args.length > 0 ? args[0].toLowerCase() : '';

    // /orch history
    if (sub === 'history') {
      // Clean up any stale "started" tasks before showing history
      const cleaned = await cleanupStaleTasks(this.r2Bucket, userId);
      const history = await loadOrchestraHistory(this.r2Bucket, userId);
      let msg = formatOrchestraHistory(history);
      if (cleaned > 0) {
        msg = `🧹 Cleaned ${cleaned} stale task(s)\n\n${msg}`;
      }
      await this.bot.sendMessage(chatId, msg);
      return;
    }

    // /orch roadmap [owner/repo] — fetch and display ROADMAP.md status
    if (sub === 'roadmap' || sub === 'status') {
      const maybeRepo = args[1];
      const hasExplicitRepo = maybeRepo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(maybeRepo);
      const repo = hasExplicitRepo ? maybeRepo : await this.storage.getOrchestraRepo(userId);
      if (!repo) {
        await this.bot.sendMessage(
          chatId,
          '❌ No repo specified.\n\nUsage: /orch roadmap owner/repo\nOr: /orch set owner/repo first'
        );
        return;
      }
      try {
        const [owner, repoName] = repo.split('/');
        const { content, path } = await fetchRoadmapFromGitHub(owner, repoName, this.githubToken);
        const formatted = formatRoadmapStatus(content, repo, path);
        await this.bot.sendMessage(chatId, formatted);
      } catch (error) {
        await this.bot.sendMessage(
          chatId,
          `❌ ${error instanceof Error ? error.message : 'Failed to fetch roadmap'}`
        );
      }
      return;
    }

    // /orch reset <task|phase> — uncheck completed tasks so /orch next re-runs them
    if (sub === 'reset') {
      const query = args.slice(1).join(' ').trim();
      if (!query) {
        await this.bot.sendMessage(
          chatId,
          '❌ Please specify which task(s) to reset.\n\n' +
          'Usage:\n' +
          '  /orch reset <task name> — Reset a specific task\n' +
          '  /orch reset Phase 2 — Reset all tasks in Phase 2\n\n' +
          'This unchecks completed tasks so `/orch next` picks them up again.\n' +
          'A PR will be created with the roadmap changes.'
        );
        return;
      }
      const lockedRepo = await this.storage.getOrchestraRepo(userId);
      if (!lockedRepo) {
        await this.bot.sendMessage(chatId, '❌ No default repo set.\n\nFirst run: /orch set owner/repo');
        return;
      }
      if (!this.githubToken) {
        await this.bot.sendMessage(chatId, '❌ GitHub token not configured. Cannot create reset PR.');
        return;
      }
      const [owner, repoName] = lockedRepo.split('/');
      try {
        // Fetch roadmap
        await this.bot.sendMessage(chatId, `🔍 Looking for roadmap in ${lockedRepo}...`);
        const { content, path: filePath } = await fetchRoadmapFromGitHub(owner, repoName, this.githubToken);

        // Find and preview matching tasks
        const matchedTasks = findMatchingTasks(content, query);
        if (matchedTasks.length === 0) {
          await this.bot.sendMessage(
            chatId,
            `❌ No tasks found matching "${query}".\n\n` +
            'Use `/orch roadmap` to see all tasks and their exact names.'
          );
          return;
        }

        const doneTasks = matchedTasks.filter(t => t.done);
        if (doneTasks.length === 0) {
          const names = matchedTasks.map(t => `  ⬜ ${t.title}`).join('\n');
          await this.bot.sendMessage(
            chatId,
            `ℹ️ Found ${matchedTasks.length} matching task(s), but none are completed:\n${names}\n\n` +
            'Nothing to reset — these tasks are already pending.'
          );
          return;
        }

        // Perform the reset
        const { modified, resetCount, taskNames } = resetRoadmapTasks(content, query);

        // Create PR
        await this.bot.sendMessage(
          chatId,
          `📝 Resetting ${resetCount} task(s):\n${taskNames.map(t => `  ✅ → ⬜ ${t}`).join('\n')}\n\nCreating PR...`
        );

        const { prUrl } = await createRoadmapResetPR({
          owner,
          repo: repoName,
          filePath,
          newContent: modified,
          taskNames,
          githubToken: this.githubToken,
        });

        await this.bot.sendMessage(
          chatId,
          `✅ Reset PR created!\n\n` +
          `📋 ${resetCount} task(s) unchecked:\n${taskNames.map(t => `  ⬜ ${t}`).join('\n')}\n\n` +
          `🔗 PR: ${prUrl}\n\n` +
          `Once merged, run \`/orch next\` to re-execute these tasks.`
        );
      } catch (error) {
        await this.bot.sendMessage(
          chatId,
          `❌ Reset failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return;
    }

    // /orch redo <task> — re-implement a previously completed task
    if (sub === 'redo') {
      const taskQuery = args.slice(1).join(' ').trim();
      if (!taskQuery) {
        await this.bot.sendMessage(
          chatId,
          '❌ Please specify which task to redo.\n\n' +
          'Usage:\n' +
          '  /orch redo <task name> — Re-implement a task that was done incorrectly\n\n' +
          'The bot will:\n' +
          '1. Read the current roadmap and find the task\n' +
          '2. Examine what the previous attempt did wrong\n' +
          '3. Re-implement it properly\n' +
          '4. Create a PR with the fix + updated roadmap'
        );
        return;
      }
      const lockedRepo = await this.storage.getOrchestraRepo(userId);
      if (!lockedRepo) {
        await this.bot.sendMessage(chatId, '❌ No default repo set.\n\nFirst run: /orch set owner/repo');
        return;
      }
      // Delegate to executeOrchestra with redo mode
      return this.executeOrchestra(chatId, userId, 'redo', lockedRepo, taskQuery);
    }

    // /orch set owner/repo — lock the default repo
    if (sub === 'set') {
      const repo = args[1];
      if (!repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
        await this.bot.sendMessage(chatId, '❌ Usage: /orch set owner/repo\nExample: /orch set PetrAnto/moltworker');
        return;
      }
      await this.storage.setOrchestraRepo(userId, repo);
      await this.bot.sendMessage(chatId, `✅ Default orchestra repo set to: ${repo}\n\nNow you can use:\n  /orch do <description> — one-shot task (no roadmap)\n  /orch init <description> — create roadmap\n  /orch next — execute next roadmap task`);
      return;
    }

    // /orch unset — clear locked repo
    if (sub === 'unset') {
      await this.storage.setOrchestraRepo(userId, undefined);
      await this.bot.sendMessage(chatId, '✅ Default orchestra repo cleared.');
      return;
    }

    // /orch advise — analyze next task and recommend best model with clickable buttons
    if (sub === 'advise' || sub === 'pick') {
      const lockedRepo = await this.storage.getOrchestraRepo(userId);
      if (!lockedRepo) {
        await this.bot.sendMessage(chatId, '❌ No default repo set.\n\nFirst run: /orch set owner/repo');
        return;
      }
      await this.bot.sendChatAction(chatId, 'typing');
      try {
        const [owner, repoName] = lockedRepo.split('/');
        const { content } = await fetchRoadmapFromGitHub(owner, repoName, this.githubToken);
        const phases = parseRoadmapPhases(content);

        // Use the hierarchical resolver to find the best next task
        const resolved = resolveNextRoadmapTask(phases);

        if (!resolved) {
          await this.bot.sendMessage(chatId, '✅ All roadmap tasks are complete! Nothing to advise on.');
          return;
        }

        // Use resolved task for advise display
        const nextTask = { title: resolved.title, phase: resolved.phase };

        // Classify task complexity and recommend models
        const taskLower = nextTask.title.toLowerCase();
        const isHeavyCoding = /refactor|split|migrat|rewrite|architect|complex|multi.?file|test suite/i.test(taskLower);
        const isSimple = /add comment|update readme|rename|typo|config|bump|version/i.test(taskLower);

        // Load historical completion rates + event-based scores for model ranking
        const [histories, events] = await Promise.all([
          loadAllOrchestraHistories(this.r2Bucket),
          getRecentOrchestraEvents(this.r2Bucket, 3, undefined, 500),
        ]);
        const completionStats = getModelCompletionStats(histories);
        const eventScores = getEventBasedModelScores(events);
        const ranked = getRankedOrchestraModels({ isHeavyCoding, isSimple, completionStats, eventScores });
        const lines: string[] = [
          `🔍 **Next task:** ${nextTask.title}`,
          `📁 **Phase:** ${nextTask.phase}`,
          '',
        ];

        if (resolved.ambiguity === 'high') {
          lines.push('⚠️ Task title is generic — consider fixing the roadmap or using a strong model');
        }
        if (isHeavyCoding) {
          lines.push('🔴 Complex coding task — strong model recommended');
        } else if (isSimple) {
          lines.push('🟢 Simple task — free model should suffice');
        } else {
          lines.push('🟡 Standard task');
        }
        lines.push('');

        // Show top models grouped by tier (limit to keep output readable)
        const MAX_PAID = 8;
        const MAX_FREE = 5;
        const paidModels = ranked.filter(r => !r.isFree);
        const freeModels = ranked.filter(r => r.isFree);

        // Format model line with value indicator
        const fmtModel = (r: typeof ranked[0], showCost: boolean) => {
          const bar = r.confidence >= 80 ? '🟩' : r.confidence >= 50 ? '🟨' : '🟥';
          const value = r.valueTier === 'best' ? ' ⚡' : r.valueTier === 'premium' ? ' 💎' : '';
          const cost = showCost ? ` (${r.cost})` : '';
          const hl = r.highlights ? ` · ${r.highlights}` : '';
          return `${bar} ${r.confidence}% /${r.alias}${cost}${hl}${value}`;
        };

        if (paidModels.length > 0) {
          lines.push('💰 **Paid models** _(⚡=best value, 💎=premium)_:');
          for (const r of paidModels.slice(0, MAX_PAID)) {
            lines.push(fmtModel(r, true));
          }
          if (paidModels.length > MAX_PAID) {
            lines.push(`   _+${paidModels.length - MAX_PAID} more_`);
          }
          lines.push('');
        }

        if (freeModels.length > 0) {
          lines.push('🆓 **Free models:**');
          for (const r of freeModels.slice(0, MAX_FREE)) {
            lines.push(fmtModel(r, false));
          }
          if (freeModels.length > MAX_FREE) {
            lines.push(`   _+${freeModels.length - MAX_FREE} more_`);
          }
        }

        // Build buttons: top 3 paid + top 3 free
        const buttons: { text: string; callback_data: string }[][] = [];
        const topPaid = paidModels.slice(0, 3).map(r => ({
          text: `/${r.alias} ${r.confidence}%`, callback_data: `orchgo:${r.alias}`,
        }));
        const topFree = freeModels.slice(0, 3).map(r => ({
          text: `/${r.alias} ${r.confidence}%`, callback_data: `orchgo:${r.alias}`,
        }));
        if (isSimple) {
          if (topFree.length > 0) buttons.push(topFree);
          if (topPaid.length > 0) buttons.push(topPaid);
        } else {
          if (topPaid.length > 0) buttons.push(topPaid);
          if (topFree.length > 0) buttons.push(topFree);
        }

        // Store pending orchestra params so buttons work
        await this.storage.setPendingOrchestra(userId, chatId, { mode: 'run', repo: lockedRepo, prompt: '', chatId });

        await this.bot.sendMessage(chatId, lines.join('\n'), {
          parseMode: 'Markdown',
          reply_markup: { inline_keyboard: buttons },
        });
      } catch (error) {
        await this.bot.sendMessage(chatId, `❌ ${error instanceof Error ? error.message : 'Failed to analyze roadmap'}`);
      }
      return;
    }

    // /orch do <description> — one-shot task execution without roadmap
    if (sub === 'do') {
      const maybeRepo = args[1];
      const hasExplicitRepo = maybeRepo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(maybeRepo);
      if (hasExplicitRepo) {
        const prompt = args.slice(2).join(' ').trim();
        if (!prompt) {
          await this.bot.sendMessage(chatId, '❌ Usage: /orch do owner/repo <task description>');
          return;
        }
        await this.storage.setOrchestraRepo(userId, maybeRepo);
        return this.executeOrchestra(chatId, userId, 'do', maybeRepo, prompt);
      } else {
        const lockedRepo = await this.storage.getOrchestraRepo(userId);
        if (!lockedRepo) {
          await this.bot.sendMessage(
            chatId,
            '❌ No default repo set.\n\nEither: /orch do owner/repo <description>\nOr: /orch set owner/repo first'
          );
          return;
        }
        const prompt = args.slice(1).join(' ').trim();
        if (!prompt) {
          await this.bot.sendMessage(chatId, '❌ Usage: /orch do <task description>');
          return;
        }
        return this.executeOrchestra(chatId, userId, 'do', lockedRepo, prompt);
      }
    }

    // /orch merge <PR#> [squash|merge|rebase] — merge a PR
    if (sub === 'merge') {
      const prArg = args[1];
      if (!prArg) {
        await this.bot.sendMessage(chatId, '❌ Usage: /orch merge <PR#> [squash|merge|rebase]');
        return;
      }
      const pullNumber = parseInt(prArg.replace('#', ''), 10);
      if (isNaN(pullNumber) || pullNumber <= 0) {
        await this.bot.sendMessage(chatId, `❌ Invalid PR number: ${prArg}`);
        return;
      }
      const mergeMethod = (args[2]?.toLowerCase() || 'squash') as 'squash' | 'merge' | 'rebase';
      if (!['squash', 'merge', 'rebase'].includes(mergeMethod)) {
        await this.bot.sendMessage(chatId, `❌ Invalid merge method: ${args[2]}\nUse: squash (default), merge, or rebase`);
        return;
      }
      const lockedRepo = await this.storage.getOrchestraRepo(userId);
      if (!lockedRepo) {
        await this.bot.sendMessage(chatId, '❌ No default repo set.\n\nFirst run: /orch set owner/repo');
        return;
      }
      if (!this.githubToken) {
        await this.bot.sendMessage(chatId, '❌ GitHub token not configured.');
        return;
      }
      const [owner, repoName] = lockedRepo.split('/');
      await this.bot.sendChatAction(chatId, 'typing');
      try {
        const result = await githubMergePr(owner, repoName, pullNumber, mergeMethod, undefined, undefined, this.githubToken);
        await this.bot.sendMessage(chatId, result);
      } catch (error) {
        await this.bot.sendMessage(chatId, `❌ Merge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    // /orch next [specific task] — shorthand for run with locked repo
    if (sub === 'next') {
      const lockedRepo = await this.storage.getOrchestraRepo(userId);
      if (!lockedRepo) {
        await this.bot.sendMessage(
          chatId,
          '❌ No default repo set.\n\nFirst run: /orch set owner/repo\nThen: /orch next'
        );
        return;
      }
      // Treat remaining args as optional specific task
      const specificTask = args.slice(1).join(' ').trim();
      return this.executeOrchestra(chatId, userId, 'run', lockedRepo, specificTask);
    }

    // /orch init ... — try parsing with init/run/legacy syntax
    // Allow init and run to use locked repo when repo arg is omitted
    if (sub === 'init') {
      const maybeRepo = args[1];
      const hasExplicitRepo = maybeRepo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(maybeRepo);
      let repo: string;
      let prompt: string;
      if (hasExplicitRepo) {
        repo = maybeRepo;
        prompt = args.slice(2).join(' ').trim();
        if (!prompt) {
          await this.bot.sendMessage(chatId, '❌ Usage: /orch init owner/repo <project description>');
          return;
        }
        await this.storage.setOrchestraRepo(userId, maybeRepo);
      } else {
        const lockedRepo = await this.storage.getOrchestraRepo(userId);
        if (!lockedRepo) {
          await this.bot.sendMessage(
            chatId,
            '❌ No default repo set.\n\nEither: /orch init owner/repo <description>\nOr: /orch set owner/repo first'
          );
          return;
        }
        repo = lockedRepo;
        prompt = args.slice(1).join(' ').trim();
        if (!prompt) {
          await this.bot.sendMessage(chatId, '❌ Usage: /orch init <project description>');
          return;
        }
      }
      // Use draft mode: model generates roadmap for preview, user approves before PR
      return this.executeOrchestra(chatId, userId, 'draft', repo, prompt);
    }

    // /orch modify — modify existing roadmap via draft preview flow
    if (sub === 'modify') {
      const maybeRepo = args[1];
      const hasExplicitRepo = maybeRepo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(maybeRepo);
      let modifyRepo: string;
      let modifyPrompt: string;
      if (hasExplicitRepo) {
        modifyRepo = maybeRepo;
        modifyPrompt = args.slice(2).join(' ').trim();
        await this.storage.setOrchestraRepo(userId, maybeRepo);
      } else {
        const lockedRepo = await this.storage.getOrchestraRepo(userId);
        if (!lockedRepo) {
          await this.bot.sendMessage(chatId, '❌ No default repo set.\n\nUse: /orch modify owner/repo <changes>\nOr: /orch set owner/repo first');
          return;
        }
        modifyRepo = lockedRepo;
        modifyPrompt = args.slice(1).join(' ').trim();
      }
      if (!modifyPrompt) {
        await this.bot.sendMessage(chatId, '❌ Usage: /orch modify [owner/repo] <description of changes>\n\nExample: /orch modify Add a phase for API documentation');
        return;
      }
      // Use draft mode with a modify-specific prompt that reads the existing roadmap
      const modifyFullPrompt = `MODIFY EXISTING ROADMAP: Read the current ROADMAP.md from the repo first, then apply these changes: ${modifyPrompt}`;
      return this.executeOrchestra(chatId, userId, 'draft', modifyRepo, modifyFullPrompt);
    }

    // /orch plan — conversational requirements gathering
    if (sub === 'plan') {
      const maybeRepo = args[1];
      const hasExplicitRepo = maybeRepo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(maybeRepo);
      let planRepo: string;
      if (hasExplicitRepo) {
        planRepo = maybeRepo;
        await this.storage.setOrchestraRepo(userId, maybeRepo);
      } else {
        const lockedRepo = await this.storage.getOrchestraRepo(userId);
        if (!lockedRepo) {
          await this.bot.sendMessage(chatId, '❌ No default repo set.\n\nUse: /orch plan owner/repo\nOr: /orch set owner/repo first');
          return;
        }
        planRepo = lockedRepo;
      }
      // Enter planning mode (keyed by userId+chatId)
      await this.storage.setOrchestraPlan(userId, chatId, {
        repo: planRepo,
        chatId,
        requirements: [],
      });
      await this.bot.sendMessage(
        chatId,
        `📝 Planning mode for **${planRepo}**\n\n` +
        `Send your requirements — describe what the roadmap should cover.\n` +
        `You can send multiple messages. When done, tap Generate Draft.\n\n` +
        `💡 Tip: be specific about features, phases, and priorities.`,
      );
      // Send generate button separately so it stays visible
      await this.bot.sendMessage(chatId, 'Ready when you are.', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📝 Generate Draft', callback_data: 'orchplan:generate' },
              { text: '❌ Cancel', callback_data: 'orchplan:cancel' },
            ],
          ],
        },
      });
      return;
    }

    // /orch draft — trigger draft generation from planning mode
    if (sub === 'draft') {
      const plan = await this.storage.getOrchestraPlan(userId, chatId);
      if (!plan || plan.requirements.length === 0) {
        await this.bot.sendMessage(chatId, '❌ No planning session active. Start with /orch plan owner/repo');
        return;
      }
      const combinedPrompt = plan.requirements.join('\n\n');
      await this.storage.setOrchestraPlan(userId, chatId, null); // Clear planning state
      return this.executeOrchestra(chatId, userId, 'draft', plan.repo, combinedPrompt);
    }

    if (sub === 'run') {
      const maybeRepo = args[1];
      const hasExplicitRepo = maybeRepo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(maybeRepo);
      if (hasExplicitRepo) {
        const specificTask = args.slice(2).join(' ').trim();
        return this.executeOrchestra(chatId, userId, 'run', maybeRepo, specificTask);
      } else {
        // /orch run [task] — use locked repo
        const lockedRepo = await this.storage.getOrchestraRepo(userId);
        if (!lockedRepo) {
          await this.bot.sendMessage(
            chatId,
            '❌ No default repo set.\n\nEither: /orch run owner/repo\nOr: /orch set owner/repo first'
          );
          return;
        }
        const specificTask = args.slice(1).join(' ').trim();
        return this.executeOrchestra(chatId, userId, 'run', lockedRepo, specificTask);
      }
    }

    // /orch stats [model] — show aggregated event metrics
    if (sub === 'stats') {
      if (!this.r2Bucket) {
        await this.bot.sendMessage(chatId, '❌ R2 not configured.');
        return;
      }
      const modelFilter = args[1] || undefined;
      const events = await getRecentOrchestraEvents(this.r2Bucket, 2, modelFilter);
      if (events.length === 0) {
        await this.bot.sendMessage(chatId, modelFilter
          ? `📊 No orchestra events found for *${modelFilter}* in last 2 months.`
          : '📊 No orchestra events recorded yet.',
          { parseMode: 'Markdown' });
        return;
      }
      const stats = aggregateOrchestraStats(events);
      const lines: string[] = ['📊 *Orchestra Stats* (last 2 months)\n'];
      // Event type breakdown
      lines.push('*Events by type:*');
      for (const [type, count] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
        const icon = type === 'task_complete' ? '✅' : type.includes('stall') ? '🛑' : type.includes('abort') ? '⏹' : type.includes('validation') ? '❌' : '🔄';
        lines.push(`  ${icon} ${type}: ${count}`);
      }
      // Per-model breakdown
      lines.push('\n*Per model:*');
      const sortedModels = Object.entries(stats.byModel)
        .sort((a, b) => b[1].total - a[1].total);
      for (const [model, m] of sortedModels) {
        const rate = m.total > 0 ? Math.round((m.completions / m.total) * 100) : 0;
        const bar = rate >= 75 ? '🟩' : rate >= 50 ? '🟨' : '🟥';
        lines.push(`  ${bar} *${model}*: ${m.completions}/${m.total} ok (${rate}%) — ${m.failures} fail`);
      }
      lines.push(`\n_Total: ${stats.total} events — overall success: ${stats.successRate}%_`);
      await this.bot.sendMessage(chatId, lines.join('\n'), { parseMode: 'Markdown' });
      return;
    }

    // Legacy: /orch owner/repo <prompt> — treated as run
    const parsed = parseOrchestraCommand(args);
    if (parsed) {
      return this.executeOrchestra(chatId, userId, parsed.mode, parsed.repo, parsed.prompt);
    }

    // No valid subcommand — show help with action buttons
    const lockedRepo = await this.storage.getOrchestraRepo(userId);
    const repoLine = lockedRepo
      ? `📦 Current repo: ${lockedRepo}\n\n`
      : '📦 No repo set — use /orch set owner/repo first\n\n';

    const modelRecs = formatOrchestraModelRecs();

    // Build inline buttons for main actions
    const orchButtons: InlineKeyboardButton[][] = [];
    if (lockedRepo) {
      // Primary actions (only when repo is set)
      orchButtons.push([
        { text: '▶️ Next Task', callback_data: 'orch:next' },
        { text: '🔍 Advise', callback_data: 'orch:advise' },
        { text: '📋 Roadmap', callback_data: 'orch:roadmap' },
      ]);
      orchButtons.push([
        { text: '📜 History', callback_data: 'orch:history' },
        { text: '📊 Stats', callback_data: 'orch:stats' },
        { text: '🔓 Unset Repo', callback_data: 'orch:unset' },
      ]);
    } else {
      orchButtons.push([
        { text: '📜 History', callback_data: 'orch:history' },
        { text: '📊 Stats', callback_data: 'orch:stats' },
      ]);
    }

    await this.bot.sendMessage(
      chatId,
      '🎼 Orchestra Mode — AI-Driven Project Execution\n\n' +
      repoLine +
      '━━━ Quick Start ━━━\n' +
      '/orch set owner/repo — Lock your repo\n' +
      '/orch do <description> — One-shot task (no roadmap)\n' +
      '/orch init <description> — Create roadmap + work log\n' +
      '/orch next — Execute next roadmap task\n\n' +
      '━━━ Commands ━━━\n' +
      '/orch do <description> — Execute a task directly (no roadmap)\n' +
      '/orch init <description> — Plan: create roadmap (no code)\n' +
      '/orch advise — Analyze next task & pick best model\n' +
      '/orch next [task] — Run next (or specific) task\n' +
      '/orch roadmap — View roadmap status\n' +
      '/orch history — View past tasks\n' +
      '/orch stats [model] — Event metrics (stalls, aborts)\n' +
      '/orch reset <task> — Uncheck for re-run\n' +
      '/orch merge <PR#> [method] — Merge a PR (squash/merge/rebase)\n' +
      '/orch redo <task> — Re-implement a failed task\n\n' +
      modelRecs + '\n\n' +
      '━━━ Workflows ━━━\n' +
      'Simple task (no roadmap):\n' +
      '1. /orch set PetrAnto/myapp\n' +
      '2. /orch do Add dark mode toggle\n\n' +
      'Complex project (with roadmap):\n' +
      '1. /orch set PetrAnto/myapp\n' +
      '2. /orch init Build a user auth system\n' +
      '3. /orch advise → pick best model\n' +
      '4. /orch next (repeat until done)',
      { reply_markup: { inline_keyboard: orchButtons } },
    );
  }

  /**
   * Commit an approved draft roadmap — delegates to centralized commitDraftRoadmap in orchestra.ts.
   */
  private async commitDraftRoadmap(userId: string, chatId: number, draft: OrchestraDraft): Promise<string> {
    if (!this.githubToken) throw new Error('GitHub token not configured');
    return commitDraftRoadmap({
      githubToken: this.githubToken,
      draft,
      userId,
      r2: this.r2Bucket,
    });
  }

  /**
   * Re-run draft generation with user revision feedback.
   * Uses buildDraftInitPrompt with the previous draft + revision text.
   */
  private async executeOrchestraDraftRevision(
    chatId: number,
    userId: string,
    draft: OrchestraDraft,
    revisionText: string,
  ): Promise<void> {
    await this.bot.sendMessage(chatId, `✏️ Revising roadmap (revision #${draft.revisionCount})...`);
    // Route through the normal draft flow but with revision context
    // The buildDraftInitPrompt will include the previous draft and revision text
    return this.executeOrchestra(chatId, userId, 'draft', draft.repo, draft.userPrompt, false, {
      revision: revisionText,
      previousDraft: draft.roadmapContent,
    });
  }

  /**
   * Execute an orchestra init or run task.
   * Extracted from handleOrchestraCommand to share between subcommands.
   */
  private async executeOrchestra(
    chatId: number,
    userId: string,
    mode: 'init' | 'run' | 'redo' | 'do' | 'draft',
    repo: string,
    prompt: string,
    skipModelGuard: boolean = false,
    draftRevision?: { revision: string; previousDraft: string },
  ): Promise<void> {
    // Clean up stale orchestra tasks before starting new work
    if (this.r2Bucket) {
      await cleanupStaleTasks(this.r2Bucket, userId);
    }

    // Verify prerequisites
    if (!this.githubToken) {
      await this.bot.sendMessage(chatId, '❌ GitHub token not configured. Orchestra mode requires GITHUB_TOKEN.');
      return;
    }
    if (!this.taskProcessor) {
      await this.bot.sendMessage(chatId, '❌ Task processor not available. Orchestra mode requires Durable Objects.');
      return;
    }

    let modelAlias = await this.storage.getUserModel(userId);
    const modelInfo = getModel(modelAlias);

    if (!modelInfo?.supportsTools) {
      // Hard block: model can't call tools at all
      const recs = getOrchestraRecommendations();
      const freeButtons = recs.free.slice(0, 3).map(r => ({
        text: `/${r.alias} (free)`, callback_data: `orchgo:${r.alias}`,
      }));
      const paidButtons = recs.paid.slice(0, 2).map(r => ({
        text: `/${r.alias} ${r.cost}`, callback_data: `orchgo:${r.alias}`,
      }));
      // Store pending orchestra params for the callback (keyed by userId+chatId)
      await this.storage.setPendingOrchestra(userId, chatId, { mode, repo, prompt, chatId });
      await this.bot.sendMessage(
        chatId,
        `❌ /${modelAlias} doesn't support tools — orchestra requires tool-calling.\n\nPick a model:`,
        { reply_markup: { inline_keyboard: [freeButtons, paidButtons] } },
      );
      return;
    }

    // Soft warning: model supports tools but isn't orchestra-ready.
    // Models without orchestraReady (undefined) are treated as not ready —
    // only explicitly true models pass. This catches auto-synced models
    // (e.g. 12B Nemotron) that technically support tools but can't do multi-step tasks.
    // Exception: models with proven event history (1+ task_complete) skip the gate.
    let hasProvenHistory = false;
    if (modelInfo.orchestraReady !== true && !skipModelGuard && this.r2Bucket) {
      const events = await getRecentOrchestraEvents(this.r2Bucket, 3, modelAlias, 50);
      hasProvenHistory = events.some(ev => ev.eventType === 'task_complete');
    }
    if (modelInfo.orchestraReady !== true && !modelInfo.isImageGen && !skipModelGuard && !hasProvenHistory) {
      const recs = getOrchestraRecommendations();
      const betterModels = [...recs.free.slice(0, 2), ...recs.paid.slice(0, 2)];
      const buttons = betterModels.map(r => ({
        text: `/${r.alias}${r.cost !== 'Free' ? ` ${r.cost}` : ' (free)'}`,
        callback_data: `orchgo:${r.alias}`,
      }));
      buttons.push({ text: `Proceed with /${modelAlias}`, callback_data: 'orchgo:proceed' });
      // Store pending orchestra params for the callback (keyed by userId+chatId)
      await this.storage.setPendingOrchestra(userId, chatId, { mode, repo, prompt, chatId });
      const warnings: string[] = [];
      let isUnknown = false;
      if (!modelInfo.intelligenceIndex && !modelInfo.benchmarks?.coding) {
        warnings.push('no benchmark data');
        isUnknown = true;
      } else {
        if (modelInfo.intelligenceIndex && modelInfo.intelligenceIndex < 45) {
          warnings.push(`low intelligence score (${modelInfo.intelligenceIndex.toFixed(0)})`);
        }
        if (modelInfo.benchmarks?.coding && modelInfo.benchmarks.coding < 30) {
          warnings.push(`weak coding benchmark (${modelInfo.benchmarks.coding.toFixed(0)})`);
        }
      }
      if ((modelInfo.maxContext || 0) < 64000) {
        warnings.push(`small context (${Math.round((modelInfo.maxContext || 0) / 1000)}K)`);
      }
      // Flag small models by name pattern (Nano, Mini, Small, etc.)
      if (/\b(nano|mini|small|lite|tiny)\b/i.test(modelInfo.name)) {
        warnings.push('small model — may produce invalid tool calls');
      }
      const warnStr = warnings.length > 0 ? ` (${warnings.join(', ')})` : '';
      const header = isUnknown
        ? `⚠️ /${modelAlias} is untested for orchestra${warnStr}.\nIt may work fine — tap Proceed to try, or pick a proven model:`
        : `⚠️ /${modelAlias} may struggle with orchestra tasks${warnStr}.\n\nRecommended models:`;
      await this.bot.sendMessage(
        chatId,
        header,
        { reply_markup: { inline_keyboard: [buttons.slice(0, 4), buttons.slice(4)] } },
      );
      return;
    }

    await this.bot.sendChatAction(chatId, 'typing');

    // Load orchestra history for context injection
    const history = await loadOrchestraHistory(this.r2Bucket, userId);
    const previousTasks = history?.tasks.filter(t => t.repo === repo) || [];

    // For run/redo mode, pre-fetch roadmap + work log to inject into prompt.
    // This eliminates 1-2 LLM round-trips (Step 1: READ ROADMAP + read WORK_LOG).
    let resolvedTask = prompt;
    let resolvedExecutionBrief: string | undefined;
    let executionProfile: OrchestraExecutionProfile | undefined;
    let prefetchedRoadmap: string | undefined;
    let prefetchedRoadmapPath: string | undefined;
    let prefetchedWorkLog: string | undefined;
    if (mode !== 'init' && mode !== 'do' && this.githubToken) {
      const [owner, repoName] = repo.split('/');
      try {
        const { content, path: roadmapPath } = await fetchRoadmapFromGitHub(owner, repoName, this.githubToken);
        prefetchedRoadmap = content;
        prefetchedRoadmapPath = roadmapPath;

        // Resolve next task using hierarchical resolver (not flat first-undone)
        if (mode === 'run' && !prompt) {
          const phases = parseRoadmapPhases(content);
          const resolved = resolveNextRoadmapTask(phases);
          if (resolved) {
            resolvedTask = resolved.title;
            // Store the execution brief for injection into the user message
            resolvedExecutionBrief = resolved.executionBrief;
            // Build centralized execution profile — drives sandbox, resume, and routing decisions
            executionProfile = buildExecutionProfile(resolved, modelAlias);
            console.log(`[orchestra] executionProfile: tier=${executionProfile.bounds.complexityTier} ambiguity=${executionProfile.intent.ambiguity} sandbox=${executionProfile.bounds.requiresSandbox} maxResumes=${executionProfile.bounds.maxAutoResumes} expectedTools=${executionProfile.bounds.expectedTools} expectedWallClock=${Math.round(executionProfile.bounds.expectedWallClockMs / 1000)}s promptTier=${executionProfile.routing.promptTier} children=${executionProfile.intent.pendingChildren}`);
          }
        }

        // Pre-fetch WORK_LOG.md (best-effort)
        try {
          const { githubReadFile: readFile } = await import('../openrouter/tools');
          prefetchedWorkLog = await readFile(owner, repoName, 'WORK_LOG.md', undefined, this.githubToken);
        } catch {
          // WORK_LOG.md may not exist yet — that's fine
        }
      } catch {
        // Roadmap fetch failed — let the model figure it out
      }
    }

    // Force-escalation: if profile detects heavy task on weak model, auto-upgrade
    // to the top-ranked free orchestra model. If the best free model still doesn't
    // meet the model floor, suggest a paid model (but don't auto-switch to paid).
    if (executionProfile?.routing.forceEscalation) {
      const recs = getOrchestraRecommendations();
      const upgrade = recs.free[0]; // Top-ranked free model
      if (upgrade && upgrade.alias !== modelAlias) {
        const origAlias = modelAlias;
        modelAlias = upgrade.alias;
        // Re-resolve model info for the upgraded model
        const upgradedInfo = getModel(modelAlias);
        if (upgradedInfo) {
          // Recompute profile with upgraded model
          const phases = prefetchedRoadmap ? parseRoadmapPhases(prefetchedRoadmap) : [];
          const resolved = phases.length > 0 ? resolveNextRoadmapTask(phases) : undefined;
          if (resolved) {
            executionProfile = buildExecutionProfile(resolved, modelAlias);
          }
        }
        // Check if upgraded model meets the model floor
        const upgradedIQ = upgradedInfo?.intelligenceIndex ?? (upgradedInfo?.isFree ? 20 : 50);
        const floor = executionProfile?.routing.modelFloor ?? 0;
        if (floor > 0 && upgradedIQ < floor && recs.paid.length > 0) {
          // Best free model is still below floor — suggest paid alternative
          const paidSuggestion = recs.paid[0];
          await this.bot.sendMessage(
            chatId,
            `⚡ Auto-escalated: /${origAlias} → /${modelAlias} (heavy task requires stronger model)\n` +
            `⚠️ Best free model (IQ:${upgradedIQ}) is below the recommended floor (IQ:${floor}) for this task. ` +
            `Consider /${paidSuggestion.alias} ${paidSuggestion.why} for better results.`,
          );
        } else {
          await this.bot.sendMessage(
            chatId,
            `⚡ Auto-escalated: /${origAlias} → /${modelAlias} (heavy task requires stronger model)`,
          );
        }
        console.log(`[orchestra] forceEscalation: ${origAlias} → ${modelAlias} (floor=${floor}, IQ=${upgradedIQ}) for heavy task "${resolvedTask?.substring(0, 80)}"`);
      }
    }

    // Determine branch name — append short timestamp suffix to prevent branch collisions
    const branchSuffix = Date.now().toString(36).slice(-4); // 4-char unique suffix
    const taskSlug = mode === 'init' || mode === 'draft'
      ? 'roadmap-init'
      : mode === 'do'
      ? `do-${generateTaskSlug(prompt)}`
      : mode === 'redo'
      ? `redo-${generateTaskSlug(prompt)}`
      : generateTaskSlug(resolvedTask || 'next-task');
    const branchName = `bot/${taskSlug}-${modelAlias}-${branchSuffix}`;

    // Build mode-specific system prompt
    let orchestraSystemPrompt: string;
    // Strip bot/ prefix to get the slug the model should use in tool calls
    const branchSlug = branchName.replace(/^bot\//, '');
    if (mode === 'draft') {
      orchestraSystemPrompt = buildDraftInitPrompt({
        repo, modelAlias,
        revision: draftRevision?.revision,
        previousDraft: draftRevision?.previousDraft,
      });
    } else if (mode === 'init') {
      orchestraSystemPrompt = buildInitPrompt({ repo, modelAlias, branchSlug });
    } else if (mode === 'do') {
      orchestraSystemPrompt = buildDoPrompt({ repo, modelAlias, branchSlug, hasSandbox: !!this.sandbox });
    } else if (mode === 'redo') {
      orchestraSystemPrompt = buildRedoPrompt({
        repo,
        modelAlias,
        previousTasks,
        taskToRedo: prompt,
      });
    } else {
      orchestraSystemPrompt = buildRunPrompt({
        repo,
        modelAlias,
        previousTasks,
        // When we have an execution brief, pass it instead of the bare task title
        // so the system prompt has full context, not just a title
        specificTask: resolvedExecutionBrief ? undefined : (resolvedTask || undefined),
        executionBrief: resolvedExecutionBrief,
        branchSlug,
        // Profile-driven sandbox gating: skip sandbox instructions for simple+concrete tasks
        hasSandbox: !!this.sandbox && (executionProfile?.bounds.requiresSandbox ?? true),
        // Profile-driven prompt tier: single source of truth (avoids recomputing in buildRunPrompt)
        promptTierOverride: executionProfile?.routing.promptTier,
        roadmapContent: prefetchedRoadmap,
        roadmapPath: prefetchedRoadmapPath,
        workLogContent: prefetchedWorkLog,
      });
    }

    // Inject learnings, memory, and last task context — skip for INIT mode (no prior context needed, reduces token bloat)
    let memoryHint = '';
    let learningsHint = '';
    let lastTaskHint = '';
    let sessionContext = '';
    if (mode !== 'init') {
      const contextPrompt = resolvedTask || prompt || 'Execute next roadmap task';
      [memoryHint, learningsHint, lastTaskHint, sessionContext] = await Promise.all([
        this.getMemoryHint(userId),
        this.getLearningsHint(userId, contextPrompt),
        this.getLastTaskHint(userId),
        this.getSessionContext(userId, contextPrompt),
      ]);
    }

    const toolHint = modelInfo.parallelCalls
      ? '\n\nCall multiple tools in parallel when possible (e.g., read multiple files at once).'
      : '';

    // Build messages for the task
    // Build user message — use structured execution brief when available
    const userMessage = mode === 'draft'
      ? prompt
      : mode === 'init'
      ? prompt
      : mode === 'do'
      ? prompt
      : mode === 'redo'
      ? `Redo this task: ${prompt}`
      : resolvedExecutionBrief
      ? `Execute this roadmap work item.\n\n${resolvedExecutionBrief}\n\nDo not switch to another task unless this one is impossible.`
      : resolvedTask
      ? `Execute this task: ${resolvedTask}`
      : 'Execute the next uncompleted task from the roadmap.';
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: orchestraSystemPrompt + toolHint + memoryHint + learningsHint + lastTaskHint + sessionContext,
      },
      { role: 'user', content: userMessage },
    ];

    // Store the orchestra task entry as "started"
    const orchestraTask: OrchestraTask = {
      taskId: `orch-${userId}-${Date.now()}`,
      timestamp: Date.now(),
      modelAlias,
      repo,
      mode,
      prompt: (resolvedTask || prompt || (mode === 'init' ? 'Roadmap creation' : 'Next roadmap task')).substring(0, 200),
      branchName,
      status: 'started',
      filesChanged: [],
    };

    // F.23: Acquire repo-level concurrency lock to prevent parallel tasks on same repo.
    // Must happen before storeOrchestraTask to avoid storing an entry we'll never execute.
    if (this.r2Bucket) {
      let { acquired, existingLock } = await acquireRepoLock(
        this.r2Bucket, userId, repo, orchestraTask.taskId, branchName
      );
      // Stale lock recovery: if the lock's task already completed/failed in history,
      // force-release and re-acquire. This handles DO eviction before lock release.
      if (!acquired && existingLock) {
        try {
          const history = await loadOrchestraHistory(this.r2Bucket, userId);
          const lockedTask = history?.tasks.find(t => t.taskId === existingLock!.taskId);
          if (lockedTask && lockedTask.status !== 'started') {
            console.log(`[orchestra] Stale lock detected: task ${existingLock.taskId} is ${lockedTask.status}, force-releasing`);
            await forceReleaseRepoLock(this.r2Bucket, userId, repo);
            const retry = await acquireRepoLock(
              this.r2Bucket, userId, repo, orchestraTask.taskId, branchName
            );
            acquired = retry.acquired;
            existingLock = retry.existingLock;
          }
        } catch { /* best-effort stale lock recovery */ }
      }
      if (!acquired && existingLock) {
        const elapsed = Math.round((Date.now() - existingLock.acquiredAt) / 60000);
        await this.bot.sendMessage(chatId,
          `🔒 Another orchestra task is already running on ${repo}.\n\n` +
          `Active: ${existingLock.branchName} (started ${elapsed}min ago)\n\n` +
          `Wait for it to finish, or use /cancel to stop it first.`,
        );
        return;
      }
    }

    await storeOrchestraTask(this.r2Bucket, userId, orchestraTask);

    // Dispatch to TaskProcessor DO
    const taskId = `${userId}-${Date.now()}`;
    const autoResume = await this.storage.getUserAutoResume(userId);
    const modeLabel = mode === 'draft' ? 'Draft' : mode === 'init' ? 'Init' : mode === 'do' ? 'Do' : mode === 'redo' ? 'Redo' : 'Run';
    const taskRequest: TaskRequest = {
      taskId,
      chatId,
      userId,
      modelAlias,
      messages,
      telegramToken: this.telegramToken,
      openrouterKey: this.openrouterKey,
      githubToken: this.githubToken,
      braveSearchKey: this.braveSearchKey,
      cloudflareApiToken: this.cloudflareApiToken,
      dashscopeKey: this.dashscopeKey,
      moonshotKey: this.moonshotKey,
      deepseekKey: this.deepseekKey,
      anthropicKey: this.anthropicKey,
      autoResume,
      prompt: `[Orchestra ${modeLabel}] ${repo}: ${(resolvedTask || prompt || 'next task').substring(0, 150)}`,
      acontextKey: this.acontextKey,
      acontextBaseUrl: this.acontextBaseUrl,
      executionProfile,
      orchestraRepo: repo,
      isDraftInit: mode === 'draft',
    };

    const doId = this.taskProcessor.idFromName(userId);
    const doStub = this.taskProcessor.get(doId);
    await fetchDOWithRetry(doStub, new Request('https://do/process', {
      method: 'POST',
      body: JSON.stringify(taskRequest),
    }));

    await this.storage.addMessage(userId, 'user', `[Orchestra ${modeLabel}: ${repo}] ${resolvedTask || prompt || 'next task'}`);

    // Mode-specific confirmation message
    if (mode === 'draft') {
      await this.bot.sendMessage(
        chatId,
        `🎼 Generating roadmap draft...\n\n` +
        `📦 Repo: ${repo}\n` +
        `🤖 Model: /${modelAlias}\n\n` +
        `The bot will analyze the repo and generate a roadmap preview for you to review.\n` +
        `Use /cancel to stop.`
      );
    } else if (mode === 'init') {
      await this.bot.sendMessage(
        chatId,
        `🎼 Orchestra INIT started!\n\n` +
        `📦 Repo: ${repo}\n` +
        `🤖 Model: /${modelAlias}\n` +
        `🌿 Branch: ${branchName}\n\n` +
        `The bot will analyze the repo, create ROADMAP.md + WORK_LOG.md, and open a PR.\n` +
        `Use /cancel to stop.`
      );
    } else if (mode === 'do') {
      await this.bot.sendMessage(
        chatId,
        `🎼 Orchestra DO started!\n\n` +
        `📦 Repo: ${repo}\n` +
        `🤖 Model: /${modelAlias}\n` +
        `🌿 Branch: ${branchName}\n` +
        `📝 Task: ${prompt.substring(0, 150)}${prompt.length > 150 ? '...' : ''}\n\n` +
        `One-shot execution — no roadmap needed. The bot will implement and open a PR.\n` +
        `Use /cancel to stop.`
      );
    } else if (mode === 'redo') {
      await this.bot.sendMessage(
        chatId,
        `🎼 Orchestra REDO started!\n\n` +
        `📦 Repo: ${repo}\n` +
        `🤖 Model: /${modelAlias}\n` +
        `🌿 Branch: ${branchName}\n` +
        `🔄 Redoing: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}\n\n` +
        `The bot will:\n` +
        `1. Read the roadmap and find the task\n` +
        `2. Examine what the previous attempt did wrong\n` +
        `3. Re-implement it properly\n` +
        `4. Create a PR with the fix + updated roadmap\n\n` +
        `Use /cancel to stop.`
      );
    } else {
      const effectiveTask = resolvedTask || prompt;
      const taskDesc = effectiveTask
        ? `📝 Task: ${effectiveTask.substring(0, 100)}${effectiveTask.length > 100 ? '...' : ''}`
        : '📝 Task: next uncompleted from roadmap';
      // Build profile info line for the confirmation message
      const profileInfo = executionProfile
        ? `\n📊 Profile: ${executionProfile.bounds.complexityTier} scope, ` +
          `${executionProfile.intent.ambiguity} ambiguity, ` +
          `${executionProfile.bounds.requiresSandbox ? 'sandbox' : 'no sandbox'}, ` +
          `${executionProfile.bounds.maxAutoResumes} resumes` +
          (executionProfile.intent.pendingChildren > 0 ? `, ${executionProfile.intent.pendingChildren} sub-steps` : '') +
          (executionProfile.routing.forceEscalation ? '\n⚠️ Heavy task on weak model — consider upgrading' : '')
        : '';
      await this.bot.sendMessage(
        chatId,
        `🎼 Orchestra RUN started!\n\n` +
        `📦 Repo: ${repo}\n` +
        `🤖 Model: /${modelAlias}\n` +
        `🌿 Branch: ${branchName}\n` +
        `${taskDesc}${profileInfo}\n\n` +
        `The bot will read the roadmap, implement the task, update ROADMAP.md + WORK_LOG.md, and create a PR.\n` +
        `Use /cancel to stop.`
      );
    }
  }

  /**
   * Handle /briefing command
   * Usage: /briefing — use saved location (or prompt to set one)
   * Usage: /briefing set <city> — save location for future briefings
   * Usage: /briefing <city> — one-off briefing for that city
   * Usage: /briefing <lat,lon> [subreddit] [arxiv_category] — explicit coords
   */
  private async handleBriefingCommand(chatId: number, userId: string, args: string[]): Promise<void> {
    await this.bot.sendChatAction(chatId, 'typing');

    let subreddit = 'technology';
    let arxivCategory = 'cs.AI';

    // Handle "set <city>" subcommand
    if (args.length >= 2 && args[0].toLowerCase() === 'set') {
      const cityQuery = args.slice(1).join(' ');
      const geo = await geocodeCity(cityQuery);
      if (!geo) {
        await this.bot.sendMessage(chatId, `Could not find location "${cityQuery}". Try a different city name.`);
        return;
      }
      // Save to user preferences
      const prefs = await this.storage.getPreferences(userId);
      prefs.locationLat = geo.lat;
      prefs.locationLon = geo.lon;
      prefs.locationName = geo.displayName;
      await this.storage.setPreferences(prefs);
      await this.bot.sendMessage(chatId, `Location saved: ${geo.displayName}\nYour briefings will now use this location.`);
      return;
    }

    // Resolve coordinates: explicit coords > city arg > saved pref > no default
    let latitude: string | undefined;
    let longitude: string | undefined;

    if (args.length > 0) {
      // Check for lat,lon format
      const coordMatch = args[0].match(/^(-?[\d.]+),(-?[\d.]+)$/);
      if (coordMatch) {
        latitude = coordMatch[1];
        longitude = coordMatch[2];
        if (args.length > 1) subreddit = args[1];
        if (args.length > 2) arxivCategory = args[2];
      } else {
        // Treat as city name for one-off geocoding
        const cityQuery = args.join(' ');
        const geo = await geocodeCity(cityQuery);
        if (!geo) {
          await this.bot.sendMessage(chatId, `Could not find location "${cityQuery}". Try a different city name or use /briefing set <city> to save your location.`);
          return;
        }
        latitude = geo.lat;
        longitude = geo.lon;
      }
    } else {
      // No args — use saved location
      const prefs = await this.storage.getPreferences(userId);
      if (prefs.locationLat && prefs.locationLon) {
        latitude = prefs.locationLat;
        longitude = prefs.locationLon;
      } else {
        await this.bot.sendMessage(chatId, 'No location set. Use /briefing set <city> to save your location, or /briefing <city> for a one-off briefing.');
        return;
      }
    }

    try {
      const briefing = await generateDailyBriefing(latitude, longitude, subreddit, arxivCategory);

      // Split and send if too long for Telegram
      if (briefing.length > 4000) {
        const chunks = this.splitMessage(briefing, 4000);
        for (const chunk of chunks) {
          await this.bot.sendMessage(chatId, chunk);
        }
      } else {
        await this.bot.sendMessage(chatId, briefing);
      }
    } catch (error) {
      await this.bot.sendMessage(chatId, `Briefing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle /costs command
   * Usage: /costs - today's usage
   *        /costs week - 7-day breakdown
   */
  private async handleCostsCommand(chatId: number, userId: string, args: string[]): Promise<void> {
    if (args.length > 0 && args[0].toLowerCase() === 'week') {
      const records = getUsageRange(userId, 7);
      await this.bot.sendMessage(chatId, formatWeekSummary(records));
    } else {
      const record = getUsage(userId);
      await this.bot.sendMessage(chatId, formatUsageSummary(record));
    }
  }

  /**
   * Handle vision (image + text)
   */
  private async handleVision(message: TelegramMessage): Promise<void> {
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);
    const caption = message.caption || 'What is in this image?';

    await this.bot.sendChatAction(chatId, 'typing');

    // Get user's model
    let modelAlias = await this.storage.getUserModel(userId);

    // Check if model supports vision, fallback if not
    if (!supportsVision(modelAlias)) {
      modelAlias = 'gpt'; // Fallback to GPT-4o for vision
    }

    try {
      // Get the largest photo
      const photo = message.photo![message.photo!.length - 1];
      const file = await this.bot.getFile(photo.file_id);

      if (!file.file_path) {
        await this.bot.sendMessage(chatId, 'Could not download image.');
        return;
      }

      const base64 = await this.bot.downloadFileBase64(file.file_path);

      // Build multimodal user message with image + text
      const visionMessage: ChatMessage = {
        role: 'user',
        content: [
          { type: 'text', text: caption },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      };

      // If model supports tools, route through tool-calling path (DO or fallback)
      if (modelSupportsTools(modelAlias)) {
        const history = await this.storage.getConversation(userId, 10);
        const systemPrompt = await this.getSystemPrompt();
        const visionModelInfo = getModel(modelAlias);
        const visionParallelHint = visionModelInfo?.parallelCalls
          ? ' Call multiple tools in parallel when possible.'
          : '';
        const toolHint = `\n\nYou have access to tools (web browsing, GitHub, weather, news, currency conversion, charts, code execution, etc). Use them proactively — don't guess when you can look up real data.${visionParallelHint} Tools are fast and free; prefer using them over making assumptions.`;
        const learningsHint = await this.getLearningsHint(userId, caption);
        const lastTaskHint = await this.getLastTaskHint(userId);
        const sessionCtx = await this.getSessionContext(userId, caption);

        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt + toolHint + learningsHint + lastTaskHint + sessionCtx },
          ...history.map(msg => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
          })),
          visionMessage,
        ];

        if (this.taskProcessor) {
          // Route to Durable Object for vision + tools
          const taskId = `${userId}-${Date.now()}`;
          const autoResume = await this.storage.getUserAutoResume(userId);
          const taskRequest: TaskRequest = {
            taskId,
            chatId,
            userId,
            modelAlias,
            messages,
            telegramToken: this.telegramToken,
            openrouterKey: this.openrouterKey,
            githubToken: this.githubToken,
            braveSearchKey: this.braveSearchKey,
            cloudflareApiToken: this.cloudflareApiToken,
            dashscopeKey: this.dashscopeKey,
            moonshotKey: this.moonshotKey,
            deepseekKey: this.deepseekKey,
            anthropicKey: this.anthropicKey,
            autoResume,
            acontextKey: this.acontextKey,
            acontextBaseUrl: this.acontextBaseUrl,
          };

          const doId = this.taskProcessor.idFromName(userId);
          const doStub = this.taskProcessor.get(doId);
          await fetchDOWithRetry(doStub, new Request('https://do/process', {
            method: 'POST',
            body: JSON.stringify(taskRequest),
          }));

          await this.storage.addMessage(userId, 'user', `[Image] ${caption}`);
          return;
        }

        // Fallback: direct tool-calling with vision
        const { finalText, toolsUsed } = await this.openrouter.chatCompletionWithTools(
          modelAlias, messages, {
            maxToolCalls: 10,
            maxTimeMs: 120000,
            toolContext: { githubToken: this.githubToken, braveSearchKey: this.braveSearchKey, cloudflareApiToken: this.cloudflareApiToken, browser: this.browser, sandbox: this.sandbox, acontextClient: createAcontextClient(this.acontextKey, this.acontextBaseUrl), acontextSessionId: `chat-${userId}`, r2Bucket: this.r2Bucket, r2FilePrefix: `files/${userId}/` },
          }
        );

        await this.storage.addMessage(userId, 'user', `[Image] ${caption}`);
        await this.storage.addMessage(userId, 'assistant', finalText);
        const toolSuffix = toolsUsed.length > 0 ? `\n\n[Tools: ${toolsUsed.join(', ')}]` : '';
        await this.bot.sendMessage(chatId, finalText + toolSuffix);
        return;
      }

      // Non-tool model: use simple vision call
      const response = await this.openrouter.chatCompletionWithVision(
        modelAlias,
        caption,
        base64,
        'image/jpeg'
      );

      const responseText = extractTextResponse(response);
      await this.storage.addMessage(userId, 'user', `[Image] ${caption}`);
      await this.storage.addMessage(userId, 'assistant', responseText);
      await this.bot.sendMessage(chatId, responseText);
    } catch (error) {
      await this.bot.sendMessage(chatId, `Vision analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Resolve the model to use for resume, with escalation logic.
   * If the last checkpoint was on a weak free model and the task is coding-related,
   * suggest (or auto-switch to) a stronger model.
   * @param overrideAlias - User-specified model override from /resume <model>
   * @returns { modelAlias, escalationMsg } - resolved model + optional user message
   */
  private async resolveResumeModel(
    userId: string,
    overrideAlias?: string
  ): Promise<{ modelAlias: string; escalationMsg?: string }> {
    // Get the user's current model
    const userModel = await this.storage.getUserModel(userId);

    // Build checkpoint metadata for the Task Router
    const cpInfo = await this.storage.getCheckpointInfo(userId, 'latest');
    const checkpoint: RouterCheckpointMeta | null = cpInfo
      ? {
          modelAlias: cpInfo.modelAlias,
          iterations: cpInfo.iterations,
          toolsUsed: cpInfo.toolsUsed,
          completed: cpInfo.completed,
          taskPrompt: cpInfo.taskPrompt,
        }
      : null;

    // Delegate to Task Router (single source of truth)
    const decision = resolveTaskModel(userModel, checkpoint, overrideAlias);

    // If the router provided a rationale with escalation hints, surface it
    const escalationMsg = decision.rationale.startsWith('⚠️') || decision.rationale.startsWith('User override')
      ? decision.rationale
      : undefined;

    return { modelAlias: decision.modelAlias, escalationMsg };
  }

  /**
   * Handle "continue" keyword by resuming from checkpoint.
   * Mirrors the resume button callback logic but triggered by text message.
   */
  private async handleContinueResume(message: TelegramMessage): Promise<void> {
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);

    if (!this.taskProcessor) return;

    await this.bot.sendChatAction(chatId, 'typing');

    // Get the last user message from storage (the original task, not "continue")
    const history = await this.storage.getConversation(userId, 1);
    const lastUserMessage = history.find(m => m.role === 'user');

    if (!lastUserMessage) {
      await this.bot.sendMessage(chatId, 'No previous task found to continue.');
      return;
    }

    // Build minimal messages — checkpoint will be loaded by the TaskProcessor
    const systemPrompt = await this.getSystemPrompt();
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: lastUserMessage.content },
    ];

    const { modelAlias, escalationMsg } = await this.resolveResumeModel(userId);
    if (escalationMsg) {
      await this.bot.sendMessage(chatId, escalationMsg);
    }
    const autoResume = await this.storage.getUserAutoResume(userId);
    const taskId = `${userId}-${Date.now()}`;
    const taskRequest: TaskRequest = {
      taskId,
      chatId,
      userId,
      modelAlias,
      messages,
      telegramToken: this.telegramToken,
      openrouterKey: this.openrouterKey,
      githubToken: this.githubToken,
      braveSearchKey: this.braveSearchKey,
      cloudflareApiToken: this.cloudflareApiToken,
      dashscopeKey: this.dashscopeKey,
      moonshotKey: this.moonshotKey,
      deepseekKey: this.deepseekKey,
      anthropicKey: this.anthropicKey,
      autoResume,
      acontextKey: this.acontextKey,
      acontextBaseUrl: this.acontextBaseUrl,
    };

    const doId = this.taskProcessor.idFromName(userId);
    const doStub = this.taskProcessor.get(doId);
    await fetchDOWithRetry(doStub, new Request('https://do/process', {
      method: 'POST',
      body: JSON.stringify(taskRequest),
    }));

    // Don't add "continue" to conversation history — it's a control command, not content
  }

  /**
   * Handle /resume [model] command — resume from checkpoint with optional model override.
   */
  private async handleResumeCommand(chatId: number, userId: string, args: string[]): Promise<void> {
    if (!this.taskProcessor) return;

    await this.bot.sendChatAction(chatId, 'typing');

    const history = await this.storage.getConversation(userId, 1);
    const lastUserMessage = history.find(m => m.role === 'user');

    if (!lastUserMessage) {
      await this.bot.sendMessage(chatId, 'No previous task found to resume.\n\nUsage: /resume [model]\nExample: /resume deep');
      return;
    }

    // Validate optional model override
    const overrideAlias = args[0]?.toLowerCase();
    if (overrideAlias && !getModel(overrideAlias)) {
      await this.bot.sendMessage(chatId, `Unknown model: ${overrideAlias}\nType /models to see available models.\n\nUsage: /resume [model]`);
      return;
    }

    const { modelAlias, escalationMsg } = await this.resolveResumeModel(userId, overrideAlias);
    if (escalationMsg) {
      await this.bot.sendMessage(chatId, escalationMsg);
    }

    const systemPrompt = await this.getSystemPrompt();
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: lastUserMessage.content },
    ];

    const autoResume = await this.storage.getUserAutoResume(userId);
    const taskId = `${userId}-${Date.now()}`;
    const taskRequest: TaskRequest = {
      taskId,
      chatId,
      userId,
      modelAlias,
      messages,
      telegramToken: this.telegramToken,
      openrouterKey: this.openrouterKey,
      githubToken: this.githubToken,
      braveSearchKey: this.braveSearchKey,
      cloudflareApiToken: this.cloudflareApiToken,
      dashscopeKey: this.dashscopeKey,
      moonshotKey: this.moonshotKey,
      deepseekKey: this.deepseekKey,
      anthropicKey: this.anthropicKey,
      autoResume,
      acontextKey: this.acontextKey,
      acontextBaseUrl: this.acontextBaseUrl,
    };

    const doId = this.taskProcessor.idFromName(userId);
    const doStub = this.taskProcessor.get(doId);
    await fetchDOWithRetry(doStub, new Request('https://do/process', {
      method: 'POST',
      body: JSON.stringify(taskRequest),
    }));
  }

  /**
   * Handle regular chat
   */
  private async handleChat(message: TelegramMessage, text: string): Promise<void> {
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);

    await this.bot.sendChatAction(chatId, 'typing');

    // Parse optional think:LEVEL prefix (e.g., "think:high how do I ...")
    const { level: reasoningLevel, cleanMessage } = parseReasoningOverride(text);
    // Parse optional json: prefix (e.g., "json: list 5 cities")
    const { requestJson, cleanMessage: messageText } = parseJsonPrefix(cleanMessage);

    // Get user's model and conversation history
    let modelAlias = await this.storage.getUserModel(userId);

    // If user's model is image-gen only, fall back to default text model
    if (isImageGenModel(modelAlias)) {
      await this.bot.sendMessage(chatId, `Model /${modelAlias} is image-only. Use /img <prompt> to generate images.\nFalling back to /${DEFAULT_MODEL} for text.`);
      modelAlias = DEFAULT_MODEL;
    }

    // If user's model was removed/blocked/sunset, fall back to best free model (not /auto).
    // First ensure dynamic models are loaded from R2 (may not be ready on cold start).
    if (modelAlias !== DEFAULT_MODEL && !getModel(modelAlias)) {
      await this.dynamicModelsReady;
      // Re-check after dynamic models are loaded — the model may exist now
      if (!getModel(modelAlias)) {
        const unavailableAlias = modelAlias;
        // Try to find a free model with tools instead of expensive /auto
        const freeModels = getFreeToolModels();
        if (freeModels.length > 0) {
          modelAlias = freeModels[0]; // Best free model (sorted by context size)
          await this.bot.sendMessage(
            chatId,
            `⚠️ Model /${unavailableAlias} is no longer available. Switching to /${modelAlias} (free).\nRun /pick to choose a different model.`
          );
        } else {
          modelAlias = DEFAULT_MODEL;
          await this.bot.sendMessage(
            chatId,
            `⚠️ Model /${unavailableAlias} is no longer available. No free models found — switching to /${DEFAULT_MODEL}.\nRun /pick to choose a model.`
          );
        }
        await this.storage.setUserModel(userId, modelAlias);
      }
    }
    // Classify task complexity to skip expensive R2 reads for trivial queries (Phase 7A.2)
    const fullHistory = await this.storage.getConversation(userId, 10);
    const complexity = classifyTaskComplexity(messageText, fullHistory.length);

    // Route simple queries to fast models when user is on default 'auto' (Phase 7B.2)
    // Use message-only complexity (ignoring conversation length) so that simple messages
    // in long conversations still get routed to fast models.
    const autoRouteEnabled = await this.storage.getUserAutoRoute(userId);
    const routingComplexity = classifyTaskComplexity(messageText, 0);
    const routing = routeByComplexity(modelAlias, routingComplexity, autoRouteEnabled);
    if (routing.wasRouted) {
      console.log(`[ModelRouter] ${routing.reason} (user=${userId})`);
      modelAlias = routing.modelAlias;
    }

    // Simple queries: skip learnings/sessions, keep only last 5 messages
    const history = complexity === 'simple' ? fullHistory.slice(-5) : fullHistory;
    const systemPrompt = await this.getSystemPrompt();

    // Augment system prompt with tool hints for tool-supporting models
    const hasTools = modelSupportsTools(modelAlias);
    const modelInfo = getModel(modelAlias);
    const parallelHint = modelInfo?.parallelCalls
      ? ' Call multiple tools in parallel when possible (e.g., read multiple files at once, fetch multiple URLs simultaneously).'
      : '';
    const toolIntent = detectToolIntent(messageText);
    // Only encourage proactive tool use when the message clearly needs tools
    const toolHint = hasTools
      ? toolIntent.needsTools
        ? `\n\nYou have access to tools (web browsing, GitHub, weather, news, currency conversion, charts, code execution, etc). Use them proactively — don't guess when you can look up real data.${parallelHint} Tools are fast and free; prefer using them over making assumptions.`
        : `\n\nYou have access to tools (web browsing, GitHub, weather, news, currency conversion, charts, code execution, etc). Use them ONLY when the user asks for specific data or actions — do NOT call tools for greetings, capability questions, or general conversation.${parallelHint}`
      : '';

    // Warn user if message needs tools but model doesn't support them
    if (!hasTools) {
      const intent = detectToolIntent(messageText);
      if (intent.needsTools) {
        await this.bot.sendMessage(
          chatId,
          `⚠️ ${intent.reason}\nModel /${modelAlias} doesn't support tools. Switch to a tool model:\n${getFreeToolModels().slice(0, 3).map(a => `/${a}`).join(' ')} (free)\n/deep /grok /gpt (paid)\n\nSending your message anyway — the model will try its best without tools.`
        );
      }
    }

    // Gate expensive R2 loads based on task complexity (Phase 7A.2)
    // Simple queries skip learnings, memory, last-task summary, and session history
    let memoryHint = '';
    let learningsHint = '';
    let lastTaskHint = '';
    let sessionContext = '';
    if (complexity === 'complex') {
      [memoryHint, learningsHint, lastTaskHint, sessionContext] = await Promise.all([
        this.getMemoryHint(userId),
        this.getLearningsHint(userId, messageText),
        this.getLastTaskHint(userId),
        this.getSessionContext(userId, messageText),
      ]);
    }

    // Add conversation boundary hint when history exists to prevent context bleed
    const conversationBoundary = history.length > 0
      ? '\n\nIMPORTANT: Previous messages are provided for context only. Answer ONLY the latest user message. Do NOT re-execute tools or repeat answers from previous turns.'
      : '';

    // Build messages array
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: systemPrompt + toolHint + memoryHint + learningsHint + lastTaskHint + sessionContext + conversationBoundary,
      },
      ...history.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
      { role: 'user', content: messageText },
    ];

    try {
      let responseText: string;

      // Route through Durable Object when available (unlimited time, checkpointing, auto-resume)
      // All models benefit from DO: tool-supporting models get tools, others get timeout protection
      if (this.taskProcessor) {
        const taskId = `${userId}-${Date.now()}`;
        const autoResume = await this.storage.getUserAutoResume(userId);
        const responseFormat: ResponseFormat | undefined =
          requestJson && supportsStructuredOutput(modelAlias)
            ? { type: 'json_object' }
            : undefined;

        const taskRequest: TaskRequest = {
          taskId,
          chatId,
          userId,
          modelAlias,
          messages,
          telegramToken: this.telegramToken,
          openrouterKey: this.openrouterKey,
          githubToken: this.githubToken,
          braveSearchKey: this.braveSearchKey,
          cloudflareApiToken: this.cloudflareApiToken,
          dashscopeKey: this.dashscopeKey,
          moonshotKey: this.moonshotKey,
          deepseekKey: this.deepseekKey,
          anthropicKey: this.anthropicKey,
          autoResume,
          reasoningLevel: reasoningLevel ?? undefined,
          responseFormat,
          acontextKey: this.acontextKey,
          acontextBaseUrl: this.acontextBaseUrl,
        };

        const doId = this.taskProcessor.idFromName(userId);
        const doStub = this.taskProcessor.get(doId);
        await fetchDOWithRetry(doStub, new Request('https://do/process', {
          method: 'POST',
          body: JSON.stringify(taskRequest),
        }));

        await this.storage.addMessage(userId, 'user', text);
        return;
      }

      // Fallback: Worker-based processing (only when DO not available)
      if (modelSupportsTools(modelAlias)) {
        // Fallback: Direct tool-calling processing (with timeout)
        let statusMessage: TelegramMessage | null = null;
        let toolCallCount = 0;
        const uniqueTools = new Set<string>();

        try {
          statusMessage = await this.bot.sendMessage(chatId, '⏳ Thinking...');
        } catch {
          // Ignore if status message fails
        }

        const updateStatus = async (toolName: string) => {
          toolCallCount++;
          uniqueTools.add(toolName);

          // Map tool names to user-friendly descriptions
          const toolDescriptions: Record<string, string> = {
            'fetch_url': '🌐 Fetching URL',
            'github_read_file': '📄 Reading file from GitHub',
            'github_list_files': '📁 Listing GitHub files',
            'github_api': '🔧 Calling GitHub API',
          };

          const status = toolDescriptions[toolName] || `🔧 Using ${toolName}`;

          if (statusMessage) {
            try {
              await this.bot.editMessage(
                chatId,
                statusMessage.message_id,
                `⏳ ${status}... (${toolCallCount} tool call${toolCallCount > 1 ? 's' : ''})`
              );
            } catch {
              // Ignore edit failures, send typing instead
              this.bot.sendChatAction(chatId, 'typing');
            }
          } else {
            this.bot.sendChatAction(chatId, 'typing');
          }
        };

        let lastIterationUpdate = 0;
        const updateIteration = async (iteration: number, totalTools: number) => {
          // Update status every 3 iterations to avoid rate limits
          if (iteration - lastIterationUpdate >= 3 || iteration === 1) {
            lastIterationUpdate = iteration;
            if (statusMessage) {
              try {
                await this.bot.editMessage(
                  chatId,
                  statusMessage.message_id,
                  `⏳ Processing... (iteration ${iteration}, ${totalTools} tool calls)`
                );
              } catch {
                // Ignore edit failures
              }
            }
            // Send typing indicator as heartbeat
            this.bot.sendChatAction(chatId, 'typing');
          }
        };

        // Use tool-calling chat completion with higher limits for complex tasks
        // Paid Workers plan allows longer execution via waitUntil()
        const { finalText, toolsUsed, hitLimit } = await this.openrouter.chatCompletionWithTools(
          modelAlias,
          messages,
          {
            maxToolCalls: 50, // High limit for complex multi-file tasks
            maxTimeMs: 120000, // 2 minutes for paid Workers plan
            onToolCall: (toolName, _args) => {
              updateStatus(toolName);
            },
            onIteration: (iteration, totalTools) => {
              updateIteration(iteration, totalTools);
            },
            toolContext: {
              githubToken: this.githubToken,
              braveSearchKey: this.braveSearchKey,
              cloudflareApiToken: this.cloudflareApiToken,
              browser: this.browser,
              sandbox: this.sandbox,
              acontextClient: createAcontextClient(this.acontextKey, this.acontextBaseUrl),
              acontextSessionId: `chat-${userId}`,
              r2Bucket: this.r2Bucket,
              r2FilePrefix: `files/${userId}/`,
            },
            reasoningLevel: reasoningLevel ?? undefined,
            responseFormat: requestJson && supportsStructuredOutput(modelAlias)
              ? { type: 'json_object' }
              : undefined,
          }
        );

        // Delete status message before sending response
        if (statusMessage) {
          try {
            await this.bot.deleteMessage(chatId, statusMessage.message_id);
          } catch {
            // Ignore delete failures
          }
        }

        responseText = finalText;

        // If tools were used, prepend a summary
        if (toolsUsed.length > 0) {
          const toolsSummary = `[Used ${toolsUsed.length} tool(s): ${[...new Set(toolsUsed)].join(', ')}]\n\n`;
          responseText = toolsSummary + responseText;
        }

        // If we hit the limit, add a warning
        if (hitLimit) {
          responseText += '\n\n⚠️ Task was too complex and hit time/iteration limit. Send "continue" to keep going, or break into smaller steps.'
        }
      } else {
        // Regular chat completion without tools
        const response = await this.openrouter.chatCompletion(modelAlias, messages, {
          reasoningLevel: reasoningLevel ?? undefined,
          responseFormat: requestJson && supportsStructuredOutput(modelAlias)
            ? { type: 'json_object' }
            : undefined,
        });
        responseText = extractTextResponse(response);
      }

      // Save to history (use cleaned message without think: prefix)
      await this.storage.addMessage(userId, 'user', messageText);
      await this.storage.addMessage(userId, 'assistant', responseText);

      // Send response with HTML formatting (handle long messages)
      if (responseText.length > 4000) {
        // Split into chunks for long responses
        const chunks = this.splitMessage(responseText, 4000);
        for (const chunk of chunks) {
          try {
            await this.bot.sendMessage(chatId, markdownToTelegramHtml(chunk), { parseMode: 'HTML' });
          } catch {
            await this.bot.sendMessage(chatId, chunk); // Fallback: plain text
          }
        }
      } else {
        try {
          await this.bot.sendMessage(chatId, markdownToTelegramHtml(responseText), { parseMode: 'HTML' });
        } catch {
          await this.bot.sendMessage(chatId, responseText); // Fallback: plain text
        }
      }
    } catch (error) {
      await this.bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Split a long message into chunks
   */
  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to split at a newline
      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // No good newline, split at space
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // No good space, hard split
        splitIndex = maxLength;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trim();
    }

    return chunks;
  }

  /**
   * Format a timestamp as relative age (e.g., "2 hours ago")
   */
  private formatAge(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  /**
   * Escape special characters for Telegram Markdown
   */
  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }

  /**
   * Handle callback queries (from inline keyboards)
   */
  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const callbackData = query.data;
    const userId = String(query.from.id);
    const chatId = query.message?.chat.id;

    console.log('[Telegram] Callback query:', callbackData);

    // Acknowledge the callback immediately
    await this.bot.answerCallbackQuery(query.id);

    if (!callbackData || !chatId) {
      return;
    }

    // Check if user is allowed
    if (!this.isUserAllowed(userId)) {
      return;
    }

    // Parse callback data format: action:param1:param2...
    // Split with limit 2 first to get action, then re-split payload as needed per action.
    const colonIdx = callbackData.indexOf(':');
    const action = colonIdx >= 0 ? callbackData.slice(0, colonIdx) : callbackData;
    const payload = colonIdx >= 0 ? callbackData.slice(colonIdx + 1) : '';
    const parts = callbackData.split(':');

    switch (action) {
      case 'model':
        // Quick model switch: model:alias (payload preserves full alias even if it has colons)
        const modelAlias = payload;
        if (modelAlias) {
          await this.handleUseCommand(chatId, userId, query.from.username, [modelAlias]);
          // Remove buttons after selection
          if (query.message) {
            await this.bot.editMessageReplyMarkup(chatId, query.message.message_id, null);
          }
        }
        break;

      case 'modelnav':
        // Hub navigation buttons: modelnav:list or modelnav:rank
        if (payload === 'list') {
          await this.bot.sendMessage(chatId, formatModelsList());
        } else if (payload === 'rank') {
          await this.sendModelRanking(chatId);
        }
        break;

      case 'orchgo': {
        // Orchestra model gate: switch model (or proceed) then resume pending orchestra
        if (query.message) {
          await this.bot.editMessageReplyMarkup(chatId, query.message.message_id, null);
        }
        const pending = await this.storage.getPendingOrchestra(userId, chatId);
        if (!pending) {
          await this.bot.sendMessage(chatId, '⏳ Orchestra request expired. Please run /orch again.');
          break;
        }
        // Validate chat ownership
        if (pending.chatId !== chatId) {
          await this.bot.sendMessage(chatId, '⚠️ This orchestra request belongs to another chat. Run /orch again here.');
          break;
        }
        // Switch model unless "proceed" was chosen
        if (payload && payload !== 'proceed') {
          await this.handleUseCommand(chatId, userId, query.from.username, [payload]);
        }
        // Clear pending and execute (skip model guard if user chose "proceed")
        await this.storage.setPendingOrchestra(userId, chatId, null);
        const skipGuard = payload === 'proceed';
        await this.executeOrchestra(pending.chatId, userId, pending.mode, pending.repo, pending.prompt, skipGuard);
        break;
      }

      case 'orchdraft': {
        // Draft init buttons: approve/revise/cancel/full
        if (query.message) {
          await this.bot.editMessageReplyMarkup(chatId, query.message.message_id, null);
        }
        const draft = await this.storage.getOrchestraDraft(userId, chatId);
        if (!draft) {
          await this.bot.sendMessage(chatId, '⏳ Draft expired. Please run /orch init again.');
          break;
        }
        // Validate chat ownership — reject callbacks from wrong chat
        if (draft.chatId !== chatId) {
          await this.bot.sendMessage(chatId, '⚠️ This draft belongs to another chat. Use /orch init here to start a new one.');
          break;
        }
        switch (payload) {
          case 'approve': {
            // Idempotency: reject if status is already past 'draft'
            if (draft.status === 'approving') {
              await this.bot.sendMessage(chatId, '⏳ Approval already in progress...');
              break;
            }
            if (draft.status === 'approved') {
              await this.bot.sendMessage(chatId, '✅ This draft was already approved.');
              break;
            }
            // Acquire R2 lock to prevent concurrent double-approve from duplicate callbacks.
            // Unlike status checks (which are read-then-write and can race),
            // the lock uses a separate key checked close to write time.
            const lockAcquired = await this.storage.tryAcquireApproveLock(userId, chatId);
            if (!lockAcquired) {
              await this.bot.sendMessage(chatId, '⏳ Approval already in progress...');
              break;
            }
            draft.status = 'approving';
            await this.storage.setOrchestraDraft(userId, chatId, draft);
            await this.bot.sendMessage(chatId, '✅ Creating PR with your approved roadmap...');
            try {
              const prUrl = await this.commitDraftRoadmap(userId, chatId, draft);
              draft.status = 'approved';
              await this.storage.setOrchestraDraft(userId, chatId, null); // Clear draft
              await this.storage.releaseApproveLock(userId, chatId);
              await this.bot.sendMessage(
                chatId,
                `✅ Roadmap PR created!\n\n🔗 ${prUrl}\n\n` +
                `Use /orch next to start implementing the first task.`
              );
            } catch (err) {
              // Reset to draft so user can retry, release lock
              draft.status = 'draft';
              await this.storage.setOrchestraDraft(userId, chatId, draft);
              await this.storage.releaseApproveLock(userId, chatId);
              await this.bot.sendMessage(chatId, `❌ Failed to create PR: ${err instanceof Error ? err.message : String(err)}`);
            }
            break;
          }
          case 'revise': {
            // Set pending revision flag — next user message will be treated as revision feedback
            draft.pendingRevision = true;
            await this.storage.setOrchestraDraft(userId, chatId, draft);
            await this.bot.sendMessage(
              chatId,
              '✏️ What should I change? Describe your revision and I\'ll regenerate the roadmap.'
            );
            break;
          }
          case 'full': {
            // Send full roadmap preview
            const fullPreview = draft.roadmapContent.length > 4000
              ? draft.roadmapContent.slice(0, 4000) + '\n\n[Truncated — approve to see full content in PR]'
              : draft.roadmapContent;
            await this.bot.sendMessage(chatId, `📄 Full Draft:\n\n${fullPreview}`);
            // Re-send action buttons
            await this.bot.sendMessage(chatId, 'What would you like to do?', {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Approve & Create PR', callback_data: 'orchdraft:approve' },
                    { text: '✏️ Revise', callback_data: 'orchdraft:revise' },
                  ],
                  [{ text: '❌ Cancel', callback_data: 'orchdraft:cancel' }],
                ],
              },
            });
            break;
          }
          case 'cancel': {
            draft.status = 'cancelled';
            await this.storage.setOrchestraDraft(userId, chatId, null);
            await this.bot.sendMessage(chatId, '❌ Draft cancelled.');
            break;
          }
        }
        break;
      }

      case 'orchplan': {
        // Planning mode buttons: generate/cancel
        if (query.message) {
          await this.bot.editMessageReplyMarkup(chatId, query.message.message_id, null);
        }
        // Validate chat ownership
        if (payload === 'generate') {
          const plan = await this.storage.getOrchestraPlan(userId, chatId);
          if (!plan || plan.requirements.length === 0) {
            await this.bot.sendMessage(chatId, '❌ No requirements collected yet. Send some messages first.');
            break;
          }
          if (plan.chatId !== chatId) {
            await this.bot.sendMessage(chatId, '⚠️ This planning session belongs to another chat.');
            break;
          }
          const combinedPrompt = plan.requirements.join('\n\n');
          await this.storage.setOrchestraPlan(userId, chatId, null);
          await this.executeOrchestra(chatId, userId, 'draft', plan.repo, combinedPrompt);
        } else if (payload === 'cancel') {
          await this.storage.setOrchestraPlan(userId, chatId, null);
          await this.bot.sendMessage(chatId, '❌ Planning cancelled.');
        }
        break;
      }

      case 'orch': {
        // Orchestra hub buttons: orch:next, orch:advise, orch:roadmap, etc.
        if (query.message) {
          await this.bot.editMessageReplyMarkup(chatId, query.message.message_id, null);
        }
        // Create a fake message for handleOrchestraCommand
        const fakeMsg = { chat: { id: chatId }, from: query.from } as TelegramMessage;
        switch (payload) {
          case 'next':
            await this.handleOrchestraCommand(fakeMsg, chatId, userId, ['next']);
            break;
          case 'advise':
            await this.handleOrchestraCommand(fakeMsg, chatId, userId, ['advise']);
            break;
          case 'roadmap':
            await this.handleOrchestraCommand(fakeMsg, chatId, userId, ['roadmap']);
            break;
          case 'history':
            await this.handleOrchestraCommand(fakeMsg, chatId, userId, ['history']);
            break;
          case 'unset':
            await this.handleOrchestraCommand(fakeMsg, chatId, userId, ['unset']);
            break;
          case 'stats':
            await this.handleOrchestraCommand(fakeMsg, chatId, userId, ['stats']);
            break;
          default:
            await this.bot.sendMessage(chatId, '❓ Unknown orchestra action.');
        }
        break;
      }

      case 'confirm':
        // Confirmation action: confirm:yes or confirm:no
        const confirmed = parts[1] === 'yes';
        const confirmAction = parts[2]; // What was being confirmed
        if (query.message) {
          await this.bot.editMessageReplyMarkup(chatId, query.message.message_id, null);
        }
        if (confirmed && confirmAction) {
          await this.bot.sendMessage(chatId, `✓ Confirmed: ${confirmAction}`);
          // Handle the confirmed action based on confirmAction value
        } else {
          await this.bot.sendMessage(chatId, '✗ Cancelled');
        }
        break;

      case 'clear':
        // Clear conversation confirmation
        if (parts[1] === 'yes') {
          await this.storage.clearConversation(userId);
          await this.bot.sendMessage(chatId, '✓ Conversation cleared');
        }
        if (query.message) {
          await this.bot.editMessageReplyMarkup(chatId, query.message.message_id, null);
        }
        break;

      case 'resume':
        // Resume a failed task from checkpoint
        if (this.taskProcessor) {
          // Remove button
          if (query.message) {
            await this.bot.editMessageReplyMarkup(chatId, query.message.message_id, null);
          }

          // Get the last user message from storage to resume with
          const history = await this.storage.getConversation(userId, 1);
          const lastUserMessage = history.find(m => m.role === 'user');

          if (lastUserMessage) {
            // Restart the task - checkpoint will be loaded by DO
            const systemPrompt = await this.getSystemPrompt();
            const messages: ChatMessage[] = [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: lastUserMessage.content },
            ];

            // Check for model escalation (e.g., stalled on weak free model)
            const { modelAlias, escalationMsg } = await this.resolveResumeModel(userId);
            if (escalationMsg) {
              await this.bot.sendMessage(chatId, escalationMsg);
            }
            const autoResume = await this.storage.getUserAutoResume(userId);
            const taskId = `${userId}-${Date.now()}`;
            const taskRequest: TaskRequest = {
              taskId,
              chatId,
              userId,
              modelAlias,
              messages,
              telegramToken: this.telegramToken,
              openrouterKey: this.openrouterKey,
              githubToken: this.githubToken,
              braveSearchKey: this.braveSearchKey,
              cloudflareApiToken: this.cloudflareApiToken,
              dashscopeKey: this.dashscopeKey,
              moonshotKey: this.moonshotKey,
              deepseekKey: this.deepseekKey,
              anthropicKey: this.anthropicKey,
              autoResume,
              acontextKey: this.acontextKey,
              acontextBaseUrl: this.acontextBaseUrl,
            };

            const doId = this.taskProcessor.idFromName(userId);
            const doStub = this.taskProcessor.get(doId);
            await fetchDOWithRetry(doStub, new Request('https://do/process', {
              method: 'POST',
              body: JSON.stringify(taskRequest),
            }));
          } else {
            await this.bot.sendMessage(chatId, 'No previous message found to resume.');
          }
        }
        break;

      case 's':
        // Sync models picker: s:a:alias (toggle add), s:r:alias (toggle remove), s:ok, s:x
        await this.handleSyncCallback(query, parts, userId, chatId);
        break;

      case 'start':
        // /start feature exploration: start:coding, start:research, etc.
        await this.handleStartCallback(parts, chatId, userId);
        break;

      case 'mu':
        // Model update from /synccheck: mu:cost:alias:newcost or mu:allcost
        await this.handleModelUpdateCallback(parts, chatId, query);
        break;

      case 'sa':
        // Sync-all quick-use: sa:<alias> — switch active model
        await this.handleSyncAllUseCallback(query, parts, userId, chatId);
        break;

      default:
        console.log('[Telegram] Unknown callback action:', action);
    }
  }

  /**
   * Handle /start menu button callbacks
   */
  private async handleStartCallback(parts: string[], chatId: number, userId: string): Promise<void> {
    const feature = parts[1];

    // Direct-action buttons
    if (feature === 'pick') {
      await this.sendModelPicker(chatId);
      return;
    }

    if (feature === 'sync') {
      await this.handleSyncAllCommand(chatId, userId);
      return;
    }

    if (feature === 'help') {
      await this.bot.sendMessage(chatId, this.getHelpMessage());
      return;
    }

    if (feature === 'menu') {
      await this.sendStartMenu(chatId);
      return;
    }

    // Sub-menu buttons: start:sub:<group>
    if (feature === 'sub') {
      const group = parts[2];
      await this.sendStartSubMenu(chatId, userId, group);
      return;
    }

    // Action buttons: start:cmd:<command>
    if (feature === 'cmd') {
      await this.handleStartCommandAction(chatId, userId, parts.slice(2).join(':'));
      return;
    }

    // Hint buttons: show usage instructions for commands that need arguments
    if (feature === 'hint') {
      const hint = parts.slice(2).join(':');
      await this.sendStartHint(chatId, hint);
      return;
    }

    // Feature info pages (coding, research, images, etc.)
    const text = this.getStartFeatureText(feature);
    if (text) {
      const buttons = this.getStartFeatureButtons(feature);
      await this.bot.sendMessageWithButtons(chatId, text, buttons);
    }
  }

  /**
   * Send a sub-menu with action buttons for a specific command group.
   */
  private async sendStartSubMenu(chatId: number, userId: string, group: string): Promise<void> {
    let text: string;
    let buttons: InlineKeyboardButton[][];

    switch (group) {
      case 'models': {
        const current = await this.storage.getUserModel(userId);
        const model = getModel(current);
        text = `🤖 Models\n\nCurrent: ${model?.name || current} (/${current})\n\nQuick switch or browse the full catalog:`;
        buttons = [
          [
            { text: '🤖 Pick a Model', callback_data: 'start:pick' },
            { text: '📋 Full Catalog', callback_data: 'start:cmd:models' },
          ],
          [
            { text: '📊 Current Model', callback_data: 'start:cmd:model' },
          ],
          [
            { text: '⬅️ Back to Menu', callback_data: 'start:menu' },
          ],
        ];
        break;
      }

      case 'saves': {
        text = '💾 Checkpoints & History\n\nSave and restore conversation states:';
        buttons = [
          [
            { text: '📁 List Saves', callback_data: 'start:cmd:saves' },
            { text: '📝 Learnings', callback_data: 'start:cmd:learnings' },
          ],
          [
            { text: '📚 Sessions', callback_data: 'start:cmd:sessions' },
          ],
          [
            { text: '⬅️ Back to Menu', callback_data: 'start:menu' },
          ],
        ];
        break;
      }

      case 'stats': {
        text = '📊 Stats & Monitoring\n\nUsage, costs, and bot health:';
        buttons = [
          [
            { text: '💰 Credits', callback_data: 'start:cmd:credits' },
            { text: '📈 Costs', callback_data: 'start:cmd:costs' },
          ],
          [
            { text: '📋 Weekly Costs', callback_data: 'start:cmd:costsweek' },
            { text: '🏓 Ping', callback_data: 'start:cmd:ping' },
          ],
          [
            { text: 'ℹ️ Status', callback_data: 'start:cmd:status' },
            { text: '🧪 Smoke Tests', callback_data: 'start:cmd:test' },
          ],
          [
            { text: '📰 Daily Briefing', callback_data: 'start:cmd:briefing' },
          ],
          [
            { text: '⬅️ Back to Menu', callback_data: 'start:menu' },
          ],
        ];
        break;
      }

      case 'sync': {
        text = '🔄 Model Sync\n\nKeep your model catalog up to date with OpenRouter:';
        buttons = [
          [
            { text: '🔄 Free Models Sync', callback_data: 'start:cmd:syncmodels' },
            { text: '🌐 Full Sync + Top 20', callback_data: 'start:sync' },
          ],
          [
            { text: '🔍 Check for Updates', callback_data: 'start:cmd:synccheck' },
          ],
          [
            { text: '📋 Model Overrides', callback_data: 'start:cmd:modelupdatelist' },
            { text: '🗑️ Reset Dynamic', callback_data: 'start:cmd:syncreset' },
          ],
          [
            { text: '⬅️ Back to Menu', callback_data: 'start:menu' },
          ],
        ];
        break;
      }

      case 'settings': {
        text = '⚙️ Settings\n\nConfigure bot behavior:';
        buttons = [
          [
            { text: '🔁 Auto-Resume', callback_data: 'start:cmd:ar' },
            { text: '🛤️ Auto-Route', callback_data: 'start:cmd:autoroute' },
          ],
          [
            { text: '🗑️ Clear Chat', callback_data: 'start:cmd:clear' },
            { text: '🎭 Skills', callback_data: 'start:cmd:skill' },
          ],
          [
            { text: '⬅️ Back to Menu', callback_data: 'start:menu' },
          ],
        ];
        break;
      }

      default:
        return;
    }

    await this.bot.sendMessageWithButtons(chatId, text, buttons);
  }

  /**
   * Execute a command from a /start sub-menu button press.
   * Each case mirrors the logic from the main command switch in handleMessage.
   */
  private async handleStartCommandAction(chatId: number, userId: string, cmd: string): Promise<void> {
    switch (cmd) {
      // === Models group ===
      case 'models':
        await this.bot.sendMessage(chatId, formatModelsList());
        break;
      case 'model': {
        const currentModel = await this.storage.getUserModel(userId);
        const modelInfo = getModel(currentModel);
        await this.bot.sendMessage(
          chatId,
          `Current model: ${modelInfo?.name || currentModel}\n` +
          `Alias: /${currentModel}\n` +
          `${modelInfo?.specialty || ''}\n` +
          `Cost: ${modelInfo?.cost || 'N/A'}`
        );
        break;
      }

      // === Saves group ===
      case 'saves': {
        const checkpoints = await this.storage.listCheckpoints(userId);
        if (checkpoints.length === 0) {
          await this.bot.sendMessage(chatId, '📭 No saved checkpoints found.\n\nCheckpoints are automatically created during long-running tasks.');
          break;
        }
        let msg = '💾 *Saved Checkpoints:*\n\n';
        for (const cp of checkpoints) {
          const age = this.formatAge(cp.savedAt);
          const status = cp.completed ? '✅' : '⏸️';
          const prompt = cp.taskPrompt ? `\n   _${this.escapeMarkdown(cp.taskPrompt.substring(0, 50))}${cp.taskPrompt.length > 50 ? '...' : ''}_` : '';
          const modelTag = cp.modelAlias ? ` [${cp.modelAlias}]` : '';
          msg += `${status} \`${cp.slotName}\` - ${cp.iterations} iters, ${cp.toolsUsed} tools${modelTag} (${age})${prompt}\n`;
        }
        msg += '\n✅=completed ⏸️=interrupted\n_Use /delsave <name> to delete, /saveas <name> to backup_';
        await this.bot.sendMessage(chatId, msg, { parseMode: 'Markdown' });
        break;
      }
      case 'learnings': {
        const learningHistory = await loadLearnings(this.r2Bucket, userId);
        if (!learningHistory || learningHistory.learnings.length === 0) {
          await this.bot.sendMessage(chatId, '📚 No task history yet. Complete some tasks and check back!');
          break;
        }
        await this.bot.sendMessage(chatId, formatLearningSummary(learningHistory));
        break;
      }
      case 'sessions': {
        if (!this.acontextKey) {
          await this.bot.sendMessage(chatId, '⚠️ Acontext not configured. Set ACONTEXT_API_KEY to enable session tracking.');
          break;
        }
        try {
          const acontext = createAcontextClient(this.acontextKey, this.acontextBaseUrl);
          if (!acontext) {
            await this.bot.sendMessage(chatId, '⚠️ Failed to create Acontext client.');
            break;
          }
          const response = await acontext.listSessions({ user: userId, limit: 10, timeDesc: true });
          await this.bot.sendMessage(chatId, formatSessionsList(response.items));
        } catch {
          await this.bot.sendMessage(chatId, '⚠️ Failed to fetch sessions. Try again later.');
        }
        break;
      }

      // === Stats group ===
      case 'credits':
        try {
          const credits = await this.openrouter.getCredits();
          await this.bot.sendMessage(
            chatId,
            `OpenRouter Credits\nRemaining: $${credits.credits.toFixed(4)}\nUsed: $${credits.usage.toFixed(4)}`
          );
        } catch (error) {
          await this.bot.sendMessage(chatId, `Failed to get credits: ${error}`);
        }
        break;
      case 'costs':
        await this.handleCostsCommand(chatId, userId, []);
        break;
      case 'costsweek':
        await this.handleCostsCommand(chatId, userId, ['week']);
        break;
      case 'ping': {
        const pingStart = Date.now();
        const pingMsg = await this.bot.sendMessage(chatId, '🏓 Pong!');
        const pingLatency = Date.now() - pingStart;
        await this.bot.editMessage(chatId, pingMsg.message_id, `🏓 Pong! (${pingLatency}ms)`);
        break;
      }
      case 'status': {
        const statusModel = await this.storage.getUserModel(userId);
        const statusModelInfo = getModel(statusModel);
        const statusHistory = await this.storage.getConversation(userId, 100);
        const statusAutoResume = await this.storage.getUserAutoResume(userId);
        const statusAutoRoute = await this.storage.getUserAutoRoute(userId);
        await this.bot.sendMessage(
          chatId,
          `📊 Bot Status\n\n` +
          `Model: ${statusModelInfo?.name || statusModel}\n` +
          `Conversation: ${statusHistory.length} messages\n` +
          `Auto-resume: ${statusAutoResume ? '✓ Enabled' : '✗ Disabled'}\n` +
          `Auto-route: ${statusAutoRoute ? '✓ Enabled' : '✗ Disabled'}\n` +
          `GitHub: ${this.githubToken ? '✓' : '✗'} | Browser: ${this.browser ? '✓' : '✗'} | Sandbox: ${this.sandbox ? '✓' : '✗'}`
        );
        break;
      }
      case 'test':
        if (!this.taskProcessor) {
          await this.bot.sendMessage(chatId, 'Task processor not available.');
          break;
        }
        await this.bot.sendMessage(chatId, 'Running smoke tests...\nThis may take up to 2 minutes.');
        try {
          const testResults = await runSmokeTests({
            taskProcessor: this.taskProcessor,
            userId,
            chatId,
            telegramToken: this.telegramToken,
            openrouterKey: this.openrouterKey,
            githubToken: this.githubToken,
            braveSearchKey: this.braveSearchKey,
          });
          await this.bot.sendMessage(chatId, formatTestResults(testResults));
        } catch (error) {
          await this.bot.sendMessage(chatId, `❌ Test error: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      case 'briefing':
        await this.handleBriefingCommand(chatId, userId, []);
        break;

      // === Sync group ===
      case 'syncmodels':
        await this.handleSyncModelsCommand(chatId, userId);
        break;
      case 'synccheck':
        await this.handleSyncCheckCommand(chatId);
        break;
      case 'syncreset': {
        await this.storage.saveDynamicModels({}, []);
        registerDynamicModels({});
        const blocked = getBlockedAliases();
        if (blocked.length > 0) unblockModels(blocked);
        await this.bot.sendMessage(chatId, '🗑️ Dynamic models and blocked list cleared.\nOnly static catalog models are available now.');
        break;
      }
      case 'modelupdatelist':
        await this.handleModelUpdateCommand(chatId, ['list']);
        break;

      // === Settings group ===
      case 'ar': {
        const curAR = await this.storage.getUserAutoResume(userId);
        const newAR = !curAR;
        await this.storage.setUserAutoResume(userId, newAR);
        await this.bot.sendMessage(chatId, newAR
          ? '✓ Auto-resume enabled. Tasks will automatically retry on timeout.'
          : '✗ Auto-resume disabled.');
        break;
      }
      case 'autoroute': {
        const curRoute = await this.storage.getUserAutoRoute(userId);
        const newRoute = !curRoute;
        await this.storage.setUserAutoRoute(userId, newRoute);
        await this.bot.sendMessage(chatId, newRoute
          ? '✓ Auto-routing enabled. Simple queries → fast model.'
          : '✗ Auto-routing disabled.');
        break;
      }
      case 'clear':
        await this.storage.clearConversation(userId);
        await this.bot.sendMessage(chatId, '🆕 Conversation history cleared.');
        break;
      case 'skill':
        await this.handleSkillCommand(chatId, []);
        break;

      // === Skill shortcuts (no-argument commands) ===
      case 'ideas':
      case 'spark':
      case 'gauntlet':
      case 'brainstorm':
        await this.dispatchSkillFromButton(chatId, userId, `/${cmd}`);
        break;
      case 'orchnext':
        await this.dispatchSkillFromButton(chatId, userId, '/orch next');
        break;
      case 'orchroadmap':
        await this.dispatchSkillFromButton(chatId, userId, '/orch roadmap');
        break;
      case 'orchhistory':
        await this.dispatchSkillFromButton(chatId, userId, '/orch history');
        break;
    }
  }

  /**
   * Dispatch a skill command from a button tap (no TelegramMessage needed)
   */
  private async dispatchSkillFromButton(chatId: number, userId: string, commandText: string): Promise<void> {
    initializeSkills();
    const skillParsed = parseCommandMessage(commandText);
    if (skillParsed && isSkillRegistered(skillParsed.mapping.skillId)) {
      const skillEnv = {
        MOLTBOT_BUCKET: this.r2Bucket,
        OPENROUTER_API_KEY: this.openrouterKey,
        GITHUB_TOKEN: this.githubToken,
        BRAVE_SEARCH_KEY: this.braveSearchKey,
        TASK_PROCESSOR: this.taskProcessor,
        NEXUS_KV: this.nexusKv,
      } as import('../types').MoltbotEnv;
      const skillRequest: SkillRequest = {
        skillId: skillParsed.mapping.skillId,
        subcommand: skillParsed.subcommand,
        text: skillParsed.text,
        flags: skillParsed.flags,
        transport: 'telegram',
        userId,
        chatId,
        modelAlias: await this.storage.getUserModel(userId),
        env: skillEnv,
        context: { telegramToken: this.telegramToken },
      };
      const result = await runSkill(skillRequest);
      const chunks = renderForTelegram(result);
      for (const chunk of chunks) {
        await this.bot.sendMessage(chatId, chunk.text, chunk.parseMode ? { parseMode: chunk.parseMode } : undefined);
      }
    } else {
      await this.bot.sendMessage(chatId, `Command not available: ${commandText}`);
    }
  }

  /**
   * Send ranked model list with inline switch buttons.
   * Combines the old /model rank text view with /model pick buttons.
   */
  async sendModelRanking(chatId: number): Promise<void> {
    const text = formatModelRanking();
    const ranked = getRankedOrchestraModels();

    const makeButton = (alias: string, name: string, isFree: boolean, confidence: number): InlineKeyboardButton => {
      const prefix = isFree ? '🆓' : '💎';
      const shortName = name.length > 14 ? name.slice(0, 13) + '…' : name;
      return { text: `${prefix} ${shortName} ${confidence}%`, callback_data: `model:${alias}` };
    };

    // Top 4 paid + top 3 free as quick-switch buttons
    const paidTop = ranked.filter(r => !r.isFree).slice(0, 4);
    const freeTop = ranked.filter(r => r.isFree).slice(0, 3);

    const buttons: InlineKeyboardButton[][] = [];
    // 2 buttons per row
    for (let i = 0; i < paidTop.length; i += 2) {
      const row = [makeButton(paidTop[i].alias, paidTop[i].name, false, paidTop[i].confidence)];
      if (i + 1 < paidTop.length) {
        row.push(makeButton(paidTop[i + 1].alias, paidTop[i + 1].name, false, paidTop[i + 1].confidence));
      }
      buttons.push(row);
    }
    for (let i = 0; i < freeTop.length; i += 2) {
      const row = [makeButton(freeTop[i].alias, freeTop[i].name, true, freeTop[i].confidence)];
      if (i + 1 < freeTop.length) {
        row.push(makeButton(freeTop[i + 1].alias, freeTop[i + 1].name, true, freeTop[i + 1].confidence));
      }
      buttons.push(row);
    }

    await this.bot.sendMessageWithButtons(chatId, text, buttons);
  }

  /**
   * Send a quick model picker (legacy — now calls sendModelRanking)
   */
  async sendModelPicker(chatId: number): Promise<void> {
    const all = Object.values(getAllModels());
    const toolModels = all.filter(m => m.supportsTools && !m.isImageGen);

    // Score models for picker ranking (higher = better pick)
    const scored = toolModels.map(m => {
      let score = 0;
      const lower = (m.name + ' ' + m.specialty + ' ' + m.score).toLowerCase();
      // SWE-Bench scores
      const sweMatch = m.score.match(/(\d+(?:\.\d+)?)%\s*SWE/i);
      if (sweMatch) score += parseFloat(sweMatch[1]);
      // Agentic / coding keywords
      if (/agentic|coding/i.test(lower)) score += 15;
      // Large context is a bonus
      if ((m.maxContext || 0) >= 200000) score += 5;
      // Vision is nice
      if (m.supportsVision) score += 3;
      // Parallel calls
      if (m.parallelCalls) score += 2;
      return { m, score };
    });

    // Free models with tools — top 4 by score
    const freeScored = scored
      .filter(s => s.m.isFree)
      .sort((a, b) => b.score - a.score);
    const freeTop = freeScored.slice(0, 4);

    // Paid value models (exceptional + great tier) — top 4 by score
    const paidValue = scored
      .filter(s => !s.m.isFree && ['exceptional', 'great'].includes(getValueTier(s.m)))
      .sort((a, b) => b.score - a.score);
    const valueTop = paidValue.slice(0, 4);

    // Premium flagships — top 4 by score
    const premium = scored
      .filter(s => !s.m.isFree && ['good', 'premium'].includes(getValueTier(s.m)))
      .sort((a, b) => b.score - a.score);
    const premiumTop = premium.slice(0, 4);

    const makeButton = (m: ModelInfo, prefix: string): InlineKeyboardButton => {
      const icons = [m.supportsTools && '🔧', m.supportsVision && '👁️'].filter(Boolean).join('');
      // Truncate name to fit Telegram button (2 per row — ~28 chars visible)
      const shortName = m.name.length > 18 ? m.name.slice(0, 17) + '…' : m.name;
      return { text: `${prefix} ${shortName} ${icons}`, callback_data: `model:${m.alias}` };
    };

    // Build button grid: 2 buttons per row for readability
    const toRows = (items: { m: ModelInfo; score: number }[], prefix: string): InlineKeyboardButton[][] => {
      const rows: InlineKeyboardButton[][] = [];
      for (let i = 0; i < items.length; i += 2) {
        const row = [makeButton(items[i].m, prefix)];
        if (i + 1 < items.length) row.push(makeButton(items[i + 1].m, prefix));
        rows.push(row);
      }
      return rows;
    };

    const buttons: InlineKeyboardButton[][] = [];
    buttons.push(...toRows(freeTop, '🆓'));
    buttons.push(...toRows(valueTop, '🏆'));
    buttons.push(...toRows(premiumTop, '💎'));

    const totalCount = all.filter(m => !m.isImageGen).length;
    await this.bot.sendMessageWithButtons(
      chatId,
      `🤖 Top models (${totalCount} available):\n🆓 = free  🏆 = best value  💎 = premium\n🔧 = tools  👁️ = vision\n\nTip: /use <alias> for any model\nFull list: /models`,
      buttons
    );
  }

  /**
   * Send a confirmation dialog
   */
  async sendConfirmation(
    chatId: number,
    message: string,
    actionId: string
  ): Promise<void> {
    const buttons: InlineKeyboardButton[][] = [
      [
        { text: '✓ Yes', callback_data: `confirm:yes:${actionId}` },
        { text: '✗ No', callback_data: `confirm:no:${actionId}` },
      ],
    ];

    await this.bot.sendMessageWithButtons(chatId, message, buttons);
  }

  /**
   * Generate a short alias from an OpenRouter model ID.
   */
  private generateModelAlias(modelId: string): string {
    return modelId
      .replace(/:free$/, '')
      .replace(/^[^/]+\//, '')   // Remove provider prefix
      .replace(/-(instruct|preview|base|chat)$/i, '')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
      .substring(0, 14);
  }

  /**
   * Detect replacement recommendations: new models that are better than existing ones in the same category.
   */
  private detectReplacements(newModels: SyncModelCandidate[], currentModels: Record<string, ModelInfo>): SyncReplacement[] {
    const replacements: SyncReplacement[] = [];
    const existingFree = Object.values(currentModels).filter(m => m.isFree && !m.isImageGen);

    for (const newModel of newModels) {
      const newCat = newModel.category || 'general';

      for (const existing of existingFree) {
        const existingCat = categorizeModel(existing.id, existing.name, false);
        if (existingCat !== newCat) continue;

        const existingCtxK = existing.maxContext ? Math.round(existing.maxContext / 1024) : 0;
        const reasons: string[] = [];

        // Bigger context window is a significant upgrade
        if (newModel.contextK > existingCtxK * 1.5 && existingCtxK > 0) {
          reasons.push(`${newModel.contextK}K vs ${existingCtxK}K ctx`);
        }
        // Gains tool support
        if (newModel.tools && !existing.supportsTools) {
          reasons.push('adds tool support 🔧');
        }
        // Gains reasoning
        if (newModel.reasoning && !existing.reasoning) {
          reasons.push('adds reasoning');
        }

        if (reasons.length > 0) {
          replacements.push({
            newAlias: newModel.alias,
            oldAlias: existing.alias,
            reason: reasons.join(', '),
          });
        }
      }
    }
    return replacements;
  }

  /**
   * Build the sync picker message text from session state.
   */
  private buildSyncMessage(session: SyncSession): string {
    const currentModels = getAllModels();
    const catalogCount = Object.values(currentModels).filter(m => m.isFree && !m.isImageGen).length;

    const categoryLabels: Record<string, string> = {
      coding: '💻 Coding & Agents',
      reasoning: '🧠 Reasoning & Math',
      fast: '⚡ Fast & Light',
      general: '🌐 General',
    };

    let msg = `🔄 Free Models Sync\n`;
    msg += `📊 ${catalogCount} free models in catalog\n`;

    // Group new models by category
    if (session.newModels.length > 0) {
      const byCategory = new Map<string, SyncModelCandidate[]>();
      for (const m of session.newModels) {
        const cat = m.category || 'general';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(m);
      }

      // Show categories in priority order: coding > reasoning > fast > general
      const catOrder = ['coding', 'reasoning', 'fast', 'general'];
      for (const cat of catOrder) {
        const models = byCategory.get(cat);
        if (!models || models.length === 0) continue;

        msg += `\n━━━ ${categoryLabels[cat] || cat} (new) ━━━\n`;
        for (const m of models) {
          const isAdded = session.selectedAdd.includes(m.alias);
          const isReplacing = session.selectedReplace.includes(m.alias);
          const sel = (isAdded || isReplacing) ? '☑' : '☐';
          const badges = [m.vision ? '👁️' : '', m.tools ? '🔧' : '', m.reasoning ? '💭' : ''].filter(Boolean).join('');
          const badgeStr = badges ? ` ${badges}` : '';
          msg += `${sel} /${m.alias} — ${m.name}${badgeStr}\n`;
          // Show replacement recommendation if exists
          const repl = session.replacements.find(r => r.newAlias === m.alias);
          if (repl) {
            msg += `   ${m.contextK}K ctx | ↑ replaces /${repl.oldAlias} (${repl.reason})\n`;
          } else {
            msg += `   ${m.contextK}K ctx\n`;
          }
          if (m.description) {
            // Truncate description to keep message manageable
            const desc = m.description.length > 60 ? m.description.slice(0, 57) + '...' : m.description;
            msg += `   ${desc}\n`;
          }
        }
      }
    }

    if (session.staleModels.length > 0) {
      msg += `\n━━━ ❌ No Longer Free ━━━\n`;
      for (const m of session.staleModels) {
        const sel = session.selectedRemove.includes(m.alias) ? '☑' : '☐';
        msg += `${sel} /${m.alias} — ${m.name}\n`;
      }
    }

    if (session.newModels.length === 0 && session.staleModels.length === 0) {
      msg += `\n✅ Catalog is up to date — no changes needed.`;
    } else {
      const addCount = session.selectedAdd.length;
      const replCount = session.selectedReplace.length;
      const rmCount = session.selectedRemove.length;
      msg += `\nTap to select. ↻ = add & replace old.`;
      const parts: string[] = [];
      if (addCount > 0) parts.push(`${addCount} add`);
      if (replCount > 0) parts.push(`${replCount} replace`);
      if (rmCount > 0) parts.push(`${rmCount} remove`);
      if (parts.length > 0) msg += ` (${parts.join(', ')})`;
    }

    return msg;
  }

  /**
   * Build inline keyboard buttons for the sync picker.
   */
  private buildSyncButtons(session: SyncSession): InlineKeyboardButton[][] {
    const buttons: InlineKeyboardButton[][] = [];

    // New models — each gets Add button, plus Replace button if replacement exists
    for (const m of session.newModels) {
      const row: InlineKeyboardButton[] = [];
      const isAdded = session.selectedAdd.includes(m.alias);
      const isReplacing = session.selectedReplace.includes(m.alias);

      // Capability badges for buttons
      const btnBadges = [m.tools ? '🔧' : '', m.vision ? '👁️' : ''].filter(Boolean).join('');
      const badgeSuffix = btnBadges ? ` ${btnBadges}` : '';

      // Add button
      const addSel = isAdded ? '☑' : '☐';
      row.push({ text: `${addSel} + ${m.alias}${badgeSuffix}`, callback_data: `s:a:${m.alias}` });

      // Replace button (if this model has a replacement recommendation)
      const repl = session.replacements.find(r => r.newAlias === m.alias);
      if (repl) {
        const replSel = isReplacing ? '☑' : '☐';
        row.push({ text: `${replSel} ↻ ${m.alias}→${repl.oldAlias}`, callback_data: `s:rp:${m.alias}` });
      }

      buttons.push(row);
    }

    // Stale models — 2 per row
    for (let i = 0; i < session.staleModels.length; i += 2) {
      const row: InlineKeyboardButton[] = [];
      for (let j = i; j < Math.min(i + 2, session.staleModels.length); j++) {
        const m = session.staleModels[j];
        const sel = session.selectedRemove.includes(m.alias) ? '☑' : '☐';
        row.push({ text: `${sel} ✕ ${m.alias}`, callback_data: `s:r:${m.alias}` });
      }
      buttons.push(row);
    }

    // Bottom row: Validate + Cancel
    const addCount = session.selectedAdd.length;
    const replCount = session.selectedReplace.length;
    const rmCount = session.selectedRemove.length;
    const total = addCount + replCount + rmCount;
    buttons.push([
      { text: `✓ Validate${total > 0 ? ` (${total})` : ''}`, callback_data: 's:ok' },
      { text: '✗ Cancel', callback_data: 's:x' },
    ]);

    return buttons;
  }

  /**
   * Handle /syncmodels — fetch free models from OpenRouter and show interactive picker.
   */
  private async handleSyncModelsCommand(chatId: number, userId: string): Promise<void> {
    await this.bot.sendChatAction(chatId, 'typing');

    try {
      // 1. Fetch models from OpenRouter API
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${this.openrouterKey}`,
          'HTTP-Referer': 'https://moltworker.com',
        },
      });

      if (!response.ok) {
        await this.bot.sendMessage(chatId, `Failed to fetch models from OpenRouter: HTTP ${response.status}`);
        return;
      }

      const rawData = await response.json() as { data: Array<{
        id: string;
        name: string;
        description?: string;
        context_length: number;
        architecture: { modality: string };
        pricing: { prompt: string; completion: string };
        supported_parameters?: string[];
      }> };

      const allApiModels = rawData.data.map(m => ({
        id: m.id,
        name: m.name,
        description: m.description || '',
        contextLength: m.context_length,
        modality: m.architecture?.modality || 'text->text',
        promptCost: parseFloat(m.pricing?.prompt || '0'),
        completionCost: parseFloat(m.pricing?.completion || '0'),
        supportsTools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
        supportsReasoning: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('reasoning'),
      }));

      // 2. Filter for free text models
      const freeApiModels = allApiModels.filter(m =>
        m.promptCost === 0 && m.completionCost === 0 &&
        !m.id.includes('flux') &&
        !m.id.includes('stable-diffusion') &&
        m.modality.includes('text')
      );

      // 3. Compare with current catalog (including dynamic)
      const currentModels = getAllModels();
      const currentIds = new Set(Object.values(currentModels).map(m => m.id));

      // New free models not in our catalog
      const newModels: SyncModelCandidate[] = [];
      const usedAliases = new Set(Object.keys(currentModels));
      for (const m of freeApiModels) {
        if (currentIds.has(m.id)) continue;

        let alias = this.generateModelAlias(m.id);
        // Avoid conflicts
        while (usedAliases.has(alias)) alias = alias + 'f';
        usedAliases.add(alias);

        const hasReasoning = m.supportsReasoning;
        const contextK = Math.round(m.contextLength / 1024);
        newModels.push({
          alias,
          name: m.name,
          modelId: m.id,
          contextK,
          vision: m.modality.includes('image'),
          tools: m.supportsTools,
          reasoning: hasReasoning,
          category: categorizeModel(m.id, m.name, hasReasoning),
          description: m.description ? m.description.split(/[.\n]/)[0].trim() : undefined,
        });
      }

      // Stale: models in catalog as isFree but not found as free on OpenRouter
      const freeApiIds = new Set(freeApiModels.map(m => m.id));
      const staleModels: SyncModelCandidate[] = [];
      for (const m of Object.values(currentModels)) {
        if (!m.isFree || m.isImageGen || m.alias === 'auto') continue;
        if (!freeApiIds.has(m.id)) {
          staleModels.push({
            alias: m.alias,
            name: m.name,
            modelId: m.id,
            contextK: m.maxContext ? Math.round(m.maxContext / 1024) : 0,
            vision: !!m.supportsVision,
            tools: !!m.supportsTools,
          });
        }
      }

      // 4. Detect replacement recommendations
      const replacements = this.detectReplacements(newModels, currentModels);

      // 5. Create session
      const session: SyncSession = {
        newModels,
        staleModels,
        replacements,
        selectedAdd: [],
        selectedRemove: [],
        selectedReplace: [],
        chatId,
        messageId: 0,
      };

      // 5. Build message + buttons and send
      const text = this.buildSyncMessage(session);
      const buttons = this.buildSyncButtons(session);

      if (newModels.length === 0 && staleModels.length === 0) {
        await this.bot.sendMessage(chatId, text);
        return;
      }

      const sent = await this.bot.sendMessageWithButtons(chatId, text, buttons);
      session.messageId = sent.message_id;

      // Persist session to R2 (Workers are stateless — in-memory state lost between requests)
      await this.storage.saveSyncSession(userId, session);

    } catch (error) {
      await this.bot.sendMessage(chatId, `Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle /syncall — run full model catalog sync from OpenRouter.
   * Syncs ALL models (not just free), updates R2, registers in runtime,
   * and shows top 20 recommended models with quick-use buttons.
   */
  private async handleSyncAllCommand(chatId: number, userId: string): Promise<void> {
    await this.bot.sendChatAction(chatId, 'typing');
    await this.bot.sendMessage(chatId, '🌐 Running full model catalog sync from OpenRouter...');

    try {
      const { runFullSync } = await import('../openrouter/model-sync/sync');
      const result = await runFullSync(this.r2Bucket, this.openrouterKey);

      if (result.success) {
        // Stats message
        const lines = [
          '✅ Full catalog sync complete!\n',
          `📊 ${result.totalFetched} models fetched from OpenRouter`,
          `📦 ${result.totalSynced} models synced (explore tier)`,
          `🆕 ${result.newModels} new models`,
          `⏳ ${result.staleModels} stale/deprecated`,
          `🗑️ ${result.removedModels} removed`,
          `⚡ ${result.durationMs}ms`,
        ];

        // Auto-enrich with AA benchmarks if key is available
        if (this.aaKey) {
          try {
            const { runEnrichment } = await import('../openrouter/model-sync/enrich');
            const enrichResult = await runEnrichment(this.r2Bucket, this.aaKey, this.openrouterKey);
            lines.push(`\n🧠 Auto-enriched: ${enrichResult.enrichedCount}/${enrichResult.totalModels} models with AA benchmarks`);
          } catch (enrichError) {
            lines.push(`\n⚠️ AA enrichment failed: ${enrichError instanceof Error ? enrichError.message : String(enrichError)}`);
          }
        }

        await this.bot.sendMessage(chatId, lines.join('\n'));

        // Top 20 recommendations with buttons
        if (result.topModels && result.topModels.length > 0) {
          const currentModel = await this.storage.getUserModel(userId);
          const { text, buttons } = this.buildTopModelsMessage(result.topModels, currentModel);
          await this.bot.sendMessageWithButtons(chatId, text, buttons, { parseMode: 'HTML' });
        }
      } else {
        await this.bot.sendMessage(chatId, `❌ Sync failed: ${result.error}`);
      }
    } catch (error) {
      await this.bot.sendMessage(chatId, `❌ Sync error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Build the top models recommendation message with quick-use buttons.
   */
  private buildTopModelsMessage(
    topModels: Array<{ alias: string; name: string; score: number; contextK: number; tools: boolean; vision: boolean; reasoning: boolean; isFree: boolean; cost: string; category: string }>,
    currentModel: string,
  ): { text: string; buttons: InlineKeyboardButton[][] } {
    const categoryLabels: Record<string, string> = {
      coding: '💻 Coding',
      reasoning: '🧠 Reasoning',
      fast: '⚡ Fast',
      general: '🌐 General',
    };

    let text = '<b>Top 20 Recommended Models</b>\n';
    text += 'Tap an alias or button to switch.\n';

    // Group by category
    const byCategory = new Map<string, typeof topModels>();
    for (const m of topModels) {
      const cat = m.category || 'general';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(m);
    }

    const catOrder = ['coding', 'reasoning', 'fast', 'general'];
    for (const cat of catOrder) {
      const models = byCategory.get(cat);
      if (!models || models.length === 0) continue;

      text += `\n<b>${categoryLabels[cat] || cat}</b>\n`;
      for (const m of models) {
        const badges = [
          m.tools ? '🔧' : '',
          m.vision ? '👁' : '',
          m.reasoning ? '💭' : '',
        ].filter(Boolean).join('');
        const badgeStr = badges ? ` ${badges}` : '';
        const active = m.alias === currentModel ? ' ◀' : '';
        const freeTag = m.isFree ? ' FREE' : ` ${m.cost}`;
        const safeName = escapeHtml(m.name);
        text += `/${m.alias} <b>${safeName}</b>${badgeStr} ${m.contextK}K${freeTag}${active}\n`;
      }
    }

    // Build buttons: 2 per row, include short model name
    const buttons: InlineKeyboardButton[][] = [];
    for (let i = 0; i < topModels.length; i += 2) {
      const row: InlineKeyboardButton[] = [];
      for (let j = i; j < Math.min(i + 2, topModels.length); j++) {
        const m = topModels[j];
        const badges = [m.tools ? '🔧' : '', m.vision ? '👁' : ''].filter(Boolean).join('');
        const suffix = badges ? ` ${badges}` : '';
        const active = m.alias === currentModel ? ' ◀' : '';
        const shortName = m.name.length > 14 ? m.name.slice(0, 13) + '…' : m.name;
        row.push({
          text: `${m.alias} ${shortName}${suffix}${active}`,
          callback_data: `sa:${m.alias}`,
        });
      }
      buttons.push(row);
    }

    return { text, buttons };
  }

  /**
   * Handle /model — unified model hub with subcommands.
   *
   * Subcommands:
   *   (none)           — Hub: current model + top picks (buttons) + guide
   *   list             — Full catalog with prices
   *   pick             — Quick model picker (buttons)
   *   info <alias>     — Detailed capability card
   *   <alias>          — Shortcut for info (e.g. /model sonnet)
   *   rank             — Orchestra/capability ranking
   *   search <query>   — Search all models (curated + synced)
   *   use <alias>      — Switch model
   *   sync             — Fetch latest free models
   *   syncall          — Full catalog sync + recommendations
   *   check            — Check for model updates
   *   enrich           — Fetch AA benchmarks + verify capabilities
   *   update <a> k=v   — Patch model live
   *   reset            — Clear synced models
   */
  private async handleModelCommand(
    chatId: number,
    userId: string,
    username: string | undefined,
    args: string[],
  ): Promise<void> {
    const sub = args[0]?.toLowerCase();

    if (!sub) {
      // /model — hub overview with inline buttons for top picks
      await this.sendModelHub(chatId, userId);
      return;
    }

    switch (sub) {
      case 'list':
        await this.bot.sendMessage(chatId, formatModelsList());
        break;

      case 'pick':
        // Legacy — redirect to rank (which now includes buttons)
        await this.sendModelRanking(chatId);
        break;

      case 'info':
        await this.handleModelInfoCommand(chatId, args.slice(1));
        break;

      case 'rank':
      case 'ranking':
        await this.sendModelRanking(chatId);
        break;

      case 'use':
        await this.handleUseCommand(chatId, userId, username, args.slice(1));
        break;

      // --- Sync commands ---
      case 'sync':
        await this.handleSyncModelsCommand(chatId, userId);
        break;

      case 'syncall':
        await this.handleSyncAllCommand(chatId, userId);
        break;

      case 'check':
        await this.handleSyncCheckCommand(chatId);
        break;

      case 'reset': {
        await this.storage.saveDynamicModels({}, []);
        registerDynamicModels({});
        const currentBlocked = getBlockedAliases();
        if (currentBlocked.length > 0) {
          unblockModels(currentBlocked);
        }
        await this.bot.sendMessage(chatId, '🗑️ Synced models cleared. Only static catalog models are available now.');
        break;
      }

      case 'update':
        await this.handleModelUpdateCommand(chatId, args.slice(1));
        break;

      case 'enrich':
        await this.handleEnrichCommand(chatId);
        break;

      case 'search':
      case 'find': {
        const query = args.slice(1).join(' ').trim();
        if (!query) {
          await this.bot.sendMessage(chatId, 'Usage: /model search <query>\n\nExamples:\n  /model search nvidia\n  /model search nemotron\n  /model search llama\n  /model search coding');
        } else {
          const { searchModels, formatSearchResults } = await import('../openrouter/models');
          const results = searchModels(query);
          await this.bot.sendMessage(chatId, formatSearchResults(query, results));
        }
        break;
      }

      default:
        // Treat unknown subcommand as /model info <alias> for convenience
        await this.handleModelInfoCommand(chatId, [sub]);
        break;
    }
  }

  /**
   * Send the model hub with inline buttons for top picks.
   */
  private async sendModelHub(chatId: number, userId: string): Promise<void> {
    const currentAlias = await this.storage.getUserModel(userId);
    const text = formatModelHub(currentAlias);
    const picks = getTopModelPicks();

    const makeButton = (m: ModelInfo, prefix: string): InlineKeyboardButton => {
      const icons = [
        m.supportsTools && '🔧',
        m.supportsVision && '👁️',
        m.reasoning && '🧠',
      ].filter(Boolean).join('');
      const shortName = m.name.length > 16 ? m.name.slice(0, 15) + '…' : m.name;
      return { text: `${prefix} ${shortName} ${icons}`, callback_data: `model:${m.alias}` };
    };

    const toRows = (items: ModelInfo[], prefix: string): InlineKeyboardButton[][] => {
      const rows: InlineKeyboardButton[][] = [];
      for (let i = 0; i < items.length; i += 2) {
        const row = [makeButton(items[i], prefix)];
        if (i + 1 < items.length) row.push(makeButton(items[i + 1], prefix));
        rows.push(row);
      }
      return rows;
    };

    const buttons: InlineKeyboardButton[][] = [];
    if (picks.free.length > 0) buttons.push(...toRows(picks.free, '🆓'));
    if (picks.value.length > 0) buttons.push(...toRows(picks.value, '🏆'));
    if (picks.premium.length > 0) buttons.push(...toRows(picks.premium, '💎'));

    // Navigation row
    buttons.push([
      { text: '📋 Full List', callback_data: 'modelnav:list' },
      { text: '🏅 Ranking', callback_data: 'modelnav:rank' },
    ]);

    await this.bot.sendMessageWithButtons(chatId, text, buttons);
  }

  /**
   * Handle /modelinfo <alias> — show detailed capability card for a model.
   */
  private async handleModelInfoCommand(chatId: number, args: string[]): Promise<void> {
    if (args.length === 0) {
      await this.bot.sendMessage(chatId, 'Usage: /model <alias>\n\nExample: /model sonnet');
      return;
    }

    const alias = args[0].replace(/^\//, '');
    const card = formatModelInfoCard(alias);

    if (!card) {
      await this.bot.sendMessage(chatId, `❌ Model not found: ${alias}\n\nUse /models to see available models.`);
      return;
    }

    await this.bot.sendMessage(chatId, card);
  }

  /**
   * Handle /enrich — run the model enrichment pipeline.
   * Fetches AA benchmark data and cross-references with OpenRouter capabilities.
   */
  private async handleEnrichCommand(chatId: number): Promise<void> {
    await this.bot.sendChatAction(chatId, 'typing');

    if (!this.aaKey) {
      await this.bot.sendMessage(chatId, '❌ ARTIFICIAL_ANALYSIS_KEY not configured.\nSet it via: wrangler secret put ARTIFICIAL_ANALYSIS_KEY');
      return;
    }

    await this.bot.sendMessage(chatId, '🧠 Running model enrichment (AA benchmarks + capability verification)...');

    try {
      const { runEnrichment, formatEnrichmentMessage } = await import('../openrouter/model-sync/enrich');
      const result = await runEnrichment(
        this.r2Bucket,
        this.aaKey,
        this.openrouterKey,
      );
      const message = formatEnrichmentMessage(result);
      await this.bot.sendMessage(chatId, message);
    } catch (error) {
      await this.bot.sendMessage(chatId, `❌ Enrichment error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle /synccheck — compare curated models against live OpenRouter catalog.
   * Detects missing models, price changes, and new models from tracked families.
   */
  private async handleSyncCheckCommand(chatId: number): Promise<void> {
    await this.bot.sendChatAction(chatId, 'typing');
    await this.bot.sendMessage(chatId, '🔍 Checking curated models against live OpenRouter catalog...');

    try {
      const { runSyncCheck, formatSyncCheckMessage } = await import('../openrouter/model-sync/synccheck');
      const result = await runSyncCheck(this.openrouterKey);
      const message = formatSyncCheckMessage(result);

      // Build actionable buttons for price changes and missing models
      const priceChanged = result.curatedChecks.filter(c => c.status === 'price_changed');
      const buttons: InlineKeyboardButton[][] = [];

      if (priceChanged.length > 0) {
        // Offer to update cost for each changed model
        for (const m of priceChanged.slice(0, 5)) { // Cap at 5 buttons
          buttons.push([{
            text: `💰 Update /${m.alias} cost → ${m.liveCost}`,
            callback_data: `mu:cost:${m.alias}:${m.liveCost}`,
          }]);
        }
      }

      // Offer to apply ALL price updates at once if multiple
      if (priceChanged.length > 1) {
        buttons.push([{
          text: `⚡ Apply all ${priceChanged.length} price updates`,
          callback_data: 'mu:allcost',
        }]);
      }

      if (buttons.length > 0) {
        await this.bot.sendMessageWithButtons(chatId, message, buttons);
      } else {
        await this.bot.sendMessage(chatId, message);
      }
    } catch (error) {
      await this.bot.sendMessage(chatId, `❌ Sync check error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle /modelupdate command — patch curated model fields without code deploy.
   *
   * Smart modes (auto-fetch from OpenRouter):
   *   /modelupdate <alias> refresh                  — refresh cost/caps from live API
   *   /modelupdate <alias> id=<new-model-id>        — swap model + auto-fill metadata
   *   /modelupdate <alias> id=<id> name="Custom"    — auto-fill + manual override
   *
   * Manual mode:
   *   /modelupdate <alias> <key>=<value> [key=value ...]
   *   /modelupdate <alias> revert
   *   /modelupdate list
   *
   * Allowed keys: id, name, cost, score, specialty, maxContext, supportsTools,
   *               supportsVision, parallelCalls, structuredOutput, reasoning
   */
  private async handleModelUpdateCommand(chatId: number, args: string[]): Promise<void> {
    if (args.length === 0) {
      await this.bot.sendMessage(chatId, `🔧 /modelupdate — Patch any model (curated or synced) without deploy

Usage:
  /modelupdate <alias> refresh
  /modelupdate <alias> id=<new-model-id>
  /modelupdate <alias> <key>=<value> ...
  /modelupdate <alias> revert
  /modelupdate list

Smart modes (auto-fetch from OpenRouter):
  /modelupdate sonnet refresh
    → Refreshes cost, capabilities, context from live API
  /modelupdate sonnet id=anthropic/claude-sonnet-4.6
    → Swaps to new model ID + auto-fills all metadata
  /modelupdate sonnet id=anthropic/claude-sonnet-4.6 name="Custom"
    → Auto-fills from API, then applies your overrides on top

Manual mode:
  /modelupdate sonnet cost=$3/$15 score="81% SWE, 200K ctx"
  /modelupdate haiku revert

Allowed keys: id, name, cost, score, specialty, maxContext, supportsTools, supportsVision, parallelCalls, structuredOutput, reasoning`);
      return;
    }

    // /modelupdate list — show active overrides
    if (args[0] === 'list') {
      const overrides = getAllModelOverrides();
      if (Object.keys(overrides).length === 0) {
        await this.bot.sendMessage(chatId, '📋 No active model overrides. All models using static catalog values.');
        return;
      }
      const lines = ['📋 Active model overrides:\n'];
      for (const [a, patch] of Object.entries(overrides)) {
        const bi = getBaseModel(a);
        const base = bi?.model;
        const src = bi?.source === 'synced' ? ' (synced)' : '';
        const fields = Object.entries(patch)
          .map(([k, v]) => `  ${k}: ${(base as unknown as Record<string, unknown>)?.[k]} → ${v}`)
          .join('\n');
        lines.push(`/${a}${src}:\n${fields}`);
      }
      await this.bot.sendMessage(chatId, lines.join('\n\n'));
      return;
    }

    const input = args[0].replace(/^\//, '').toLowerCase();

    // Resolve input to a known alias (supports alias, model ID, or fuzzy match)
    const alias = resolveToAlias(input) || input;
    const baseInfo = getBaseModel(alias);

    if (!baseInfo) {
      await this.bot.sendMessage(chatId, `❌ /${input} not found in any registry (curated, synced, or dynamic).\n\n💡 Try the alias (e.g. \`stepfree\`) or run /model list to find it.`);
      return;
    }

    // /modelupdate <alias> revert — remove override
    if (args[1] === 'revert') {
      const removed = removeModelOverride(alias);
      if (removed) {
        // Persist to R2
        const overrides = getAllModelOverrides();
        await this.storage.saveModelOverrides(overrides);
        await this.bot.sendMessage(chatId, `✅ /${alias} reverted to ${baseInfo.source} catalog.\nModel ID: ${baseInfo.model.id}\nName: ${baseInfo.model.name}`);
      } else {
        await this.bot.sendMessage(chatId, `ℹ️ /${alias} has no override — already using ${baseInfo.source} catalog.`);
      }
      return;
    }

    // /modelupdate <alias> refresh — auto-fetch live data for current model ID
    if (args[1] === 'refresh') {
      const currentModel = getModel(alias);
      if (!currentModel) {
        await this.bot.sendMessage(chatId, `❌ /${alias} not found.`);
        return;
      }
      await this.bot.sendMessage(chatId, `🔄 Fetching live data for ${currentModel.id}...`);
      try {
        const { fetchModelById, buildPatchFromApiModel } = await import('../openrouter/model-sync/sync');
        const liveModel = await fetchModelById(this.openrouterKey, currentModel.id);
        if (!liveModel) {
          await this.bot.sendMessage(chatId, `⚠️ ${currentModel.id} not found on OpenRouter. Model may have been removed.`);
          return;
        }
        const apiPatch = buildPatchFromApiModel(liveModel);
        // Don't override the alias or id (same model, just refreshing metadata)
        delete apiPatch.id;

        // Compute what actually changed vs current state (compare against base from any registry)
        const refreshBase = baseInfo.model;
        const actualChanges: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(apiPatch)) {
          if (JSON.stringify(v) !== JSON.stringify((refreshBase as unknown as Record<string, unknown>)[k])) {
            actualChanges[k] = v;
          }
        }

        if (Object.keys(actualChanges).length === 0) {
          await this.bot.sendMessage(chatId, `✅ /${alias} is already up to date — no changes needed.`);
          return;
        }

        applyModelOverrides({ [alias]: actualChanges as Partial<ModelInfo> });
        const allOverrides = getAllModelOverrides();
        await this.storage.saveModelOverrides(allOverrides);

        const updatedModel = getModel(alias);
        const changes = Object.entries(actualChanges)
          .map(([k, v]) => `  ${k}: ${(refreshBase as unknown as Record<string, unknown>)?.[k]} → ${v}`)
          .join('\n');

        await this.bot.sendMessage(chatId,
          `✅ /${alias} refreshed from OpenRouter:\n${changes}\n\nNow: ${updatedModel?.name} (${updatedModel?.id})\nCost: ${updatedModel?.cost}\n\n💡 Use /modelupdate ${alias} revert to undo.`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await this.bot.sendMessage(chatId, `❌ Refresh failed: ${msg}`);
      }
      return;
    }

    // Parse key=value pairs
    const ALLOWED_STRING_KEYS = new Set(['id', 'name', 'cost', 'score', 'specialty', 'reasoning']);
    const ALLOWED_NUMBER_KEYS = new Set(['maxContext']);
    const ALLOWED_BOOL_KEYS = new Set(['supportsTools', 'supportsVision', 'parallelCalls', 'structuredOutput']);

    const patch: Record<string, unknown> = {};
    const rawPairs = args.slice(1).join(' ');

    // Parse key=value and key="quoted value" pairs
    const pairRegex = /(\w+)=("(?:[^"\\]|\\.)*"|[^\s]+)/g;
    let match;
    while ((match = pairRegex.exec(rawPairs)) !== null) {
      const key = match[1];
      let value: string = match[2];
      // Strip surrounding quotes
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).replace(/\\"/g, '"');
      }

      if (ALLOWED_STRING_KEYS.has(key)) {
        patch[key] = value;
      } else if (ALLOWED_NUMBER_KEYS.has(key)) {
        const num = parseInt(value, 10);
        if (isNaN(num)) {
          await this.bot.sendMessage(chatId, `❌ Invalid number for ${key}: ${value}`);
          return;
        }
        patch[key] = num;
      } else if (ALLOWED_BOOL_KEYS.has(key)) {
        patch[key] = value === 'true' || value === '1' || value === 'yes';
      } else {
        await this.bot.sendMessage(chatId, `❌ Unknown key: ${key}\nAllowed: ${[...ALLOWED_STRING_KEYS, ...ALLOWED_NUMBER_KEYS, ...ALLOWED_BOOL_KEYS].join(', ')}`);
        return;
      }
    }

    if (Object.keys(patch).length === 0) {
      await this.bot.sendMessage(chatId, '❌ No valid key=value pairs found.\nExample: /modelupdate sonnet id=anthropic/claude-sonnet-4.6');
      return;
    }

    // Smart auto-fetch: when `id` is provided, fetch metadata from OpenRouter
    // and use it as the base, with any explicit key=value overrides applied on top.
    if (patch.id && typeof patch.id === 'string') {
      const newModelId = patch.id;
      await this.bot.sendMessage(chatId, `🔄 Fetching metadata for ${newModelId}...`);
      try {
        const { fetchModelById, buildPatchFromApiModel } = await import('../openrouter/model-sync/sync');
        const liveModel = await fetchModelById(this.openrouterKey, newModelId);
        if (liveModel) {
          // Build auto-filled patch from API data
          const apiPatch = buildPatchFromApiModel(liveModel);
          // Merge: API data first, then user's explicit overrides on top
          const userOverrides = { ...patch };
          delete userOverrides.id; // id is already in apiPatch
          Object.assign(patch, apiPatch, userOverrides);
        } else {
          await this.bot.sendMessage(chatId, `⚠️ ${newModelId} not found on OpenRouter — applying manual values only.`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await this.bot.sendMessage(chatId, `⚠️ Auto-fetch failed (${msg}) — applying manual values only.`);
      }
    }

    // Apply the override
    const applied = applyModelOverrides({ [alias]: patch as Partial<ModelInfo> });
    if (applied === 0) {
      await this.bot.sendMessage(chatId, `❌ Failed to apply override for /${alias}.`);
      return;
    }

    // Persist to R2
    const allOverrides = getAllModelOverrides();
    await this.storage.saveModelOverrides(allOverrides);

    // Show result
    const updatedModel = getModel(alias);
    const changes = Object.entries(patch)
      .map(([k, v]) => `  ${k}: ${(baseInfo.model as unknown as Record<string, unknown>)?.[k]} → ${v}`)
      .join('\n');

    await this.bot.sendMessage(chatId,
      `✅ /${alias} updated:\n${changes}\n\nNow: ${updatedModel?.name} (${updatedModel?.id})\nCost: ${updatedModel?.cost}\n\n💡 Use /modelupdate ${alias} revert to undo.`
    );
  }

  /**
   * Handle model update button callbacks from /synccheck actionable results.
   * Callback data formats:
   *   mu:cost:<alias>:<newCost>  — update cost for single model
   *   mu:allcost                 — apply all price updates (re-runs synccheck)
   */
  private async handleModelUpdateCallback(
    parts: string[],
    chatId: number,
    query: TelegramCallbackQuery
  ): Promise<void> {
    const subAction = parts[1];

    if (subAction === 'cost' && parts[2] && parts[3]) {
      const alias = parts[2];
      const newCost = parts.slice(3).join(':'); // Cost may contain $
      if (!getBaseModel(alias)) {
        await this.bot.sendMessage(chatId, `❌ /${alias} not found in any model registry.`);
        return;
      }
      applyModelOverrides({ [alias]: { cost: newCost } });
      const allOverrides = getAllModelOverrides();
      await this.storage.saveModelOverrides(allOverrides);
      // Remove buttons from message
      if (query.message) {
        await this.bot.editMessageReplyMarkup(chatId, query.message.message_id, null);
      }
      await this.bot.sendMessage(chatId, `✅ /${alias} cost updated → ${newCost}`);
    } else if (subAction === 'allcost') {
      // Re-run synccheck and apply all price changes
      try {
        const { runSyncCheck } = await import('../openrouter/model-sync/synccheck');
        const result = await runSyncCheck(this.openrouterKey);
        const priceChanged = result.curatedChecks.filter(c => c.status === 'price_changed');
        if (priceChanged.length === 0) {
          await this.bot.sendMessage(chatId, 'ℹ️ No price changes found (already up to date).');
          return;
        }
        const overridePatches: Record<string, Partial<ModelInfo>> = {};
        for (const m of priceChanged) {
          if (m.liveCost) {
            overridePatches[m.alias] = { cost: m.liveCost };
          }
        }
        applyModelOverrides(overridePatches);
        const allOverrides = getAllModelOverrides();
        await this.storage.saveModelOverrides(allOverrides);
        // Remove buttons from message
        if (query.message) {
          await this.bot.editMessageReplyMarkup(chatId, query.message.message_id, null);
        }
        const lines = priceChanged.map(m => `  /${m.alias}: ${m.curatedCost} → ${m.liveCost}`);
        await this.bot.sendMessage(chatId, `✅ Updated ${priceChanged.length} model prices:\n${lines.join('\n')}`);
      } catch (error) {
        await this.bot.sendMessage(chatId, `❌ Failed to apply: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Handle /syncall top-model quick-use button: immediately switch active model.
   * Callback data: sa:<alias>
   */
  private async handleSyncAllUseCallback(
    query: TelegramCallbackQuery,
    parts: string[],
    userId: string,
    chatId: number,
  ): Promise<void> {
    const alias = parts[1];
    if (!alias) {
      await this.bot.answerCallbackQuery(query.id, { text: 'Invalid button data.' });
      return;
    }

    const model = getModel(alias);
    if (!model) {
      await this.bot.answerCallbackQuery(query.id, { text: `Model /${alias} not found.` });
      return;
    }

    await this.storage.setUserModel(userId, model.alias);
    await this.bot.answerCallbackQuery(query.id, {
      text: `Switched to ${model.name}`,
    });
    await this.bot.sendMessage(
      chatId,
      `✅ Model set to: ${model.name}\n` +
      `Alias: /${model.alias}\n` +
      `${model.specialty}\n` +
      `Cost: ${model.cost}`
    );
  }

  /**
   * Handle sync picker callback queries (toggle, validate, cancel).
   */
  private async handleSyncCallback(
    query: TelegramCallbackQuery,
    parts: string[],
    userId: string,
    chatId: number
  ): Promise<void> {
    // Load session from R2 (persists across Worker instances)
    const session = await this.storage.loadSyncSession(userId) as SyncSession | null;
    if (!session) {
      await this.bot.answerCallbackQuery(query.id, { text: 'Session expired. Run /syncmodels again.' });
      return;
    }

    const subAction = parts[1]; // a=add, r=remove, rp=replace, ok=validate, x=cancel
    const alias = parts[2];

    switch (subAction) {
      case 'a': { // Toggle add selection (deselect replace if active)
        const idx = session.selectedAdd.indexOf(alias);
        if (idx >= 0) {
          session.selectedAdd.splice(idx, 1);
        } else {
          session.selectedAdd.push(alias);
          // Deselect replace for same alias (mutually exclusive)
          const rpIdx = session.selectedReplace.indexOf(alias);
          if (rpIdx >= 0) session.selectedReplace.splice(rpIdx, 1);
        }
        break;
      }

      case 'rp': { // Toggle replace selection (deselect add if active)
        const idx = session.selectedReplace.indexOf(alias);
        if (idx >= 0) {
          session.selectedReplace.splice(idx, 1);
        } else {
          session.selectedReplace.push(alias);
          // Deselect add for same alias (mutually exclusive)
          const addIdx = session.selectedAdd.indexOf(alias);
          if (addIdx >= 0) session.selectedAdd.splice(addIdx, 1);
        }
        break;
      }

      case 'r': { // Toggle remove selection
        const idx = session.selectedRemove.indexOf(alias);
        if (idx >= 0) {
          session.selectedRemove.splice(idx, 1);
        } else {
          session.selectedRemove.push(alias);
        }
        break;
      }

      case 'ok': { // Validate — apply changes
        const totalSelections = session.selectedAdd.length + session.selectedReplace.length + session.selectedRemove.length;
        if (totalSelections === 0) {
          await this.bot.answerCallbackQuery(query.id, { text: 'No models selected!' });
          return;
        }

        // Load existing dynamic models to merge
        const existing = await this.storage.loadDynamicModels();
        const dynamicModels = existing?.models || {};
        const blockedList = existing?.blocked || [];

        // Helper to create ModelInfo from candidate
        const candidateToModelInfo = (candidate: SyncModelCandidate): ModelInfo => ({
          id: candidate.modelId,
          alias: candidate.alias,
          name: candidate.name,
          specialty: candidate.category
            ? `Free ${candidate.category.charAt(0).toUpperCase() + candidate.category.slice(1)} (synced)`
            : 'Free (synced from OpenRouter)',
          score: `${candidate.contextK}K context`,
          cost: 'FREE',
          isFree: true,
          supportsVision: candidate.vision || undefined,
          supportsTools: candidate.tools || undefined,
          maxContext: candidate.contextK * 1024,
        });

        // Add selected new models
        const addedNames: string[] = [];
        for (const addAlias of session.selectedAdd) {
          const candidate = session.newModels.find(m => m.alias === addAlias);
          if (!candidate) continue;
          dynamicModels[addAlias] = candidateToModelInfo(candidate);
          addedNames.push(addAlias);
        }

        // Process replacements (add new + block old)
        const replacedNames: string[] = [];
        for (const replAlias of session.selectedReplace) {
          const repl = session.replacements.find(r => r.newAlias === replAlias);
          if (!repl) continue;
          const candidate = session.newModels.find(m => m.alias === replAlias);
          if (!candidate) continue;

          // Add new model
          dynamicModels[replAlias] = candidateToModelInfo(candidate);

          // Block old model
          if (!blockedList.includes(repl.oldAlias)) {
            blockedList.push(repl.oldAlias);
          }
          delete dynamicModels[repl.oldAlias];
          replacedNames.push(`/${replAlias} ↻ /${repl.oldAlias}`);
        }

        // Block selected stale models
        const removedNames: string[] = [];
        for (const rmAlias of session.selectedRemove) {
          if (!blockedList.includes(rmAlias)) {
            blockedList.push(rmAlias);
          }
          delete dynamicModels[rmAlias];
          removedNames.push(rmAlias);
        }

        // Save to R2 and register in runtime
        await this.storage.saveDynamicModels(dynamicModels, blockedList, {
          syncedAt: Date.now(),
          totalFetched: 0,
        });
        registerDynamicModels(dynamicModels);
        blockModels(blockedList);

        // Build result message
        let result = '✅ Sync complete!\n\n';
        if (addedNames.length > 0) {
          result += `Added ${addedNames.length} model(s):\n`;
          for (const a of addedNames) result += `  /${a}\n`;
        }
        if (replacedNames.length > 0) {
          result += `Replaced ${replacedNames.length} model(s):\n`;
          for (const a of replacedNames) result += `  ${a}\n`;
        }
        if (removedNames.length > 0) {
          result += `Removed ${removedNames.length} model(s):\n`;
          for (const a of removedNames) result += `  /${a}\n`;
        }
        result += '\nChanges are active now and persist across deploys.';

        // Update message, remove buttons, clean up session
        await this.bot.editMessageWithButtons(chatId, session.messageId, result, null);
        await this.storage.deleteSyncSession(userId);
        return;
      }

      case 'x': // Cancel
        await this.bot.editMessageWithButtons(chatId, session.messageId, '🔄 Sync cancelled.', null);
        await this.storage.deleteSyncSession(userId);
        return;
    }

    // Save updated session to R2 and re-render the message
    await this.storage.saveSyncSession(userId, session);
    const text = this.buildSyncMessage(session);
    const buttons = this.buildSyncButtons(session);
    await this.bot.editMessageWithButtons(chatId, session.messageId, text, buttons);
  }

  /**
   * Send /start welcome menu with inline buttons
   */
  private async sendStartMenu(chatId: number): Promise<void> {
    const welcome = `🤖 Welcome to Moltworker!

Your multi-model AI assistant with 15 real-time tools, 4 skills, and 30+ AI models.

Just type a message to chat, or tap a button below to explore:`;

    const buttons: InlineKeyboardButton[][] = [
      // Row 1-2: Feature guides
      [
        { text: '💻 Coding', callback_data: 'start:coding' },
        { text: '🔍 Research', callback_data: 'start:research' },
        { text: '🎨 Images', callback_data: 'start:images' },
      ],
      [
        { text: '🔧 Tools & Data', callback_data: 'start:tools' },
        { text: '👁️ Vision', callback_data: 'start:vision' },
        { text: '🧠 Reasoning', callback_data: 'start:reasoning' },
      ],
      // Row 3-4: Skills
      [
        { text: '✍️ Lyra', callback_data: 'start:lyra' },
        { text: '💡 Spark', callback_data: 'start:spark' },
        { text: '🔬 Nexus', callback_data: 'start:nexus' },
        { text: '🎼 Orchestra', callback_data: 'start:orchestra' },
      ],
      // Row 5: Workflows
      [
        { text: '☁️ Cloudflare', callback_data: 'start:cloudflare' },
      ],
      // Row 4-5: Action sub-menus
      [
        { text: '🤖 Models ▸', callback_data: 'start:sub:models' },
        { text: '💾 Saves ▸', callback_data: 'start:sub:saves' },
        { text: '📊 Stats ▸', callback_data: 'start:sub:stats' },
      ],
      [
        { text: '🔄 Sync ▸', callback_data: 'start:sub:sync' },
        { text: '⚙️ Settings ▸', callback_data: 'start:sub:settings' },
      ],
      // Row 6: Help
      [
        { text: '📖 All Commands', callback_data: 'start:help' },
      ],
    ];

    await this.bot.sendMessageWithButtons(chatId, welcome, buttons);
  }

  /**
   * Get feature detail text for /start button callbacks
   */
  private getStartFeatureText(feature: string): string {
    switch (feature) {
      case 'coding':
        return `💻 Coding with Moltworker

Just describe what you need — I'll read repos, write code, create PRs, and run tests.

What I can do:
• Read files from any GitHub repo
• Create PRs with multi-file changes
• Run code in a sandbox (git, node, npm)
• Analyze code, refactor, debug

🆓 Free models with tools (🔧):
/qwencoderfree — Qwen3 Coder 480B MoE 🔧 (262K ctx)
/trinity — Trinity Large 400B MoE 🔧 (128K ctx)
/devstral — Devstral Small 🔧 (131K ctx)
/gptoss — GPT-OSS 120B 🔧 (128K ctx)

💰 Best paid models for coding:
/deep — DeepSeek V3.2 🔧 ($0.25/M)
/grok — Grok 4.1 🔧 (#1 agentic)
/sonnet — Claude Sonnet 4.5 🔧👁️

⚠️ Models without 🔧 can't use tools (no GitHub, no web fetch).

Try it: "Read the README of PetrAnto/moltworker and summarize it"`;

      case 'research':
        return `🔍 Research & Web

I can fetch any URL, browse JS-heavy sites, pull news, and analyze content.

What I can do:
• Fetch & summarize any webpage
• Browse JS-rendered sites (screenshots, PDFs)
• Get top stories from HackerNews, Reddit, arXiv
• Extract metadata (title, author, images)

Try it: "What's on the front page of Hacker News?"
Try it: "Summarize https://example.com"`;

      case 'images':
        return `🎨 Image Generation

Create images with FLUX.2 models — from quick drafts to high-quality renders.

Usage: /img <prompt>
Example: /img a cat astronaut floating in space

Models (pick by quality):
/img fluxklein — Fast draft ($0.014/MP)
/img fluxpro — Default, great quality ($0.05/MP)
/img fluxflex — Best for text in images ($0.06/MP)
/img fluxmax — Highest quality ($0.07/MP)`;

      case 'tools':
        return `🔧 Tools & Live Data

I have 14 tools that run automatically — just ask naturally:

📊 Data:
• "What's the weather in Prague?"
• "Bitcoin price" / "Top 10 crypto"
• "Convert 100 EUR to CZK"

📰 News:
• "Top stories on HN" / "Reddit r/programming"
• "Latest arXiv papers on cs.AI"

🌐 Web:
• Paste any URL — I'll fetch it
• "Browse https://example.com" for JS sites

📈 Charts:
• "Chart showing quarterly revenue: Q1=10, Q2=15, Q3=22, Q4=30"

🌍 Other:
• "Geolocate IP 8.8.8.8"
• /briefing for a daily digest (weather + news)`;

      case 'vision':
        return `👁️ Vision & Image Analysis

Send a photo and I'll analyze it. Add a caption to guide the analysis.

What I can do:
• Identify objects, text, scenes
• Analyze code from screenshots
• Combine vision with tools (see a city → get its weather)

How to use:
• Send a photo → I describe what I see
• Send a photo + caption → I follow your instructions
• Works with: /gpt, /flash, /haiku, /sonnet, /kimi

Try it: Send a screenshot and ask "What's in this image?"`;

      case 'reasoning':
        return `🧠 Deep Reasoning

Activate extended thinking for complex problems — math, logic, planning.

Usage: Prefix your message with think:high
Example: "think:high Prove that the square root of 2 is irrational"

Levels: think:low, think:medium, think:high, think:off

Also works with JSON: "think:high json: Analyze these metrics..."

Best reasoning models:
/deep — Great value, configurable thinking
/flash — Strong reasoning + 1M context
/opus — Maximum quality`;

      case 'lyra':
        return `✍️ Lyra — Content Creator

Draft, rewrite, headline, and repurpose content with AI self-review.

━━━ Commands ━━━
/write <topic> — Draft new content
/rewrite <text> — Improve existing text
/headline <text> — Generate headline options
/repurpose <text> — Adapt content for different platforms

━━━ Examples ━━━
/write a blog post about serverless AI
/rewrite Make this paragraph more concise: ...
/headline New open-source framework beats GPT-4
/repurpose --platform twitter My latest blog post about...

Lyra auto-reviews its output and revises if quality is low.
Uses: flash model (fast + cheap)`;

      case 'spark':
        return `💡 Spark — Brainstorm & Ideas

Capture ideas, evaluate them through a rigorous gauntlet, and brainstorm new connections.

━━━ Commands ━━━
/save <idea or URL> — Capture an idea to your inbox
/spark — Quick reaction to a random saved idea
/gauntlet — 6-stage deep evaluation of an idea
/brainstorm — Cluster and cross-pollinate your saved ideas
/ideas — List your saved ideas

━━━ Examples ━━━
/save Build a CLI tool that converts Figma to code
/save https://interesting-article.com
/spark
/gauntlet
/brainstorm

Uses: flash model (fast + cheap)`;

      case 'nexus':
        return `🔬 Nexus — Multi-Source Research

Deep research with evidence gathering from 10+ sources, confidence scoring, and decision analysis.

━━━ Commands ━━━
/research <query> — Quick research with source synthesis
/dossier <query> — Full dossier with structured evidence

━━━ Sources ━━━
Web search, Wikipedia, HackerNews, Reddit, arXiv, GDELT news, CoinGecko, Yahoo Finance, DEX Screener, ReliefWeb

━━━ Examples ━━━
/research What is the current state of WebGPU?
/dossier Compare Cloudflare Workers vs AWS Lambda for AI workloads
/research --mode decision Should I use Rust or Go for my CLI tool?

Results are cached for 4 hours. Uses: flash model (fast + cheap)`;

      case 'cloudflare':
        return `☁️ Cloudflare API Integration

Query and execute Cloudflare API calls directly from chat.

━━━ Commands ━━━
/cf search <query> — Search Cloudflare API endpoints
/cf execute <code> — Run TypeScript against Cloudflare SDK

━━━ Examples ━━━
/cf search workers
/cf execute list all zones
/cf search dns records

Uses Code Mode MCP for full Cloudflare SDK access. Requires CLOUDFLARE_API_TOKEN.`;

      case 'orchestra':
        return `🎼 Orchestra Mode — AI Project Execution

Give the bot a complex project. It will break it into phases, create a roadmap, then execute tasks one by one — each as a separate PR.

━━━ How it works ━━━

Step 1: Lock your repo
  /orch set PetrAnto/myapp

Step 2: Create a roadmap
  /orch init Build a user auth system with JWT and OAuth
  → Creates ROADMAP.md + WORK_LOG.md as a PR

Step 3: Execute tasks
  /orch next
  → Reads the roadmap, picks the next task, implements it
  → Updates ROADMAP.md (✅) + WORK_LOG.md in the same PR

Step 4: Repeat
  /orch next  (keep going until done)

━━━ Commands ━━━
/orch set owner/repo — Lock default repo
/orch init <description> — Create roadmap
/orch next — Execute next task
/orch next <specific task> — Execute specific task
/orch run owner/repo — Run with explicit repo
/orch roadmap — View roadmap status
/orch history — View past tasks
/orch unset — Clear locked repo

━━━ Fixing Mistakes ━━━
/orch redo <task> — Re-implement a task that was done wrong
  → Bot examines what went wrong and creates a fix PR
/orch reset <task> — Uncheck a completed task
  → Creates a PR that flips ✅→⬜, then /orch next re-runs it
/orch reset Phase 2 — Reset all tasks in a phase

━━━ What gets created ━━━
📋 ROADMAP.md — Phased task list with - [ ] / - [x] checkboxes
📝 WORK_LOG.md — Table: Date | Task | Model | Branch | PR | Status

Each /orch next picks up where the last one left off.`;

      default:
        return '';
    }
  }

  /**
   * Send a usage hint for commands that require arguments
   */
  private async sendStartHint(chatId: number, hint: string): Promise<void> {
    const hints: Record<string, string> = {
      write: '✍️ Usage: /write <topic or instructions>\n\nExamples:\n/write a blog post about serverless AI\n/write --for linkedin My startup just hit 10K users',
      rewrite: '🔄 Usage: /rewrite <text to improve>\n\nExamples:\n/rewrite Make this clearer: The system processes data efficiently\n/rewrite --tone formal Hey check out this cool thing',
      headline: '📰 Usage: /headline <content to title>\n\nExamples:\n/headline New open-source framework beats GPT-4 at reasoning\n/headline Our Q4 revenue grew 300% year over year',
      repurpose: '🔀 Usage: /repurpose <text to adapt>\n\nExamples:\n/repurpose --platform twitter My latest blog post about AI agents\n/repurpose --platform linkedin We just shipped a major update',
      save: '💾 Usage: /save <idea or URL>\n\nExamples:\n/save Build a CLI that converts Figma to code\n/save https://interesting-article.com',
      research: '🔍 Usage: /research <query>\n\nExamples:\n/research What is the current state of WebGPU?\n/research --mode decision Should I use Rust or Go for my CLI?',
      dossier: '📑 Usage: /dossier <topic>\n\nExamples:\n/dossier Compare Cloudflare Workers vs AWS Lambda\n/dossier State of AI coding assistants in 2026',
      orchset: '🔒 Usage: /orch set <owner/repo>\n\nExample:\n/orch set PetrAnto/myapp',
      orchinit: '📋 Usage: /orch init <project description>\n\nExample:\n/orch init Build a user auth system with JWT and OAuth',
      img: '🎨 Usage: /img <prompt>\n\nExamples:\n/img a cat astronaut floating in space\n/img fluxmax a photorealistic mountain landscape at sunset',
      cfsearch: '🔍 Usage: /cf search <query>\n\nExamples:\n/cf search workers\n/cf search dns records',
    };
    const text = hints[hint] || `Type the command with your input to get started.`;
    await this.bot.sendMessage(chatId, text);
  }

  /**
   * Get per-feature action buttons for /start feature pages
   */
  private getStartFeatureButtons(feature: string): InlineKeyboardButton[][] {
    const back: InlineKeyboardButton[] = [
      { text: '⬅️ Back to Menu', callback_data: 'start:menu' },
      { text: '🤖 Pick Model', callback_data: 'start:pick' },
    ];

    switch (feature) {
      case 'lyra':
        return [
          [
            { text: '✍️ /write', callback_data: 'start:hint:write' },
            { text: '🔄 /rewrite', callback_data: 'start:hint:rewrite' },
          ],
          [
            { text: '📰 /headline', callback_data: 'start:hint:headline' },
            { text: '🔀 /repurpose', callback_data: 'start:hint:repurpose' },
          ],
          back,
        ];
      case 'spark':
        return [
          [
            { text: '💾 /save', callback_data: 'start:hint:save' },
            { text: '📋 /ideas', callback_data: 'start:cmd:ideas' },
          ],
          [
            { text: '⚡ /spark', callback_data: 'start:cmd:spark' },
            { text: '🏟️ /gauntlet', callback_data: 'start:cmd:gauntlet' },
          ],
          [
            { text: '🧠 /brainstorm', callback_data: 'start:cmd:brainstorm' },
          ],
          back,
        ];
      case 'nexus':
        return [
          [
            { text: '🔍 /research', callback_data: 'start:hint:research' },
            { text: '📑 /dossier', callback_data: 'start:hint:dossier' },
          ],
          back,
        ];
      case 'orchestra':
        return [
          [
            { text: '🔒 /orch set', callback_data: 'start:hint:orchset' },
            { text: '📋 /orch init', callback_data: 'start:hint:orchinit' },
          ],
          [
            { text: '▶️ /orch next', callback_data: 'start:cmd:orchnext' },
            { text: '📊 /orch roadmap', callback_data: 'start:cmd:orchroadmap' },
          ],
          [
            { text: '📜 /orch history', callback_data: 'start:cmd:orchhistory' },
          ],
          back,
        ];
      case 'images':
        return [
          [
            { text: '🎨 /img', callback_data: 'start:hint:img' },
          ],
          back,
        ];
      case 'tools':
        return [
          [
            { text: '📰 /briefing', callback_data: 'start:cmd:briefing' },
          ],
          back,
        ];
      case 'coding':
        return [
          [
            { text: '🎼 Orchestra', callback_data: 'start:orchestra' },
            { text: '🆓 Free Models', callback_data: 'start:cmd:syncmodels' },
          ],
          back,
        ];
      case 'cloudflare':
        return [
          [
            { text: '🔍 /cf search', callback_data: 'start:hint:cfsearch' },
          ],
          back,
        ];
      default:
        return [back];
    }
  }

  private getHelpMessage(): string {
    return `📖 Moltworker — Command Reference

━━━ Core ━━━
/model — Model hub (top picks + buttons + guide)
/new or /clear — Reset conversation
/cancel — Stop a running task
/status — Bot status
/ping — Latency check

━━━ Models ━━━
/model              — Hub with recommended models
/model list         — Full catalog with prices
/model rank         — Capability/orchestra ranking
/model <alias>      — Model details (e.g. /model sonnet)
/model use <alias>  — Switch model
/model search <q>   — Search all models (e.g. /model search nvidia)
/model sync         — Fetch latest free models
/model syncall      — Full catalog sync
/model check        — Check for updates
/model enrich       — Fetch benchmarks (Artificial Analysis)
/model update       — Patch model without deploy
Quick switch: /deep /grok /sonnet /flash /opus etc.

━━━ Costs & Credits ━━━
/credits — OpenRouter balance
/costs — Token usage summary
/costs week — Past 7 days breakdown

━━━ Daily Briefing ━━━
/briefing — Weather + HN + Reddit + arXiv digest

━━━ Task History & Memory ━━━
/learnings — View task patterns, success rates, top tools
/sessions — Recent context sessions (replay & analysis)
/memory — View remembered facts about you
/memory add <fact> — Manually add a fact
/memory remove <id> — Remove a specific fact
/memory clear — Clear all memories

━━━ Files ━━━
/files — List your saved files
/files get <name> — Show file content
/files delete <name> — Delete a file
/files clear — Delete all files

━━━ Image Generation ━━━
/img <prompt> — Generate (default: FLUX.2 Pro)
/img fluxmax <prompt> — Pick model
Available: fluxklein, fluxpro, fluxflex, fluxmax

━━━ Checkpoints ━━━
/saves — List saved slots
/saveas <name> — Save current state
/load <name> — Restore state
/delsave <name> — Delete slot
/ar — Toggle auto-resume
/autoroute — Toggle fast-model routing for simple queries
/resume [model] — Resume with optional model override

━━━ Cloudflare API ━━━
/cloudflare search <query> — Search CF API endpoints
/cloudflare execute <code> — Run TypeScript against CF SDK
/cf — Shortcut alias

━━━ 15 Live Tools ━━━
The bot calls these automatically when relevant:
 • get_weather — Current conditions + 7-day forecast
 • get_crypto — Coin price, top N, DEX pairs
 • convert_currency — Live exchange rates
 • fetch_news — HackerNews, Reddit, arXiv
 • fetch_url — Read any web page
 • browse_url — JS-rendered pages, screenshots, PDFs
 • url_metadata — Page title/description/image
 • generate_chart — Chart.js image via QuickChart
 • geolocate_ip — IP to city/country/timezone
 • github_read_file — Read file from any repo
 • github_list_files — List repo directory
 • github_api — Full GitHub API access
 • github_create_pr — Create PR with file changes
 • sandbox_exec — Run commands in sandbox container
 • cloudflare_api — Full Cloudflare API via Code Mode MCP

━━━ Lyra — Content Creator ━━━
/write <topic> — Draft new content
/rewrite <text> — Improve existing text
/headline <text> — Generate headline options
/repurpose <text> — Adapt for other platforms

━━━ Spark — Brainstorm & Ideas ━━━
/save <idea or URL> — Capture to inbox
/spark — Quick reaction to a random idea
/gauntlet — 6-stage deep evaluation
/brainstorm — Cluster and cross-pollinate ideas
/ideas — List saved ideas

━━━ Nexus — Research ━━━
/research <query> — Quick multi-source research
/dossier <query> — Full dossier with evidence

━━━ Orchestra Mode ━━━
/orch set owner/repo — Lock default repo
/orch do <desc> — One-shot task (no roadmap)
/orch init <desc> — Create ROADMAP.md + WORK_LOG.md
/orch next — Execute next roadmap task
/orch next <task> — Execute specific task
/orch merge <PR#> [method] — Merge PR (squash/merge/rebase)
/orch roadmap — View roadmap status
/orch history — View past tasks
/orch redo <task> — Re-implement a failed task
/orch reset <task> — Uncheck task(s) for re-run

━━━ Special Prefixes ━━━
think:high <msg> — Deep reasoning (also: low, medium, off)
json: <msg> — Structured JSON output
Both work together: think:high json: analyze X

━━━ Vision ━━━
Send a photo with a caption — the bot analyzes the image and can call tools based on what it sees (e.g. identify a city, then look up its weather).
Send a photo without caption — defaults to "What is in this image?"
Models with vision: gpt, sonnet, haiku, flash, geminipro, kimi, kimidirect`;
  }

  /**
   * Get the Telegram bot instance (for webhook setup)
   */
  getBot(): TelegramBot {
    return this.bot;
  }
}

/**
 * Create a Telegram handler
 */
export function createTelegramHandler(
  telegramToken: string,
  openrouterKey: string,
  r2Bucket: R2Bucket,
  workerUrl?: string,
  defaultSkill?: string,
  allowedUserIds?: string[],
  githubToken?: string,
  braveSearchKey?: string,
  taskProcessor?: DurableObjectNamespace<TaskProcessor>,
  browser?: Fetcher,
  dashscopeKey?: string,
  moonshotKey?: string,
  deepseekKey?: string,
  anthropicKey?: string,
  sandbox?: SandboxLike,
  acontextKey?: string,
  acontextBaseUrl?: string,
  cloudflareApiToken?: string,
  aaKey?: string,
  nexusKv?: KVNamespace,
): TelegramHandler {
  return new TelegramHandler(
    telegramToken,
    openrouterKey,
    r2Bucket,
    workerUrl,
    defaultSkill,
    allowedUserIds,
    githubToken,
    braveSearchKey,
    taskProcessor,
    browser,
    dashscopeKey,
    moonshotKey,
    deepseekKey,
    anthropicKey,
    sandbox,
    acontextKey,
    acontextBaseUrl,
    cloudflareApiToken,
    aaKey,
    nexusKv,
  );
}
