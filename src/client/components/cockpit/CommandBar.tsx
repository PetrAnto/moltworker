import { useState, useRef, useEffect, useCallback } from 'react';
import type { CockpitModel, PickIntent } from '../../types/models';
import {
  PROVIDER_COLORS,
  INTENT_TABS,
  getProviderFromId,
  formatStars,
  formatCostShort,
  formatSpeedShort,
  formatContextShort,
} from '../../types/models';
import { useLiveModels, filterByIntent, rankModels } from '../../hooks/useLiveModels';
import './cockpit.css';

/* ── SVG micro-icons (inline to avoid external deps) ── */

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

function PinIcon({ filled }: { filled?: boolean }) {
  if (filled) {
    return (
      <svg viewBox="0 0 16 16" fill="currentColor">
        <path d="M9.828 1.172a1 1 0 0 1 1.414 0l3.586 3.586a1 1 0 0 1-.707 1.707L12 6.586 9.414 9.172l.293 4.121a1 1 0 0 1-1.707.707L5.879 11.88l-3.172 3.172a.5.5 0 0 1-.707-.707L5.172 11.17 3 8.998a1 1 0 0 1 .707-1.707l4.121.293L10.414 5l.121-2.121a1 1 0 0 1 .293-.707z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M9.828 1.172a1 1 0 0 1 1.414 0l3.586 3.586a1 1 0 0 1-.707 1.707L12 6.586 9.414 9.172l.293 4.121a1 1 0 0 1-1.707.707L5.879 11.88l-3.172 3.172a.5.5 0 0 1-.707-.707L5.172 11.17 3 8.998a1 1 0 0 1 .707-1.707l4.121.293L10.414 5l.121-2.121a1 1 0 0 1 .293-.707z" />
    </svg>
  );
}

/* ── QualityRing: SVG ring that fills based on star rating ── */

function QualityRing({ stars }: { stars: number }) {
  const radius = 11;
  const circumference = 2 * Math.PI * radius;
  const filled = (stars / 3) * circumference;
  const color = stars >= 3 ? '#c8a96e' : stars >= 2 ? '#a78bfa' : stars >= 1 ? '#60a5fa' : '#5a586e';

  return (
    <div className="ai-selector-quality-ring">
      <svg viewBox="0 0 28 28">
        <circle className="ai-selector-quality-ring__track" cx="14" cy="14" r={radius} />
        <circle
          className="ai-selector-quality-ring__fill"
          cx="14"
          cy="14"
          r={radius}
          stroke={color}
          strokeDasharray={circumference}
          strokeDashoffset={circumference - filled}
          transform="rotate(-90 14 14)"
        />
      </svg>
      <span>{stars}</span>
    </div>
  );
}

/* ── SelectorTrigger: the engine capsule button ── */

interface SelectorTriggerProps {
  model: CockpitModel | null;
  isOpen: boolean;
  onClick: () => void;
}

function SelectorTrigger({ model, isOpen, onClick }: SelectorTriggerProps) {
  const provider = model ? getProviderFromId(model.id) : 'openrouter';
  const providerColor = PROVIDER_COLORS[provider] || PROVIDER_COLORS.openrouter;
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1, 3).toUpperCase();
  const speedStr = model ? formatSpeedShort(model.speedTps) : '';
  const costStr = model ? formatCostShort(model.cost) : '';

  return (
    <button
      className="ai-selector-trigger"
      aria-expanded={isOpen}
      onClick={onClick}
      type="button"
    >
      {/* Reactor icon */}
      <div
        className="ai-selector-reactor"
        style={{ background: providerColor }}
      >
        {providerLabel}
      </div>

      {/* Center info */}
      <div className="ai-selector-trigger__info">
        <span className="ai-selector-trigger__model-name">
          {model?.name || 'Select Model'}
        </span>
        <span className="ai-selector-trigger__meta">
          <span>{provider}</span>
          {speedStr && (
            <>
              <span className="ai-selector-trigger__meta-sep">·</span>
              <span>{speedStr}</span>
            </>
          )}
          {costStr && (
            <>
              <span className="ai-selector-trigger__meta-sep">·</span>
              <span>{costStr}</span>
            </>
          )}
        </span>
      </div>

      {/* Quality ring */}
      {model && (
        <div className="ai-selector-trigger__quality">
          <QualityRing stars={model.rating.stars} />
        </div>
      )}

      {/* Chevron */}
      <ChevronDown className="ai-selector-trigger__chevron" />
    </button>
  );
}

/* ── IntentTabs: filter strip above model list ── */

interface IntentTabsProps {
  active: PickIntent | null;
  onSelect: (intent: PickIntent | null) => void;
}

function IntentTabs({ active, onSelect }: IntentTabsProps) {
  return (
    <div className="ai-selector-tabs" role="tablist">
      {INTENT_TABS.map(({ intent, label, icon }) => (
        <button
          key={intent}
          role="tab"
          aria-selected={active === intent}
          className={`ai-selector-tab ${active === intent ? 'ai-selector-tab--active' : ''}`}
          onClick={() => onSelect(active === intent ? null : intent)}
          type="button"
        >
          <span className="ai-selector-tab__icon">{icon}</span>
          {label}
        </button>
      ))}
    </div>
  );
}

/* ── ModelRow: single model in the list ── */

interface ModelRowProps {
  model: CockpitModel;
  isSelected: boolean;
  isPinned: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
}

function ModelRow({ model, isSelected, isPinned, onSelect, onTogglePin }: ModelRowProps) {
  const provider = getProviderFromId(model.id);
  const providerColor = PROVIDER_COLORS[provider] || PROVIDER_COLORS.openrouter;
  const costStr = formatCostShort(model.cost);
  const contextStr = formatContextShort(model.maxContext);
  const speedStr = formatSpeedShort(model.speedTps);

  const tierClass = model.valueTier === 'free' ? 'ai-selector-row__tier--free'
    : model.valueTier === 'exceptional' ? 'ai-selector-row__tier--exceptional'
    : model.valueTier === 'great' ? 'ai-selector-row__tier--great'
    : model.valueTier === 'premium' ? 'ai-selector-row__tier--premium'
    : '';

  return (
    <div
      className={`ai-selector-row ${isSelected ? 'ai-selector-row--selected' : ''}`}
      onClick={onSelect}
      role="option"
      aria-selected={isSelected}
    >
      {/* Provider dot */}
      <div
        className="ai-selector-row__provider-dot"
        style={{ background: providerColor }}
      />

      {/* Info */}
      <div className="ai-selector-row__info">
        <span className="ai-selector-row__name">{model.name}</span>
        <span className="ai-selector-row__meta">
          <span>{provider}</span>
          {costStr && (
            <>
              <span className="ai-selector-row__meta-sep">·</span>
              <span>{costStr}</span>
            </>
          )}
          {contextStr && (
            <>
              <span className="ai-selector-row__meta-sep">·</span>
              <span>{contextStr}</span>
            </>
          )}
          {speedStr && (
            <>
              <span className="ai-selector-row__meta-sep">·</span>
              <span>{speedStr}</span>
            </>
          )}
        </span>
      </div>

      {/* Right side */}
      <div className="ai-selector-row__right">
        {/* Quality pips */}
        <div className="ai-selector-row__quality-bar">
          {[1, 2, 3].map(pip => (
            <div
              key={pip}
              className={`ai-selector-row__quality-pip ${model.rating.stars >= pip ? 'ai-selector-row__quality-pip--filled' : ''}`}
            />
          ))}
        </div>

        {/* Tier tag */}
        {tierClass && (
          <span className={`ai-selector-row__tier ${tierClass}`}>
            {model.valueTier}
          </span>
        )}

        {/* Pin button */}
        <button
          className={`ai-selector-row__pin ${isPinned ? 'ai-selector-row__pin--active' : ''}`}
          onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
          title={isPinned ? 'Unpin model' : 'Pin model'}
          type="button"
        >
          <PinIcon filled={isPinned} />
        </button>
      </div>
    </div>
  );
}

/* ── PinnedRecentStrip: quick-access chips ── */

interface PinnedRecentStripProps {
  models: CockpitModel[];
  pinnedIds: string[];
  recentIds: string[];
  onSelect: (alias: string) => void;
}

function PinnedRecentStrip({ models, pinnedIds, recentIds, onSelect }: PinnedRecentStripProps) {
  const chips = [...new Set([...pinnedIds, ...recentIds])].slice(0, 8);
  const modelMap = new Map(models.map(m => [m.alias, m]));

  if (chips.length === 0) return null;

  return (
    <div className="ai-selector-pinned-strip">
      {chips.map(alias => {
        const m = modelMap.get(alias);
        if (!m) return null;
        const provider = getProviderFromId(m.id);
        const color = PROVIDER_COLORS[provider] || PROVIDER_COLORS.openrouter;
        const isPinned = pinnedIds.includes(alias);

        return (
          <button
            key={alias}
            className="ai-selector-pinned-chip"
            onClick={() => onSelect(alias)}
            type="button"
          >
            <span className="ai-selector-pinned-chip__dot" style={{ background: color }} />
            {m.name.length > 18 ? m.alias : m.name}
            {isPinned && <span style={{ fontSize: '8px', opacity: 0.5 }}>📌</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ── GeckoRecommendStrip: shows active personality suggestion ── */

interface GeckoRecommendStripProps {
  activePersonality?: string;
}

function GeckoRecommendStrip({ activePersonality }: GeckoRecommendStripProps) {
  if (!activePersonality) return null;

  return (
    <div className="gecko-recommend-strip">
      <span className="gecko-recommend-strip__dot" />
      <span>{activePersonality} suggests this engine</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CommandBar — Main AI Selector Component
   Combines: Trigger + Flyout (Sheet) with all data logic
   ═══════════════════════════════════════════════════════════════════ */

export interface CommandBarProps {
  activePersonality?: string;
}

export function CommandBar({ activePersonality }: CommandBarProps) {
  const {
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
  } = useLiveModels();

  const [isOpen, setIsOpen] = useState(false);
  const [activeIntent, setActiveIntent] = useState<PickIntent | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus search input when flyout opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen]);

  const handleSelect = useCallback((alias: string) => {
    selectModel(alias);
    setIsOpen(false);
    setSearch('');
    setActiveIntent(null);
  }, [selectModel, setSearch]);

  // Determine displayed models
  const displayModels = search.trim()
    ? filteredModels
    : activeIntent
      ? rankModels(filterByIntent(models, activeIntent))
      : models;

  // Split into pinned + rest
  const pinnedModels = displayModels.filter(m => pinnedModelIds.includes(m.alias));
  const restModels = displayModels.filter(m => !pinnedModelIds.includes(m.alias));

  return (
    <div style={{ position: 'relative' }}>
      {/* Trigger capsule */}
      <SelectorTrigger
        model={selectedModel}
        isOpen={isOpen}
        onClick={() => setIsOpen(!isOpen)}
      />

      {/* Flyout */}
      {isOpen && (
        <>
          {/* Backdrop for click-away */}
          <div
            className="ai-selector-backdrop"
            onClick={() => { setIsOpen(false); setActiveIntent(null); setSearch(''); }}
          />

          <div className="ai-selector-sheet" ref={sheetRef}>
            {/* Header: Search + Gecko strip */}
            <div className="ai-selector-sheet__header">
              <div className="ai-selector-search">
                <SearchIcon className="ai-selector-search__icon" />
                <input
                  ref={searchInputRef}
                  className="ai-selector-search__input"
                  type="text"
                  placeholder="Search models..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              <GeckoRecommendStrip activePersonality={activePersonality} />
            </div>

            {/* Pinned / Recent strip */}
            <PinnedRecentStrip
              models={models}
              pinnedIds={pinnedModelIds}
              recentIds={recentModelIds}
              onSelect={handleSelect}
            />

            {/* Intent tabs */}
            <IntentTabs active={activeIntent} onSelect={setActiveIntent} />

            {/* Model list */}
            <div className="ai-selector-list" role="listbox">
              {loading ? (
                <div className="ai-selector-loading">
                  <div className="ai-selector-loading__spinner" />
                </div>
              ) : error ? (
                <div className="ai-selector-empty">
                  <span className="ai-selector-empty__icon">⚠️</span>
                  <span className="ai-selector-empty__text">{error}</span>
                </div>
              ) : displayModels.length === 0 ? (
                <div className="ai-selector-empty">
                  <span className="ai-selector-empty__icon">🔍</span>
                  <span className="ai-selector-empty__text">
                    {search ? `No models matching "${search}"` : 'No models available'}
                  </span>
                </div>
              ) : (
                <>
                  {/* Pinned section */}
                  {pinnedModels.length > 0 && (
                    <>
                      <div className="ai-selector-section">Pinned</div>
                      {pinnedModels.map(m => (
                        <ModelRow
                          key={m.alias}
                          model={m}
                          isSelected={selectedModel?.alias === m.alias}
                          isPinned={true}
                          onSelect={() => handleSelect(m.alias)}
                          onTogglePin={() => togglePin(m.alias)}
                        />
                      ))}
                    </>
                  )}

                  {/* All models section */}
                  <div className="ai-selector-section">
                    {activeIntent
                      ? INTENT_TABS.find(t => t.intent === activeIntent)?.label || 'Models'
                      : 'All Models'}
                  </div>
                  {restModels.map(m => (
                    <ModelRow
                      key={m.alias}
                      model={m}
                      isSelected={selectedModel?.alias === m.alias}
                      isPinned={pinnedModelIds.includes(m.alias)}
                      onSelect={() => handleSelect(m.alias)}
                      onTogglePin={() => togglePin(m.alias)}
                    />
                  ))}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default CommandBar;
