# W7-S2: Feature Gates — Module/Gecko/Vault Access Control

> **Target AI**: Claude Code
> **Repo**: PetrAnto/ai-hub
> **Branch**: `claude/w7-s2-feature-gates-<session-id>`
> **Effort**: ~4h
> **Depends on**: W7-S1 (pricing rewrite must be merged)

---

## Context

W7-S1 created the 2-tier pricing model (Free/Pro). Now we need the enforcement layer — a centralized feature gate system that controls what each tier can access: modules, geckos, vault limits, project limits.

## Pre-Read

```bash
cat src/lib/pricing.ts       # W7-S1 output — tier definitions
cat src/lib/subscription.ts  # getUserTier() function
```

## Required Actions

### Step 1: Create `src/lib/feature-gates.ts`

```typescript
import { type Tier } from './pricing';

export const FEATURE_GATES = {
  free: {
    vaultEntries: 50,
    projects: 3,
    modules: ['chat'] as const,
    geckos: ['zori', 'kai', 'vex', 'razz'] as const,
    morningBrief: false,
    knowledgeGraph: false,
    collectiveIntelligence: false,
    byokVault: false,
    freeModelAccess: true,
    priorityRouting: false,
  },
  pro: {
    vaultEntries: Infinity,
    projects: Infinity,
    modules: ['chat', 'creator', 'code', 'sitmon', 'coaching'] as const,
    geckos: ['zori', 'kai', 'vex', 'razz', 'edoc', 'tach', 'omni', 'crex'] as const,
    morningBrief: true,
    knowledgeGraph: true,
    collectiveIntelligence: true,
    byokVault: true,
    freeModelAccess: true,
    priorityRouting: true,
  },
} as const;

export type ModuleId = typeof FEATURE_GATES.pro.modules[number];
export type GeckoId = typeof FEATURE_GATES.pro.geckos[number];

export function canAccessModule(tier: Tier, module: ModuleId): boolean {
  return (FEATURE_GATES[tier].modules as readonly string[]).includes(module);
}

export function canAccessGecko(tier: Tier, gecko: GeckoId): boolean {
  return (FEATURE_GATES[tier].geckos as readonly string[]).includes(gecko);
}

export function getVaultLimit(tier: Tier): number {
  return FEATURE_GATES[tier].vaultEntries;
}

export function getProjectLimit(tier: Tier): number {
  return FEATURE_GATES[tier].projects;
}

export function hasFeature(tier: Tier, feature: keyof typeof FEATURE_GATES.pro): boolean {
  return !!FEATURE_GATES[tier][feature];
}
```

### Step 2: Create `src/hooks/useFeatureGate.ts`

React hook that reads user tier from session and exposes gate checks:

```typescript
import { useSession } from 'next-auth/react';
import { canAccessModule, canAccessGecko, hasFeature, type ModuleId, type GeckoId } from '@/lib/feature-gates';

export function useFeatureGate() {
  const { data: session } = useSession();
  const tier = session?.user?.tier ?? 'free';
  
  return {
    tier,
    canAccess: (module: ModuleId) => canAccessModule(tier, module),
    canUseGecko: (gecko: GeckoId) => canAccessGecko(tier, gecko),
    has: (feature: string) => hasFeature(tier, feature as any),
    isPro: tier === 'pro',
  };
}
```

### Step 3: Wire into cockpit

Add gate checks where cockpit tabs are rendered. If a module is gated, show a locked state with upgrade CTA instead of the module content. The exact component depends on current cockpit structure — read the cockpit components first.

### Step 4: Wire into API routes

Add gate checks to vault save and project create endpoints:
- `POST /api/vault/entries` (or equivalent) — check `getVaultLimit(tier)` against current count
- `POST /api/projects` (created in W7-S5) — check `getProjectLimit(tier)` against current count
- Return 403 with `{ error: 'limit_reached', upgrade_url: '/pricing' }` when limit hit

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/lib/feature-gates.ts` | CREATE |
| `src/hooks/useFeatureGate.ts` | CREATE |
| `src/lib/feature-gates.test.ts` | CREATE |
| Cockpit tab components | MODIFY (add gate checks) |
| Vault API routes | MODIFY (add limit check) |

## Verification

```bash
npm run build
npm run test
```

## After Completion

Update SYNC_CHECKLIST files. Rewrite PROMPT_READY.md → W7-S3.

---
---
---

# W7-S3: Knowledge Flywheel — D1 Schema + Drizzle Types

> **Target AI**: Claude Code
> **Repo**: PetrAnto/ai-hub
> **Branch**: `claude/w7-s3-flywheel-schema-<session-id>`
> **Effort**: ~5h
> **Spec**: `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.1.md` §6
> **Independent** — can run in parallel with W7-S1

---

## Context

The Knowledge Flywheel needs 4 new D1 tables and column additions to 2 existing tables. This sprint creates the schema foundation — pure database work, no application logic.

## Pre-Read

```bash
cat src/lib/schema.ts    # Current Drizzle schema — understand table patterns
ls drizzle/migrations/   # See existing migration naming convention
```

## Required Actions

### Step 1: Create D1 migrations

Follow the existing migration naming pattern. Create one migration file with all changes:

```sql
-- knowledge_captures: every learning event that produces a saved artifact
CREATE TABLE IF NOT EXISTS knowledge_captures (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,           -- 'chat', 'journal', 'sitmon', 'code', 'manual'
  source_id TEXT,
  target_type TEXT NOT NULL,           -- 'vault_entry', 'journal_entry', 'task'
  target_id TEXT NOT NULL,
  gecko_id TEXT,
  auto_generated INTEGER DEFAULT 0,
  embedding_vector_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_captures_user_date ON knowledge_captures(user_id, created_at);
CREATE INDEX idx_captures_source ON knowledge_captures(user_id, source_type, source_id);
CREATE INDEX idx_captures_target ON knowledge_captures(target_type, target_id);

-- knowledge_edges: connections between knowledge nodes
CREATE TABLE IF NOT EXISTS knowledge_edges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,             -- 'related', 'derived_from', 'contradicts', 'supports', 'supersedes'
  confidence REAL DEFAULT 1.0,
  gecko_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_edges_user ON knowledge_edges(user_id);
CREATE INDEX idx_edges_source ON knowledge_edges(source_type, source_id);
CREATE INDEX idx_edges_target ON knowledge_edges(target_type, target_id);
CREATE UNIQUE INDEX idx_edges_pair ON knowledge_edges(user_id, source_type, source_id, target_type, target_id);

-- knowledge_reuses: every time a saved artifact is injected into a new context
CREATE TABLE IF NOT EXISTS knowledge_reuses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  knowledge_type TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  context_type TEXT NOT NULL,
  context_id TEXT,
  method TEXT NOT NULL,                -- 'cis_suggestion', 'slash_command', 'morning_brief', 'manual'
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_reuses_user_date ON knowledge_reuses(user_id, created_at);
CREATE INDEX idx_reuses_knowledge ON knowledge_reuses(knowledge_type, knowledge_id);

-- morning_brief_prefs
CREATE TABLE IF NOT EXISTS morning_brief_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER DEFAULT 0,
  include_tasks INTEGER DEFAULT 1,
  include_knowledge INTEGER DEFAULT 1,
  include_sitmon INTEGER DEFAULT 1,
  preferred_gecko TEXT DEFAULT 'kai',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Extend prompt_library
ALTER TABLE prompt_library ADD COLUMN embedding_vector_id TEXT;
ALTER TABLE prompt_library ADD COLUMN reuse_count INTEGER DEFAULT 0;
ALTER TABLE prompt_library ADD COLUMN last_reused_at TEXT;
ALTER TABLE prompt_library ADD COLUMN knowledge_type TEXT DEFAULT 'prompt';

-- Extend journal_entries
ALTER TABLE journal_entries ADD COLUMN embedding_vector_id TEXT;
ALTER TABLE journal_entries ADD COLUMN knowledge_tags TEXT;
ALTER TABLE journal_entries ADD COLUMN is_til INTEGER DEFAULT 0;
```

### Step 2: Add Drizzle TypeScript schema

Add the new tables to `src/lib/schema.ts` (or create `src/lib/schema-flywheel.ts` and re-export from schema.ts). Follow existing patterns for table definitions — use `sqliteTable`, `text`, `integer`, `real` from `drizzle-orm/sqlite-core`.

See spec §6.3 for the exact Drizzle schema.

### Step 3: Create Zod validation schemas

Create `src/lib/validations/flywheel.ts` with schemas for:
- `createCaptureSchema`
- `createEdgeSchema`
- `createReuseSchema`
- `updateBriefPrefsSchema`

## Verification

```bash
npx drizzle-kit generate   # Should generate clean migration
npm run build              # TypeScript compiles
npm run test               # Existing tests still pass
```

## After Completion

Update SYNC_CHECKLIST files. Rewrite PROMPT_READY.md → W7-S4.

---
---
---

# W7-S4: Flywheel Logic — Quality Gate + GeScore v2 + Gecko Templates

> **Target AI**: Claude Code
> **Repo**: PetrAnto/ai-hub
> **Branch**: `claude/w7-s4-flywheel-logic-<session-id>`
> **Effort**: ~8h
> **Spec**: `claude-share/brainstorming/wave7/gecko-life-knowledge-flywheel-spec-v1.1.md` §2-5
> **Depends on**: W7-S3 (schema must be merged)

---

## Context

The schema is in place. Now build the application logic: the quality gate that filters which conversations are worth processing, the GeScore v2 formula, the gecko coaching templates, and the capture logging utility. All of this runs on pure TypeScript + D1 queries — NO Workers AI calls in this sprint (embeddings come later).

## Required Actions

### Step 1: Quality Gate — `src/lib/flywheel/quality-gate.ts`

Pure JS heuristic classifier (no LLM, no WASM):

```typescript
export interface QualitySignals {
  messageCount: number;
  userSignals: ('thumbs_up' | 'thanks' | 'copy' | 'save')[];
  hasCodeBlock: boolean;
  averageMessageLength: number;
}

export function shouldProcess(signals: QualitySignals): boolean {
  // Substantive if: >4 messages AND user signaled satisfaction
  if (signals.messageCount > 4 && signals.userSignals.length > 0) return true;
  // Or: >8 messages (long conversation implies engagement)
  if (signals.messageCount > 8) return true;
  // Or: contains code + >3 messages (coding session)
  if (signals.hasCodeBlock && signals.messageCount > 3) return true;
  return false;
}
```

### Step 2: GeScore v2 — `src/lib/flywheel/gescore.ts`

Four metrics computed via D1 queries (see spec §5.2-5.3):

```typescript
export interface GeScoreMetrics {
  knowledgeVelocity: number;   // 0-100
  captureRate: number;         // 0-100
  reuseRate: number;           // 0-100 (highest weight)
  connectionDensity: number;   // 0-100
}

export function computeGeScore(metrics: GeScoreMetrics): number {
  return Math.round(
    metrics.knowledgeVelocity * 0.25 +
    metrics.captureRate * 0.25 +
    metrics.reuseRate * 0.30 +
    metrics.connectionDensity * 0.20
  );
}
```

Include the D1 query functions for each metric (spec §5.3 has exact SQL).

### Step 3: Gecko Coaching Templates — `src/lib/flywheel/gecko-templates.ts`

Static template strings with variable interpolation — $0 cost:

```typescript
export const COACHING_TEMPLATES: Record<string, (vars: Record<string, any>) => string> = {
  'kai_starter': (v) => `Every knowledge journey starts with a single question. What are you curious about today?`,
  'zori_seeds': (v) => `I see seeds! ${v.velocity} new captures this week. Now let's connect them to something...`,
  // ... all templates from spec §5.4
};

export function getCoachingMessage(score: number, metrics: GeScoreMetrics): { gecko: string; message: string } {
  if (score <= 15) return { gecko: 'kai', message: COACHING_TEMPLATES.kai_starter(metrics) };
  if (score <= 35) return { gecko: 'zori', message: COACHING_TEMPLATES.zori_seeds(metrics) };
  // ... full mapping
}
```

### Step 4: GeScore API endpoint — `src/app/api/flywheel/gescore/route.ts`

```
GET /api/flywheel/gescore → { score, metrics, coaching }
```

Auth required. Returns GeScore + individual metrics + coaching message with gecko assignment.

### Step 5: Capture logging — `src/lib/flywheel/capture.ts`

Utility to log knowledge captures to D1:

```typescript
export async function logCapture(db: DrizzleDb, params: {
  userId: string;
  sourceType: 'chat' | 'journal' | 'sitmon' | 'code' | 'manual';
  sourceId?: string;
  targetType: 'vault_entry' | 'journal_entry' | 'task';
  targetId: string;
  geckoId?: string;
  autoGenerated?: boolean;
}): Promise<void>
```

### Step 6: Tests

Create `src/lib/flywheel/__tests__/` with tests for:
- Quality gate (edge cases: exactly 4 messages, signals without messages, code blocks)
- GeScore formula (boundary values, all-zero, all-max)
- Coaching template selection (score boundaries)
- Capture logging (D1 insert verification)

## Verification

```bash
npm run build
npm run test
```

## After Completion

Update SYNC_CHECKLIST files. Rewrite PROMPT_READY.md → W7-S5.

---
---
---

# W7-S5: Project System — Backend API + Zustand Store

> **Target AI**: Claude Code
> **Repo**: PetrAnto/ai-hub
> **Branch**: `claude/w7-s5-project-backend-<session-id>`
> **Effort**: ~12h
> **Spec**: `claude-share/brainstorming/wave7/project-architecture-lyra-media-spec-v1.1.md` §2
> **Independent** — can run in parallel with S1-S4

---

## Context

Projects are named containers that group work across modules. This sprint creates the database schema, 7 API endpoints, Zod validations, and the Zustand store. No UI in this sprint — that's W7-S6.

## Pre-Read

```bash
cat src/lib/schema.ts                    # Existing table patterns
cat src/app/api/user/route.ts            # Existing API route patterns (auth, edge runtime)
ls src/app/api/                          # See route structure
cat src/lib/validations/stripe.ts        # See Zod pattern
```

## Required Actions

### Step 1: D1 migrations

Create migrations for `projects` and `project_items` tables + `prompt_library.project_id` FK. See spec §2.2 for exact SQL.

### Step 2: Drizzle schema

Create `src/lib/schema-projects.ts` with `projects` and `projectItems` table definitions. Re-export from `src/lib/schema.ts`. See spec §2.3 for exact TypeScript.

### Step 3: Zod validations

Create `src/lib/validations/projects.ts` with all 6 schemas from spec §2.4:
- `createProjectSchema`
- `updateProjectSchema`
- `createProjectItemSchema`
- `transferItemSchema`
- `listProjectItemsSchema`
- Plus any additional query parameter schemas

### Step 4: API routes (7 endpoints)

All routes need: auth check (Auth.js session), Zod validation, edge runtime export, rate limiting.

| Method | Path | Handler |
|--------|------|---------|
| POST | `/api/projects` | Create project |
| GET | `/api/projects` | List user's projects (active by default) |
| GET | `/api/projects/[id]` | Get project with item counts per module |
| PATCH | `/api/projects/[id]` | Update project |
| DELETE | `/api/projects/[id]` | Soft-delete (archive) |
| POST | `/api/projects/[id]/items` | Save SkillResult as project item |
| GET | `/api/projects/[id]/items` | List items (filterable by module, status) |
| PATCH | `/api/projects/[id]/items/[itemId]` | Update item (pin, archive, rename) |
| POST | `/api/projects/[id]/items/[itemId]/transfer` | Mark as transferred + return context payload |
| DELETE | `/api/projects/[id]/items/[itemId]` | Remove item |

**Important**: Add project limit check from `feature-gates.ts` (if W7-S2 is merged) on the POST create route. If not merged yet, add a TODO comment.

### Step 5: Zustand store

Create `src/stores/project-store.ts`:

```typescript
interface ProjectStore {
  activeProjectId: string | null;
  projects: Project[];
  items: Record<string, ProjectItem[]>; // keyed by projectId
  railOpen: boolean;
  
  setActiveProject: (id: string | null) => void;
  fetchProjects: () => Promise<void>;
  fetchItems: (projectId: string) => Promise<void>;
  saveItem: (projectId: string, item: CreateProjectItemInput) => Promise<void>;
  transferItem: (projectId: string, itemId: string, targetModule: string) => Promise<void>;
  toggleRail: () => void;
}
```

### Step 6: Tests

Create API route tests covering:
- CRUD operations for projects
- CRUD operations for project items
- Auth requirement (401 without session)
- Zod validation (400 with invalid input)
- Project limit enforcement (403 when free tier hits 3 projects)
- Transfer flow (item status changes to 'transferred')

## Verification

```bash
npm run build
npm run test
```

## After Completion

Update SYNC_CHECKLIST files. Rewrite PROMPT_READY.md → W7-S6.

---
---
---

# W7-S6: Chat-Only Project UI

> **Target AI**: Claude Code (or Codex)
> **Repo**: PetrAnto/ai-hub
> **Branch**: `claude/w7-s6-chat-project-ui-<session-id>`
> **Effort**: ~6h
> **Depends on**: W7-S5 (project backend must be merged)

---

## Context

The project backend is live (schema, 7 API endpoints, Zustand store). Now add minimal UI to make projects usable from the Chat tab — no other module tabs needed yet.

## Required Actions

### Step 1: ProjectSelector — `src/components/cockpit/ProjectSelector.tsx`

Dropdown in the TopStrip (right of Storia logo):
- Shows active projects as selectable items
- "New Project" option that opens a small modal (name + optional description + icon)
- "All Projects →" link (for future project management page)
- When project selected, Zustand store updates `activeProjectId`
- Shows `📁 Project Name ▾` when a project is active, `📁 No Project ▾` when none

Design: follow existing cosmic design system — void-black background, Orbitron headers, Rajdhani body text.

### Step 2: ProjectContextCard — `src/components/chat/ProjectContextCard.tsx`

Shows above the Chat input when transferred items exist:
- Compact card: `📡 Nexus research attached — [Title] [✕ Remove] [Expand]`
- On expand: shows the item's summary and payload preview
- On remove: clears the context from the current prompt
- Multiple cards stack vertically (max 3 visible, "+N more" overflow)

### Step 3: SaveToProjectButton — `src/components/chat/SaveToProjectButton.tsx`

Shows on each AI response in Chat when a project is active:
- Small `[📌 Save to Project]` button
- On click: saves the response content as a project item via `POST /api/projects/:id/items`
- Shows success toast with item title
- sourceModule: 'chat', sourceSkill: 'spark'

### Step 4: Wire to ChatPanel

Modify `src/components/chat/ChatPanel.tsx` (or equivalent):
- Import Zustand project store
- Pass active project context to the chat API call
- Show ProjectContextCard when transferred items exist
- Show SaveToProjectButton on AI responses

## Verification

```bash
npm run build
npm run test
```

Manual verification:
- Create project from dropdown
- Send chat message, save response to project
- See project items accumulate
- Works on mobile (responsive)

## After Completion

Update SYNC_CHECKLIST files. Rewrite PROMPT_READY.md → next priority.

---
---
---

# W7-M1: Lyra Media Extension — Image + Video Briefs

> **Target AI**: Claude Code
> **Repo**: PetrAnto/moltworker
> **Branch**: `claude/w7-m1-lyra-media-<session-id>`
> **Effort**: ~11h
> **Spec**: `claude-share/brainstorming/wave7/project-architecture-lyra-media-spec-v1.1.md` §3
> **Independent** — runs in parallel with all ai-hub work

---

## Context

Moltworker Sprint 4 shipped Lyra with text-only commands (/write, /rewrite, /headline, /repurpose). This sprint adds image and video brief generation — Lyra produces structured creative briefs that ai-hub's future Creator module will execute via BYOK keys.

Lyra is the creative director, not the renderer. She produces the brief. The actual image/video generation happens on the consumer side.

## Pre-Read (mandatory)

```bash
cat claude-share/core/AI_CODE_STANDARDS.md
cat src/skills/types.ts              # SkillResult kind union
cat src/skills/lyra/handler.ts       # Existing Lyra submodes
cat src/skills/lyra/types.ts         # LyraArtifact, HeadlineResult
cat src/skills/command-map.ts        # COMMAND_SKILL_MAP
cat src/skills/renderers/telegram.ts # Existing render cases
cat src/skills/renderers/web.ts
```

## Required Actions

### Step 1: Extend SkillResult kind union

In `src/skills/types.ts`, add `'image_brief' | 'video_brief'` to the `kind` union.

### Step 2: Create `src/skills/lyra/media-types.ts`

All types from spec §3.3 and §3.4:
- `ImageBrief` interface + `isImageBrief` type guard
- `VideoBrief` interface + `isVideoBrief` type guard
- `ImageStyle` type (12 values)
- `ImagePlatform` type (14 values) + `PLATFORM_DIMENSIONS` map
- `VideoPlatform` type (8 values) + `VIDEO_PLATFORM_SPECS` map
- `VideoScript`, `VideoScene`, `ShotDescription` interfaces

### Step 3: Create `src/skills/lyra/media-prompts.ts`

System prompts from spec §3.7:
- `LYRA_IMAGE_SYSTEM_PROMPT` — creative direction for image briefs
- `LYRA_VIDEO_SYSTEM_PROMPT` — creative direction for video briefs
- `buildImagePrompt()` helper
- `buildVideoPrompt()` helper

### Step 4: Extend Lyra handler

In `src/skills/lyra/handler.ts`, add two new submodes:

```typescript
case 'image': {
  // Parse flags: --for (platform), --style (image style)
  // Call callSkillLLM with LYRA_IMAGE_SYSTEM_PROMPT
  // Parse response as ImageBrief
  // Validate with isImageBrief
  // Inject platform dimensions
  // Return { kind: 'image_brief', payload: parsed }
}

case 'video': {
  // Parse flags: --for (platform), --duration (seconds)
  // Call callSkillLLM with LYRA_VIDEO_SYSTEM_PROMPT
  // Parse response as VideoBrief
  // Validate with isVideoBrief
  // Inject platform specs
  // Return { kind: 'video_brief', payload: parsed }
}
```

### Step 5: Add commands to command map

In `src/skills/command-map.ts`:
```typescript
'/image':      { skill: 'lyra', command: 'image' },
'/imagine':    { skill: 'lyra', command: 'image' },
'/video':      { skill: 'lyra', command: 'video' },
'/storyboard': { skill: 'lyra', command: 'video' },
```

### Step 6: Extend renderers

**Telegram** (`src/skills/renderers/telegram.ts`): Add cases for `image_brief` and `video_brief` — formatted Telegram HTML from spec §3.8.

**Web** (`src/skills/renderers/web.ts`): Add JSON envelope cases.

### Step 7: Tests

Create `src/skills/lyra/__tests__/media.test.ts`:
- Type guard tests for `isImageBrief` and `isVideoBrief`
- Platform dimension map completeness
- Video platform specs completeness
- Command map routing for new commands
- Renderer output format checks
- Handler integration tests (mock LLM response → valid SkillResult)

Target: ~25 new tests.

## Verification

```bash
npm test           # All tests pass (should be ~2598+ total)
npm run typecheck  # Clean
```

## After Completion

Follow `claude-share/core/SYNC_CHECKLIST.md`:
1. Update `GLOBAL_ROADMAP.md` — add W7-M1 to Sprint 4+ section
2. Update `claude-log.md`
3. Update `WORK_STATUS.md` — add Lyra media to completed list
4. Rewrite `next_prompt.md` → W7-M2

---
---
---

# W7-M2: Moltworker Integration Tests

> **Target AI**: Claude Code
> **Repo**: PetrAnto/moltworker
> **Branch**: `claude/w7-m2-integration-tests-<session-id>`
> **Effort**: ~3h
> **Depends on**: W7-M1

---

## Required Actions

1. Create `/simulate/chat` integration tests for Lyra media commands
2. Test cross-skill render consistency (text vs image_brief vs video_brief)
3. Verify R2 prompt loading works for new media prompts

## Verification

```bash
npm test
npm run typecheck
```

---
---
---

# W7-M3: Moltworker Deploy Prep

> **Target AI**: Claude Code
> **Repo**: PetrAnto/moltworker
> **Branch**: `claude/w7-m3-deploy-prep-<session-id>`
> **Effort**: ~3h
> **Depends on**: W7-M1 + W7-M2

---

## Required Actions

1. Update `claude-share/core/GLOBAL_ROADMAP.md` with Wave 7 completion status
2. Update `claude-share/core/WORK_STATUS.md`
3. Update `claude-share/core/next_prompt.md` for post-Wave 7 tasks
4. Run `wrangler kv:namespace create nexus-cache` if not done
5. Create pre-deploy checklist

## ⚠️ DEPLOYMENT REMINDER

**Before ANY deploy, remind PetrAnto to delete R2 bucket contents first:**
https://dash.cloudflare.com/5200b896d3dfdb6de35f986ef2d7dc6b/r2/default/buckets/moltbot-data

## PetrAnto Actions (manual)

- Upload Lyra media R2 prompts to `moltbot-data/skills/lyra/`
- Verify KV namespace exists
- Delete R2 bucket contents
- Deploy
- Test via Telegram: `/image --for instagram-post create a sunset` and `/video --for instagram-reel --duration 15 product teaser`
