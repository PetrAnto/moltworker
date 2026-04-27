/**
 * Gecko Skills — LLM Helper
 *
 * Thin wrapper around OpenRouterClient for skill handlers.
 * Provides callSkillLLM() and selectSkillModel() — the functions
 * the spec assumes exist but don't in the base codebase.
 */

import { createOpenRouterClient, type ChatMessage, type ResponseFormat } from '../openrouter/client';
import { getModel, getModelId, getProvider, isDirectApi, DEFAULT_MODEL } from '../openrouter/models';
import type { MoltbotEnv } from '../types';

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/**
 * Select the model alias for a skill call.
 *
 * Priority:
 *   1. Explicit override from the request
 *   2. Skill-specific default
 *   3. Global default ('auto')
 */
export function selectSkillModel(
  requestModel: string | undefined,
  skillDefault: string,
): string {
  if (requestModel && getModel(requestModel)) return requestModel;
  if (getModel(skillDefault)) return skillDefault;
  return DEFAULT_MODEL;
}

/**
 * Resolve the model id the skill path should ship to OpenRouter for a given
 * alias.
 *
 * Returns:
 *   - undefined when the registry id is already OpenRouter-compatible (the
 *     caller's default lookup path is fine);
 *   - a synthesized `anthropic/<id>` for direct-API Anthropic aliases (so
 *     OpenRouter can resolve `sonnet` → `anthropic/claude-sonnet-4-6`);
 *   - throws for direct-only providers (DashScope/Moonshot/DeepSeek/etc.)
 *     because routing them through OpenRouter isn't viable — surface a clear
 *     "switch model" message instead of a confusing OpenRouter rejection.
 */
export function resolveSkillModelId(modelAlias: string): string | undefined {
  if (!isDirectApi(modelAlias)) return undefined;

  const provider = getProvider(modelAlias);
  if (provider === 'anthropic') {
    const id = getModelId(modelAlias);
    return id.includes('/') ? id : `anthropic/${id}`;
  }

  throw new Error(
    `Skills can't use the direct-API model "${modelAlias}" (provider: ${provider}). ` +
    `Switch to an OpenRouter-routed model — e.g. /use auto, /use kimi26or, /use flash, or /use sonnetrouter.`,
  );
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

export interface CallSkillLLMOptions {
  /** System prompt (prepended as a system message). */
  systemPrompt?: string;
  /** User prompt (the main query). */
  userPrompt: string;
  /** Model alias to use. */
  modelAlias: string;
  /** Optional response format (JSON mode). */
  responseFormat?: ResponseFormat;
  /** Max tokens for the response. */
  maxTokens?: number;
  /** Temperature (default 0.7). */
  temperature?: number;
  /** Worker env (needed for API key). */
  env: MoltbotEnv;
}

export interface CallSkillLLMResult {
  /** Raw text response from the model. */
  text: string;
  /** Token usage if available. */
  tokens?: { prompt: number; completion: number };
}

/**
 * Call an LLM through OpenRouter for a skill handler.
 *
 * This is a simple single-turn call (no tool loop). For tool-calling
 * workflows, use the OpenRouterClient directly.
 */
export async function callSkillLLM(options: CallSkillLLMOptions): Promise<CallSkillLLMResult> {
  const {
    systemPrompt,
    userPrompt,
    modelAlias,
    responseFormat,
    maxTokens,
    temperature,
    env,
  } = options;

  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('[callSkillLLM] OPENROUTER_API_KEY not configured');
  }

  const client = createOpenRouterClient(apiKey);

  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userPrompt });

  // Route direct-API models through OpenRouter where possible. The skill path
  // only speaks OpenRouter (no streaming Anthropic/DashScope/Moonshot/DeepSeek
  // clients), so an alias like `sonnet` (provider:'anthropic', id:'claude-sonnet-4-6')
  // would otherwise ship a bare id OpenRouter rejects. For Anthropic models we
  // synthesize the OpenRouter form `anthropic/<id>`. For direct-only providers
  // we surface a clear error pointing the user at compatible models.
  const modelIdOverride = resolveSkillModelId(modelAlias);

  const response = await client.chatCompletion(modelAlias, messages, {
    maxTokens: maxTokens ?? 4096,
    temperature: temperature ?? 0.7,
    responseFormat,
    modelIdOverride,
  });

  const text = response.choices[0]?.message?.content ?? '';
  const tokens = response.usage
    ? { prompt: response.usage.prompt_tokens, completion: response.usage.completion_tokens }
    : undefined;

  return { text, tokens };
}
