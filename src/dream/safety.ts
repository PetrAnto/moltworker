/**
 * Dream Machine safety gates.
 *
 * Enforces budget caps, destructive operation checks,
 * and branch protection rules.
 */

import type { DreamBuildJob, WorkItem, SafetyCheckResult } from './types';

// Patterns that indicate destructive database operations
const DESTRUCTIVE_PATTERNS = [
  /DROP\s+TABLE/i,
  /DROP\s+DATABASE/i,
  /TRUNCATE\s+TABLE/i,
  /DELETE\s+FROM\s+\w+\s*;/i, // DELETE without WHERE
  /ALTER\s+TABLE\s+\w+\s+DROP/i,
  /--force/i,
  /--hard/i,
  /rm\s+-rf/i,
];

// Branch prefixes we never allow force-pushing to
const PROTECTED_BRANCHES = ['main', 'master', 'production', 'staging'];

/**
 * Check if the estimated cost is within budget.
 */
export function checkBudget(
  tokensUsed: number,
  costEstimate: number,
  budget: DreamBuildJob['budget']
): SafetyCheckResult {
  if (tokensUsed > budget.maxTokens) {
    return {
      allowed: false,
      reason: `Token budget exceeded: ${tokensUsed} / ${budget.maxTokens}`,
    };
  }

  if (costEstimate > budget.maxDollars) {
    return {
      allowed: false,
      reason: `Cost budget exceeded: $${costEstimate.toFixed(2)} / $${budget.maxDollars.toFixed(2)}`,
    };
  }

  return { allowed: true };
}

/**
 * Check work items for destructive operations.
 */
export function checkDestructiveOps(items: WorkItem[]): SafetyCheckResult {
  const flagged: string[] = [];

  for (const item of items) {
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(item.content)) {
        flagged.push(`${item.path}: matches ${pattern.source}`);
      }
    }
  }

  if (flagged.length > 0) {
    return {
      allowed: false,
      reason: 'Destructive operations detected — requires manual approval',
      flaggedItems: flagged,
    };
  }

  return { allowed: true };
}

/**
 * Validate that the target branch is safe to push to.
 */
export function checkBranchSafety(branchName: string): SafetyCheckResult {
  const lower = branchName.toLowerCase();

  for (const protected_ of PROTECTED_BRANCHES) {
    if (lower === protected_) {
      return {
        allowed: false,
        reason: `Cannot push directly to protected branch: ${branchName}`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Validate the entire job before execution.
 */
export function validateJob(job: DreamBuildJob): SafetyCheckResult {
  // Validate required fields
  if (!job.jobId || !job.specId || !job.userId) {
    return { allowed: false, reason: 'Missing required job fields (jobId, specId, userId)' };
  }

  if (!job.repoOwner || !job.repoName) {
    return { allowed: false, reason: 'Missing repository info (repoOwner, repoName)' };
  }

  if (!job.specMarkdown || job.specMarkdown.trim().length === 0) {
    return { allowed: false, reason: 'Spec markdown is empty' };
  }

  if (!job.callbackUrl) {
    return { allowed: false, reason: 'Missing callbackUrl for status updates' };
  }

  // Validate budget
  if (!job.budget || job.budget.maxTokens <= 0 || job.budget.maxDollars <= 0) {
    return { allowed: false, reason: 'Invalid budget: maxTokens and maxDollars must be positive' };
  }

  // Validate repo owner/name format
  if (!/^[a-zA-Z0-9._-]+$/.test(job.repoOwner)) {
    return { allowed: false, reason: `Invalid repoOwner format: ${job.repoOwner}` };
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(job.repoName)) {
    return { allowed: false, reason: `Invalid repoName format: ${job.repoName}` };
  }

  // Validate callbackUrl is a valid HTTPS URL
  try {
    const url = new URL(job.callbackUrl);
    if (url.protocol !== 'https:') {
      return { allowed: false, reason: 'callbackUrl must use HTTPS' };
    }
  } catch {
    return { allowed: false, reason: `Invalid callbackUrl: ${job.callbackUrl}` };
  }

  return { allowed: true };
}
