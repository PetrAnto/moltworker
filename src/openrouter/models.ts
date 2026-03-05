/**
 * OpenRouter Model Definitions
 * Direct model IDs for OpenRouter API
 */

// Direct API providers
export type Provider = 'openrouter' | 'dashscope' | 'moonshot' | 'deepseek';

export interface ProviderConfig {
  baseUrl: string;
  envKey: string; // Environment variable name for API key
  maxOutputTokens?: number; // Provider-specific max_tokens ceiling
}

export const PROVIDERS: Record<Provider, ProviderConfig> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    envKey: 'OPENROUTER_API_KEY',
  },
  dashscope: {
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    envKey: 'DASHSCOPE_API_KEY',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.ai/v1/chat/completions',
    envKey: 'MOONSHOT_API_KEY',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/chat/completions',
    envKey: 'DEEPSEEK_API_KEY',
    maxOutputTokens: 8192, // DeepSeek API hard limit
  },
};

export type ReasoningCapability = 'none' | 'fixed' | 'configurable' | 'mandatory';

export interface ModelInfo {
  id: string;
  alias: string;
  name: string;
  specialty: string;
  score: string;
  cost: string;
  supportsVision?: boolean;
  supportsTools?: boolean;
  isImageGen?: boolean;
  isFree?: boolean;
  provider?: Provider; // Direct API provider (default: openrouter)
  // Extended capability metadata (R2)
  parallelCalls?: boolean;       // Can emit multiple tool_calls in one response
  structuredOutput?: boolean;    // Supports response_format JSON schema
  reasoning?: ReasoningCapability; // Reasoning control capability
  maxContext?: number;           // Context window in tokens
  fixedTemperature?: number;    // Model requires this exact temperature (e.g. Kimi K2.5 = 1)
  // Benchmark & quality data (from Artificial Analysis)
  intelligenceIndex?: number;  // AA Intelligence Index (0-100 composite score)
  benchmarks?: ModelBenchmarks; // Individual benchmark scores
  orchestraReady?: boolean;    // Computed: suitable for orchestra/agentic tasks
}

/** Benchmark scores from Artificial Analysis */
export interface ModelBenchmarks {
  coding?: number;        // AA Coding Index
  math?: number;          // AA Math Index
  mmluPro?: number;       // MMLU-Pro score
  gpqa?: number;          // GPQA Diamond score
  livecodebench?: number; // LiveCodeBench score
  speedTps?: number;      // Median output tokens/sec
}

/**
 * Complete model catalog with direct OpenRouter IDs
 * Organized by category: Free → Paid (by cost)
 */
export const MODELS: Record<string, ModelInfo> = {
  // Auto-routing (default)
  auto: {
    id: 'openrouter/auto',
    alias: 'auto',
    name: 'OpenRouter Auto',
    specialty: 'Auto/Best-Value (Default)',
    score: 'Dynamic routing',
    cost: 'Variable (often FREE)',
    isFree: true,
    supportsTools: true,
  },

  // === FREE MODELS ===
  trinity: {
    id: 'arcee-ai/trinity-large-preview:free',
    alias: 'trinity',
    name: 'Trinity Large',
    specialty: 'Free Premium Agentic/Reasoning',
    score: '400B MoE (13B active), 128K context',
    cost: 'FREE',
    supportsTools: true,
    structuredOutput: true,
    isFree: true,
    maxContext: 131072,
  },
  deepfree: {
    id: 'deepseek/deepseek-r1-0528:free',
    alias: 'deepfree',
    name: 'DeepSeek R1 0528 (Free)',
    specialty: 'Free Deep Reasoning/Math',
    score: '671B MoE, strong AIME/Math',
    cost: 'FREE',
    isFree: true,
    maxContext: 163840,
  },
  glmfree: {
    id: 'z-ai/glm-4.5-air:free',
    alias: 'glmfree',
    name: 'GLM 4.5 Air',
    specialty: 'Free General/Multimodal',
    score: 'Solid MMMU/general',
    cost: 'FREE',
    supportsTools: true,
    isFree: true,
  },
  stepfree: {
    id: 'stepfun/step-3.5-flash:free',
    alias: 'stepfree',
    name: 'Step 3.5 Flash',
    specialty: 'Free Speed/Long Context',
    score: '256k context, fast',
    cost: 'FREE',
    supportsTools: true,
    isFree: true,
  },
  // llama405free removed — deprecated on OpenRouter (Jan 2026)
  // nemofree removed — no longer in OpenRouter free collection
  qwencoderfree: {
    id: 'qwen/qwen3-coder:free',
    alias: 'qwencoderfree',
    name: 'Qwen3 Coder (Free)',
    specialty: 'Free Agentic Coding',
    score: '480B MoE, strong SWE-Bench',
    cost: 'FREE',
    supportsTools: true,
    isFree: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 262144,
  },
  // llama70free removed — replaced by maverick (Llama 4 Maverick, 400B MoE, 1M ctx)
  maverick: {
    id: 'meta-llama/llama-4-maverick:free',
    alias: 'maverick',
    name: 'Llama 4 Maverick',
    specialty: 'Free Multimodal/Large Context',
    score: '400B MoE (17B active), 1M context',
    cost: 'FREE',
    supportsVision: true,
    isFree: true,
    maxContext: 1048576,
  },
  trinitymini: {
    id: 'arcee-ai/trinity-mini:free',
    alias: 'trinitymini',
    name: 'Trinity Mini',
    specialty: 'Free Fast Reasoning',
    score: '26B MoE (3B active), 131K context',
    cost: 'FREE',
    supportsTools: true,
    structuredOutput: true,
    isFree: true,
    maxContext: 131072,
  },
  pony: {
    id: 'openrouter/pony-alpha',
    alias: 'pony',
    name: 'GLM-5 (Pony Alpha)',
    specialty: 'Free Coding/Agentic/Reasoning',
    score: '744B MoE (40B active), 77.8% SWE-Bench, MIT license',
    cost: 'FREE',
    supportsTools: true,
    isFree: true,
    maxContext: 200000,
  },
  gptoss: {
    id: 'openai/gpt-oss-120b:free',
    alias: 'gptoss',
    name: 'GPT-OSS 120B',
    specialty: 'Free Reasoning/Tools (OpenAI Open-Source)',
    score: '117B MoE (5.1B active), native tool use',
    cost: 'FREE',
    supportsTools: true,
    isFree: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 128000,
  },
  // mimo removed — free period ended Jan 26, 2026 (404 error)
  mimo: {
    id: 'xiaomi/mimo-v2-flash',
    alias: 'mimo',
    name: 'MiMo V2 Flash',
    specialty: 'Paid Top-Tier Coding/Reasoning',
    score: '#1 OSS SWE-Bench, 309B MoE (15B active), 256K ctx',
    cost: '$0.10/$0.30',
    supportsTools: true,
    structuredOutput: true,
    maxContext: 262144,
  },
  phi4reason: {
    id: 'microsoft/phi-4-reasoning:free',
    alias: 'phi4reason',
    name: 'Phi-4 Reasoning',
    specialty: 'Free Math/Code Reasoning',
    score: '14B dense, strong AIME/LiveCodeBench',
    cost: 'FREE',
    supportsTools: true,
    isFree: true,
    reasoning: 'fixed',
    maxContext: 32768,
  },
  // hermes405free removed — Hermes 3 is outdated, superseded by Hermes 4
  deepchatfree: {
    id: 'deepseek/deepseek-chat-v3.1:free',
    alias: 'deepchatfree',
    name: 'DeepSeek Chat V3.1 (Free)',
    specialty: 'Free Fast General Chat/Tools',
    score: 'GPT-4o class, fast inference',
    cost: 'FREE',
    supportsTools: true,
    isFree: true,
    maxContext: 131072,
  },
  chimerafree: {
    id: 'tngtech/deepseek-r1t2-chimera:free',
    alias: 'chimerafree',
    name: 'DeepSeek R1T2 Chimera',
    specialty: 'Free Reasoning Chimera',
    score: 'Rising usage, reasoning variant',
    cost: 'FREE',
    isFree: true,
    maxContext: 163840,
  },
  kimifree: {
    id: 'moonshotai/kimi-k2:free',
    alias: 'kimifree',
    name: 'Kimi K2 (Free)',
    specialty: 'Free General/Long Context',
    score: 'Agent tasks, long context',
    cost: 'FREE',
    // Note: OpenRouter lists tool support but multiple IDEs report it as broken
    // (model responds in plain text instead of invoking tools). Omitting supportsTools.
    isFree: true,
    maxContext: 131072,
  },
  qwen235free: {
    id: 'qwen/qwen3-235b-a22b:free',
    alias: 'qwen235free',
    name: 'Qwen3 235B (Free)',
    specialty: 'Free Largest MoE/Reasoning',
    score: '235B MoE (22B active), strong reasoning',
    cost: 'FREE',
    isFree: true,
    maxContext: 131072,
  },
  devstral2free: {
    id: 'mistralai/devstral-2512:free',
    alias: 'devstral2free',
    name: 'Devstral 2 (Free)',
    specialty: 'Free Premium Agentic Coding',
    score: '123B dense, multi-file refactoring',
    cost: 'FREE',
    supportsTools: true,
    isFree: true,
    parallelCalls: true,
    maxContext: 262144,
  },

  // === IMAGE GENERATION ===
  fluxklein: {
    id: 'black-forest-labs/flux.2-klein-4b',
    alias: 'fluxklein',
    name: 'FLUX.2 Klein',
    specialty: 'Fast/Cheap Image Gen',
    score: 'Best value images',
    cost: '$0.014/megapixel',
    isImageGen: true,
  },
  fluxpro: {
    id: 'black-forest-labs/flux.2-pro',
    alias: 'fluxpro',
    name: 'FLUX.2 Pro',
    specialty: 'Pro Image Generation',
    score: 'Top-tier images',
    cost: '$0.05/megapixel',
    isImageGen: true,
  },
  fluxflex: {
    id: 'black-forest-labs/flux.2-flex',
    alias: 'fluxflex',
    name: 'FLUX.2 Flex',
    specialty: 'Text/Typography Images',
    score: 'Best for text in images',
    cost: '$0.06/megapixel',
    isImageGen: true,
  },
  fluxmax: {
    id: 'black-forest-labs/flux.2-max',
    alias: 'fluxmax',
    name: 'FLUX.2 Max',
    specialty: 'Advanced Image Gen',
    score: 'Highest quality',
    cost: '$0.07/megapixel',
    isImageGen: true,
  },

  // === PAID MODELS (by cost) ===
  // nemo removed — Mistral Nemo 12B (mid-2024), completely superseded
  // qwencoder7b removed — Qwen 2.5 era, 2 generations behind Qwen3 Coder
  devstral: {
    id: 'mistralai/devstral-small:free',
    alias: 'devstral',
    name: 'Devstral Small',
    specialty: 'Free Agentic Coding',
    score: '53.6% SWE-Bench, 128K context',
    cost: 'FREE',
    supportsTools: true,
    isFree: true,
    parallelCalls: true,
    maxContext: 131072,
  },
  devstral2: {
    id: 'mistralai/devstral-2512',
    alias: 'devstral2',
    name: 'Devstral 2',
    specialty: 'Paid Premium Agentic Coding',
    score: '123B dense, 256K context',
    cost: '$0.05/$0.22',
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 262144,
  },
  glm47: {
    id: 'z-ai/glm-4.7',
    alias: 'glm47',
    name: 'GLM 4.7',
    specialty: 'Paid Agentic/Reasoning',
    score: '200K context, stable multi-step execution',
    cost: '$0.07/$0.40',
    supportsTools: true,
    structuredOutput: true,
    maxContext: 200000,
  },
  mini: {
    id: 'openai/gpt-4o-mini',
    alias: 'mini',
    name: 'GPT-4o Mini',
    specialty: 'Cheap Paid Light Tasks',
    score: 'Good all-round',
    cost: '$0.15/$0.60',
    supportsVision: true,
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 128000,
  },
  qwenthink: {
    id: 'qwen/qwen3-next-80b-a3b-thinking',
    alias: 'qwenthink',
    name: 'Qwen3 Next Thinking',
    specialty: 'Paid Reasoning-First/Structured',
    score: '80B MoE, auto <think> traces',
    cost: '$0.15/$1.20',
    supportsTools: true,
    reasoning: 'fixed',
    structuredOutput: true,
    maxContext: 128000,
  },
  minimax: {
    id: 'minimax/minimax-m2.5',
    alias: 'minimax',
    name: 'MiniMax M2.5',
    specialty: 'Paid Agentic/Office/Coding',
    score: '80.2% SWE-Bench, 1M context, cross-env agents',
    cost: '$0.20/$1.10',
    supportsTools: true,
    parallelCalls: true,
    reasoning: 'fixed', // MiniMax API requires reasoning — cannot be disabled
    structuredOutput: true,
    maxContext: 196608,
  },
  grok: {
    id: 'x-ai/grok-4.1-fast',
    alias: 'grok',
    name: 'Grok 4.1 Fast',
    specialty: 'Paid Agentic/Tools/Search',
    score: '#1 agentic, 2M context',
    cost: '$0.20/$0.50',
    supportsVision: true,
    supportsTools: true,
    parallelCalls: true,
    reasoning: 'configurable',
    structuredOutput: true,
    maxContext: 2000000,
  },
  grokcode: {
    id: 'x-ai/grok-code-fast-1',
    alias: 'grokcode',
    name: 'Grok Code Fast',
    specialty: 'Paid Coding/Tools',
    score: 'Agentic coding with reasoning traces',
    cost: '$0.20/$1.50',
    supportsTools: true,
    parallelCalls: true,
    reasoning: 'fixed',
    structuredOutput: true,
    maxContext: 256000,
  },
  qwennext: {
    id: 'qwen/qwen3-coder-next',
    alias: 'qwennext',
    name: 'Qwen3 Coder Next',
    specialty: 'Paid Efficient Agentic Coding',
    score: '70.6% SWE-Bench, 80B MoE',
    cost: '$0.20/$1.50',
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 262144,
  },
  qwencoder: {
    id: 'qwen/qwen3-coder',
    alias: 'qwencoder',
    name: 'Qwen3 Coder',
    specialty: 'Paid Flagship Agentic Coding',
    score: '54-55% SWE-Bench, 480B MoE',
    cost: '$0.22/$0.95',
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 262144,
  },
  deep: {
    id: 'deepseek/deepseek-v3.2',
    alias: 'deep',
    name: 'DeepSeek V3.2',
    specialty: 'Paid General/Reasoning (Value King)',
    score: '68-75% SWE, GPT-5 class reasoning',
    cost: '$0.25/$0.38',
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    reasoning: 'configurable',
    maxContext: 163840,
  },
  deepreason: {
    id: 'deepseek/deepseek-r1-0528',
    alias: 'deepreason',
    name: 'DeepSeek R1 0528',
    specialty: 'Paid Deep Math/Reasoning',
    score: 'Approaches O3/Gemini 2.5 Pro level',
    cost: '$0.40/$1.75',
    supportsTools: true,
    structuredOutput: true,
    maxContext: 163840,
  },
  mistrallarge: {
    id: 'mistralai/mistral-large-2512',
    alias: 'mistrallarge',
    name: 'Mistral Large 3',
    specialty: 'Paid Premium General',
    score: '675B MoE (41B active), Apache 2.0',
    cost: '$0.50/$1.50',
    supportsVision: true,
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 262144,
  },
  kimi: {
    id: 'moonshotai/kimi-k2.5',
    alias: 'kimi',
    name: 'Kimi K2.5',
    specialty: 'Paid Vision/Agents',
    score: '78% MMMU',
    cost: '$0.50/$2.80',
    supportsVision: true,
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 262144,
  },
  flash: {
    id: 'google/gemini-3-flash-preview',
    alias: 'flash',
    name: 'Gemini 3 Flash',
    specialty: 'Paid Speed/Massive Context',
    score: '1M context, agentic workflows',
    cost: '$0.50/$3.00',
    supportsVision: true,
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    reasoning: 'configurable',
    maxContext: 1048576,
  },
  haiku: {
    id: 'anthropic/claude-haiku-4.5',
    alias: 'haiku',
    name: 'Claude Haiku 4.5',
    specialty: 'Paid Fast Claude',
    score: '73% SWE',
    cost: '$1/$5',
    supportsVision: true,
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 200000,
  },
  geminipro: {
    id: 'google/gemini-3-pro-preview',
    alias: 'geminipro',
    name: 'Gemini 3 Pro',
    specialty: 'Paid Advanced Reasoning/Vision',
    score: 'SOTA reasoning, 1M context',
    cost: '$2/$12',
    supportsVision: true,
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    reasoning: 'configurable',
    maxContext: 1048576,
  },
  gpt: {
    id: 'openai/gpt-4o',
    alias: 'gpt',
    name: 'GPT-4o',
    specialty: 'Paid Vision/Tools',
    score: '84% MMMU',
    cost: '$2.50/$10',
    supportsVision: true,
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 128000,
  },
  sonnet: {
    id: 'anthropic/claude-sonnet-4.6',
    alias: 'sonnet',
    name: 'Claude Sonnet 4.6',
    specialty: 'Paid Premium Reasoning',
    score: 'AA Index (48), Code (79), 1M context',
    cost: '$3/$15',
    supportsVision: true,
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 1000000,
  },
  opus45: {
    id: 'anthropic/claude-opus-4.5',
    alias: 'opus45',
    name: 'Claude Opus 4.5',
    specialty: 'Paid Premium (Previous Gen)',
    score: '80.9% SWE-Bench, 200K context',
    cost: '$5/$25',
    supportsVision: true,
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 200000,
  },
  opus: {
    id: 'anthropic/claude-opus-4.6',
    alias: 'opus',
    name: 'Claude Opus 4.6',
    specialty: 'Paid Best Quality (Newest)',
    score: 'AA Index #1 (53), best for professional tasks',
    cost: '$5/$25',
    supportsVision: true,
    supportsTools: true,
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 1000000,
  },

  // === DIRECT API MODELS (bypass OpenRouter) ===
  dcode: {
    id: 'deepseek-chat',
    alias: 'dcode',
    name: 'DeepSeek V3.2 (Direct)',
    specialty: 'Direct DeepSeek API - Tools/Reasoning/Coding',
    score: 'V3.2 128K ctx, prefix caching (90% cheaper), tool use in thinking mode',
    cost: '$0.28/$0.42',
    supportsTools: true,
    provider: 'deepseek',
    parallelCalls: true,
    structuredOutput: true,
    reasoning: 'configurable',
    maxContext: 131072,
  },
  dreason: {
    id: 'deepseek-reasoner',
    alias: 'dreason',
    name: 'DeepSeek Reasoner (Direct)',
    specialty: 'Direct DeepSeek API - Deep Reasoning/Math',
    score: 'V3.2 128K ctx, chain-of-thought, 64K max output',
    cost: '$0.28/$0.42',
    provider: 'deepseek',
    reasoning: 'fixed',
    maxContext: 131072,
  },
  q3coder: {
    id: 'qwen3-coder-plus',
    alias: 'q3coder',
    name: 'Qwen3 Coder Plus (Direct)',
    specialty: 'Direct DashScope API - Agentic Coding',
    score: '480B MoE, 256K ctx, context cache (20% rate on hits)',
    cost: '$1.00/$5.00',
    supportsTools: true,
    provider: 'dashscope',
    parallelCalls: true,
    structuredOutput: true,
    maxContext: 262144,
  },
  kimidirect: {
    id: 'kimi-k2.5',
    alias: 'kimidirect',
    name: 'Kimi K2.5 (Direct)',
    specialty: 'Direct Moonshot API - Agentic/Vision/Coding',
    score: '1T MoE (32B active), 256K ctx, 76.8% SWE-Bench, cache hits $0.10/M',
    cost: '$0.60/$3.00',
    supportsTools: true,
    supportsVision: true,
    provider: 'moonshot',
    parallelCalls: true,
    maxContext: 262144,
    fixedTemperature: 1,
  },
};

// === DYNAMIC MODELS (synced from OpenRouter at runtime) ===

/**
 * Dynamic models discovered via /syncmodels (interactive free-model picker).
 * Checked first by getModel() — overrides static catalog.
 */
const DYNAMIC_MODELS: Record<string, ModelInfo> = {};

/**
 * Auto-synced models from the full catalog sync (cron + /syncall).
 * Lowest priority — curated and /syncmodels dynamic models take precedence.
 */
const AUTO_SYNCED_MODELS: Record<string, ModelInfo> = {};

/**
 * Blocked model aliases (hidden at runtime).
 * Used to hide stale free models that no longer work on OpenRouter.
 */
const BLOCKED_ALIASES: Set<string> = new Set();

/**
 * Register dynamically discovered models (from R2 or API sync).
 * These take priority over the static MODELS catalog.
 */
export function registerDynamicModels(models: Record<string, ModelInfo>): void {
  // Clear existing dynamic models first
  for (const key of Object.keys(DYNAMIC_MODELS)) {
    delete DYNAMIC_MODELS[key];
  }
  Object.assign(DYNAMIC_MODELS, models);
}

/**
 * Apply model overrides: merge partial patches on top of the static catalog
 * and register the results as dynamic models (highest priority in getModel).
 *
 * Each key in `overrides` is an alias from the static MODELS catalog.
 * The override fields are merged on top of the static entry to produce a
 * complete ModelInfo that is stored in DYNAMIC_MODELS.
 *
 * Existing dynamic models (from /syncmodels) are preserved — only overridden
 * aliases are replaced.
 */
export function applyModelOverrides(overrides: Record<string, Partial<ModelInfo>>): number {
  let applied = 0;
  for (const [alias, patch] of Object.entries(overrides)) {
    const lower = alias.toLowerCase();
    const base = MODELS[lower];
    if (!base) continue; // Only override curated models
    const merged: ModelInfo = { ...base, ...patch, alias: lower };
    DYNAMIC_MODELS[lower] = merged;
    applied++;
  }
  return applied;
}

/**
 * Remove a model override, reverting to the static catalog entry.
 */
export function removeModelOverride(alias: string): boolean {
  const lower = alias.toLowerCase();
  if (!(lower in MODELS)) return false; // Not a curated model
  delete DYNAMIC_MODELS[lower];
  return true;
}

/**
 * Get the current override for an alias (the diff from static), or null.
 */
export function getModelOverride(alias: string): Partial<ModelInfo> | null {
  const lower = alias.toLowerCase();
  const dynamic = DYNAMIC_MODELS[lower];
  const base = MODELS[lower];
  if (!dynamic || !base) return null;
  // Compute diff: only fields that differ from base
  const diff: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dynamic)) {
    if (key === 'alias') continue;
    if (JSON.stringify(value) !== JSON.stringify((base as unknown as Record<string, unknown>)[key])) {
      diff[key] = value;
    }
  }
  return Object.keys(diff).length > 0 ? diff as Partial<ModelInfo> : null;
}

/**
 * Get all current model overrides (for persistence).
 */
export function getAllModelOverrides(): Record<string, Partial<ModelInfo>> {
  const result: Record<string, Partial<ModelInfo>> = {};
  for (const alias of Object.keys(DYNAMIC_MODELS)) {
    if (alias in MODELS) {
      const override = getModelOverride(alias);
      if (override) result[alias] = override;
    }
  }
  return result;
}

/**
 * Add models to the blocked list (hidden from getModel/getAllModels).
 */
export function blockModels(aliases: string[]): void {
  for (const a of aliases) BLOCKED_ALIASES.add(a.toLowerCase());
}

/**
 * Remove models from the blocked list.
 */
export function unblockModels(aliases: string[]): void {
  for (const a of aliases) BLOCKED_ALIASES.delete(a.toLowerCase());
}

/**
 * Get list of currently blocked aliases.
 */
export function getBlockedAliases(): string[] {
  return [...BLOCKED_ALIASES];
}

/**
 * Register auto-synced models from the full catalog sync.
 * These are lowest priority — curated and /syncmodels dynamic models override them.
 */
export function registerAutoSyncedModels(models: Record<string, ModelInfo>): void {
  for (const key of Object.keys(AUTO_SYNCED_MODELS)) {
    delete AUTO_SYNCED_MODELS[key];
  }
  Object.assign(AUTO_SYNCED_MODELS, models);
}

/**
 * Get the count of dynamically registered models (/syncmodels interactive).
 */
export function getDynamicModelCount(): number {
  return Object.keys(DYNAMIC_MODELS).length;
}

/**
 * Get the count of auto-synced models (full catalog sync).
 */
export function getAutoSyncedModelCount(): number {
  return Object.keys(AUTO_SYNCED_MODELS).length;
}

/** Major providers whose auto-synced models are highlighted in /models and /synccheck. */
const NOTABLE_PROVIDERS = ['anthropic', 'google', 'openai', 'deepseek', 'x-ai', 'meta-llama', 'mistralai'];

/**
 * Get notable auto-synced models for display in /models.
 * Picks top 2 per major provider (highest cost = flagship), capped at 15.
 */
export function getNotableAutoSynced(): ModelInfo[] {
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of Object.values(AUTO_SYNCED_MODELS)) {
    const provider = m.id.split('/')[0];
    if (!NOTABLE_PROVIDERS.includes(provider)) continue;
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider)!.push(m);
  }

  const notable: ModelInfo[] = [];
  for (const models of byProvider.values()) {
    models.sort((a, b) => parseCostForSort(b.cost) - parseCostForSort(a.cost));
    notable.push(...models.slice(0, 2));
  }

  notable.sort((a, b) => parseCostForSort(b.cost) - parseCostForSort(a.cost));
  return notable.slice(0, 15);
}

/**
 * Get auto-synced model by OpenRouter model ID (for synccheck cross-referencing).
 */
export function getAutoSyncedByModelId(modelId: string): ModelInfo | undefined {
  return Object.values(AUTO_SYNCED_MODELS).find(m => m.id === modelId);
}

/**
 * Get all models merged: curated < auto-synced < dynamic (dynamic wins on conflict).
 * Excludes blocked models.
 */
export function getAllModels(): Record<string, ModelInfo> {
  const all = { ...AUTO_SYNCED_MODELS, ...MODELS, ...DYNAMIC_MODELS };
  for (const alias of BLOCKED_ALIASES) {
    delete all[alias];
  }
  return all;
}

/**
 * Get model by alias.
 * Priority: blocked → dynamic (/syncmodels) → curated (static) → auto-synced (full catalog)
 * Falls back to fuzzy matching when exact match fails (strips hyphens/dots, tries suffix/prefix).
 */
export function getModel(alias: string): ModelInfo | undefined {
  const lower = alias.toLowerCase();
  if (BLOCKED_ALIASES.has(lower)) return undefined;

  // Exact match by alias (highest priority)
  const exact = DYNAMIC_MODELS[lower] || MODELS[lower] || AUTO_SYNCED_MODELS[lower];
  if (exact) return exact;

  // Exact match by full model ID (e.g. "openai/gpt-oss-safeguard-20b:nitro")
  if (lower.includes('/')) {
    for (const reg of [DYNAMIC_MODELS, MODELS, AUTO_SYNCED_MODELS]) {
      for (const model of Object.values(reg)) {
        if (model.id.toLowerCase() === lower) return model;
      }
    }
  }

  // Fuzzy fallback for auto-synced and hyphenated aliases
  return fuzzyMatchModel(lower);
}

/**
 * Fuzzy model lookup when exact alias match fails.
 * Normalizes query and keys by stripping hyphens/dots, then tries:
 * 1. Normalized exact match (e.g. "claudesonnet46" matches key "claude-sonnet-46")
 * 2. Normalized key ends with query (e.g. "sonnet46" matches "claude-sonnet-46")
 * 3. Normalized key starts with query (e.g. "claudesonnet" matches "claude-sonnet-46")
 * 4. Model ID match (strip provider prefix, normalize)
 *
 * Respects registry priority: DYNAMIC > MODELS > AUTO_SYNCED.
 */
function fuzzyMatchModel(query: string): ModelInfo | undefined {
  const norm = query.replace(/[-_.]/g, '');
  if (norm.length < 3) return undefined;

  const registries = [DYNAMIC_MODELS, MODELS, AUTO_SYNCED_MODELS];

  // Pass 1: Normalized exact match on alias
  for (const reg of registries) {
    for (const [key, model] of Object.entries(reg)) {
      if (BLOCKED_ALIASES.has(key)) continue;
      if (key.replace(/[-_.]/g, '') === norm) return model;
    }
  }

  // Pass 2: Normalized alias ends with query
  // e.g. "sonnet46" matches "claude-sonnet-46" → normalized "claudesonnet46"
  for (const reg of registries) {
    for (const [key, model] of Object.entries(reg)) {
      if (BLOCKED_ALIASES.has(key)) continue;
      const normKey = key.replace(/[-_.]/g, '');
      if (normKey.endsWith(norm) && norm.length >= 4) return model;
    }
  }

  // Pass 3: Normalized alias starts with query (handles version-less lookups)
  // e.g. "claudesonnet" matches "claude-sonnet-46" → normalized "claudesonnet46"
  // Single match only — returns undefined if ambiguous
  const startMatches: ModelInfo[] = [];
  for (const reg of registries) {
    for (const [key, model] of Object.entries(reg)) {
      if (BLOCKED_ALIASES.has(key)) continue;
      const normKey = key.replace(/[-_.]/g, '');
      if (normKey.startsWith(norm) && norm.length >= 5 && norm.length >= normKey.length * 0.6) {
        startMatches.push(model);
      }
    }
  }
  if (startMatches.length === 1) return startMatches[0];

  // Pass 4: Match against model ID (strip provider prefix, normalize)
  // e.g. "gpt4o" matches model with ID "openai/gpt-4o"
  for (const reg of registries) {
    for (const model of Object.values(reg)) {
      if (BLOCKED_ALIASES.has(model.alias)) continue;
      const idName = model.id.includes('/') ? model.id.split('/').pop()! : model.id;
      const normId = idName.replace(/[-_.]/g, '').replace(/:.*$/, '').toLowerCase();
      if (normId === norm) return model;
    }
  }

  return undefined;
}

/**
 * Check if a model is from the auto-synced full catalog (not curated or manual-synced).
 */
export function isAutoSyncedModel(alias: string): boolean {
  return alias.toLowerCase() in AUTO_SYNCED_MODELS;
}

/**
 * Check if a model routes to Anthropic (model ID starts with 'anthropic/')
 */
export function isAnthropicModel(alias: string): boolean {
  const model = getModel(alias);
  if (!model) return false;
  return model.id.startsWith('anthropic/');
}

/**
 * Get model ID for API
 */
export function getModelId(alias: string): string {
  const model = getModel(alias);
  if (!model) {
    console.log(`[Models] Unknown alias '${alias}', falling back to openrouter/auto`);
  }
  return model?.id || 'openrouter/auto';
}

/**
 * Get provider for a model (default: openrouter)
 */
export function getProvider(alias: string): Provider {
  const model = getModel(alias);
  return model?.provider || 'openrouter';
}

/**
 * Get provider config for a model
 */
export function getProviderConfig(alias: string): ProviderConfig {
  const provider = getProvider(alias);
  return PROVIDERS[provider];
}

/**
 * Check if model uses direct API (not OpenRouter)
 */
export function isDirectApi(alias: string): boolean {
  const model = getModel(alias);
  return !!model?.provider && model.provider !== 'openrouter';
}

/**
 * Clamp max_tokens to the provider's ceiling.
 * Some APIs (e.g. DeepSeek: 8192) reject requests exceeding their limit.
 */
export function clampMaxTokens(alias: string, requested: number): number {
  const config = getProviderConfig(alias);
  if (config.maxOutputTokens && requested > config.maxOutputTokens) {
    return config.maxOutputTokens;
  }
  return requested;
}

/**
 * Get the temperature for a model.
 * Some models require a fixed temperature (e.g. Kimi K2.5 direct API requires exactly 1).
 * Returns the fixed temperature if set, otherwise the provided default.
 */
export function getTemperature(alias: string, defaultTemp: number = 0.7): number {
  const model = getModel(alias);
  return model?.fixedTemperature ?? defaultTemp;
}

/**
 * Check if model supports vision
 */
export function supportsVision(alias: string): boolean {
  const model = getModel(alias);
  return model?.supportsVision || false;
}

/**
 * Check if model is for image generation
 */
export function isImageGenModel(alias: string): boolean {
  const model = getModel(alias);
  return model?.isImageGen || false;
}

/**
 * Check if a model supports structured output (JSON schema)
 */
export function supportsStructuredOutput(alias: string): boolean {
  const model = getModel(alias);
  return model?.structuredOutput || false;
}

/**
 * Parse cost string to get input cost for sorting
 * Formats: "$X/$Y" (per million), "FREE", "$X/megapixel"
 */
function parseCostForSort(cost: string): number {
  if (cost === 'FREE' || cost.includes('FREE')) return 0;
  if (cost.includes('/megapixel')) {
    const match = cost.match(/\$([0-9.]+)/);
    return match ? parseFloat(match[1]) : 999;
  }
  // Format: $input/$output per million tokens
  const match = cost.match(/\$([0-9.]+)\/\$([0-9.]+)/);
  if (match) {
    // Use average of input and output for sorting
    return (parseFloat(match[1]) + parseFloat(match[2])) / 2;
  }
  return 999; // Unknown format, sort last
}

/**
 * Check if a model alias is from the curated (static) catalog vs synced dynamically.
 */
export function isCuratedModel(alias: string): boolean {
  return alias.toLowerCase() in MODELS;
}

/** Value tier emoji labels */
const VALUE_TIER_LABELS: Record<ValueTier, string> = {
  free: '🆓',
  exceptional: '🏆',
  great: '⭐',
  good: '✅',
  premium: '💎',
  outdated: '⚠️',
};

/** Format a single model line — compact single-line for Telegram 4096 char limit */
function formatModelLine(m: ModelInfo): string {
  const features = [m.supportsVision && '👁️', m.supportsTools && '🔧'].filter(Boolean).join('');
  const tier = getValueTier(m);
  const tierIcon = VALUE_TIER_LABELS[tier];
  if (m.isFree) {
    return `  /${m.alias} ${features} — ${m.name}`;
  }
  return `  ${tierIcon} /${m.alias} ${features} ${m.cost}`;
}

/**
 * Format models list for /models command.
 * Groups paid models by value tier, free models by curated/synced.
 */
export function formatModelsList(): string {
  const lines: string[] = ['📋 Model Catalog — sorted by value\n'];

  const all = Object.values(getAllModels());
  // Tier sections show curated + dynamic only (auto-synced get their own section below)
  const curated = all.filter(m => isCuratedModel(m.alias));
  const free = curated.filter(m => m.isFree && !m.isImageGen && !m.provider);
  const imageGen = curated.filter(m => m.isImageGen);
  const paid = curated.filter(m => !m.isFree && !m.isImageGen && !m.provider);
  const direct = curated.filter(m => m.provider && m.provider !== 'openrouter');

  // Dynamic (from /syncmodels) free models shown separately
  const dynamicFree = all.filter(m => m.isFree && !m.isImageGen && !m.provider && !isCuratedModel(m.alias) && !isAutoSyncedModel(m.alias));
  const freeCurated = free;
  const freeSynced = dynamicFree;

  const sortByCost = (a: ModelInfo, b: ModelInfo) => parseCostForSort(a.cost) - parseCostForSort(b.cost);
  paid.sort(sortByCost);
  direct.sort(sortByCost);

  // --- Paid models grouped by value tier ---
  const paidAndDirect = [...direct, ...paid];
  const exceptional = paidAndDirect.filter(m => getValueTier(m) === 'exceptional');
  const great = paidAndDirect.filter(m => getValueTier(m) === 'great');
  const good = paidAndDirect.filter(m => getValueTier(m) === 'good');
  const premium = paidAndDirect.filter(m => getValueTier(m) === 'premium');
  const outdated = paidAndDirect.filter(m => getValueTier(m) === 'outdated');

  if (exceptional.length > 0) {
    lines.push('🏆 EXCEPTIONAL VALUE (< $0.50/M output):');
    for (const m of exceptional) lines.push(formatModelLine(m));
    lines.push('');
  }

  if (great.length > 0) {
    lines.push('⭐ GREAT VALUE ($0.50–$2/M output):');
    for (const m of great) lines.push(formatModelLine(m));
    lines.push('');
  }

  if (good.length > 0) {
    lines.push('✅ GOOD VALUE ($2–$5/M output):');
    for (const m of good) lines.push(formatModelLine(m));
    lines.push('');
  }

  if (premium.length > 0) {
    lines.push('💎 PREMIUM — highest quality ($5+/M output):');
    for (const m of premium) lines.push(formatModelLine(m));
    lines.push('');
  }

  if (outdated.length > 0) {
    lines.push('⚠️ OUTDATED — cheaper alternatives exist:');
    for (const m of outdated) lines.push(formatModelLine(m));
    lines.push('');
  }

  // --- Image gen ---
  if (imageGen.length > 0) {
    lines.push('🎨 IMAGE GEN:');
    for (const m of imageGen) {
      lines.push(`  /${m.alias} ${m.cost}`);
    }
    lines.push('');
  }

  // --- Free models ---
  lines.push('🆓 FREE (curated):');
  for (const m of freeCurated) lines.push(formatModelLine(m));

  if (freeSynced.length > 0) {
    lines.push('\n🔄 FREE (synced):');
    for (const m of freeSynced) {
      const features = [m.supportsVision && '👁️', m.supportsTools && '🔧'].filter(Boolean).join('');
      lines.push(`  /${m.alias} ${features}`);
    }
  }

  // Auto-synced models — just show count
  const autoSyncedCount = getAutoSyncedModelCount();
  if (autoSyncedCount > 0) {
    lines.push(`\n🌐 +${autoSyncedCount} auto-synced — /use <alias>`);
  }

  // --- Orchestra-capable models ---
  const orchRecs = getOrchestraRecommendations();
  lines.push('\n🎼 ORCHESTRA-READY (tool-calling + agentic):');
  if (orchRecs.free.length > 0) {
    lines.push('  Free: ' + orchRecs.free.map(r => `/${r.alias}`).join('  '));
  }
  if (orchRecs.paid.length > 0) {
    lines.push('  Paid: ' + orchRecs.paid.map(r => `/${r.alias}`).join('  '));
  }
  if (orchRecs.avoid.length > 0) {
    lines.push('  Avoid: ' + orchRecs.avoid.map(a => `/${a}`).join('  '));
  }
  lines.push('  Use /orch with these for best results');

  lines.push('\n━━━ Legend ━━━');
  lines.push('🏆=best $/perf  ⭐=strong value  ✅=solid  💎=flagship  ⚠️=outdated');
  lines.push('👁️=vision  🔧=tools  🎼=orchestra  Cost: $input/$output per M tokens');
  lines.push('🧠=AA Intelligence Index  Use /model info <alias> for details');
  lines.push('Usage: /model use <alias> or /<alias>');

  return lines.join('\n');
}

/**
 * Format the /model hub — one-stop overview with subcommand guide.
 * Returns text for the hub message. Buttons are added by the handler.
 */
export function formatModelHub(currentAlias: string): string {
  const lines: string[] = [];
  const model = getModel(currentAlias);
  const all = Object.values(getAllModels());
  const chatModels = all.filter(m => !m.isImageGen);

  // Header
  lines.push('🤖 Model Hub\n');

  // Current model
  if (model) {
    const caps = [
      model.supportsTools && '🔧',
      model.supportsVision && '👁️',
      model.structuredOutput && '📋',
      model.parallelCalls && '⚡',
      model.reasoning && '🧠',
    ].filter(Boolean).join('');
    const tier = model.isFree ? '🆓' : VALUE_TIER_LABELS[getValueTier(model)] || '✅';
    lines.push(`${tier} Active: ${model.name} (/${model.alias}) ${caps}`);
    lines.push(`   ${model.specialty} — ${model.cost}`);
    if (model.maxContext) {
      const ctxStr = model.maxContext >= 1048576
        ? `${(model.maxContext / 1048576).toFixed(0)}M`
        : `${Math.round(model.maxContext / 1024)}K`;
      lines.push(`   Context: ${ctxStr}`);
    }
  } else {
    lines.push(`Active: /${currentAlias} (unknown — run /model sync)`);
  }

  // Quick stats
  const freeCount = chatModels.filter(m => m.isFree).length;
  const paidCount = chatModels.filter(m => !m.isFree).length;
  const toolCount = chatModels.filter(m => m.supportsTools).length;
  const orchCount = chatModels.filter(m =>
    m.supportsTools && m.parallelCalls && (m.maxContext || 0) >= 64000
  ).length;
  lines.push(`\n📊 ${chatModels.length} models available`);
  lines.push(`   ${freeCount} free · ${paidCount} paid · ${toolCount} with tools · ${orchCount} orchestra-ready`);

  // Tap a button below to switch, or use commands:
  lines.push('\n⬇️ Tap a button to switch instantly\n');

  // Subcommands — organized by purpose
  lines.push('━━━ Browse & Switch ━━━');
  lines.push('/model list     — Full catalog with prices');
  lines.push('/model rank     — Capability ranking');
  lines.push('/model <alias>  — Model details (e.g. /model sonnet)');

  lines.push('\n━━━ Keep Up to Date ━━━');
  lines.push('/model sync     — Fetch latest free models');
  lines.push('/model syncall  — Full catalog sync');
  lines.push('/model check    — Check for updates');
  lines.push('/model enrich   — Fetch benchmarks (AA)');

  lines.push('\n━━━ Advanced ━━━');
  lines.push('/model update <alias> key=val  — Patch live');
  lines.push('/model reset    — Clear synced models');

  lines.push('\n🔧=tools 👁️=vision 📋=structured 🧠=reasoning ⚡=parallel');

  return lines.join('\n');
}

/**
 * Get top recommended models for hub buttons.
 * Returns { free, value, premium } arrays of ModelInfo.
 */
export function getTopModelPicks(): {
  free: ModelInfo[];
  value: ModelInfo[];
  premium: ModelInfo[];
} {
  const all = Object.values(getAllModels());
  const toolModels = all.filter(m => m.supportsTools && !m.isImageGen);

  const score = (m: ModelInfo): number => {
    let s = 0;
    const lower = (m.name + ' ' + m.specialty + ' ' + m.score).toLowerCase();
    const sweMatch = m.score.match(/(\d+(?:\.\d+)?)%\s*SWE/i);
    if (sweMatch) s += parseFloat(sweMatch[1]);
    if (/agentic|coding/i.test(lower)) s += 15;
    if ((m.maxContext || 0) >= 200000) s += 5;
    if (m.supportsVision) s += 3;
    if (m.parallelCalls) s += 2;
    if (m.intelligenceIndex) s += m.intelligenceIndex;
    return s;
  };

  const scored = toolModels.map(m => ({ m, s: score(m) }));

  const free = scored
    .filter(x => x.m.isFree)
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map(x => x.m);

  const value = scored
    .filter(x => !x.m.isFree && ['exceptional', 'great'].includes(getValueTier(x.m)))
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map(x => x.m);

  const premium = scored
    .filter(x => !x.m.isFree && ['good', 'premium'].includes(getValueTier(x.m)))
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map(x => x.m);

  return { free, value, premium };
}

/**
 * Format capability ranking — models sorted by orchestra readiness and intelligence.
 * Shows a clear tier list for demanding tasks.
 */
export function formatModelRanking(): string {
  const lines: string[] = [];
  lines.push('🏅 Model Ranking — Orchestra & Capability\n');

  const all = Object.values(getAllModels());
  const chatModels = all.filter(m => !m.isImageGen && m.supportsTools);

  // Score each model comprehensively
  interface RankedModel {
    m: ModelInfo;
    score: number;
    tier: string;
  }

  const ranked: RankedModel[] = chatModels.map(m => {
    let score = 0;
    const lower = (m.name + ' ' + m.specialty + ' ' + m.score).toLowerCase();

    // AA intelligence index (most reliable signal)
    if (m.intelligenceIndex) score += m.intelligenceIndex * 2;

    // SWE-Bench (real-world coding benchmark)
    const sweMatch = m.score.match(/(\d+(?:\.\d+)?)%\s*SWE/i);
    if (sweMatch) score += parseFloat(sweMatch[1]);

    // Agentic capability
    if (/agentic/i.test(lower)) score += 20;
    if (/multi-?file/i.test(lower)) score += 15;
    if (/coding/i.test(lower)) score += 10;

    // Feature flags
    if (m.parallelCalls) score += 5;
    if (m.structuredOutput) score += 5;
    if (m.supportsVision) score += 3;
    if ((m.maxContext || 0) >= 200000) score += 5;
    if (m.reasoning) score += 5;

    // Penalty for small models
    if (/\b(mini|small|lite|nano)\b/i.test(m.name)) score -= 15;

    return { m, score, tier: '' };
  });

  ranked.sort((a, b) => b.score - a.score);

  // Assign tiers
  for (let i = 0; i < ranked.length; i++) {
    if (i < 5) ranked[i].tier = '🥇';
    else if (i < 10) ranked[i].tier = '🥈';
    else if (i < 18) ranked[i].tier = '🥉';
    else ranked[i].tier = '  ';
  }

  // Group: free vs paid
  const freeRanked = ranked.filter(r => r.m.isFree);
  const paidRanked = ranked.filter(r => !r.m.isFree);

  const formatRankLine = (r: RankedModel, idx: number): string => {
    const caps = [
      r.m.parallelCalls && '⚡',
      r.m.structuredOutput && '📋',
      r.m.supportsVision && '👁️',
      r.m.reasoning && '🧠',
    ].filter(Boolean).join('');
    const ctx = r.m.maxContext
      ? r.m.maxContext >= 1048576
        ? `${(r.m.maxContext / 1048576).toFixed(0)}M`
        : `${Math.round(r.m.maxContext / 1024)}K`
      : '?';
    const aaStr = r.m.intelligenceIndex ? ` AA:${r.m.intelligenceIndex.toFixed(0)}` : '';
    return `${r.tier} ${idx}. /${r.m.alias} ${caps} ${ctx}${aaStr} ${r.m.cost}`;
  };

  if (paidRanked.length > 0) {
    lines.push('💎 PAID (best for orchestra/complex tasks):');
    paidRanked.slice(0, 12).forEach((r, i) => lines.push(formatRankLine(r, i + 1)));
    lines.push('');
  }

  if (freeRanked.length > 0) {
    lines.push('🆓 FREE (best free options):');
    freeRanked.slice(0, 8).forEach((r, i) => lines.push(formatRankLine(r, i + 1)));
    lines.push('');
  }

  lines.push('━━━ Legend ━━━');
  lines.push('⚡=parallel  📋=structured  👁️=vision  🧠=reasoning');
  lines.push('AA = Artificial Analysis Intelligence Index');
  lines.push('🥇=top 5  🥈=top 10  🥉=top 18');
  lines.push('\nUse /model info <alias> for full details');
  lines.push('Use /model enrich to update benchmark data');

  return lines.join('\n');
}

/**
 * Format detailed model info card for /modelinfo command.
 * Shows all capabilities, benchmarks, and settings for a single model.
 */
export function formatModelInfoCard(alias: string): string | null {
  const model = getModel(alias);
  if (!model) return null;

  const lines: string[] = [];

  // Header
  const tier = model.isFree ? '🆓' : VALUE_TIER_LABELS[getValueTier(model)] || '✅';
  lines.push(`${tier} ${model.name} (/${model.alias})`);
  lines.push(`${model.specialty}\n`);

  // Identity
  lines.push('━━━ Identity ━━━');
  lines.push(`ID: ${model.id}`);
  if (model.provider && model.provider !== 'openrouter') {
    lines.push(`Provider: ${model.provider} (direct API)`);
  }
  lines.push(`Cost: ${model.cost}`);
  lines.push('');

  // Capabilities
  lines.push('━━━ Capabilities ━━━');
  const caps: string[] = [];
  caps.push(`🔧 Tools: ${model.supportsTools ? '✅' : '❌'}`);
  caps.push(`👁️ Vision: ${model.supportsVision ? '✅' : '❌'}`);
  caps.push(`📋 Structured Output: ${model.structuredOutput ? '✅' : '❌'}`);
  caps.push(`⚡ Parallel Calls: ${model.parallelCalls ? '✅' : '❌'}`);
  caps.push(`🎼 Orchestra Ready: ${model.orchestraReady ? '✅' : '❌'}`);
  for (const c of caps) lines.push(c);
  lines.push('');

  // Settings
  lines.push('━━━ Settings ━━━');
  const reasoningLabel = model.reasoning || 'none';
  lines.push(`Reasoning: ${reasoningLabel}`);
  if (model.maxContext) {
    const ctxStr = model.maxContext >= 1048576
      ? `${(model.maxContext / 1048576).toFixed(1)}M`
      : `${Math.round(model.maxContext / 1024)}K`;
    lines.push(`Context: ${ctxStr} tokens`);
  }
  if (model.fixedTemperature != null) {
    lines.push(`Temperature: fixed at ${model.fixedTemperature}`);
  } else {
    lines.push('Temperature: default (0.7)');
  }
  if (model.isImageGen) {
    lines.push('Type: Image Generation');
  }
  lines.push('');

  // Benchmarks (if enriched with AA data)
  if (model.intelligenceIndex || model.benchmarks) {
    lines.push('━━━ Benchmarks (Artificial Analysis) ━━━');
    if (model.intelligenceIndex) {
      lines.push(`🧠 Intelligence Index: ${model.intelligenceIndex.toFixed(1)}`);
    }
    if (model.benchmarks) {
      if (model.benchmarks.coding != null) lines.push(`  Coding: ${model.benchmarks.coding.toFixed(1)}`);
      if (model.benchmarks.math != null) lines.push(`  Math: ${model.benchmarks.math.toFixed(1)}`);
      if (model.benchmarks.mmluPro != null) lines.push(`  MMLU-Pro: ${model.benchmarks.mmluPro.toFixed(1)}`);
      if (model.benchmarks.gpqa != null) lines.push(`  GPQA: ${model.benchmarks.gpqa.toFixed(1)}`);
      if (model.benchmarks.livecodebench != null) lines.push(`  LiveCodeBench: ${model.benchmarks.livecodebench.toFixed(1)}`);
      if (model.benchmarks.speedTps != null) lines.push(`  Speed: ${model.benchmarks.speedTps.toFixed(0)} tok/s`);
    }
    lines.push('');
  } else {
    lines.push('📊 No benchmark data — run /enrich to fetch');
    lines.push('');
  }

  // Score (existing manual annotation)
  if (model.score) {
    lines.push(`📝 Notes: ${model.score}`);
  }

  return lines.join('\n');
}

// === REASONING SUPPORT ===

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high';

/**
 * Reasoning parameter formats per provider:
 * - DeepSeek/Grok: { enabled: boolean }
 * - Gemini: { effort: 'minimal' | 'low' | 'medium' | 'high' }
 */
export type ReasoningParam =
  | { enabled: boolean }
  | { effort: 'minimal' | 'low' | 'medium' | 'high' };

/**
 * Build the provider-specific reasoning parameter for a model.
 * Returns undefined if the model doesn't support configurable reasoning
 * and doesn't require mandatory reasoning.
 *
 * For 'mandatory' models: always returns { enabled: true } (or effort: 'medium'
 * for Gemini) regardless of the requested level, because the provider rejects
 * requests without reasoning enabled.
 */
export function getReasoningParam(alias: string, level: ReasoningLevel): ReasoningParam | undefined {
  const model = getModel(alias);
  if (!model) return undefined;

  // 'mandatory': provider requires reasoning — always enable, ignore user level
  if (model.reasoning === 'mandatory') {
    if (model.id.startsWith('google/')) {
      return { effort: 'medium' };
    }
    return { enabled: true };
  }

  if (model.reasoning !== 'configurable') return undefined;

  // Gemini models use effort levels
  if (model.id.startsWith('google/')) {
    const effortMap: Record<ReasoningLevel, 'minimal' | 'low' | 'medium' | 'high'> = {
      off: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
    };
    return { effort: effortMap[level] };
  }

  // DeepSeek and Grok use enabled boolean
  return { enabled: level !== 'off' };
}

/**
 * Build a fallback reasoning parameter for an unknown model that returned
 * a "reasoning is mandatory" API error. Infers the right format from
 * the model ID (Gemini uses effort, everything else uses enabled boolean).
 */
export function buildFallbackReasoningParam(modelIdOrAlias: string): ReasoningParam {
  const model = getModel(modelIdOrAlias);
  const id = model?.id ?? modelIdOrAlias;
  if (id.startsWith('google/')) {
    return { effort: 'medium' };
  }
  return { enabled: true };
}

/**
 * Auto-detect reasoning level based on message content.
 * - Simple Q&A → off (save tokens)
 * - Coding/tool-use → medium
 * - Research/analysis → high
 */
export function detectReasoningLevel(messages: readonly ChatMessageLike[]): ReasoningLevel {
  // Find the last user message
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return 'off';

  const text = typeof lastUserMsg.content === 'string'
    ? lastUserMsg.content
    : '';

  if (!text) return 'off';

  const lower = text.toLowerCase();

  // Research indicators → high
  if (/\b(research|analy[sz]e|compare|explain in detail|comprehensive|deep dive|thorough|investigate|literature|survey|pros and cons)\b/.test(lower)) {
    return 'high';
  }

  // Coding/tool-use indicators → medium
  if (/\b(code|implement|debug|fix|refactor|function|class|api|fetch|github|weather|chart|news|build|deploy|test|error|bug|script)\b/.test(lower)) {
    return 'medium';
  }

  // Math/logic → medium
  if (/\b(calculate|solve|prove|equation|algorithm|optimize|formula)\b/.test(lower)) {
    return 'medium';
  }

  // Default: simple Q&A → off
  return 'off';
}

/**
 * Parse a `think:LEVEL` prefix from user message text.
 * Returns the parsed level and the cleaned message.
 *
 * Examples:
 *   "think:high what is X?" → { level: 'high', cleanMessage: "what is X?" }
 *   "no prefix here"       → { level: null, cleanMessage: "no prefix here" }
 */
export function parseReasoningOverride(message: string): { level: ReasoningLevel | null; cleanMessage: string } {
  const match = message.match(/^think:(off|low|medium|high)\s+/i);
  if (match) {
    return {
      level: match[1].toLowerCase() as ReasoningLevel,
      cleanMessage: message.slice(match[0].length),
    };
  }
  return { level: null, cleanMessage: message };
}

/**
 * Parse json: prefix from user message
 * Format: "json: <message>" — requests JSON output from models that support it
 * Returns { requestJson, cleanMessage } where requestJson is true if prefix found
 */
export function parseJsonPrefix(message: string): { requestJson: boolean; cleanMessage: string } {
  const match = message.match(/^json:\s*/i);
  if (match) {
    return {
      requestJson: true,
      cleanMessage: message.slice(match[0].length),
    };
  }
  return { requestJson: false, cleanMessage: message };
}

/** Minimal shape needed for reasoning detection (avoids importing ChatMessage) */
interface ChatMessageLike {
  role: string;
  content: string | unknown[] | null;
}

/**
 * Regex that matches API error messages indicating the provider requires
 * reasoning to be enabled. Used for reactive retry in both client.ts
 * and task-processor.ts.
 */
export const REASONING_MANDATORY_ERROR = /reasoning\s+(is\s+)?mandatory|reasoning.*cannot\s+be\s+disabled|require[sd]?\s+reasoning|reasoning\s+.*required/i;

/**
 * Check if an error message indicates that reasoning is mandatory for the model.
 */
export function isReasoningMandatoryError(errorMessage: string): boolean {
  return REASONING_MANDATORY_ERROR.test(errorMessage);
}

/**
 * Get free models that support tool-calling, sorted by context window (largest first).
 */
export function getFreeToolModels(): string[] {
  const all = getAllModels();
  return Object.values(all)
    .filter(m => m.isFree && m.supportsTools && !m.isImageGen)
    .sort((a, b) => (b.maxContext || 0) - (a.maxContext || 0))
    .map(m => m.alias);
}

/**
 * Detect if a user message likely requires tool usage.
 * Uses conservative keyword matching to avoid false positives.
 * Only triggers on strong, unambiguous tool signals.
 */
export function detectToolIntent(message: string): { needsTools: boolean; reason: string } {
  const lower = message.toLowerCase();

  // Strong GitHub signals (explicit repo/PR references)
  if (/\b(create\s+(a\s+)?pr|pull\s+request|modify\s+(the\s+)?repo|push\s+to\s+github|read\s+file\s+from\s+github|github\.com\/\w+\/\w+)\b/i.test(lower)) {
    return { needsTools: true, reason: 'GitHub operations require tools (🔧)' };
  }

  // Strong URL/fetch signals (explicit URLs or fetch commands)
  if (/\b(fetch|scrape|browse|read)\s+(https?:\/\/|the\s+(url|page|site|website))/i.test(lower) || /https?:\/\/\S+/.test(message)) {
    return { needsTools: true, reason: 'Web fetching requires tools (🔧)' };
  }

  // Strong data lookup signals (explicit real-time data requests)
  if (/\b(what('?s| is)\s+the\s+(weather|bitcoin|btc|eth|crypto)\s+(in|price|for|at))\b/i.test(lower)) {
    return { needsTools: true, reason: 'Real-time data lookups require tools (🔧)' };
  }

  // Strong code execution signals
  if (/\b(run\s+this\s+(code|script|command)|execute\s+(in\s+)?sandbox)\b/i.test(lower)) {
    return { needsTools: true, reason: 'Code execution requires tools (🔧)' };
  }

  return { needsTools: false, reason: '' };
}

/**
 * Categorize a model by its ID/name into coding, reasoning, fast, or general.
 * Used by /syncmodels to group models and suggest replacements.
 */
export type ModelCategory = 'coding' | 'reasoning' | 'fast' | 'general';

export function categorizeModel(modelId: string, name: string, hasReasoning?: boolean): ModelCategory {
  const lower = (modelId + ' ' + name).toLowerCase();
  if (/coder|code|devstral|codestral|starcoder|aider|swe-?bench/i.test(lower)) return 'coding';
  if (hasReasoning || /\br1\b|reason|think|math|chimera/i.test(lower)) return 'reasoning';
  if (/flash|mini|small|fast|turbo|lite|nano/i.test(lower)) return 'fast';
  return 'general';
}

/**
 * Value tier based on performance/cost ratio.
 * Free models are always 'free'. Paid models ranked by intelligence per dollar.
 */
export type ValueTier = 'free' | 'exceptional' | 'great' | 'good' | 'premium' | 'outdated';

/**
 * Get the value tier for a model.
 * Uses cost string parsing + known benchmark data to compute a rough tier.
 *
 * Tiers:
 * - free: No cost
 * - exceptional: Best-in-class value (MiMo, DeepSeek V3.2, Devstral 2, Grok Fast)
 * - great: Strong value (MiniMax, Qwen3 Coder, Mistral Large)
 * - good: Reasonable for the capability (Gemini Flash, Haiku, Kimi)
 * - premium: Expensive but highest quality (Opus, Sonnet, Gemini Pro)
 * - outdated: Poor value — newer/cheaper alternatives exist (GPT-4o)
 */
export function getValueTier(model: ModelInfo): ValueTier {
  if (model.isFree || model.cost === 'FREE') return 'free';
  if (model.isImageGen) return 'good'; // Image gen pricing is different

  // Parse output cost from "$/M_in / $/M_out" format
  const costMatch = model.cost.match(/\$[\d.]+\/\$([\d.]+)/);
  if (!costMatch) return 'good';
  const outputCostPerM = parseFloat(costMatch[1]);
  if (isNaN(outputCostPerM)) return 'good';

  // Known outdated models — poor value regardless of cost
  const outdatedIds = ['openai/gpt-4o'];
  if (outdatedIds.includes(model.id)) return 'outdated';

  // Tier by output cost + capability class
  if (outputCostPerM <= 0.5) return 'exceptional';  // Under $0.50/M output
  if (outputCostPerM <= 2.0) return 'great';         // $0.50-$2.00/M output
  if (outputCostPerM <= 5.0) return 'good';           // $2.00-$5.00/M output
  return 'premium';                                    // $5.00+/M output
}

/**
 * Get model recommendations for orchestra tasks.
 * Dynamically picks the best models from the catalog based on:
 * - Must support tools
 * - Prefer 'agentic' / 'coding' specialty
 * - Prefer larger active parameters (avoid tiny MoE models)
 * - Avoid models with 'mini' / 'small' / 'flash' in name (weak instruction following)
 * - Group by free / cheap paid / premium paid
 *
 * Returns structured recommendations that update automatically when models change.
 */
export interface OrchestraModelRec {
  alias: string;
  name: string;
  cost: string;
  why: string;
}

export function getOrchestraRecommendations(): {
  free: OrchestraModelRec[];
  paid: OrchestraModelRec[];
  avoid: string[];
} {
  const all = getAllModels();
  const toolModels = Object.values(all).filter(m => m.supportsTools && !m.isImageGen);

  // Score each model for orchestra suitability using AA benchmarks + heuristics
  const scored = toolModels.map(m => {
    let score = 0;
    const lower = (m.name + ' ' + m.specialty + ' ' + m.score).toLowerCase();

    // === AA Benchmark Data (most reliable signals) ===
    if (m.intelligenceIndex) {
      // Intelligence index is 0-100; strong models score 50+
      if (m.intelligenceIndex >= 60) score += 25;
      else if (m.intelligenceIndex >= 50) score += 15;
      else if (m.intelligenceIndex >= 40) score += 5;
      else score -= 10; // Low intelligence = risky for orchestra
    }
    if (m.benchmarks?.coding) {
      // Coding index: orchestra tasks are primarily code changes
      if (m.benchmarks.coding >= 50) score += 20;
      else if (m.benchmarks.coding >= 40) score += 10;
      else if (m.benchmarks.coding < 25) score -= 10;
    }
    if (m.benchmarks?.livecodebench) {
      // LiveCodeBench: real-world coding signal
      if (m.benchmarks.livecodebench >= 50) score += 10;
      else if (m.benchmarks.livecodebench >= 40) score += 5;
    }

    // === Heuristic signals (fallback when no AA data) ===
    const hasAAData = !!(m.intelligenceIndex || m.benchmarks?.coding);

    if (!hasAAData) {
      // Only use keyword heuristics when we have no benchmark data.
      // Cap heuristic bonus to avoid unverified models outscoring benchmarked ones.
      let heuristicBonus = 0;
      if (/agentic/i.test(lower)) heuristicBonus += 15;
      if (/multi-?file/i.test(lower)) heuristicBonus += 10;
      if (/coding/i.test(lower)) heuristicBonus += 10;
      if (/swe-?bench/i.test(lower)) heuristicBonus += 5;

      // SWE-Bench score from description string
      const sweMatch = m.score.match(/(\d+(?:\.\d+)?)%\s*SWE/i);
      if (sweMatch) {
        const sweScore = parseFloat(sweMatch[1]);
        if (sweScore >= 70) heuristicBonus += 15;
        else if (sweScore >= 60) heuristicBonus += 5;
      }

      // Cap: unverified models shouldn't score higher than mid-tier benchmarked ones
      score += Math.min(heuristicBonus, 25);

      // Uncertainty penalty: no benchmarks means we can't trust reliability
      score -= 10;
    }

    // === Universal signals (always apply) ===

    // Positive: large context (orchestra tasks can be long)
    if ((m.maxContext || 0) >= 200000) score += 10;
    else if ((m.maxContext || 0) >= 128000) score += 5;

    // Positive: dense models (all params active = better instruction following)
    if (/dense/i.test(lower)) score += 15;

    // Negative: small active parameter models (weak instruction following)
    if (/\b(mini|small|flash|lite|nano)\b/i.test(m.name)) score -= 20;
    if (/\b\d+B active\b/i.test(m.score)) {
      const activeMatch = m.score.match(/(\d+)B active/i);
      if (activeMatch) {
        const activeB = parseInt(activeMatch[1], 10);
        if (activeB < 20) score -= 15;
        if (activeB >= 40) score += 10;
      }
    }

    // Positive: direct API models (faster, more reliable, no OpenRouter overhead)
    if (m.provider && m.provider !== 'openrouter') score += 10;

    // Positive: parallel tool calls (orchestra uses many tools)
    if (m.parallelCalls) score += 5;

    // Tool-calling reliability: models from families with proven structured JSON tool output.
    // Orchestra requires github_create_pr with complex JSON — models that struggle with
    // structured tool arguments waste all their iterations on formatting errors.
    // Use else-if to prevent double-counting (e.g. "anthropic/claude-..." matches both).
    const modelId = m.id.toLowerCase();
    if (modelId.includes('anthropic') || modelId.includes('claude')) score += 12;
    else if (modelId.includes('openai') || modelId.includes('gpt')) score += 10;
    else if (modelId.includes('qwen') || modelId.includes('alibaba')) score += 8;
    else if (modelId.includes('deepseek')) score += 6;

    // Use orchestraReady flag computed by enrichment pipeline
    if (m.orchestraReady) score += 10;

    return { model: m, score };
  });

  // Separate free vs paid
  const freeScored = scored.filter(s => s.model.isFree).sort((a, b) => b.score - a.score);
  const paidScored = scored.filter(s => !s.model.isFree).sort((a, b) => b.score - a.score);

  // Models to avoid for orchestra (small active params, weak instruction following)
  const avoidList = scored
    .filter(s => s.score < -5)
    .map(s => s.model.alias);

  const formatRec = (s: { model: ModelInfo; score: number }): OrchestraModelRec => {
    const specialty = s.model.specialty.replace(/^(Free|Paid)\s+/i, '');
    // Append AA benchmark summary when available
    const aaHints: string[] = [];
    if (s.model.intelligenceIndex) aaHints.push(`IQ:${s.model.intelligenceIndex.toFixed(0)}`);
    if (s.model.benchmarks?.coding) aaHints.push(`Code:${s.model.benchmarks.coding.toFixed(0)}`);
    const aaStr = aaHints.length > 0 ? ` (${aaHints.join(', ')})` : '';
    return {
      alias: s.model.alias,
      name: s.model.name,
      cost: s.model.cost,
      why: specialty + aaStr,
    };
  };

  return {
    free: freeScored.slice(0, 3).map(formatRec),
    paid: paidScored.slice(0, 3).map(formatRec),
    avoid: avoidList,
  };
}

/**
 * Format orchestra model recommendations as a user-friendly string.
 * Used in /orch help text.
 */
export function formatOrchestraModelRecs(): string {
  const recs = getOrchestraRecommendations();

  const lines: string[] = ['━━━ Recommended Models ━━━'];

  if (recs.free.length > 0) {
    lines.push('Free:');
    for (const r of recs.free) {
      lines.push(`  /${r.alias} — ${r.why}`);
    }
  }

  if (recs.paid.length > 0) {
    lines.push('Paid (best value):');
    for (const r of recs.paid) {
      lines.push(`  /${r.alias} (${r.cost}) — ${r.why}`);
    }
  }

  if (recs.avoid.length > 0) {
    // Only show a count + use /orch advise for details, don't dump 100+ aliases
    lines.push(`⚠️ ${recs.avoid.length} models not suited for orchestra — use /orch advise to check`);
  }

  lines.push('Switch model: type /<model> then /orch next');

  return lines.join('\n');
}

/**
 * Default model alias
 */
export const DEFAULT_MODEL = 'auto';

/**
 * Default image generation model
 */
export const DEFAULT_IMAGE_MODEL = 'fluxpro';

// === TASK ROUTER ===

/** Escalation targets for coding tasks, ordered by preference (cost-effective first). */
const CODING_ESCALATION_TARGETS = ['deep', 'grok', 'sonnet'] as const;

/** Task intent categories for routing decisions. */
export type TaskIntent = 'coding' | 'reasoning' | 'general';

/** Checkpoint metadata used by the router to decide escalation. */
export interface RouterCheckpointMeta {
  modelAlias?: string;
  iterations: number;
  toolsUsed: number;
  completed?: boolean;
  taskPrompt?: string;
}

/** Result of a routing decision. */
export interface RoutingDecision {
  /** The model alias to use. */
  modelAlias: string;
  /** Human-readable rationale for the decision (for logs and user messages). */
  rationale: string;
  /** Whether the model was escalated from the user's original choice. */
  escalated: boolean;
}

/**
 * Detect task intent from a user message (or task prompt).
 * Reusable across handler and task processor.
 */
export function detectTaskIntent(text: string): TaskIntent {
  const lower = text.toLowerCase();

  if (/\b(code|implement|debug|fix|refactor|function|class|script|deploy|build|test|coding|programming|pr\b|pull.?request|repository|repo\b|commit|merge|branch)\b/.test(lower)) {
    return 'coding';
  }
  if (/\b(research|analy[sz]e|compare|explain.{0,10}detail|reason|math|calculate|solve|prove|algorithm|investigate|comprehensive)\b/.test(lower)) {
    return 'reasoning';
  }
  return 'general';
}

/**
 * Task Router — single source of truth for model selection on resume.
 *
 * Policy rules:
 * 1. If the user explicitly overrides the model, use it directly.
 * 2. If checkpoint shows a stalled task (low tool ratio) on a weak/free model for a coding task,
 *    escalate to a stronger coding model.
 * 3. If the checkpoint model is /dcode (DeepSeek direct) and the task stalled, escalate.
 * 4. Otherwise, use the user's current model.
 *
 * @param userModel - The user's currently-selected model alias
 * @param checkpoint - Last checkpoint metadata (null if no checkpoint)
 * @param overrideAlias - Explicit user override (from /resume <model>)
 * @returns RoutingDecision with model, rationale, and escalation flag
 */
export function resolveTaskModel(
  userModel: string,
  checkpoint: RouterCheckpointMeta | null,
  overrideAlias?: string,
): RoutingDecision {
  // Rule 1: Explicit override always wins
  if (overrideAlias) {
    const model = getModel(overrideAlias);
    if (model) {
      return {
        modelAlias: overrideAlias,
        rationale: `User override: /${overrideAlias} (${model.name})`,
        escalated: false,
      };
    }
    // Invalid override — fall through to default
  }

  // No checkpoint or completed checkpoint — use user's model
  if (!checkpoint || checkpoint.completed) {
    return {
      modelAlias: userModel,
      rationale: `Using current model: /${userModel}`,
      escalated: false,
    };
  }

  // Rule 2 & 3: Check for stall signals that warrant escalation
  const cpModelAlias = checkpoint.modelAlias || userModel;
  const cpModel = getModel(cpModelAlias);

  // Detect task intent from checkpoint prompt
  const taskPrompt = checkpoint.taskPrompt || '';
  const intent = detectTaskIntent(taskPrompt);

  // Check if checkpoint model is a weak candidate for escalation:
  // - Free models (any free model can stall on complex tasks)
  // - /dcode specifically (the pain point from the audit)
  const isWeakCandidate = cpModel?.isFree === true || cpModelAlias === 'dcode';

  // Stall heuristic: low tool-to-iteration ratio means the model is spinning
  const lowToolRatio = checkpoint.toolsUsed < Math.max(1, checkpoint.iterations / 3);

  if (intent === 'coding' && isWeakCandidate && lowToolRatio && checkpoint.iterations >= 3) {
    // Find the first escalation target that isn't the current model
    const escalationTarget = CODING_ESCALATION_TARGETS.find(alias => alias !== cpModelAlias && alias !== userModel);
    const suggestList = CODING_ESCALATION_TARGETS
      .map(a => `/${a}`)
      .join(', ');

    return {
      modelAlias: userModel, // Don't force-switch — suggest instead
      rationale: `⚠️ Previous run on /${cpModelAlias}${cpModel?.isFree ? ' (free)' : ''} had low progress ` +
        `(${checkpoint.iterations} iters, ${checkpoint.toolsUsed} tools). ` +
        `Consider: /resume ${escalationTarget || 'deep'}\n` +
        `Stronger options: ${suggestList}`,
      escalated: false, // We suggest, not force
    };
  }

  return {
    modelAlias: userModel,
    rationale: `Using current model: /${userModel}`,
    escalated: false,
  };
}
