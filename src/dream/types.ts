/**
 * Dream Machine types — shared across all Dream Build components.
 *
 * These interfaces define the contract between Storia (sender) and
 * Moltworker (executor) for the Dream Machine Build stage.
 */

// ── Job payload (sent by Storia) ───────────────────────────────────

export type TargetRepoType = 'storia-digital' | 'petranto-com' | 'byok-cloud' | 'custom';
export type DreamPriority = 'critical' | 'high' | 'medium' | 'low';
export type DreamTrustLevel = 'observer' | 'planner' | 'builder' | 'shipper';

export interface DreamBuildBudget {
  maxTokens: number;
  maxDollars: number;
}

export interface DreamBuildJob {
  jobId: string;
  specId: string;
  userId: string;
  targetRepoType: TargetRepoType;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  branchPrefix: string;
  specMarkdown: string;
  estimatedEffort: string;
  priority: DreamPriority;
  callbackUrl: string;
  budget: DreamBuildBudget;
  queueName?: string;
}

// ── Status updates (sent back to Storia) ────────────────────────────

export type BuildStatus =
  | 'started'
  | 'planning'
  | 'writing'
  | 'testing'
  | 'pr_open'
  | 'complete'
  | 'failed'
  | 'paused_approval';

export interface BuildStatusUpdate {
  jobId: string;
  status: BuildStatus;
  step?: string;
  message?: string;
  prUrl?: string;
  error?: string;
}

// ── Parsed spec (output of spec parser) ─────────────────────────────

export interface ParsedSpec {
  title: string;
  overview: string;
  requirements: string[];
  apiRoutes: string[];
  dbChanges: string[];
  uiComponents: string[];
  rawSections: Record<string, string>;
}

// ── Work plan (output of planner) ───────────────────────────────────

export interface WorkItem {
  path: string;
  content: string;
  description: string;
}

export interface WorkPlan {
  title: string;
  branch: string;
  items: WorkItem[];
  prBody: string;
}

// ── Durable Object state ────────────────────────────────────────────

export type DreamJobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'paused';

export interface DreamJobState {
  jobId: string;
  status: DreamJobStatus;
  job: DreamBuildJob;
  plan?: WorkPlan;
  completedItems: string[];
  prUrl?: string;
  error?: string;
  tokensUsed: number;
  costEstimate: number;
  startedAt: number;
  updatedAt: number;
}

// ── Safety gate results ─────────────────────────────────────────────

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
  flaggedItems?: string[];
}
