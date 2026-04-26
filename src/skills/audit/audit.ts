/**
 * Audit Skill — Handler
 *
 * v0 slice: Scout-only. Returns an `AuditPlan` describing what would be audited
 * (tree size, lens-filtered file selections, cost estimate). Extractor + Analyst
 * + Distiller land in subsequent commits per the design doc §14.
 *
 * Subcommands:
 *   /audit <repo>                          → plan-only (current default)
 *   /audit <repo> --lens <lens>            → narrow to a single lens
 *   /audit <repo> --depth quick|standard|deep
 *   /audit <repo> --branch <name>
 */

import type { SkillRequest, SkillResult, SkillMeta } from '../types';
import type { AuditPlan, Depth, Lens, RepoProfile } from './types';
import { MVP_LENSES, isLens, isDepth } from './types';
import { scout, parseRepoCoords } from './scout';
import { fileMatchesLens, depthBudget } from './lenses';
import { getCachedProfile, cacheProfile } from './cache';

export const AUDIT_META: SkillMeta = {
  id: 'audit',
  name: 'Audit',
  description: 'Repo audit — root-cause analysis + corrective + preventive actions, no clone required',
  defaultModel: 'flash',
  subcommands: ['plan', 'run'],
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAudit(request: SkillRequest): Promise<SkillResult> {
  const start = Date.now();

  // 1. Parse args
  const repoArg = request.text.trim().split(/\s+/)[0] ?? '';
  if (!repoArg) {
    return errorResult('Please provide a repo. Usage: /audit <owner/repo or URL> [--lens X] [--depth quick|standard|deep] [--branch <name>]');
  }
  const coords = parseRepoCoords(repoArg);
  if (!coords) {
    return errorResult(`Could not parse "${repoArg}" as a GitHub repo. Use owner/repo or a github.com URL.`);
  }

  const lens = parseLensFlag(request.flags.lens);
  if (request.flags.lens && !lens) {
    return errorResult(`Unknown --lens "${request.flags.lens}". Valid: ${MVP_LENSES.join(', ')}.`);
  }
  const lenses: Lens[] = lens ? [lens] : [...MVP_LENSES];

  const depth = parseDepthFlag(request.flags.depth);
  if (request.flags.depth && !depth) {
    return errorResult(`Unknown --depth "${request.flags.depth}". Valid: quick, standard, deep.`);
  }

  const branch = request.flags.branch;

  // 2. Scout — fetch from cache or call GitHub
  const githubToken = request.env.GITHUB_TOKEN;
  let profile: RepoProfile;
  let apiCalls = 0;
  let cachedFromSha: string | undefined;

  // First call always hits the network because we don't yet know the SHA.
  // Subsequent calls in the same run could be cached, but for the v0 plan-only
  // path the Scout is the only stage so we always run it.
  try {
    const result = await scout({ owner: coords.owner, repo: coords.repo, branch, token: githubToken });
    profile = result.profile;
    apiCalls = result.apiCalls;

    // Once we have the SHA, peek the cache — if we have a fresh profile keyed
    // on the same SHA, prefer it (it may have richer manifest content collected
    // in a prior, deeper run). Otherwise persist this one.
    const cached = await getCachedProfile(request.env.NEXUS_KV, profile.owner, profile.repo, profile.sha);
    if (cached && cached.profileHash === profile.profileHash) {
      profile = cached;
      cachedFromSha = profile.sha;
    } else {
      await cacheProfile(request.env.NEXUS_KV, profile);
    }
  } catch (err) {
    return errorResult(`Audit failed at Scout stage: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Build the plan — lens-filter + budget estimate
  const plan = buildPlan(profile, lenses, depth ?? 'quick');

  // 4. Render
  const body = formatPlan(plan, { cached: !!cachedFromSha, apiCalls });
  return {
    skillId: 'audit',
    kind: 'audit_plan',
    body,
    data: plan,
    telemetry: {
      durationMs: Date.now() - start,
      model: 'none',
      llmCalls: 0,
      toolCalls: apiCalls,
    },
  };
}

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

export function buildPlan(profile: RepoProfile, lenses: Lens[], depth: Depth): AuditPlan {
  const budget = depthBudget(depth);
  const selections = {} as Record<Lens, string[]>;
  const notes: string[] = [];

  for (const l of MVP_LENSES) selections[l] = [];

  for (const l of lenses) {
    const candidates = profile.tree
      .filter(t => fileMatchesLens(t, l))
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0)) // bigger files first as a crude signal
      .slice(0, budget.maxFilesPerLens);
    selections[l] = candidates.map(t => t.path);
    if (candidates.length === 0) {
      notes.push(`No files matched the "${l}" lens — repo may not contain typical ${l} surfaces.`);
    }
  }

  if (profile.codeScanningAlerts.length > 0) {
    const truncatedSuffix = profile.codeScanningAlertsTruncated ? ' (first page only — more may exist)' : '';
    notes.push(`${profile.codeScanningAlerts.length} pre-existing GitHub Code Scanning alerts will be ingested as evidence${truncatedSuffix}.`);
  } else {
    notes.push('No GitHub Code Scanning alerts available (feature disabled or no findings).');
  }

  if (profile.treeTruncated) {
    notes.push('⚠️ GitHub tree response was truncated (>100k entries or >7 MB) — audit coverage is partial. Consider --scope to narrow.');
  }

  if (profile.tree.length === 0) {
    notes.push('Repo tree is empty — nothing to audit.');
  }

  return {
    profile,
    lenses,
    depth,
    selections,
    estimate: {
      llmCalls: budget.maxLlmCalls,
      inputTokens: budget.inputTokenEstimate,
      costUsd: budget.costUsdEstimate,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatPlan(plan: AuditPlan, ctx: { cached: boolean; apiCalls: number }): string {
  const p = plan.profile;
  const lines: string[] = [];
  lines.push(`Audit plan: ${p.owner}/${p.repo}@${p.sha.slice(0, 7)} (${p.defaultBranch})`);
  lines.push(`Stack: ${p.meta.primaryLanguage ?? 'unknown'} • ${p.tree.length} files • ${(p.meta.sizeKb / 1024).toFixed(1)} MiB`);
  if (p.meta.archived) lines.push('⚠️ Repo is archived');
  if (p.meta.private) lines.push('🔒 Repo is private');
  lines.push('');

  lines.push(`Depth: ${plan.depth}`);
  lines.push(`Lenses: ${plan.lenses.join(', ')}`);
  lines.push('');

  lines.push('Selections (files the Extractor would parse):');
  for (const l of plan.lenses) {
    const files = plan.selections[l];
    lines.push(`  ${l} (${files.length}):`);
    for (const f of files.slice(0, 5)) lines.push(`    - ${f}`);
    if (files.length > 5) lines.push(`    … +${files.length - 5} more`);
  }
  lines.push('');

  lines.push('Manifests collected:');
  if (plan.profile.manifests.length === 0) {
    lines.push('  (none of the always-fetch manifests were present)');
  } else {
    for (const m of plan.profile.manifests) {
      lines.push(`  - ${m.path}${m.content == null ? ' (too large, sha-only)' : ''}`);
    }
  }
  lines.push('');

  if (plan.notes.length > 0) {
    lines.push('Notes:');
    for (const n of plan.notes) lines.push(`  • ${n}`);
    lines.push('');
  }

  lines.push(`Estimated cost: ~$${plan.estimate.costUsd.toFixed(2)} • ${plan.estimate.llmCalls} LLM calls • ~${plan.estimate.inputTokens.toLocaleString()} input tokens`);
  lines.push(`GitHub API calls used: ${ctx.apiCalls}${ctx.cached ? ' (profile served from cache)' : ''}`);
  lines.push('');
  lines.push('This is the v0 plan-only output — Extractor + Analyst land in the next slice.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLensFlag(raw: string | undefined): Lens | null {
  if (!raw) return null;
  return isLens(raw) ? raw : null;
}

function parseDepthFlag(raw: string | undefined): Depth | null {
  if (!raw) return null;
  return isDepth(raw) ? raw : null;
}

function errorResult(message: string): SkillResult {
  return {
    skillId: 'audit',
    kind: 'error',
    body: message,
    telemetry: { durationMs: 0, model: 'none', llmCalls: 0, toolCalls: 0 },
  };
}
