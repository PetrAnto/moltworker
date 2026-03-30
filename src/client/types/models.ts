/**
 * Client-side model types mirroring the server ModelInfo shape.
 * Used by useLiveModels hook and CommandBar components.
 */

export type Provider = 'openrouter' | 'dashscope' | 'moonshot' | 'deepseek' | 'anthropic';

export type StarRating = 3 | 2 | 1 | 0;
export type EvidenceLevel = 'verified' | 'curated' | 'unverified';
export type ValueTier = 'free' | 'exceptional' | 'great' | 'good' | 'premium' | 'outdated';
export type PickIntent = 'free' | 'coding' | 'fast' | 'orchestra' | 'creative' | 'cheap' | 'best' | 'vision' | 'reasoning';

export interface ModelRating {
  stars: StarRating;
  evidence: EvidenceLevel;
}

export interface ModelBenchmarks {
  coding?: number;
  math?: number;
  mmluPro?: number;
  gpqa?: number;
  livecodebench?: number;
  speedTps?: number;
}

export interface CockpitModel {
  alias: string;
  id: string;
  name: string;
  specialty: string;
  cost: string;
  isFree: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  reasoning: string;
  maxContext?: number;
  intelligenceIndex?: number;
  benchmarks?: ModelBenchmarks;
  orchestraReady?: boolean;
  provider?: Provider;
  valueTier: ValueTier;
  rating: ModelRating;
  category: 'coding' | 'reasoning' | 'fast' | 'general';
  speedTps?: number;
}

export interface ProviderGroup {
  provider: string;
  models: CockpitModel[];
  color: string;
}

/** Provider brand colors for reactor icons */
export const PROVIDER_COLORS: Record<string, string> = {
  openrouter: '#6366f1',
  anthropic: '#d4a574',
  openai: '#10a37f',
  google: '#4285f4',
  meta: '#0668e1',
  deepseek: '#4d6bfe',
  qwen: '#615eff',
  mistral: '#ff7000',
  xai: '#1d9bf0',
  dashscope: '#615eff',
  moonshot: '#fbbf24',
  cohere: '#39594d',
  arcee: '#e94560',
  zhipu: '#3b82f6',
  minimax: '#6d28d9',
};

/** Intent tab configuration */
export const INTENT_TABS: { intent: PickIntent; label: string; icon: string }[] = [
  { intent: 'fast', label: 'Fast', icon: '⚡' },
  { intent: 'best', label: 'Quality', icon: '🏆' },
  { intent: 'cheap', label: 'Budget', icon: '💰' },
  { intent: 'free', label: 'Free', icon: '🆓' },
  { intent: 'coding', label: 'Code', icon: '💻' },
  { intent: 'reasoning', label: 'Reason', icon: '🧠' },
];

/** Derive provider key from model ID */
export function getProviderFromId(modelId: string): string {
  if (modelId.includes('anthropic') || modelId.includes('claude')) return 'anthropic';
  if (modelId.includes('openai') || modelId.includes('gpt')) return 'openai';
  if (modelId.includes('google') || modelId.includes('gemini')) return 'google';
  if (modelId.includes('meta') || modelId.includes('llama')) return 'meta';
  if (modelId.includes('deepseek')) return 'deepseek';
  if (modelId.includes('qwen') || modelId.includes('alibaba')) return 'qwen';
  if (modelId.includes('mistral') || modelId.includes('devstral')) return 'mistral';
  if (modelId.includes('x-ai') || modelId.includes('grok')) return 'xai';
  if (modelId.includes('minimax')) return 'minimax';
  if (modelId.includes('cohere')) return 'cohere';
  if (modelId.includes('arcee')) return 'arcee';
  if (modelId.includes('zhipu') || modelId.includes('glm')) return 'zhipu';
  return 'openrouter';
}

export function formatStars(stars: StarRating): string {
  switch (stars) {
    case 3: return '★★★';
    case 2: return '★★☆';
    case 1: return '★☆☆';
    case 0: return '☆☆☆';
  }
}

export function formatCostShort(cost: string): string {
  if (cost === 'FREE' || cost.toLowerCase().includes('free')) return 'Free';
  const match = cost.match(/\$[\d.]+\/\$([\d.]+)/);
  if (match) return `$${match[1]}/M`;
  return cost;
}

export function formatSpeedShort(tps?: number): string {
  if (!tps) return '';
  if (tps >= 100) return `${Math.round(tps)} t/s`;
  return `${tps.toFixed(1)} t/s`;
}

export function formatContextShort(ctx?: number): string {
  if (!ctx) return '';
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M ctx`;
  return `${Math.round(ctx / 1000)}K ctx`;
}
