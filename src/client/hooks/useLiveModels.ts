import { useState, useEffect, useCallback, useMemo } from 'react';
import type { CockpitModel, PickIntent, ProviderGroup } from '../types/models';
import { getProviderFromId, PROVIDER_COLORS } from '../types/models';

const API_BASE = '/api/admin';
const STORAGE_KEY_PINNED = 'cockpit-pinned-models';
const STORAGE_KEY_RECENT = 'cockpit-recent-models';
const STORAGE_KEY_SELECTED = 'cockpit-selected-model';
const MAX_RECENT = 5;

interface CatalogResponse {
  synced: boolean;
  models: Array<{
    alias: string;
    id: string;
    name: string;
    cost: string;
    tools: boolean;
    vision: boolean;
    reasoning: string;
    maxContext?: number;
    isFree: boolean;
  }>;
}

function loadStorageList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveStorageList(key: string, list: string[]): void {
  localStorage.setItem(key, JSON.stringify(list));
}

/**
 * Rank models by a composite score: rating stars + intelligence + speed + free bonus.
 */
function rankScore(m: CockpitModel): number {
  let score = m.rating.stars * 25;
  score += (m.intelligenceIndex || 0) * 0.5;
  if (m.speedTps) score += Math.min(m.speedTps / 10, 10);
  if (m.isFree) score += 5;
  if (m.orchestraReady) score += 3;
  return score;
}

export function rankModels(models: CockpitModel[]): CockpitModel[] {
  return [...models].sort((a, b) => rankScore(b) - rankScore(a));
}

/**
 * Group models by provider.
 */
export function groupByProvider(models: CockpitModel[]): ProviderGroup[] {
  const groups = new Map<string, CockpitModel[]>();

  for (const m of models) {
    const provider = getProviderFromId(m.id);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider)!.push(m);
  }

  return Array.from(groups.entries()).map(([provider, models]) => ({
    provider,
    models: rankModels(models),
    color: PROVIDER_COLORS[provider] || PROVIDER_COLORS.openrouter,
  }));
}

/**
 * Filter models by intent tab.
 */
export function filterByIntent(models: CockpitModel[], intent: PickIntent): CockpitModel[] {
  switch (intent) {
    case 'free':
      return models.filter(m => m.isFree);
    case 'coding':
      return models.filter(m => m.category === 'coding' || m.orchestraReady);
    case 'fast':
      return [...models].sort((a, b) => (b.speedTps || 0) - (a.speedTps || 0)).slice(0, 12);
    case 'best':
      return models.filter(m => m.rating.stars >= 2);
    case 'cheap':
      return models.filter(m => m.valueTier === 'exceptional' || m.valueTier === 'great');
    case 'reasoning':
      return models.filter(m => m.reasoning !== 'none');
    case 'orchestra':
      return models.filter(m => m.orchestraReady);
    case 'creative':
      return models.filter(m => (m.intelligenceIndex || 0) >= 45);
    case 'vision':
      return models.filter(m => m.supportsVision);
    default:
      return models;
  }
}

export interface UseLiveModelsResult {
  models: CockpitModel[];
  loading: boolean;
  error: string | null;
  selectedModel: CockpitModel | null;
  selectModel: (alias: string) => void;
  pinnedModelIds: string[];
  togglePin: (alias: string) => void;
  recentModelIds: string[];
  search: string;
  setSearch: (q: string) => void;
  filteredModels: CockpitModel[];
  intentModels: (intent: PickIntent) => CockpitModel[];
  refresh: () => void;
}

export function useLiveModels(): UseLiveModelsResult {
  const [models, setModels] = useState<CockpitModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pinnedModelIds, setPinnedModelIds] = useState<string[]>(() => loadStorageList(STORAGE_KEY_PINNED));
  const [recentModelIds, setRecentModelIds] = useState<string[]>(() => loadStorageList(STORAGE_KEY_RECENT));
  const [selectedAlias, setSelectedAlias] = useState<string>(() => localStorage.getItem(STORAGE_KEY_SELECTED) || '');

  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/models/catalog`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: CatalogResponse = await res.json();

      if (!data.synced) {
        setModels([]);
        setError('Model catalog not synced yet');
        return;
      }

      const cockpitModels: CockpitModel[] = data.models
        .filter(m => !m.alias.startsWith('auto'))
        .map(m => {
          const provider = getProviderFromId(m.id);
          const isFree = m.isFree || m.cost.toLowerCase().includes('free');
          const costMatch = m.cost.match(/\$[\d.]+\/\$([\d.]+)/);
          const outputCost = costMatch ? parseFloat(costMatch[1]) : 0;

          let valueTier: CockpitModel['valueTier'] = 'good';
          if (isFree) valueTier = 'free';
          else if (outputCost <= 0.5) valueTier = 'exceptional';
          else if (outputCost <= 2.0) valueTier = 'great';
          else if (outputCost <= 5.0) valueTier = 'good';
          else valueTier = 'premium';

          // Compute rating client-side (simplified version of server logic)
          let stars: 0 | 1 | 2 | 3 = 0;
          if (m.tools && (m.maxContext || 0) >= 64000) stars = 1;
          if (m.tools && (m.maxContext || 0) >= 200000) stars = 2;

          // Derive category
          const lower = (m.id + ' ' + m.name).toLowerCase();
          let category: CockpitModel['category'] = 'general';
          if (/coder|code|devstral|codestral/i.test(lower)) category = 'coding';
          else if (m.reasoning !== 'none' || /\br1\b|reason|think/i.test(lower)) category = 'reasoning';
          else if (/flash|mini|small|fast|turbo|lite|nano/i.test(lower)) category = 'fast';

          return {
            alias: m.alias,
            id: m.id,
            name: m.name,
            specialty: '',
            cost: m.cost,
            isFree,
            supportsTools: m.tools,
            supportsVision: m.vision,
            reasoning: m.reasoning,
            maxContext: m.maxContext,
            provider: provider as CockpitModel['provider'],
            valueTier,
            rating: { stars, evidence: 'curated' as const },
            category,
            orchestraReady: m.tools && (m.maxContext || 0) >= 128000,
          };
        });

      setModels(rankModels(cockpitModels));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load models');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchModels(); }, [fetchModels]);

  const selectedModel = useMemo(
    () => models.find(m => m.alias === selectedAlias) || models[0] || null,
    [models, selectedAlias]
  );

  const selectModel = useCallback((alias: string) => {
    setSelectedAlias(alias);
    localStorage.setItem(STORAGE_KEY_SELECTED, alias);

    // Update recents
    setRecentModelIds(prev => {
      const next = [alias, ...prev.filter(a => a !== alias)].slice(0, MAX_RECENT);
      saveStorageList(STORAGE_KEY_RECENT, next);
      return next;
    });
  }, []);

  const togglePin = useCallback((alias: string) => {
    setPinnedModelIds(prev => {
      const next = prev.includes(alias)
        ? prev.filter(a => a !== alias)
        : [...prev, alias];
      saveStorageList(STORAGE_KEY_PINNED, next);
      return next;
    });
  }, []);

  const filteredModels = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.alias.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q)
    );
  }, [models, search]);

  const intentModels = useCallback((intent: PickIntent) => {
    return filterByIntent(models, intent);
  }, [models]);

  return {
    models,
    loading,
    error,
    selectedModel,
    selectModel,
    pinnedModelIds,
    togglePin,
    recentModelIds,
    search,
    setSearch,
    filteredModels,
    intentModels,
    refresh: fetchModels,
  };
}
