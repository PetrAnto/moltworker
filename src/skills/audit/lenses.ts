/**
 * Audit Skill — Lens Filters
 *
 * For each lens, defines:
 *   - which manifests are always-fetched
 *   - which path patterns the Scout flags as high-signal for the Extractor
 *
 * Per-lens AST queries + Analyst prompts land alongside the Extractor in
 * the next slice. This file is intentionally small — pure data + filters.
 */

import type { Lens, TreeEntry } from './types';

// ---------------------------------------------------------------------------
// Always-fetch manifests (cheap, fixed-cost evidence)
// ---------------------------------------------------------------------------

/** Manifests we fetch unconditionally — they cost a fixed ~5 GitHub calls and
 *  produce signal across multiple lenses. Order is irrelevant. */
export const ALWAYS_FETCH_MANIFESTS: ReadonlyArray<string> = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'tsconfig.base.json',
  '.eslintrc',
  '.eslintrc.json',
  'eslint.config.js',
  'eslint.config.mjs',
  'biome.json',
  'pyproject.toml',
  'requirements.txt',
  'poetry.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'Dockerfile',
  'wrangler.toml',
  'wrangler.jsonc',
  'README.md',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  'CLAUDE.md',
  '.github/dependabot.yml',
];

// ---------------------------------------------------------------------------
// Per-lens path filters
// ---------------------------------------------------------------------------

/** Always-skip paths — generated/vendor noise filtered before any lens runs. */
export const VENDORED_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)\.nuxt\//,
  /(^|\/)coverage\//,
  /(^|\/)\.cache\//,
  /(^|\/)vendor\//,
  /(^|\/)__pycache__\//,
  /(^|\/)target\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.lock$/,  // lockfiles are read separately as manifests
];

/**
 * Classify each tree entry against a lens. Returns true if the file is
 * high-signal for the lens and should be considered for Extractor input.
 *
 * Filters are intentionally cheap (path-pattern only). The Extractor handles
 * structural matching with tree-sitter; the Analyst handles semantic judgment.
 */
export function fileMatchesLens(entry: TreeEntry, lens: Lens): boolean {
  if (entry.type !== 'blob') return false;
  if (VENDORED_PATTERNS.some(re => re.test(entry.path))) return false;

  const path = entry.path;
  switch (lens) {
    case 'security': {
      // Workflow yaml files are a security surface (pinned actions, perms,
      // secret exposure) — match those without requiring a code extension.
      if (/\.github\/workflows\/.+\.(ya?ml)$/.test(path)) return true;
      // Otherwise: code files in auth/middleware/routes/handlers/api/controllers,
      // or auth-named files at any depth in src/.
      return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/.test(path) && (
        /(^|\/)(auth|middleware|routes?|handlers?|api|controllers?)\//.test(path) ||
        /(^|\/)src\/(.+\/)?(auth|login|signup|signin|session|jwt|cookie|cors)\.(ts|tsx|js|jsx|py|go)$/.test(path)
      );
    }

    case 'deps':
      // Manifests are fetched separately. This lens primarily reads them.
      return /(^|\/)(package|pnpm-lock|yarn\.lock|Cargo|requirements|go\.(mod|sum)|pyproject|poetry\.lock)/.test(path);

    case 'types':
      return /\.(ts|tsx)$/.test(path) && !/\.d\.ts$/.test(path);

    case 'tests':
      // Files that LACK tests are the signal — caller compares against test files.
      // For now, return source files in the primary code dirs so the Analyst can
      // cross-reference test presence.
      return /(^|\/)src\//.test(path) && /\.(ts|tsx|js|jsx|py|go|rs)$/.test(path);

    case 'deadcode':
      // Same set as types/tests — Knip-style analysis needs broad source visibility.
      return /(^|\/)src\//.test(path) && /\.(ts|tsx|js|jsx)$/.test(path);

    case 'perf':
      // Hot-path heuristics: routes, handlers, loops, db, render.
      return /\.(ts|tsx|js|jsx|py|go|rs)$/.test(path) && (
        /(^|\/)(routes?|handlers?|api|controllers?|db|database|render|workers?)\//.test(path) ||
        /(server|app|main|index|worker)\.(ts|tsx|js|jsx|py|go)$/.test(path)
      );

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Selection caps per depth (mirror design doc §7)
// ---------------------------------------------------------------------------

export interface DepthBudget {
  /** Max files the Scout flags PER lens. */
  maxFilesPerLens: number;
  /** Max LLM calls the Analyst is allowed across the run. */
  maxLlmCalls: number;
  /** Max retrieval rounds (deep retrieval after the initial pass). */
  maxRetrievalRounds: number;
  /** Crude token estimate for the Analyst stage (input tokens). */
  inputTokenEstimate: number;
  /** Crude $ estimate at default model routing. */
  costUsdEstimate: number;
}

export function depthBudget(depth: 'quick' | 'standard' | 'deep'): DepthBudget {
  switch (depth) {
    case 'quick':
      return { maxFilesPerLens: 5, maxLlmCalls: 2, maxRetrievalRounds: 1, inputTokenEstimate: 8000, costUsdEstimate: 0.05 };
    case 'standard':
      return { maxFilesPerLens: 10, maxLlmCalls: 4, maxRetrievalRounds: 2, inputTokenEstimate: 30000, costUsdEstimate: 0.30 };
    case 'deep':
      return { maxFilesPerLens: 25, maxLlmCalls: 7, maxRetrievalRounds: 4, inputTokenEstimate: 90000, costUsdEstimate: 1.20 };
  }
}
