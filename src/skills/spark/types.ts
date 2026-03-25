/**
 * Spark (Tach) — Brainstorm + Ideas Types
 */

/** A saved idea/link in the user's inbox. */
export interface SparkItem {
  /** Unique ID (crypto.randomUUID). */
  id: string;
  /** Raw text the user saved. */
  text: string;
  /** Extracted URL if the input contained one, or undefined. */
  url?: string;
  /** Brief AI-generated summary (from URL metadata or quick analysis). */
  summary?: string;
  /** User-assigned tags (future use). */
  tags?: string[];
  /** When the item was saved. */
  createdAt: string;
}

/** Type guard for SparkItem. */
export function isSparkItem(v: unknown): v is SparkItem {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    obj.id.length > 0 &&
    typeof obj.text === 'string' &&
    obj.text.length > 0 &&
    typeof obj.createdAt === 'string'
  );
}

/** Quick reaction result from /spark. */
export interface SparkReaction {
  /** One-liner reaction. */
  reaction: string;
  /** Potential angle or use case. */
  angle: string;
  /** Suggested next step. */
  nextStep: string;
}

/** Type guard for SparkReaction. */
export function isSparkReaction(v: unknown): v is SparkReaction {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.reaction === 'string' &&
    typeof obj.angle === 'string' &&
    typeof obj.nextStep === 'string'
  );
}

/** One stage of the 6-stage gauntlet evaluation. */
export interface GauntletStage {
  /** Stage name (e.g. "Feasibility", "Originality"). */
  name: string;
  /** Score 1-5 for this stage. */
  score: number;
  /** Brief assessment. */
  assessment: string;
}

/** Full gauntlet result from /gauntlet. */
export interface SparkGauntlet {
  /** The idea being evaluated. */
  idea: string;
  /** 6 evaluation stages. */
  stages: GauntletStage[];
  /** Overall verdict. */
  verdict: string;
  /** Overall score (average of stages). */
  overallScore: number;
}

/** Type guard for SparkGauntlet. */
export function isSparkGauntlet(v: unknown): v is SparkGauntlet {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.idea !== 'string') return false;
  if (typeof obj.verdict !== 'string') return false;
  if (typeof obj.overallScore !== 'number') return false;
  if (!Array.isArray(obj.stages)) return false;
  return obj.stages.every((s: unknown) => {
    if (typeof s !== 'object' || s === null) return false;
    const stage = s as Record<string, unknown>;
    return (
      typeof stage.name === 'string' &&
      typeof stage.score === 'number' &&
      typeof stage.assessment === 'string'
    );
  });
}

/** Brainstorm cluster result. */
export interface BrainstormCluster {
  /** Cluster theme. */
  theme: string;
  /** Item IDs in this cluster. */
  itemIds: string[];
  /** Brief insight about this cluster. */
  insight: string;
  /** Challenge question for this cluster. */
  challenge: string;
}

/** Full brainstorm result. */
export interface BrainstormResult {
  clusters: BrainstormCluster[];
  /** Overall synthesis across all clusters. */
  synthesis: string;
}

/** Type guard for BrainstormResult. */
export function isBrainstormResult(v: unknown): v is BrainstormResult {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.synthesis !== 'string') return false;
  if (!Array.isArray(obj.clusters)) return false;
  return obj.clusters.every((c: unknown) => {
    if (typeof c !== 'object' || c === null) return false;
    const cl = c as Record<string, unknown>;
    return typeof cl.theme === 'string' && typeof cl.insight === 'string';
  });
}
