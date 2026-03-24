/**
 * Tests for Orchestra Mode (init/run two-mode design)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildInitPrompt,
  buildRunPrompt,
  buildRedoPrompt,
  buildOrchestraPrompt,
  parseOrchestraCommand,
  parseOrchestraResult,
  validateOrchestraResult,
  generateTaskSlug,
  loadOrchestraHistory,
  storeOrchestraTask,
  cleanupStaleTasks,
  formatOrchestraHistory,
  parseRoadmapPhases,
  resolveNextRoadmapTask,
  scoreTaskConcreteness,
  formatRoadmapStatus,
  findMatchingTasks,
  resetRoadmapTasks,
  appendOrchestraEvent,
  getRecentOrchestraEvents,
  aggregateOrchestraStats,
  getEventBasedModelScores,
  cleanupExpiredOrchestraEvents,
  LARGE_FILE_THRESHOLD_LINES,
  LARGE_FILE_THRESHOLD_KB,
  LARGE_FILE_WARNING_LINES,
  buildExecutionProfile,
  classifyComplexityTier,
  countScopeAmplifiers,
  TIER_BUDGETS,
  type ComplexityTier,
  createRuntimeRiskProfile,
  updateRuntimeRisk,
  isHighRiskFile,
  formatRuntimeRisk,
  type RuntimeRiskProfile,
  type OrchestraTask,
  type OrchestraHistory,
  type OrchestraEvent,
  type OrchestraExecutionProfile,
  type ResolvedTask,
} from './orchestra';
import { getToolsForPhase } from '../openrouter/tools';

// --- generateTaskSlug ---

describe('generateTaskSlug', () => {
  it('converts prompt to URL-safe slug', () => {
    expect(generateTaskSlug('Add dark mode toggle')).toBe('add-dark-mode-toggle');
  });

  it('removes special characters', () => {
    expect(generateTaskSlug('Fix bug #123!')).toBe('fix-bug-123');
  });

  it('truncates to 40 characters', () => {
    const longPrompt = 'This is a very long task description that exceeds forty characters easily';
    const slug = generateTaskSlug(longPrompt);
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('handles empty prompt', () => {
    expect(generateTaskSlug('')).toBe('');
  });

  it('collapses multiple spaces into single dash', () => {
    expect(generateTaskSlug('add   new   feature')).toBe('add-new-feature');
  });

  it('removes trailing dashes', () => {
    const slug = generateTaskSlug('a'.repeat(39) + ' b');
    expect(slug.endsWith('-')).toBe(false);
  });

  it('handles unicode by stripping non-ascii', () => {
    expect(generateTaskSlug('Add émoji support')).toBe('add-moji-support');
  });
});

// --- parseOrchestraCommand ---

describe('parseOrchestraCommand', () => {
  describe('init mode', () => {
    it('parses /orchestra init owner/repo description', () => {
      const result = parseOrchestraCommand(['init', 'owner/repo', 'Build', 'a', 'user', 'auth', 'system']);
      expect(result).not.toBeNull();
      expect(result!.mode).toBe('init');
      expect(result!.repo).toBe('owner/repo');
      expect(result!.prompt).toBe('Build a user auth system');
    });

    it('returns null when init has no repo', () => {
      expect(parseOrchestraCommand(['init'])).toBeNull();
    });

    it('returns null when init has no description', () => {
      expect(parseOrchestraCommand(['init', 'owner/repo'])).toBeNull();
    });

    it('returns null for invalid repo format in init', () => {
      expect(parseOrchestraCommand(['init', 'notarepo', 'do stuff'])).toBeNull();
    });
  });

  describe('run mode', () => {
    it('parses /orchestra run owner/repo (no specific task)', () => {
      const result = parseOrchestraCommand(['run', 'owner/repo']);
      expect(result).not.toBeNull();
      expect(result!.mode).toBe('run');
      expect(result!.repo).toBe('owner/repo');
      expect(result!.prompt).toBe('');
    });

    it('parses /orchestra run owner/repo with specific task', () => {
      const result = parseOrchestraCommand(['run', 'owner/repo', 'Add', 'JWT', 'auth']);
      expect(result).not.toBeNull();
      expect(result!.mode).toBe('run');
      expect(result!.repo).toBe('owner/repo');
      expect(result!.prompt).toBe('Add JWT auth');
    });

    it('returns null for invalid repo in run', () => {
      expect(parseOrchestraCommand(['run', 'bad'])).toBeNull();
    });
  });

  describe('legacy mode', () => {
    it('parses /orchestra owner/repo <prompt> as run', () => {
      const result = parseOrchestraCommand(['owner/repo', 'Add', 'health', 'check']);
      expect(result).not.toBeNull();
      expect(result!.mode).toBe('run');
      expect(result!.repo).toBe('owner/repo');
      expect(result!.prompt).toBe('Add health check');
    });

    it('returns null for missing args', () => {
      expect(parseOrchestraCommand([])).toBeNull();
      expect(parseOrchestraCommand(['owner/repo'])).toBeNull();
    });

    it('returns null for invalid repo format', () => {
      expect(parseOrchestraCommand(['notarepo', 'do something'])).toBeNull();
    });

    it('accepts repo with dots and hyphens', () => {
      const result = parseOrchestraCommand(['my-org/my.repo', 'fix it']);
      expect(result).not.toBeNull();
      expect(result!.repo).toBe('my-org/my.repo');
    });
  });
});

// --- parseOrchestraResult ---

describe('parseOrchestraResult', () => {
  it('parses valid ORCHESTRA_RESULT block', () => {
    const response = `I've completed the task.

\`\`\`
ORCHESTRA_RESULT:
branch: bot/add-health-check-deep
pr: https://github.com/owner/repo/pull/42
files: src/health.ts, src/index.ts
summary: Added health check endpoint at /health
\`\`\``;

    const result = parseOrchestraResult(response);
    expect(result).not.toBeNull();
    expect(result!.branch).toBe('bot/add-health-check-deep');
    expect(result!.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(result!.files).toEqual(['src/health.ts', 'src/index.ts']);
    expect(result!.summary).toBe('Added health check endpoint at /health');
  });

  it('returns null when no ORCHESTRA_RESULT found', () => {
    const response = 'Just a normal response without any result block.';
    expect(parseOrchestraResult(response)).toBeNull();
  });

  it('returns null when only branch and pr are empty', () => {
    const response = `ORCHESTRA_RESULT:
branch:
pr:
files:
summary: `;
    expect(parseOrchestraResult(response)).toBeNull();
  });

  it('handles single file', () => {
    const response = `ORCHESTRA_RESULT:
branch: bot/fix-bug-grok
pr: https://github.com/o/r/pull/1
files: src/fix.ts
summary: Fixed the bug`;

    const result = parseOrchestraResult(response);
    expect(result!.files).toEqual(['src/fix.ts']);
  });

  it('handles result at end of response without closing backticks', () => {
    const response = `Done!

ORCHESTRA_RESULT:
branch: bot/feature-deep
pr: https://github.com/o/r/pull/5
files: a.ts, b.ts
summary: Added feature`;

    const result = parseOrchestraResult(response);
    expect(result).not.toBeNull();
    expect(result!.branch).toBe('bot/feature-deep');
  });
});

// --- buildInitPrompt ---

describe('buildInitPrompt', () => {
  it('includes repo info', () => {
    const prompt = buildInitPrompt({ repo: 'owner/repo', modelAlias: 'deep' });
    expect(prompt).toContain('Owner: owner');
    expect(prompt).toContain('Repo: repo');
    expect(prompt).toContain('Full: owner/repo');
  });

  it('indicates INIT mode', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('Orchestra INIT Mode');
    expect(prompt).toContain('Roadmap Creation');
  });

  it('includes ROADMAP.md format template', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('ROADMAP.md');
    expect(prompt).toContain('- [ ]');
    expect(prompt).toContain('- [x]');
    expect(prompt).toContain('Phase 1');
    expect(prompt).toContain('Phase 2');
  });

  it('includes WORK_LOG.md creation instructions', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('WORK_LOG.md');
    expect(prompt).toContain('Date');
    expect(prompt).toContain('Model');
  });

  it('includes model alias in branch naming', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'grok' });
    expect(prompt).toContain('roadmap-init-grok');
  });

  it('includes roadmap file candidates to check', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('ROADMAP.md');
    expect(prompt).toContain('TODO.md');
    expect(prompt).toContain('docs/ROADMAP.md');
  });

  it('includes ORCHESTRA_RESULT report format', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('ORCHESTRA_RESULT:');
    expect(prompt).toContain('branch:');
    expect(prompt).toContain('pr:');
    expect(prompt).toContain('files:');
    expect(prompt).toContain('summary:');
  });
});

// --- buildRunPrompt ---

describe('buildRunPrompt', () => {
  it('includes repo info', () => {
    const prompt = buildRunPrompt({ repo: 'owner/repo', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('owner/repo');
    expect(prompt).toContain('owner');
    expect(prompt).toContain('repo');
  });

  it('indicates RUN mode', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('Orchestra RUN Mode');
  });

  it('includes roadmap reading instructions', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('READ ROADMAP');
    expect(prompt).toContain('ROADMAP.md');
    expect(prompt).toContain('WORK_LOG.md');
  });

  it('includes auto-pick next task when no specific task', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('NEXT uncompleted task');
    expect(prompt).toContain('- [ ]');
  });

  it('includes specific task instructions when provided', () => {
    const prompt = buildRunPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      specificTask: 'Add JWT auth middleware',
    });
    expect(prompt).toContain('SPECIFIC task');
    expect(prompt).toContain('Add JWT auth middleware');
  });

  it('includes roadmap update instructions', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('UPDATE ROADMAP');
    expect(prompt).toContain('- [ ]');
    expect(prompt).toContain('- [x]');
    expect(prompt).toContain('APPEND');
  });

  it('includes model alias in branch naming', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'grok', previousTasks: [] });
    expect(prompt).toContain('{task-slug}-grok');
  });

  it('includes previous task history when available', () => {
    const previousTasks: OrchestraTask[] = [
      {
        taskId: 'orch-1',
        timestamp: Date.now() - 3600000,
        modelAlias: 'deep',
        repo: 'o/r',
        mode: 'run',
        prompt: 'Add login page',
        branchName: 'bot/add-login-page-deep',
        prUrl: 'https://github.com/o/r/pull/1',
        status: 'completed',
        filesChanged: ['src/login.ts'],
        summary: 'Created login page component',
      },
    ];

    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks });
    expect(prompt).toContain('Recent Orchestra History');
    expect(prompt).toContain('Add login page');
    expect(prompt).toContain('pull/1');
  });

  it('omits history section when no previous tasks', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).not.toContain('Recent Orchestra History');
  });

  it('includes ORCHESTRA_RESULT report format', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('ORCHESTRA_RESULT:');
  });

  it('includes refactor task interpretation guardrail', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('REFACTOR TASK INTERPRETATION');
    expect(prompt).toContain('CREATE');
    expect(prompt).toContain('DELETE');
    expect(prompt).toContain('NEVER assume deletion will happen in a later task');
    expect(prompt).toContain('function/const/component name');
  });

  it('uses executionBrief in system prompt when provided', () => {
    const brief = 'Phase: Refactoring\nPrimary task: Step 7: Add collapsible sections\n\nSub-steps:\n- Modify Section component';
    const prompt = buildRunPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      executionBrief: brief,
    });
    // Brief should appear in the system prompt
    expect(prompt).toContain('PRE-RESOLVED');
    expect(prompt).toContain('Step 7: Add collapsible sections');
    expect(prompt).toContain('Modify Section component');
    // Should NOT contain bare specificTask instructions
    expect(prompt).not.toContain('SPECIFIC task');
    expect(prompt).not.toContain('NEXT uncompleted task');
  });

  it('executionBrief overrides specificTask', () => {
    const prompt = buildRunPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      specificTask: 'Some old task',
      executionBrief: 'Phase: Work\nPrimary task: Better task',
    });
    // Brief takes precedence
    expect(prompt).toContain('Better task');
    // specificTask should NOT appear in the prompt since brief overrides it
    expect(prompt).toContain('PRE-RESOLVED');
  });
});

// --- F.22: Profile enforcement tests ---

describe('promptTierOverride enforcement (F.22)', () => {
  // buildRunPrompt selects minimal/standard/full based on model intelligence.
  // promptTierOverride from the execution profile should take precedence.

  it('uses promptTierOverride=minimal even for strong model', () => {
    // 'deep' would normally get 'full' tier, but override forces minimal
    const prompt = buildRunPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      promptTierOverride: 'minimal',
    });
    // Minimal prompt is shorter and has different structure
    // It should NOT contain the full prompt's "CRITICAL RULES" header
    expect(prompt).not.toContain('CRITICAL RULES');
    // It should contain the minimal prompt's simpler header
    expect(prompt).toContain('Orchestra RUN');
  });

  it('uses promptTierOverride=full even for weak model', () => {
    // 'trinity' is a weak/free model that would normally get minimal tier
    const prompt = buildRunPrompt({
      repo: 'o/r',
      modelAlias: 'trinity',
      previousTasks: [],
      promptTierOverride: 'full',
    });
    // Full prompt has "CRITICAL RULES" and "Recent Orchestra History" section format
    expect(prompt).toContain('CRITICAL RULES');
    expect(prompt).toContain('Orchestra RUN Mode');
  });

  it('falls back to model-based tier when no override', () => {
    // Without override, getPromptTier(modelAlias) determines the tier
    const prompt = buildRunPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      // no promptTierOverride
    });
    // 'deep' is a paid model → should get full tier by default
    expect(prompt).toContain('Orchestra RUN');
  });

  it('promptTierOverride=standard selects standard prompt', () => {
    const prompt = buildRunPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [{
        taskId: 't1', prompt: 'Previous task', status: 'completed',
        repo: 'o/r', branchName: 'b1', timestamp: 0,
        modelAlias: 'deep', mode: 'run', filesChanged: [],
      }],
      promptTierOverride: 'standard',
    });
    // Standard prompt has "Recent History" (not "Recent Orchestra History")
    expect(prompt).toContain('Recent History');
    expect(prompt).not.toContain('Recent Orchestra History');
  });
});

describe('sandbox tool-level gating (F.22)', () => {
  // Tests the logic chain: execution profile → ToolCapabilities → tool set.
  // The DO sets toolCaps.sandbox = !!sandbox && profileAllowsSandbox.
  // When profile says requiresSandbox=false, sandbox_exec should be absent.

  it('sandbox_exec present when profile allows sandbox', () => {
    // Simulates: sandbox available AND profile.requiresSandbox=true
    const profileAllowsSandbox = true;
    const toolCaps = { browser: false, sandbox: true && profileAllowsSandbox };
    const tools = getToolsForPhase('work', toolCaps);
    expect(tools.find(t => t.function.name === 'sandbox_exec')).toBeDefined();
  });

  it('sandbox_exec absent when profile disallows sandbox', () => {
    // Simulates: sandbox available BUT profile.requiresSandbox=false
    const profileAllowsSandbox = false;
    const toolCaps = { browser: false, sandbox: true && profileAllowsSandbox };
    const tools = getToolsForPhase('work', toolCaps);
    expect(tools.find(t => t.function.name === 'sandbox_exec')).toBeUndefined();
  });

  it('sandbox_exec absent when sandbox binding unavailable regardless of profile', () => {
    // Simulates: no sandbox binding (!!sandbox = false)
    const profileAllowsSandbox = true;
    const toolCaps = { browser: false, sandbox: false && profileAllowsSandbox };
    const tools = getToolsForPhase('work', toolCaps);
    expect(tools.find(t => t.function.name === 'sandbox_exec')).toBeUndefined();
  });

  it('profile requiresSandbox=false for simple+concrete tasks', () => {
    // Simple, concrete task with no ambiguity should disable sandbox
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Update README with new badges', concreteScore: 8, ambiguity: 'none' }),
      'claude',
    );
    expect(profile.intent.isSimple).toBe(true);
    expect(profile.bounds.requiresSandbox).toBe(false);

    // This profile would cause sandbox_exec to be removed from tool set
    const toolCaps = { browser: false, sandbox: true && profile.bounds.requiresSandbox };
    const tools = getToolsForPhase('work', toolCaps);
    expect(tools.find(t => t.function.name === 'sandbox_exec')).toBeUndefined();
  });

  it('profile requiresSandbox=true for complex tasks', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Refactor auth module with new JWT middleware', concreteScore: 5 }),
      'claude',
    );
    expect(profile.bounds.requiresSandbox).toBe(true);

    const toolCaps = { browser: false, sandbox: true && profile.bounds.requiresSandbox };
    const tools = getToolsForPhase('work', toolCaps);
    expect(tools.find(t => t.function.name === 'sandbox_exec')).toBeDefined();
  });
});

describe('forceEscalation enforcement (F.22)', () => {
  // When forceEscalation=true, the handler auto-upgrades to top-ranked
  // free orchestra model and recomputes the profile.

  it('heavy task on weak model triggers forceEscalation', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Refactor multi-file architecture with tests' }),
      'trinity', // weak model
    );
    expect(profile.routing.forceEscalation).toBe(true);
  });

  it('heavy task on strong model does NOT trigger forceEscalation', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Refactor multi-file architecture with tests' }),
      'claude', // strong model
    );
    expect(profile.routing.forceEscalation).toBe(false);
  });

  it('simple task on weak model does NOT trigger forceEscalation', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Update version number in README' }),
      'trinity',
    );
    expect(profile.routing.forceEscalation).toBe(false);
  });

  it('recomputed profile after escalation has different routing', () => {
    // Simulate: profile computed with weak model → forceEscalation=true
    const weakProfile = buildExecutionProfile(
      makeResolved({ title: 'Refactor auth module into separate services' }),
      'trinity',
    );
    expect(weakProfile.routing.forceEscalation).toBe(true);

    // After escalation: recompute with stronger model
    const strongProfile = buildExecutionProfile(
      makeResolved({ title: 'Refactor auth module into separate services' }),
      'flash', // stronger model
    );
    // Strong model should not need escalation
    expect(strongProfile.routing.forceEscalation).toBe(false);
    // Strong model may get a higher prompt tier
    expect(['standard', 'full']).toContain(strongProfile.routing.promptTier);
  });

  it('escalated profile promptTier feeds into buildRunPrompt', () => {
    // The key integration: after escalation, the profile's promptTier
    // is passed as promptTierOverride to buildRunPrompt
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Refactor complex module' }),
      'flash',
    );
    const prompt = buildRunPrompt({
      repo: 'o/r',
      modelAlias: 'flash',
      previousTasks: [],
      promptTierOverride: profile.routing.promptTier,
    });
    // The prompt tier from the profile should be used
    expect(prompt).toContain('Orchestra RUN');
  });
});

// --- Integration: end-to-end resolver → prompt pipeline ---

describe('execution brief integration (resolver → buildRunPrompt)', () => {
  const roadmap = `### Phase 1: Refactoring
- [x] Step 1: Extract utility functions — create \`src/utils.js\`
- [x] Step 2: Extract destination data
- [ ] Step 3: Extract UI atoms — create \`src/components/UIAtoms.jsx\`
  - [ ] Create the new file with the extracted code
  - [ ] Add the import to \`App.jsx\``;

  it('resolved executionBrief contains phase, task, children, and completed context', () => {
    const phases = parseRoadmapPhases(roadmap);
    const resolved = resolveNextRoadmapTask(phases);

    expect(resolved).not.toBeNull();
    expect(resolved!.executionBrief).toContain('Phase: Refactoring');
    expect(resolved!.executionBrief).toContain('Primary task:');
    expect(resolved!.executionBrief).toContain('Extract UI atoms');
    expect(resolved!.executionBrief).toContain('Sub-steps to complete:');
    expect(resolved!.executionBrief).toContain('Already completed');
    expect(resolved!.executionBrief).toContain('Step 1: Extract utility functions');
  });

  it('resolved executionBrief appears in system prompt via buildRunPrompt', () => {
    const phases = parseRoadmapPhases(roadmap);
    const resolved = resolveNextRoadmapTask(phases);

    const prompt = buildRunPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      executionBrief: resolved!.executionBrief,
    });

    // Brief should be in the system prompt (not just user message)
    expect(prompt).toContain('PRE-RESOLVED');
    expect(prompt).toContain('Extract UI atoms');
    expect(prompt).toContain('Sub-steps to complete:');
    expect(prompt).toContain('Already completed');
    // specificTask path should NOT be triggered
    expect(prompt).not.toContain('SPECIFIC task');
    expect(prompt).not.toContain('NEXT uncompleted task');
  });

  it('findMatchingTasks and resetRoadmapTasks use same AST as resolver', () => {
    // The child task "Add the import to App.jsx" should be findable
    const matches = findMatchingTasks(roadmap, 'import');
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toContain('Add the import');

    // Reset should work using the lineIndex from the parsed AST
    const result = resetRoadmapTasks(roadmap, 'Step 1');
    expect(result.resetCount).toBe(1);
    expect(result.taskNames[0]).toContain('Extract utility functions');
  });
});

// --- Large file health check constants ---

describe('LARGE_FILE_THRESHOLD constants', () => {
  it('exports line threshold', () => {
    expect(LARGE_FILE_THRESHOLD_LINES).toBe(500);
  });

  it('exports KB threshold', () => {
    expect(LARGE_FILE_THRESHOLD_KB).toBe(30);
  });

  it('exports warning threshold below line threshold', () => {
    expect(LARGE_FILE_WARNING_LINES).toBe(400);
    expect(LARGE_FILE_WARNING_LINES).toBeLessThan(LARGE_FILE_THRESHOLD_LINES);
  });
});

// --- Repo health check in prompts ---

describe('repo health check in buildRunPrompt', () => {
  it('includes health check step', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('split');
  });

  it('references the warning threshold (not the hard limit)', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain(`${LARGE_FILE_WARNING_LINES} lines`);
  });

  it('instructs to split large files', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('split');
  });

  it('instructs to use github_create_pr and github_push_files for splitting', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('github_create_pr');
    expect(prompt).toContain('github_push_files');
    expect(prompt).toContain('identifier check allows splits');
  });

  it('file splitting guidance is in Step 4', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    const step4Idx = prompt.indexOf('## Step 4:');
    const splitIdx = prompt.indexOf('FILE SPLITTING');
    const step5Idx = prompt.indexOf('## Step 5:');
    expect(step4Idx).toBeLessThan(splitIdx);
    expect(splitIdx).toBeLessThan(step5Idx);
  });
});

describe('repo health check in buildInitPrompt', () => {
  it('includes large file flagging step', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('FLAG LARGE FILES');
  });

  it('references the line threshold', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain(`${LARGE_FILE_THRESHOLD_LINES} lines`);
  });

  it('instructs to add split tasks to roadmap', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('Large file splitting');
    expect(prompt).toContain('extraction tasks EARLY');
  });

  it('includes warning zone guidance', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('WARNING ZONE');
    expect(prompt).toContain(`${LARGE_FILE_WARNING_LINES}`);
  });

  it('instructs to use github_create_pr for splitting', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('github_create_pr');
    expect(prompt).toContain('SINGLE PR call');
  });

  it('includes atomic refactoring rules to prevent dead code', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('ATOMIC REFACTORING TASKS');
    expect(prompt).toContain('create + import + DELETE');
    expect(prompt).toContain('Use the word "DELETE"');
    expect(prompt).toContain('verification gate');
  });

  it('anchors on function names over line numbers', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('Anchor on function/const/component NAMES');
  });

  it('includes topological extraction order rule', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('topological order');
    expect(prompt).toContain('leaf dependencies first');
  });

  it('large file step comes before analysis step', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    const flagIdx = prompt.indexOf('### Step 1.5: FLAG LARGE FILES');
    const analyzeIdx = prompt.indexOf('### Step 2: ANALYZE THE PROJECT REQUEST');
    expect(flagIdx).toBeLessThan(analyzeIdx);
  });

  it('includes hard tool call limit for init', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('budget of 12 total tool calls');
  });

  it('includes fast-path for copy tasks', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('just find it and copy it');
  });

  it('includes one extraction per task rule', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('One extraction per task');
  });

  it('includes cross-file reference rule', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'deep' });
    expect(prompt).toContain('cross-file references');
  });
});

describe('repo health check in buildRedoPrompt', () => {
  it('includes health check step', () => {
    const prompt = buildRedoPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      taskToRedo: 'fix auth',
    });
    expect(prompt).toContain('REPO HEALTH CHECK');
  });

  it('references the warning threshold', () => {
    const prompt = buildRedoPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      taskToRedo: 'fix auth',
    });
    expect(prompt).toContain(`${LARGE_FILE_WARNING_LINES} lines`);
  });

  it('instructs to use github_create_pr for splitting', () => {
    const prompt = buildRedoPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      taskToRedo: 'fix auth',
    });
    expect(prompt).toContain('github_create_pr');
    expect(prompt).toContain('identifier check allows splits');
  });

  it('health check comes between Step 2 and Step 3', () => {
    const prompt = buildRedoPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      taskToRedo: 'fix auth',
    });
    const step2Idx = prompt.indexOf('## Step 2: UNDERSTAND CURRENT STATE');
    const healthIdx = prompt.indexOf('## Step 2.5: REPO HEALTH CHECK');
    const step3Idx = prompt.indexOf('## Step 3: RE-IMPLEMENT');
    expect(step2Idx).toBeLessThan(healthIdx);
    expect(healthIdx).toBeLessThan(step3Idx);
  });
});

// --- buildOrchestraPrompt (backward compat) ---

describe('buildOrchestraPrompt', () => {
  it('delegates to buildRunPrompt', () => {
    const params = { repo: 'o/r', modelAlias: 'deep', previousTasks: [] as OrchestraTask[] };
    expect(buildOrchestraPrompt(params)).toBe(buildRunPrompt(params));
  });
});

// --- storeOrchestraTask & loadOrchestraHistory ---

describe('storeOrchestraTask', () => {
  let mockBucket: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockBucket = {
      get: vi.fn(),
      put: vi.fn().mockResolvedValue(undefined),
    };
  });

  const makeTask = (taskId: string, mode: 'init' | 'run' | 'redo' | 'do' = 'run', status: 'started' | 'completed' | 'failed' = 'completed'): OrchestraTask => ({
    taskId,
    timestamp: Date.now(),
    modelAlias: 'deep',
    repo: 'owner/repo',
    mode,
    prompt: `Task ${taskId}`,
    branchName: `bot/${taskId}-deep`,
    status,
    filesChanged: ['src/file.ts'],
    summary: `Did ${taskId}`,
  });

  it('creates new history when none exists', async () => {
    mockBucket.get.mockResolvedValue(null);

    await storeOrchestraTask(mockBucket as unknown as R2Bucket, 'user1', makeTask('t1'));

    expect(mockBucket.put).toHaveBeenCalledOnce();
    const [key, data] = mockBucket.put.mock.calls[0];
    expect(key).toBe('orchestra/user1/history.json');

    const parsed = JSON.parse(data as string);
    expect(parsed.userId).toBe('user1');
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].taskId).toBe('t1');
  });

  it('appends to existing history', async () => {
    const existing: OrchestraHistory = {
      userId: 'user1',
      tasks: [makeTask('t1')],
      updatedAt: Date.now(),
    };

    mockBucket.get.mockResolvedValue({
      json: () => Promise.resolve(existing),
    });

    await storeOrchestraTask(mockBucket as unknown as R2Bucket, 'user1', makeTask('t2'));

    const [, data] = mockBucket.put.mock.calls[0];
    const parsed = JSON.parse(data as string);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[1].taskId).toBe('t2');
  });

  it('caps history at 30 entries', async () => {
    const existing: OrchestraHistory = {
      userId: 'user1',
      tasks: Array.from({ length: 30 }, (_, i) => makeTask(`t${i}`)),
      updatedAt: Date.now(),
    };

    mockBucket.get.mockResolvedValue({
      json: () => Promise.resolve(existing),
    });

    await storeOrchestraTask(mockBucket as unknown as R2Bucket, 'user1', makeTask('t30'));

    const [, data] = mockBucket.put.mock.calls[0];
    const parsed = JSON.parse(data as string);
    expect(parsed.tasks).toHaveLength(30);
    expect(parsed.tasks[29].taskId).toBe('t30');
    expect(parsed.tasks[0].taskId).toBe('t1');
  });

  it('handles R2 read error gracefully', async () => {
    mockBucket.get.mockRejectedValue(new Error('R2 error'));

    await storeOrchestraTask(mockBucket as unknown as R2Bucket, 'user1', makeTask('t1'));

    expect(mockBucket.put).toHaveBeenCalledOnce();
  });

  it('preserves mode field', async () => {
    mockBucket.get.mockResolvedValue(null);

    await storeOrchestraTask(mockBucket as unknown as R2Bucket, 'user1', makeTask('t1', 'init'));

    const [, data] = mockBucket.put.mock.calls[0];
    const parsed = JSON.parse(data as string);
    expect(parsed.tasks[0].mode).toBe('init');
  });

  it('persists durationMs for completed tasks', async () => {
    mockBucket.get.mockResolvedValue(null);

    await storeOrchestraTask(mockBucket as unknown as R2Bucket, 'user1', {
      ...makeTask('t-complete', 'run', 'completed'),
      durationMs: 123456,
    });

    const [, data] = mockBucket.put.mock.calls[0];
    const parsed = JSON.parse(data as string);
    expect(parsed.tasks[0].durationMs).toBe(123456);
  });

  it('persists durationMs for failed tasks', async () => {
    mockBucket.get.mockResolvedValue(null);

    await storeOrchestraTask(mockBucket as unknown as R2Bucket, 'user1', {
      ...makeTask('t-failed', 'run', 'failed'),
      durationMs: 9876,
    });

    const [, data] = mockBucket.put.mock.calls[0];
    const parsed = JSON.parse(data as string);
    expect(parsed.tasks[0].status).toBe('failed');
    expect(parsed.tasks[0].durationMs).toBe(9876);
  });
});

describe('loadOrchestraHistory', () => {
  it('returns null when no history exists', async () => {
    const mockBucket = { get: vi.fn().mockResolvedValue(null) };

    const result = await loadOrchestraHistory(mockBucket as unknown as R2Bucket, 'user1');
    expect(result).toBeNull();
  });

  it('returns parsed history', async () => {
    const history: OrchestraHistory = {
      userId: 'user1',
      tasks: [{
        taskId: 'orch-1',
        timestamp: Date.now(),
        modelAlias: 'deep',
        repo: 'o/r',
        mode: 'run',
        prompt: 'Add feature',
        branchName: 'bot/add-feature-deep',
        status: 'completed',
        filesChanged: ['a.ts'],
      }],
      updatedAt: Date.now(),
    };

    const mockBucket = {
      get: vi.fn().mockResolvedValue({
        json: () => Promise.resolve(history),
      }),
    };

    const result = await loadOrchestraHistory(mockBucket as unknown as R2Bucket, 'user1');
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(1);
  });

  it('returns null on R2 error', async () => {
    const mockBucket = {
      get: vi.fn().mockRejectedValue(new Error('R2 down')),
    };

    const result = await loadOrchestraHistory(mockBucket as unknown as R2Bucket, 'user1');
    expect(result).toBeNull();
  });

  it('reads from correct R2 key', async () => {
    const mockBucket = { get: vi.fn().mockResolvedValue(null) };

    await loadOrchestraHistory(mockBucket as unknown as R2Bucket, '12345');

    expect(mockBucket.get).toHaveBeenCalledWith('orchestra/12345/history.json');
  });
});

// --- formatOrchestraHistory ---

describe('formatOrchestraHistory', () => {
  it('shows usage hint for null history', () => {
    const result = formatOrchestraHistory(null);
    expect(result).toContain('No orchestra tasks');
    expect(result).toContain('/orchestra init');
    expect(result).toContain('/orchestra run');
  });

  it('shows usage hint for empty history', () => {
    const result = formatOrchestraHistory({
      userId: 'user1',
      tasks: [],
      updatedAt: Date.now(),
    });
    expect(result).toContain('No orchestra tasks');
  });

  it('formats completed run task', () => {
    const history: OrchestraHistory = {
      userId: 'user1',
      tasks: [{
        taskId: 'orch-1',
        timestamp: Date.now(),
        modelAlias: 'deep',
        repo: 'owner/repo',
        mode: 'run',
        prompt: 'Add health check endpoint',
        branchName: 'bot/add-health-check-deep',
        prUrl: 'https://github.com/o/r/pull/1',
        status: 'completed',
        filesChanged: ['src/health.ts'],
        summary: 'Added /health endpoint',
      }],
      updatedAt: Date.now(),
    };

    const result = formatOrchestraHistory(history);
    expect(result).toContain('Orchestra Task History');
    expect(result).toContain('Add health check endpoint');
    expect(result).toContain('/deep');
    expect(result).toContain('bot/add-health-check-deep');
    expect(result).toContain('pull/1');
  });

  it('tags init tasks with [INIT]', () => {
    const history: OrchestraHistory = {
      userId: 'user1',
      tasks: [{
        taskId: 'orch-1',
        timestamp: Date.now(),
        modelAlias: 'deep',
        repo: 'o/r',
        mode: 'init',
        prompt: 'Build user auth system',
        branchName: 'bot/roadmap-init-deep',
        status: 'completed',
        filesChanged: ['ROADMAP.md', 'WORK_LOG.md'],
      }],
      updatedAt: Date.now(),
    };

    const result = formatOrchestraHistory(history);
    expect(result).toContain('[INIT]');
  });

  it('formats failed task with error icon', () => {
    const history: OrchestraHistory = {
      userId: 'user1',
      tasks: [{
        taskId: 'orch-1',
        timestamp: Date.now(),
        modelAlias: 'grok',
        repo: 'o/r',
        mode: 'run',
        prompt: 'Broken task',
        branchName: 'bot/broken-grok',
        status: 'failed',
        filesChanged: [],
      }],
      updatedAt: Date.now(),
    };

    const result = formatOrchestraHistory(history);
    expect(result).toContain('❌');
  });

  it('limits display to last 10 tasks', () => {
    const tasks: OrchestraTask[] = Array.from({ length: 15 }, (_, i) => ({
      taskId: `orch-${i}`,
      timestamp: Date.now() - (15 - i) * 60000,
      modelAlias: 'deep',
      repo: 'o/r',
      mode: 'run' as const,
      prompt: `Task ${i}`,
      branchName: `bot/task-${i}-deep`,
      status: 'completed' as const,
      filesChanged: [],
    }));

    const result = formatOrchestraHistory({
      userId: 'user1',
      tasks,
      updatedAt: Date.now(),
    });

    expect(result).not.toContain('Task 0');
    expect(result).not.toContain('Task 4');
    expect(result).toContain('Task 5');
    expect(result).toContain('Task 14');
  });
});

// --- parseRoadmapPhases ---

describe('parseRoadmapPhases', () => {
  const sampleRoadmap = `# Project Roadmap

> Auto-generated by Orchestra Mode

## Phases

### Phase 1: Foundation
- [x] **Task 1.1**: Set up project structure
  - Description: Initialize the repo
- [ ] **Task 1.2**: Add CI pipeline
  - Description: GitHub Actions workflow

### Phase 2: Core Features
- [ ] **Task 2.1**: Add user authentication
  - Files: src/auth.ts
- [ ] **Task 2.2**: Add database models
  - Files: src/models/

## Notes
Some notes here.`;

  it('parses phases with correct names', () => {
    const phases = parseRoadmapPhases(sampleRoadmap);
    expect(phases).toHaveLength(2);
    expect(phases[0].name).toBe('Foundation');
    expect(phases[1].name).toBe('Core Features');
  });

  it('parses task completion status', () => {
    const phases = parseRoadmapPhases(sampleRoadmap);
    expect(phases[0].tasks).toHaveLength(2);
    expect(phases[0].tasks[0].done).toBe(true);
    expect(phases[0].tasks[1].done).toBe(false);
  });

  it('extracts task titles', () => {
    const phases = parseRoadmapPhases(sampleRoadmap);
    expect(phases[0].tasks[0].title).toBe('Set up project structure');
    expect(phases[1].tasks[0].title).toBe('Add user authentication');
  });

  it('handles tasks without bold formatting', () => {
    const content = `### Phase 1: Setup
- [x] Install dependencies
- [ ] Configure linter`;

    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(1);
    expect(phases[0].tasks).toHaveLength(2);
    expect(phases[0].tasks[0].title).toBe('Install dependencies');
    expect(phases[0].tasks[0].done).toBe(true);
    expect(phases[0].tasks[1].title).toBe('Configure linter');
  });

  it('handles uppercase X checkmarks', () => {
    const content = `### Phase 1: Done
- [X] Task with uppercase X`;

    const phases = parseRoadmapPhases(content);
    expect(phases[0].tasks[0].done).toBe(true);
  });

  it('returns empty array for content without phases', () => {
    const phases = parseRoadmapPhases('Just some text without any phases');
    expect(phases).toHaveLength(0);
  });

  it('handles phase headers without "Phase N:" prefix', () => {
    const content = `### Setup and Init
- [ ] Do something

### Testing
- [x] Write tests`;

    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(2);
    expect(phases[0].name).toBe('Setup and Init');
    expect(phases[1].name).toBe('Testing');
  });

  it('captures orphan tasks before first phase into default "Tasks" phase', () => {
    const content = `# Roadmap
- [ ] Orphan task

### Phase 1: Real
- [ ] Real task`;

    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(2);
    expect(phases[0].name).toBe('Tasks');
    expect(phases[0].tasks).toHaveLength(1);
    expect(phases[0].tasks[0].title).toBe('Orphan task');
    expect(phases[1].tasks).toHaveLength(1);
    expect(phases[1].tasks[0].title).toBe('Real task');
  });
});

// --- formatRoadmapStatus ---

describe('formatRoadmapStatus', () => {
  it('shows progress for structured roadmap', () => {
    const content = `### Phase 1: Setup
- [x] **Task 1.1**: Init project
- [x] **Task 1.2**: Add CI

### Phase 2: Features
- [ ] **Task 2.1**: Add auth
- [ ] **Task 2.2**: Add API`;

    const result = formatRoadmapStatus(content, 'owner/repo', 'ROADMAP.md');
    expect(result).toContain('owner/repo');
    expect(result).toContain('ROADMAP.md');
    expect(result).toContain('Setup');
    expect(result).toContain('Features');
    expect(result).toContain('2/4');  // overall progress
    expect(result).toContain('50%');
  });

  it('shows completed phase with check icon', () => {
    const content = `### Phase 1: Done
- [x] Task A
- [x] Task B`;

    const result = formatRoadmapStatus(content, 'o/r', 'ROADMAP.md');
    expect(result).toContain('✅ Done (2/2)');
  });

  it('shows in-progress phase with hammer icon', () => {
    const content = `### Phase 1: WIP
- [x] Done task
- [ ] Pending task`;

    const result = formatRoadmapStatus(content, 'o/r', 'ROADMAP.md');
    expect(result).toContain('🔨 WIP (1/2)');
  });

  it('shows pending phase with hourglass icon', () => {
    const content = `### Phase 1: Not Started
- [ ] Task A
- [ ] Task B`;

    const result = formatRoadmapStatus(content, 'o/r', 'ROADMAP.md');
    expect(result).toContain('⏳ Not Started (0/2)');
  });

  it('falls back to raw content when no phases found', () => {
    const content = 'Just a simple TODO list without phases.';
    const result = formatRoadmapStatus(content, 'o/r', 'ROADMAP.md');
    expect(result).toContain('Just a simple TODO list');
    expect(result).toContain('o/r');
  });

  it('shows progress bar', () => {
    const content = `### Phase 1: Half
- [x] A
- [ ] B`;

    const result = formatRoadmapStatus(content, 'o/r', 'ROADMAP.md');
    expect(result).toContain('█');
    expect(result).toContain('░');
  });

  it('truncates raw content fallback if too long', () => {
    const content = 'A'.repeat(4000);
    const result = formatRoadmapStatus(content, 'o/r', 'ROADMAP.md');
    expect(result).toContain('[Truncated]');
    expect(result.length).toBeLessThan(4000);
  });
});

// --- findMatchingTasks ---

describe('findMatchingTasks', () => {
  const roadmap = `### Phase 1: Setup
- [x] **Task 1.1**: Initialize project structure
- [x] **Task 1.2**: Add CI pipeline

### Phase 2: Core
- [ ] **Task 2.1**: Add user authentication
- [x] **Task 2.2**: Add database models
- [ ] **Task 2.3**: Add API endpoints`;

  it('finds tasks by title substring', () => {
    const matches = findMatchingTasks(roadmap, 'auth');
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('Add user authentication');
    expect(matches[0].done).toBe(false);
    expect(matches[0].phase).toBe('Core');
  });

  it('finds tasks case-insensitively', () => {
    const matches = findMatchingTasks(roadmap, 'DATABASE');
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('Add database models');
  });

  it('finds all tasks in a phase', () => {
    const matches = findMatchingTasks(roadmap, 'Phase 2');
    expect(matches).toHaveLength(3);
    expect(matches[0].title).toBe('Add user authentication');
    expect(matches[1].title).toBe('Add database models');
    expect(matches[2].title).toBe('Add API endpoints');
  });

  it('returns empty array for no matches', () => {
    const matches = findMatchingTasks(roadmap, 'nonexistent');
    expect(matches).toHaveLength(0);
  });

  it('matches task number in line', () => {
    const matches = findMatchingTasks(roadmap, 'Task 1.1');
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('Initialize project structure');
  });

  it('includes done status', () => {
    const matches = findMatchingTasks(roadmap, 'Phase 1');
    expect(matches).toHaveLength(2);
    expect(matches[0].done).toBe(true);
    expect(matches[1].done).toBe(true);
  });

  it('tracks correct phase names', () => {
    const matches = findMatchingTasks(roadmap, 'API');
    expect(matches).toHaveLength(1);
    expect(matches[0].phase).toBe('Core');
  });

  it('finds indented child tasks (uses parsed AST, not just top-level regex)', () => {
    const roadmapWithChildren = `### Phase 1: Refactoring
- [x] Step 1: Extract utils
  - [x] Create \`src/utils.js\`
  - [ ] Add import to \`App.jsx\`
- [ ] Step 2: Extract data`;

    const matches = findMatchingTasks(roadmapWithChildren, 'import');
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toContain('Add import');
    expect(matches[0].done).toBe(false);
  });

  it('returns correct lineIndex for reset compatibility', () => {
    const matches = findMatchingTasks(roadmap, 'Initialize');
    expect(matches).toHaveLength(1);
    // "- [x] **Task 1.1**: Initialize project structure" is on a specific line
    expect(typeof matches[0].lineIndex).toBe('number');
    expect(matches[0].lineIndex).toBeGreaterThanOrEqual(0);
  });
});

// --- resetRoadmapTasks ---

describe('resetRoadmapTasks', () => {
  const roadmap = `### Phase 1: Setup
- [x] **Task 1.1**: Initialize project
- [x] **Task 1.2**: Add CI

### Phase 2: Core
- [ ] **Task 2.1**: Add auth
- [x] **Task 2.2**: Add database`;

  it('resets matching completed tasks', () => {
    const result = resetRoadmapTasks(roadmap, 'Initialize');
    expect(result.resetCount).toBe(1);
    expect(result.taskNames).toEqual(['Initialize project']);
    expect(result.modified).toContain('- [ ] **Task 1.1**: Initialize project');
  });

  it('resets all completed tasks in a phase', () => {
    const result = resetRoadmapTasks(roadmap, 'Phase 1');
    expect(result.resetCount).toBe(2);
    expect(result.taskNames).toContain('Initialize project');
    expect(result.taskNames).toContain('Add CI');
    expect(result.modified).toContain('- [ ] **Task 1.1**: Initialize project');
    expect(result.modified).toContain('- [ ] **Task 1.2**: Add CI');
  });

  it('does not reset already-pending tasks', () => {
    const result = resetRoadmapTasks(roadmap, 'auth');
    expect(result.resetCount).toBe(0);
    expect(result.taskNames).toHaveLength(0);
    expect(result.modified).toBe(roadmap);
  });

  it('preserves other lines unchanged', () => {
    const result = resetRoadmapTasks(roadmap, 'database');
    expect(result.resetCount).toBe(1);
    // Check that Phase 1 tasks are still checked
    expect(result.modified).toContain('- [x] **Task 1.1**: Initialize project');
    expect(result.modified).toContain('- [x] **Task 1.2**: Add CI');
    // Database is unchecked
    expect(result.modified).toContain('- [ ] **Task 2.2**: Add database');
  });

  it('returns zero count for no matches', () => {
    const result = resetRoadmapTasks(roadmap, 'nonexistent');
    expect(result.resetCount).toBe(0);
    expect(result.modified).toBe(roadmap);
  });
});

// --- buildRedoPrompt ---

describe('buildRedoPrompt', () => {
  it('includes redo-specific instructions', () => {
    const prompt = buildRedoPrompt({
      repo: 'owner/repo',
      modelAlias: 'deep',
      previousTasks: [],
      taskToRedo: 'Add user auth',
    });
    expect(prompt).toContain('REDO Mode');
    expect(prompt).toContain('Add user auth');
    expect(prompt).toContain('RE-DOING');
    expect(prompt).toContain('INCORRECT or INCOMPLETE');
  });

  it('includes repo info', () => {
    const prompt = buildRedoPrompt({
      repo: 'owner/repo',
      modelAlias: 'deep',
      previousTasks: [],
      taskToRedo: 'fix something',
    });
    expect(prompt).toContain('Owner: owner');
    expect(prompt).toContain('Repo: repo');
  });

  it('includes model alias in branch and PR naming', () => {
    const prompt = buildRedoPrompt({
      repo: 'o/r',
      modelAlias: 'grok',
      previousTasks: [],
      taskToRedo: 'test task',
    });
    expect(prompt).toContain('redo-{task-slug}-grok');
    expect(prompt).toContain('[grok]');
  });

  it('includes ORCHESTRA_RESULT format', () => {
    const prompt = buildRedoPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      taskToRedo: 'task',
    });
    expect(prompt).toContain('ORCHESTRA_RESULT:');
  });

  it('includes previous task history with redo warning', () => {
    const previousTasks: OrchestraTask[] = [{
      taskId: 'orch-1',
      timestamp: Date.now(),
      modelAlias: 'deep',
      repo: 'o/r',
      mode: 'run',
      prompt: 'Add auth',
      branchName: 'bot/add-auth-deep',
      status: 'completed',
      filesChanged: ['src/auth.ts'],
      summary: 'Added auth (broken)',
    }];

    const prompt = buildRedoPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks,
      taskToRedo: 'Add auth',
    });
    expect(prompt).toContain('Recent Orchestra History');
    expect(prompt).toContain('Do NOT repeat the same mistakes');
  });

  it('instructs model to uncheck task in roadmap', () => {
    const prompt = buildRedoPrompt({
      repo: 'o/r',
      modelAlias: 'deep',
      previousTasks: [],
      taskToRedo: 'something',
    });
    expect(prompt).toContain('- [x]');
    expect(prompt).toContain('- [ ]');
    expect(prompt).toContain('change it back');
  });
});

// --- Model alias in PR/commit messages ---

describe('model alias in prompts', () => {
  it('init prompt includes model in PR title', () => {
    const prompt = buildInitPrompt({ repo: 'o/r', modelAlias: 'grok' });
    expect(prompt).toContain('[grok]');
    expect(prompt).toContain('Generated by: grok');
  });

  it('run prompt includes model in PR title', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('[deep]');
    expect(prompt).toContain('Generated by: deep');
  });

  it('redo prompt includes model in PR title', () => {
    const prompt = buildRedoPrompt({ repo: 'o/r', modelAlias: 'sonnet', previousTasks: [], taskToRedo: 'x' });
    expect(prompt).toContain('[sonnet]');
    expect(prompt).toContain('Generated by: sonnet');
  });
});

describe('anti-rewrite rules in prompts', () => {
  it('run prompt includes code convention instructions', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('existing code conventions');
    expect(prompt).toContain('Do NOT regenerate entire files');
  });

  it('run prompt warns about identifier blocking', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('github_create_pr');
  });

  it('run prompt rules section includes patch action and anti-rewrite rule', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('USE "patch" ACTION');
    expect(prompt).toContain('never regenerate entire files from memory');
  });

  it('redo prompt includes surgical edit instructions', () => {
    const prompt = buildRedoPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [], taskToRedo: 'fix dark mode' });
    expect(prompt).toContain('NEVER regenerate or rewrite an entire file from scratch');
    expect(prompt).toContain('SURGICAL');
  });

  it('redo prompt rules section includes anti-rewrite rule', () => {
    const prompt = buildRedoPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [], taskToRedo: 'fix dark mode' });
    expect(prompt).toContain('NEVER regenerate entire files');
  });
});

// --- File update workflow instructions ---

describe('file update workflow in prompts', () => {
  it('run prompt includes patch action and file reading', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('patch');
    expect(prompt).toContain('github_read_file');
    expect(prompt).toContain('find');
    expect(prompt).toContain('replace');
  });

  it('run prompt explains the append workflow', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('APPEND');
  });

  it('redo prompt includes How to Edit Existing Files section with patch', () => {
    const prompt = buildRedoPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [], taskToRedo: 'fix auth' });
    expect(prompt).toContain('How to Edit Existing Files');
    expect(prompt).toContain('patch');
    expect(prompt).toContain('github_read_file');
  });

  it('patch instructions come before convention rules in run prompt', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    const patchIdx = prompt.indexOf('patch');
    const conventionIdx = prompt.indexOf('existing code conventions');
    expect(patchIdx).toBeGreaterThan(0);
    expect(conventionIdx).toBeGreaterThan(0);
    expect(patchIdx).toBeLessThan(conventionIdx);
  });
});

// --- Partial failure handling ---

describe('partial failure handling in prompts', () => {
  it('run prompt includes failure handling', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('blocked');
    expect(prompt).toContain('pr: FAILED');
  });

  it('run prompt explains how to log failures', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('WORK_LOG.md');
    expect(prompt).toContain('API errors');
  });

  it('run prompt lists failure scenarios', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    expect(prompt).toContain('API errors');
    expect(prompt).toContain('pr: FAILED');
  });

  it('failure handling is in Step 4', () => {
    const prompt = buildRunPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [] });
    const step4Idx = prompt.indexOf('## Step 4: IMPLEMENT');
    const blockedIdx = prompt.indexOf('If blocked');
    const step5Idx = prompt.indexOf('## Step 5:');
    expect(step4Idx).toBeLessThan(blockedIdx);
    expect(blockedIdx).toBeLessThan(step5Idx);
  });

  it('redo prompt includes partial failure handling', () => {
    const prompt = buildRedoPrompt({ repo: 'o/r', modelAlias: 'deep', previousTasks: [], taskToRedo: 'fix auth' });
    expect(prompt).toContain('Handle Partial Failures');
    expect(prompt).toContain('WORK_LOG.md');
    expect(prompt).toContain('partial');
  });
});

// --- validateOrchestraResult ---

describe('validateOrchestraResult', () => {
  const baseResult = {
    branch: 'bot/add-feature-grok',
    prUrl: 'https://github.com/owner/repo/pull/42',
    files: ['src/feature.ts'],
    summary: 'Added feature',
  };

  it('passes through valid result when no failure evidence', () => {
    const validated = validateOrchestraResult(baseResult, 'github_read_file returned content...');
    expect(validated.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(validated.phantomPr).toBe(false);
  });

  it('detects phantom PR when tool output shows PR NOT CREATED', () => {
    const toolOutput = '❌ PR NOT CREATED — github_create_pr FAILED.\n\nError: Destructive update blocked';
    const validated = validateOrchestraResult(baseResult, toolOutput);
    expect(validated.prUrl).toBe('');
    expect(validated.phantomPr).toBe(true);
    expect(validated.summary).toContain('PHANTOM PR');
  });

  it('detects phantom PR when tool output shows Destructive update blocked', () => {
    const toolOutput = 'Error executing github_create_pr: Destructive update blocked for "src/App.jsx"';
    const validated = validateOrchestraResult(baseResult, toolOutput);
    expect(validated.prUrl).toBe('');
    expect(validated.phantomPr).toBe(true);
  });

  it('detects phantom PR when INCOMPLETE REFACTOR in tool output', () => {
    const toolOutput = 'INCOMPLETE REFACTOR blocked: 3 new code files created but no existing code files updated.';
    const validated = validateOrchestraResult(baseResult, toolOutput);
    expect(validated.prUrl).toBe('');
    expect(validated.phantomPr).toBe(true);
  });

  it('detects phantom PR when DATA FABRICATION in tool output', () => {
    const toolOutput = 'DATA FABRICATION blocked for "src/App.jsx": only 3/20 original data values survive';
    const validated = validateOrchestraResult(baseResult, toolOutput);
    expect(validated.prUrl).toBe('');
    expect(validated.phantomPr).toBe(true);
  });

  it('does NOT flag phantom PR when failure exists but success also confirmed', () => {
    const toolOutput = [
      '❌ PR NOT CREATED — github_create_pr FAILED.\n\nError: 422 branch already exists',
      '✅ Pull Request created successfully!\n\nPR: https://github.com/owner/repo/pull/42',
    ].join('\n');
    const validated = validateOrchestraResult(baseResult, toolOutput);
    expect(validated.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(validated.phantomPr).toBe(false);
  });

  it('passes through when no PR URL claimed', () => {
    const noPrResult = { ...baseResult, prUrl: '' };
    const validated = validateOrchestraResult(noPrResult, 'some tool output');
    expect(validated.phantomPr).toBe(false);
  });

  it('preserves branch and files when detecting phantom PR', () => {
    const toolOutput = 'Full-rewrite blocked for "src/App.jsx"';
    const validated = validateOrchestraResult(baseResult, toolOutput);
    expect(validated.branch).toBe('bot/add-feature-grok');
    expect(validated.files).toEqual(['src/feature.ts']);
  });
});

// --- OrchestraTask.mode 'redo' type ---

describe('OrchestraTask redo mode', () => {
  it('accepts redo as a valid mode', () => {
    const task: OrchestraTask = {
      taskId: 'orch-1',
      timestamp: Date.now(),
      modelAlias: 'deep',
      repo: 'o/r',
      mode: 'redo',
      prompt: 'Fix auth',
      branchName: 'bot/redo-fix-auth-deep',
      status: 'completed',
      filesChanged: ['src/auth.ts'],
      summary: 'Redid auth properly',
    };
    expect(task.mode).toBe('redo');
  });

  it('stores redo mode via storeOrchestraTask', async () => {
    const mockBucket = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const task: OrchestraTask = {
      taskId: 'orch-redo-1',
      timestamp: Date.now(),
      modelAlias: 'sonnet',
      repo: 'o/r',
      mode: 'redo',
      prompt: 'Redo auth',
      branchName: 'bot/redo-auth-sonnet',
      status: 'started',
      filesChanged: [],
    };

    await storeOrchestraTask(mockBucket as unknown as R2Bucket, 'user1', task);

    const [, data] = mockBucket.put.mock.calls[0];
    const parsed = JSON.parse(data as string);
    expect(parsed.tasks[0].mode).toBe('redo');
  });
});

// --- formatOrchestraHistory with redo and duration ---

describe('formatOrchestraHistory enhancements', () => {
  it('shows [REDO] tag for redo tasks', () => {
    const history: OrchestraHistory = {
      userId: 'u1',
      tasks: [{
        taskId: 'orch-1',
        timestamp: Date.now(),
        modelAlias: 'deep',
        repo: 'o/r',
        mode: 'redo',
        prompt: 'Fix auth',
        branchName: 'bot/redo-auth-deep',
        status: 'completed',
        filesChanged: [],
      }],
      updatedAt: Date.now(),
    };
    const output = formatOrchestraHistory(history);
    expect(output).toContain('[REDO]');
  });

  it('shows duration in minutes for long tasks', () => {
    const history: OrchestraHistory = {
      userId: 'u1',
      tasks: [{
        taskId: 'orch-1',
        timestamp: Date.now(),
        modelAlias: 'deep',
        repo: 'o/r',
        mode: 'run',
        prompt: 'Add feature',
        branchName: 'bot/add-feat-deep',
        status: 'completed',
        filesChanged: [],
        durationMs: 180000, // 3 minutes
      }],
      updatedAt: Date.now(),
    };
    const output = formatOrchestraHistory(history);
    expect(output).toContain('⏱ 3m');
  });

  it('shows duration in seconds for short tasks', () => {
    const history: OrchestraHistory = {
      userId: 'u1',
      tasks: [{
        taskId: 'orch-1',
        timestamp: Date.now(),
        modelAlias: 'flash',
        repo: 'o/r',
        mode: 'init',
        prompt: 'Init roadmap',
        branchName: 'bot/init-flash',
        status: 'completed',
        filesChanged: [],
        durationMs: 45000, // 45 seconds
      }],
      updatedAt: Date.now(),
    };
    const output = formatOrchestraHistory(history);
    expect(output).toContain('⏱ 45s');
  });

  it('shows PR link for completed tasks', () => {
    const history: OrchestraHistory = {
      userId: 'u1',
      tasks: [{
        taskId: 'orch-1',
        timestamp: Date.now(),
        modelAlias: 'deep',
        repo: 'o/r',
        mode: 'run',
        prompt: 'Add feature',
        branchName: 'bot/add-feat-deep',
        status: 'completed',
        filesChanged: [],
        prUrl: 'https://github.com/o/r/pull/42',
      }],
      updatedAt: Date.now(),
    };
    const output = formatOrchestraHistory(history);
    expect(output).toContain('PR: https://github.com/o/r/pull/42');
  });
});

// --- parseRoadmapPhases robustness ---

describe('parseRoadmapPhases robustness', () => {
  it('parses ## headers with Phase prefix', () => {
    const content = `## Phase 1: Setup
- [x] Initialize project
- [ ] Add CI

## Phase 2: Core
- [ ] Build API`;
    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(2);
    expect(phases[0].name).toBe('Setup');
    expect(phases[0].tasks).toHaveLength(2);
    expect(phases[1].tasks).toHaveLength(1);
  });

  it('parses numbered list items with checkboxes', () => {
    const content = `### Phase 1: Tasks
1. [x] First task
2. [ ] Second task
3. [x] Third task`;
    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(1);
    expect(phases[0].tasks).toHaveLength(3);
    expect(phases[0].tasks[0].done).toBe(true);
    expect(phases[0].tasks[1].done).toBe(false);
    expect(phases[0].tasks[2].done).toBe(true);
  });

  it('parses indented checkboxes (2-space indent)', () => {
    const content = `### Phase 1: Setup
  - [x] Indented task 1
  - [ ] Indented task 2`;
    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(1);
    expect(phases[0].tasks).toHaveLength(2);
    expect(phases[0].tasks[0].title).toBe('Indented task 1');
  });

  it('parses flat checklist with no phase headers', () => {
    const content = `- [x] Task one
- [ ] Task two
- [x] Task three`;
    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(1);
    expect(phases[0].name).toBe('Tasks');
    expect(phases[0].tasks).toHaveLength(3);
  });

  it('parses mixed formats (### + numbered + indented)', () => {
    const content = `### Setup
- [x] Initialize
  - [x] Add config

### Implementation
1. [x] Build API
2. [ ] Add tests`;
    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(2);
    expect(phases[0].tasks).toHaveLength(2);
    expect(phases[1].tasks).toHaveLength(2);
  });

  it('parses plain numbered tasks inside a phase', () => {
    const content = `### Phase 1: MVP
1. Build the login page
2. Add password reset
3. Integrate OAuth`;
    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(1);
    expect(phases[0].tasks).toHaveLength(3);
    expect(phases[0].tasks[0].done).toBe(false);
    expect(phases[0].tasks[0].title).toBe('Build the login page');
  });

  it('parses ## headers without Phase/Step/Sprint prefix', () => {
    const content = `## Setup Tasks
- [x] Bootstrap app

## QA
- [ ] Add tests`;
    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(2);
    expect(phases[0].name).toBe('Setup Tasks');
    expect(phases[1].name).toBe('QA');
  });

  it('parses # Phase headers with tasks', () => {
    const content = `# Phase 1: Setup
- [x] Configure tooling

# Phase 2: Build
- [ ] Implement API`;
    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(2);
    expect(phases[0].name).toBe('Setup');
    expect(phases[1].name).toBe('Build');
  });

  it('parses # Step headers with em dash delimiter', () => {
    const content = `# Step 1 — Build
- [ ] Create endpoint`;
    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(1);
    expect(phases[0].name).toBe('Build');
    expect(phases[0].tasks).toHaveLength(1);
  });

  it('parses mixed #, ##, and ### headers in one roadmap', () => {
    const content = `# Phase 1: Planning
- [x] Define scope

## Implementation
- [ ] Build feature

### Phase 3: Validation
- [ ] Run tests`;
    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(3);
    expect(phases[0].name).toBe('Planning');
    expect(phases[1].name).toBe('Implementation');
    expect(phases[2].name).toBe('Validation');
  });

  it('filters out empty phases (headers with no tasks)', () => {
    const content = `## Intro

## Setup
- [ ] Init project

## Notes`;
    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(1);
    expect(phases[0].name).toBe('Setup');
  });
});

// --- parseRoadmapPhases hierarchy ---

describe('parseRoadmapPhases hierarchy', () => {
  it('nests indented checkboxes under their parent top-level task', () => {
    const content = `### Phase 1: Refactoring
- [x] **Step 1**: Extract utility functions — create \`src/utils.js\`
  - [x] Create the new file with the extracted code
  - [x] Add the import to App.jsx
  - [x] Delete the original code from App.jsx
- [ ] **Step 2**: Extract destination data — create \`src/destinations.js\`
  - [ ] Create the new file with the extracted code
  - [ ] Add the import to App.jsx`;

    const phases = parseRoadmapPhases(content);
    expect(phases).toHaveLength(1);

    // Flat list should have all 7 items (backwards compat)
    expect(phases[0].tasks).toHaveLength(7);

    // Top-level should only have 2 items
    expect(phases[0].topLevelTasks).toHaveLength(2);
    expect(phases[0].topLevelTasks[0].title).toContain('Extract utility functions');
    expect(phases[0].topLevelTasks[0].children).toHaveLength(3);
    expect(phases[0].topLevelTasks[0].children[0].title).toBe('Create the new file with the extracted code');

    expect(phases[0].topLevelTasks[1].title).toContain('Extract destination data');
    expect(phases[0].topLevelTasks[1].children).toHaveLength(2);
  });

  it('treats 0-indent tasks as top-level even after indented ones', () => {
    const content = `### Setup
- [x] Step A
  - [x] Sub A1
  - [x] Sub A2
- [ ] Step B`;

    const phases = parseRoadmapPhases(content);
    expect(phases[0].topLevelTasks).toHaveLength(2);
    expect(phases[0].topLevelTasks[0].children).toHaveLength(2);
    expect(phases[0].topLevelTasks[1].children).toHaveLength(0);
    expect(phases[0].topLevelTasks[1].title).toBe('Step B');
  });

  it('tracks indent level on each task', () => {
    const content = `### Phase 1: Work
- [ ] Top-level task
  - [ ] Indented child`;

    const phases = parseRoadmapPhases(content);
    expect(phases[0].topLevelTasks[0].indent).toBe(0);
    expect(phases[0].topLevelTasks[0].children[0].indent).toBe(2);
  });

  it('assigns correct kind to checkbox vs numbered tasks', () => {
    const content = `### Phase 1: MVP
- [x] Checkbox task
1. [x] Numbered checkbox task
2. Plain numbered task`;

    const phases = parseRoadmapPhases(content);
    expect(phases[0].tasks[0].kind).toBe('checkbox');
    expect(phases[0].tasks[1].kind).toBe('numbered-checkbox');
    expect(phases[0].tasks[2].kind).toBe('numbered-plain');
  });
});

// --- scoreTaskConcreteness ---

describe('scoreTaskConcreteness', () => {
  it('scores tasks with file paths high', () => {
    expect(scoreTaskConcreteness('Extract utility functions — create `src/utils.js`')).toBeGreaterThanOrEqual(5);
  });

  it('scores tasks with backtick identifiers high', () => {
    expect(scoreTaskConcreteness('Modify the `Section` component to accept collapsible prop')).toBeGreaterThanOrEqual(5);
  });

  it('scores generic boilerplate tasks low', () => {
    expect(scoreTaskConcreteness('Create the new file with the extracted code')).toBeLessThan(3);
    expect(scoreTaskConcreteness('Add the import to App.jsx')).toBeLessThan(3);
    expect(scoreTaskConcreteness('Delete the original code from App.jsx')).toBeLessThan(3);
    expect(scoreTaskConcreteness('Verify the app still renders without errors')).toBeLessThan(3);
  });

  it('scores Step N labels as moderately concrete', () => {
    expect(scoreTaskConcreteness('Step 7: Add collapsible sections')).toBeGreaterThanOrEqual(2);
  });

  it('penalizes very short titles', () => {
    expect(scoreTaskConcreteness('Add tests')).toBeLessThan(scoreTaskConcreteness('Add unit tests for financial calculations in src/utils.js'));
  });

  it('scores backend file extensions high', () => {
    expect(scoreTaskConcreteness('Create auth middleware in src/auth.py')).toBeGreaterThanOrEqual(5);
    expect(scoreTaskConcreteness('Add handler.go for API routes')).toBeGreaterThanOrEqual(3);
    expect(scoreTaskConcreteness('Update schema.sql for user table')).toBeGreaterThanOrEqual(3);
  });

  it('does not penalize generic boilerplate when positive anchors exist', () => {
    // "Add the import" normally gets -4, but the backtick anchor should cancel it
    expect(scoreTaskConcreteness('Add the import to `App.jsx` for `Section` component')).toBeGreaterThanOrEqual(3);
  });

  it('does not penalize update existing tasks (removed broad penalty)', () => {
    expect(scoreTaskConcreteness('Update existing destination data with current tax rates and costs')).toBeGreaterThanOrEqual(0);
  });
});

// --- resolveNextRoadmapTask ---

describe('resolveNextRoadmapTask', () => {
  it('prefers concrete top-level tasks over generic sub-tasks', () => {
    const content = `### Critical Refactoring
- [ ] Create the new file with the extracted code
- [ ] Add the import to App.jsx
- [ ] Delete the original code from App.jsx
- [ ] Verify the app still renders without errors
- [x] **Step 1**: Extract utility functions — create \`src/utils.js\`, delete from App.jsx
- [x] **Step 2**: Extract destination data — create \`src/destinations.js\`
- [ ] **Step 7**: Add collapsible sections for cleaner mobile view
  - [ ] Modify the \`Section\` component in \`src/components/UIAtoms.jsx\` to accept an optional \`collapsible\` prop
  - [ ] Add local state (\`useState\`) inside \`Section\` to track open/closed`;

    const phases = parseRoadmapPhases(content);
    const resolved = resolveNextRoadmapTask(phases);

    expect(resolved).not.toBeNull();
    // Should pick Step 7 (concrete) instead of "Create the new file" (generic)
    expect(resolved!.title).toContain('Step 7');
    expect(resolved!.concreteScore).toBeGreaterThanOrEqual(3);
    expect(resolved!.pendingChildren.length).toBeGreaterThan(0);
  });

  it('skips generic orphaned sub-tasks whose parent is complete', () => {
    const content = `### Refactoring
- [x] **Step 3**: Extract UI atoms — create \`src/components/UIAtoms.jsx\`
  - [ ] Create the new file with the extracted code
  - [ ] Add the import to App.jsx
  - [ ] Delete the original code from App.jsx
- [ ] **Step 7**: Add collapsible sections for cleaner mobile view`;

    const phases = parseRoadmapPhases(content);
    const resolved = resolveNextRoadmapTask(phases);

    expect(resolved).not.toBeNull();
    // Should skip the generic children of completed Step 3 and pick Step 7
    expect(resolved!.title).toContain('Step 7');
  });

  it('returns null when all tasks are complete', () => {
    const content = `### Phase 1
- [x] Task A
- [x] Task B`;

    const phases = parseRoadmapPhases(content);
    const resolved = resolveNextRoadmapTask(phases);
    expect(resolved).toBeNull();
  });

  it('includes completed context in execution brief', () => {
    const content = `### Refactoring
- [x] Step 1: Extract utils
- [x] Step 2: Extract destinations
- [ ] Step 3: Extract UI atoms — create \`src/components/UIAtoms.jsx\``;

    const phases = parseRoadmapPhases(content);
    const resolved = resolveNextRoadmapTask(phases);

    expect(resolved).not.toBeNull();
    expect(resolved!.executionBrief).toContain('Already completed');
    expect(resolved!.executionBrief).toContain('Step 1: Extract utils');
    expect(resolved!.executionBrief).toContain('Step 2: Extract destinations');
  });

  it('marks generic tasks as high ambiguity', () => {
    const content = `### Phase 1
- [ ] Create the new file with the extracted code`;

    const phases = parseRoadmapPhases(content);
    const resolved = resolveNextRoadmapTask(phases);

    expect(resolved).not.toBeNull();
    expect(resolved!.ambiguity).toBe('high');
    expect(resolved!.executionBrief).toContain('generic');
  });

  it('marks concrete tasks as no ambiguity', () => {
    const content = `### Phase 1
- [ ] **Step 3**: Extract UI atoms — create \`src/components/UIAtoms.jsx\`, delete from App.jsx`;

    const phases = parseRoadmapPhases(content);
    const resolved = resolveNextRoadmapTask(phases);

    expect(resolved).not.toBeNull();
    expect(resolved!.ambiguity).toBe('none');
  });

  it('bundles parent context for concrete sub-tasks under a done parent', () => {
    const content = `### Refactoring
- [x] **Step 3**: Extract UI atoms — create \`src/components/UIAtoms.jsx\`
  - [x] Create the new file
  - [ ] Add the import to \`App.jsx\` for \`Section\` component
  - [ ] Delete the original \`Section\` code from App.jsx`;

    const phases = parseRoadmapPhases(content);
    const resolved = resolveNextRoadmapTask(phases);

    // The second child has backtick identifiers → concrete enough
    // Should include parent context
    expect(resolved).not.toBeNull();
    if (resolved!.parent) {
      expect(resolved!.parent.title).toContain('Extract UI atoms');
    }
  });

  it('reproduces the exact wagmi ROADMAP failure scenario', () => {
    // This is the exact roadmap structure that caused PR #106-#113 degradation
    const content = `### Critical Refactoring (Foundations)
- [ ] Create the new file with the extracted code
- [ ] Add the import to App.jsx
- [ ] **Delete the original code from App.jsx** (not rename, not comment out — delete)
- [ ] Verify the app still renders without errors
- [x] **Step 1**: Extract utility functions — create \`src/utils.js\`, delete from App.jsx (lines 20-33: \`clamp\`, \`fmt\`, \`fmtUsd\`, \`shortTax\`)
- [x] **Step 2**: Extract destination data — create \`src/destinations.js\`, delete from App.jsx (lines 34-267: \`INITIAL_DESTS\` array, ~234 lines)
- [x] **Step 3**: Extract UI atoms — create \`src/components/UIAtoms.jsx\`, delete from App.jsx (lines 674-737: \`Section\`, \`KPI\`, \`Slider\`, \`NumberBox\`, \`TextBox\`, \`FeatBox\`)
- [x] **Step 4**: Extract destination editor — create \`src/components/DestEditor.jsx\`, delete from App.jsx (lines 738-805: \`DestRow\`, \`NewDestRow\`)
- [x] **Step 5**: Extract chart component — create \`src/components/Chart.jsx\`, delete from App.jsx (lines 807-847: \`LineChart\`)
- [x] **Step 6**: Extract banner component — create \`src/components/BannerImg.jsx\`, delete from App.jsx (lines 4-18: \`BannerImg\`)
- [x] Added Singapore and Lisbon (2026-02-14)
- [x] Add 5+ more destinations (emerging markets, tax-friendly jurisdictions)
- [ ] Update existing destination data with current tax rates and costs
- [ ] Add source/date annotations to destination data for freshness tracking
- [ ] **Step 7**: Add collapsible sections for cleaner mobile view
  - [ ] Modify the \`Section\` component in \`src/components/UIAtoms.jsx\` to accept an optional \`collapsible\` prop (default \`true\`)
  - [ ] Add local state (\`useState\`) inside \`Section\` to track open/closed
  - [ ] When collapsed, hide \`children\` (don't unmount — use CSS \`display:none\` or a wrapper with conditional rendering)
  - [ ] Add a visual indicator in the header: ▶ when collapsed, ▼ when expanded (plain text, no icon library needed)
  - [ ] Keep the existing card/header styling — just add the toggle behavior
  - [ ] The header should have \`cursor: pointer\` when collapsible`;

    const phases = parseRoadmapPhases(content);
    const resolved = resolveNextRoadmapTask(phases);

    expect(resolved).not.toBeNull();
    // CRITICAL: Must NOT pick "Create the new file with the extracted code"
    expect(resolved!.title).not.toBe('Create the new file with the extracted code');
    // Should pick a concrete task — either "Update existing destination data" or "Step 7"
    // Both are more concrete than the generic boilerplate at the top
    expect(resolved!.concreteScore).toBeGreaterThanOrEqual(2);
    // The generic tasks at the top should be skipped
    expect(resolved!.title).not.toContain('Add the import');
    expect(resolved!.title).not.toContain('Delete the original code');
    expect(resolved!.title).not.toContain('Verify the app still');
  });

  it('skips numbered-plain items as non-executable', () => {
    const content = `### Phase 1: MVP
1. Build the login page
2. Add password reset
- [ ] **Step 1**: Create auth module in \`src/auth.ts\``;

    const phases = parseRoadmapPhases(content);
    const resolved = resolveNextRoadmapTask(phases);

    expect(resolved).not.toBeNull();
    // Should pick the checkbox task, not the numbered-plain items
    expect(resolved!.title).toContain('Create auth module');
  });

  it('considers pending children of completed parents in second pass', () => {
    const content = `### Refactoring
- [x] Step 1: Extract utils
  - [ ] Verify utils integration still works`;

    const phases = parseRoadmapPhases(content);
    const resolved = resolveNextRoadmapTask(phases);

    // The child is under a completed parent — second pass should find it
    expect(resolved).not.toBeNull();
    expect(resolved!.title).toBe('Verify utils integration still works');
    expect(resolved!.parent?.title).toContain('Extract utils');
  });

  it('handles deeply indented tasks (6+ spaces)', () => {
    const content = `### Phase 1
- [ ] Top-level task
      - [ ] Deeply indented sub-task`;

    const phases = parseRoadmapPhases(content);
    // Should still parse — indent regex widened to 8 spaces
    expect(phases[0].tasks).toHaveLength(2);
    expect(phases[0].topLevelTasks[0].children).toHaveLength(1);
    expect(phases[0].topLevelTasks[0].children[0].title).toBe('Deeply indented sub-task');
  });

  it('supports true N-level nesting (3+ levels) via indent stack', () => {
    const content = `### Phase 1: Deep Nesting
- [ ] Level 0 task
  - [ ] Level 1 child
    - [ ] Level 2 grandchild
    - [ ] Level 2 sibling
  - [ ] Level 1 second child`;

    const phases = parseRoadmapPhases(content);
    expect(phases[0].topLevelTasks).toHaveLength(1);

    const level0 = phases[0].topLevelTasks[0];
    expect(level0.title).toBe('Level 0 task');
    expect(level0.children).toHaveLength(2); // Level 1 child + Level 1 second child

    const level1 = level0.children[0];
    expect(level1.title).toBe('Level 1 child');
    expect(level1.children).toHaveLength(2); // Level 2 grandchild + Level 2 sibling

    expect(level1.children[0].title).toBe('Level 2 grandchild');
    expect(level1.children[1].title).toBe('Level 2 sibling');

    // Second Level 1 child should be a sibling, not nested under Level 2
    expect(level0.children[1].title).toBe('Level 1 second child');
    expect(level0.children[1].children).toHaveLength(0);
  });

  it('tracks lineIndex on all parsed tasks', () => {
    const content = `### Phase 1: Setup
- [x] First task
- [ ] Second task
  - [ ] Sub-task`;

    const phases = parseRoadmapPhases(content);
    // Line 0: "### Phase 1: Setup"
    // Line 1: "- [x] First task"
    // Line 2: "- [ ] Second task"
    // Line 3: "  - [ ] Sub-task"
    expect(phases[0].topLevelTasks[0].lineIndex).toBe(1);
    expect(phases[0].topLevelTasks[1].lineIndex).toBe(2);
    expect(phases[0].topLevelTasks[1].children[0].lineIndex).toBe(3);
  });

  it('flat tasks list still contains all tasks for backwards compat with N-level nesting', () => {
    const content = `### Phase 1
- [ ] A
  - [ ] B
    - [ ] C`;

    const phases = parseRoadmapPhases(content);
    // Flat list should have all 3
    expect(phases[0].tasks).toHaveLength(3);
    // Top-level should have only 1
    expect(phases[0].topLevelTasks).toHaveLength(1);
    // Hierarchy: A → B → C
    expect(phases[0].topLevelTasks[0].children[0].children[0].title).toBe('C');
  });
});

// --- cleanupStaleTasks ---

describe('cleanupStaleTasks', () => {
  let mockBucket: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockBucket = {
      get: vi.fn(),
      put: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('marks tasks started >30 min ago as failed', async () => {
    const now = Date.now();
    const history: OrchestraHistory = {
      userId: 'user1',
      tasks: [{
        taskId: 'orch-1',
        timestamp: now - 35 * 60 * 1000, // 35 min ago
        modelAlias: 'deep',
        repo: 'o/r',
        mode: 'run',
        prompt: 'Add feature',
        branchName: 'bot/add-feat-deep',
        status: 'started',
        filesChanged: [],
      }],
      updatedAt: now - 35 * 60 * 1000,
    };

    mockBucket.get.mockResolvedValue({ json: () => Promise.resolve(history) });

    const cleaned = await cleanupStaleTasks(mockBucket as unknown as R2Bucket, 'user1', now);
    expect(cleaned).toBe(1);

    const [, data] = mockBucket.put.mock.calls[0];
    const parsed = JSON.parse(data as string);
    expect(parsed.tasks[0].status).toBe('failed');
    expect(parsed.tasks[0].summary).toContain('STALE');
  });

  it('does not touch recently started tasks', async () => {
    const now = Date.now();
    const history: OrchestraHistory = {
      userId: 'user1',
      tasks: [{
        taskId: 'orch-1',
        timestamp: now - 5 * 60 * 1000, // 5 min ago
        modelAlias: 'deep',
        repo: 'o/r',
        mode: 'run',
        prompt: 'Add feature',
        branchName: 'bot/add-feat-deep',
        status: 'started',
        filesChanged: [],
      }],
      updatedAt: now - 5 * 60 * 1000,
    };

    mockBucket.get.mockResolvedValue({ json: () => Promise.resolve(history) });

    const cleaned = await cleanupStaleTasks(mockBucket as unknown as R2Bucket, 'user1', now);
    expect(cleaned).toBe(0);
    expect(mockBucket.put).not.toHaveBeenCalled();
  });

  it('does not touch completed or failed tasks', async () => {
    const now = Date.now();
    const history: OrchestraHistory = {
      userId: 'user1',
      tasks: [
        {
          taskId: 'orch-1', timestamp: now - 60 * 60 * 1000, modelAlias: 'deep',
          repo: 'o/r', mode: 'run', prompt: 'Done', branchName: 'b1',
          status: 'completed', filesChanged: [],
        },
        {
          taskId: 'orch-2', timestamp: now - 60 * 60 * 1000, modelAlias: 'deep',
          repo: 'o/r', mode: 'run', prompt: 'Failed', branchName: 'b2',
          status: 'failed', filesChanged: [],
        },
      ],
      updatedAt: now,
    };

    mockBucket.get.mockResolvedValue({ json: () => Promise.resolve(history) });

    const cleaned = await cleanupStaleTasks(mockBucket as unknown as R2Bucket, 'user1', now);
    expect(cleaned).toBe(0);
  });

  it('returns 0 when no history exists', async () => {
    mockBucket.get.mockResolvedValue(null);
    const cleaned = await cleanupStaleTasks(mockBucket as unknown as R2Bucket, 'user1');
    expect(cleaned).toBe(0);
  });

  it('handles R2 read error gracefully', async () => {
    mockBucket.get.mockRejectedValue(new Error('R2 error'));
    const cleaned = await cleanupStaleTasks(mockBucket as unknown as R2Bucket, 'user1');
    expect(cleaned).toBe(0);
  });
});

// --- Orchestra Event Observability ---

describe('appendOrchestraEvent', () => {
  let mockBucket: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockBucket = { get: vi.fn(), put: vi.fn() };
  });

  const baseEvent: OrchestraEvent = {
    timestamp: new Date('2026-03-17T12:00:00Z').getTime(),
    taskId: 'task-1',
    userId: 'user1',
    modelAlias: 'kimidirect',
    eventType: 'stall_abort',
    details: { resumes: 3, tools: 15 },
  };

  it('creates new JSONL file when none exists', async () => {
    mockBucket.get.mockResolvedValue(null);
    mockBucket.put.mockResolvedValue(undefined);

    await appendOrchestraEvent(mockBucket as unknown as R2Bucket, baseEvent);

    expect(mockBucket.put).toHaveBeenCalledOnce();
    const [key, body] = mockBucket.put.mock.calls[0];
    expect(key).toBe('orchestra-events/2026-03.jsonl');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(baseEvent);
  });

  it('appends to existing JSONL file', async () => {
    const existing = JSON.stringify({ ...baseEvent, taskId: 'task-0' }) + '\n';
    mockBucket.get.mockResolvedValue({ text: () => Promise.resolve(existing) });
    mockBucket.put.mockResolvedValue(undefined);

    await appendOrchestraEvent(mockBucket as unknown as R2Bucket, baseEvent);

    const [, body] = mockBucket.put.mock.calls[0];
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).taskId).toBe('task-1');
  });

  it('does not throw on R2 error', async () => {
    mockBucket.get.mockRejectedValue(new Error('R2 down'));
    // Should not throw
    await appendOrchestraEvent(mockBucket as unknown as R2Bucket, baseEvent);
    expect(mockBucket.put).not.toHaveBeenCalled();
  });
});

describe('getRecentOrchestraEvents', () => {
  let mockBucket: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockBucket = { get: vi.fn() };
  });

  it('returns empty array when no events exist', async () => {
    mockBucket.get.mockResolvedValue(null);
    const events = await getRecentOrchestraEvents(mockBucket as unknown as R2Bucket, 1);
    expect(events).toEqual([]);
  });

  it('parses JSONL and returns events sorted newest-first', async () => {
    const ev1: OrchestraEvent = { timestamp: 1000, taskId: 't1', modelAlias: 'deep', eventType: 'task_complete', details: {} };
    const ev2: OrchestraEvent = { timestamp: 2000, taskId: 't2', modelAlias: 'flash', eventType: 'stall_abort', details: {} };
    const jsonl = JSON.stringify(ev1) + '\n' + JSON.stringify(ev2) + '\n';
    mockBucket.get.mockResolvedValue({ text: () => Promise.resolve(jsonl) });

    const events = await getRecentOrchestraEvents(mockBucket as unknown as R2Bucket, 1);
    expect(events).toHaveLength(2);
    expect(events[0].taskId).toBe('t2'); // newest first
    expect(events[1].taskId).toBe('t1');
  });

  it('filters by model alias', async () => {
    const ev1: OrchestraEvent = { timestamp: 1000, taskId: 't1', modelAlias: 'deep', eventType: 'task_complete', details: {} };
    const ev2: OrchestraEvent = { timestamp: 2000, taskId: 't2', modelAlias: 'flash', eventType: 'stall_abort', details: {} };
    const jsonl = JSON.stringify(ev1) + '\n' + JSON.stringify(ev2) + '\n';
    mockBucket.get.mockResolvedValue({ text: () => Promise.resolve(jsonl) });

    const events = await getRecentOrchestraEvents(mockBucket as unknown as R2Bucket, 1, 'deep');
    expect(events).toHaveLength(1);
    expect(events[0].modelAlias).toBe('deep');
  });

  it('respects limit', async () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ timestamp: i, taskId: `t${i}`, modelAlias: 'deep', eventType: 'task_complete', details: {} })
    ).join('\n') + '\n';
    mockBucket.get.mockResolvedValue({ text: () => Promise.resolve(lines) });

    const events = await getRecentOrchestraEvents(mockBucket as unknown as R2Bucket, 1, undefined, 5);
    expect(events).toHaveLength(5);
  });
});

describe('aggregateOrchestraStats', () => {
  it('aggregates events by type and model', () => {
    const events: OrchestraEvent[] = [
      { timestamp: 1, taskId: 't1', modelAlias: 'deep', eventType: 'task_complete', details: {} },
      { timestamp: 2, taskId: 't2', modelAlias: 'deep', eventType: 'stall_abort', details: {} },
      { timestamp: 3, taskId: 't3', modelAlias: 'flash', eventType: 'task_complete', details: {} },
      { timestamp: 4, taskId: 't4', modelAlias: 'deep', eventType: 'task_abort', details: {} },
      { timestamp: 5, taskId: 't5', modelAlias: 'flash', eventType: 'validation_fail', details: {} },
    ];

    const stats = aggregateOrchestraStats(events);
    expect(stats.total).toBe(5);
    // 2 completions / (2 completions + 2 failures) = 50%
    expect(stats.successRate).toBe(50);
    expect(stats.byType['task_complete']).toBe(2);
    expect(stats.byType['stall_abort']).toBe(1);
    expect(stats.byType['task_abort']).toBe(1);
    expect(stats.byType['validation_fail']).toBe(1);
    expect(stats.byModel['deep']).toEqual({ total: 3, completions: 1, failures: 2 });
    expect(stats.byModel['flash']).toEqual({ total: 2, completions: 1, failures: 0 });
  });

  it('returns empty aggregation for empty events', () => {
    const stats = aggregateOrchestraStats([]);
    expect(stats.total).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.byType).toEqual({});
    expect(stats.byModel).toEqual({});
  });

  it('computes 100% success rate when all tasks complete', () => {
    const events: OrchestraEvent[] = [
      { timestamp: 1, taskId: 't1', modelAlias: 'deep', eventType: 'task_complete', details: {} },
      { timestamp: 2, taskId: 't2', modelAlias: 'deep', eventType: 'task_complete', details: {} },
    ];
    expect(aggregateOrchestraStats(events).successRate).toBe(100);
  });
});

describe('getEventBasedModelScores', () => {
  it('computes per-model scores from mixed events', () => {
    const events: OrchestraEvent[] = [
      { timestamp: 1, taskId: 't1', modelAlias: 'deep', eventType: 'task_complete', details: {} },
      { timestamp: 2, taskId: 't2', modelAlias: 'deep', eventType: 'stall_abort', details: {} },
      { timestamp: 3, taskId: 't3', modelAlias: 'deep', eventType: 'task_complete', details: {} },
      { timestamp: 4, taskId: 't4', modelAlias: 'flash', eventType: 'task_complete', details: {} },
      { timestamp: 5, taskId: 't5', modelAlias: 'flash', eventType: 'validation_fail', details: {} },
      { timestamp: 6, taskId: 't6', modelAlias: 'deep', eventType: 'deliverable_retry', details: {} },
      { timestamp: 7, taskId: 't7', modelAlias: 'flash', eventType: 'task_abort', details: {} },
    ];

    const scores = getEventBasedModelScores(events);

    const deep = scores.get('deep')!;
    expect(deep.completions).toBe(2);
    expect(deep.failures).toBe(1);
    expect(deep.stalls).toBe(1);
    expect(deep.retries).toBe(1);
    expect(deep.validationFails).toBe(0);
    expect(deep.total).toBe(3); // 2 completions + 1 stall_abort
    // Bayesian: (2+1)/(3+2) = 0.6
    expect(deep.successRate).toBeCloseTo(0.6, 2);
    // stallRate: 1/3 ≈ 0.333
    expect(deep.stallRate).toBeCloseTo(0.333, 2);

    const flash = scores.get('flash')!;
    expect(flash.completions).toBe(1);
    expect(flash.failures).toBe(1);
    expect(flash.stalls).toBe(0);
    expect(flash.validationFails).toBe(1);
    expect(flash.retries).toBe(0);
    expect(flash.total).toBe(2); // 1 completion + 1 task_abort
    // Bayesian: (1+1)/(2+2) = 0.5
    expect(flash.successRate).toBe(0.5);
    expect(flash.stallRate).toBe(0);
  });

  it('returns empty map for no events', () => {
    const scores = getEventBasedModelScores([]);
    expect(scores.size).toBe(0);
  });

  it('handles models with only non-terminal events', () => {
    const events: OrchestraEvent[] = [
      { timestamp: 1, taskId: 't1', modelAlias: 'test', eventType: 'validation_fail', details: {} },
      { timestamp: 2, taskId: 't2', modelAlias: 'test', eventType: 'deliverable_retry', details: {} },
    ];

    const scores = getEventBasedModelScores(events);
    const test = scores.get('test')!;
    expect(test.total).toBe(0); // no terminal events
    expect(test.validationFails).toBe(1);
    expect(test.retries).toBe(1);
    // Bayesian with 0 terminal: (0+1)/(0+2) = 0.5
    expect(test.successRate).toBe(0.5);
    expect(test.stallRate).toBe(0);
  });

  it('identifies stall-heavy models', () => {
    const events: OrchestraEvent[] = [
      { timestamp: 1, taskId: 't1', modelAlias: 'staller', eventType: 'stall_abort', details: {} },
      { timestamp: 2, taskId: 't2', modelAlias: 'staller', eventType: 'stall_abort', details: {} },
      { timestamp: 3, taskId: 't3', modelAlias: 'staller', eventType: 'task_complete', details: {} },
    ];

    const scores = getEventBasedModelScores(events);
    const staller = scores.get('staller')!;
    expect(staller.stallRate).toBeCloseTo(0.667, 2);
    // Bayesian: (1+1)/(3+2) = 0.4
    expect(staller.successRate).toBeCloseTo(0.4, 2);
  });
});

describe('cleanupExpiredOrchestraEvents', () => {
  let mockBucket: { list: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockBucket = { list: vi.fn(), delete: vi.fn() };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes files older than 3 months', async () => {
    mockBucket.list.mockResolvedValue({
      objects: [
        { key: 'orchestra-events/2026-01.jsonl' }, // > 3 months old → delete
        { key: 'orchestra-events/2026-02.jsonl' }, // > 3 months old → delete
        { key: 'orchestra-events/2026-04.jsonl' }, // within retention → keep
        { key: 'orchestra-events/2026-06.jsonl' }, // current month → keep
      ],
    });
    mockBucket.delete.mockResolvedValue(undefined);

    const deleted = await cleanupExpiredOrchestraEvents(mockBucket as unknown as R2Bucket);
    expect(deleted).toBe(2);
    expect(mockBucket.delete).toHaveBeenCalledWith('orchestra-events/2026-01.jsonl');
    expect(mockBucket.delete).toHaveBeenCalledWith('orchestra-events/2026-02.jsonl');
  });

  it('returns 0 when no files exist', async () => {
    mockBucket.list.mockResolvedValue({ objects: [] });
    const deleted = await cleanupExpiredOrchestraEvents(mockBucket as unknown as R2Bucket);
    expect(deleted).toBe(0);
  });

  it('handles R2 errors gracefully', async () => {
    mockBucket.list.mockRejectedValue(new Error('R2 down'));
    const deleted = await cleanupExpiredOrchestraEvents(mockBucket as unknown as R2Bucket);
    expect(deleted).toBe(0);
  });
});

// --- Shared test helper ---

function makeResolved(overrides: Partial<ResolvedTask> = {}): ResolvedTask {
  return {
    title: overrides.title ?? 'Implement user auth middleware',
    phase: overrides.phase ?? 'Phase 1',
    task: overrides.task ?? { title: 'Implement user auth middleware', done: false, indent: 0, children: [], kind: 'checkbox', lineIndex: 0 },
    pendingChildren: overrides.pendingChildren ?? [],
    completedContext: overrides.completedContext ?? [],
    concreteScore: overrides.concreteScore ?? 5,
    ambiguity: overrides.ambiguity ?? 'none',
    executionBrief: overrides.executionBrief ?? 'Phase: Phase 1\nPrimary task: Implement user auth middleware',
  };
}

// --- buildExecutionProfile ---

describe('buildExecutionProfile', () => {

  it('returns correct structure', () => {
    const profile = buildExecutionProfile(makeResolved(), 'claude');
    expect(profile).toHaveProperty('intent');
    expect(profile).toHaveProperty('bounds');
    expect(profile).toHaveProperty('routing');
    expect(profile.intent.concreteScore).toBe(5);
    expect(profile.intent.ambiguity).toBe('none');
  });

  it('detects simple tasks and skips sandbox', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Update README with new badges', concreteScore: 6, ambiguity: 'none' }),
      'claude',
    );
    expect(profile.intent.isSimple).toBe(true);
    expect(profile.bounds.requiresSandbox).toBe(false);
  });

  it('detects heavy coding tasks', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Refactor auth module into separate files' }),
      'claude',
    );
    expect(profile.intent.isHeavyCoding).toBe(true);
    expect(profile.bounds.requiresSandbox).toBe(true);
  });

  it('caps resumes for high-ambiguity tasks', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Create the new file', concreteScore: 1, ambiguity: 'high' }),
      'claude',
    );
    expect(profile.intent.ambiguity).toBe('high');
    expect(profile.bounds.maxAutoResumes).toBeLessThanOrEqual(3);
  });

  it('gives full budget to heavy tasks on strong models', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Refactor the entire auth system', concreteScore: 7, ambiguity: 'none' }),
      'claude',
    );
    expect(profile.intent.isHeavyCoding).toBe(true);
    // Strong model + heavy coding → base + 2
    expect(profile.bounds.maxAutoResumes).toBeGreaterThanOrEqual(6);
  });

  it('forces escalation for heavy task on weak model', () => {
    // 'trinity' is a free model → intelligenceIndex fallback is 20 (< 28)
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Refactor multi-file architecture' }),
      'trinity',
    );
    expect(profile.routing.forceEscalation).toBe(true);
  });

  it('does not force escalation for simple task on weak model', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Bump version in package.json' }),
      'trinity',
    );
    expect(profile.routing.forceEscalation).toBe(false);
  });

  it('carries pendingChildren count from resolved task', () => {
    const children = [
      { title: 'Sub-task 1', done: false, indent: 1, children: [], kind: 'checkbox' as const, lineIndex: 1 },
      { title: 'Sub-task 2', done: false, indent: 1, children: [], kind: 'checkbox' as const, lineIndex: 2 },
    ];
    const profile = buildExecutionProfile(
      makeResolved({ pendingChildren: children }),
      'claude',
    );
    expect(profile.intent.pendingChildren).toBe(2);
  });

  // F.21: pendingChildren influences resume cap
  it('grants extra resume when 3+ pending children', () => {
    const children = [
      { title: 'Sub-task 1', done: false, indent: 1, children: [], kind: 'checkbox' as const, lineIndex: 1 },
      { title: 'Sub-task 2', done: false, indent: 1, children: [], kind: 'checkbox' as const, lineIndex: 2 },
      { title: 'Sub-task 3', done: false, indent: 1, children: [], kind: 'checkbox' as const, lineIndex: 3 },
    ];
    const profile = buildExecutionProfile(
      makeResolved({ pendingChildren: children }),
      'flash', // mid-tier model, not heavy coding, not ambiguous
    );
    // Base is 6, with 3+ children should get 7
    expect(profile.bounds.maxAutoResumes).toBe(7);
  });

  it('does not grant extra resume for fewer than 3 children', () => {
    const children = [
      { title: 'Sub-task 1', done: false, indent: 1, children: [], kind: 'checkbox' as const, lineIndex: 1 },
    ];
    const profile = buildExecutionProfile(
      makeResolved({ pendingChildren: children }),
      'flash',
    );
    expect(profile.bounds.maxAutoResumes).toBe(6);
  });

  // F.24: model floor
  it('sets modelFloor=28 for heavy coding tasks', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Refactor multi-file architecture' }),
      'claude',
    );
    expect(profile.routing.modelFloor).toBe(28);
  });

  it('sets modelFloor=35 for high-ambiguity tasks', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Do something', ambiguity: 'high' }),
      'claude',
    );
    expect(profile.routing.modelFloor).toBe(35);
  });

  it('sets modelFloor=0 for simple clear tasks', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Update readme with new info', ambiguity: 'none' }),
      'claude',
    );
    expect(profile.routing.modelFloor).toBe(0);
  });

  it('heavy coding modelFloor takes precedence over high ambiguity', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Refactor complex multi-file system', ambiguity: 'high' }),
      'claude',
    );
    // isHeavyCoding matches first in the ternary, so floor=28
    expect(profile.routing.modelFloor).toBe(28);
  });
  // --- Complexity tier in profile ---

  it('sets trivial tier for simple + no-ambiguity tasks', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Bump version to 2.0', concreteScore: 8, ambiguity: 'none' }),
      'claude',
    );
    expect(profile.bounds.complexityTier).toBe('trivial');
    expect(profile.bounds.expectedTools).toBe(TIER_BUDGETS.trivial.expectedTools);
    expect(profile.bounds.expectedWallClockMs).toBe(TIER_BUDGETS.trivial.expectedWallClockMs);
  });

  it('sets small tier for concrete non-heavy tasks', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Implement user auth middleware', concreteScore: 5, ambiguity: 'none' }),
      'claude',
    );
    expect(profile.bounds.complexityTier).toBe('small');
  });

  it('sets medium tier for high-ambiguity non-heavy tasks', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Do something', concreteScore: 1, ambiguity: 'high' }),
      'claude',
    );
    expect(profile.bounds.complexityTier).toBe('medium');
  });

  it('sets large tier for heavy coding tasks', () => {
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Refactor auth module into separate files', concreteScore: 7, ambiguity: 'none' }),
      'claude',
    );
    expect(profile.bounds.complexityTier).toBe('large');
  });

  it('sets large tier for tasks with 3+ children', () => {
    const children = [
      { title: 'Sub-task 1', done: false, indent: 1, children: [], kind: 'checkbox' as const, lineIndex: 1 },
      { title: 'Sub-task 2', done: false, indent: 1, children: [], kind: 'checkbox' as const, lineIndex: 2 },
      { title: 'Sub-task 3', done: false, indent: 1, children: [], kind: 'checkbox' as const, lineIndex: 3 },
    ];
    const profile = buildExecutionProfile(
      makeResolved({ pendingChildren: children }),
      'flash',
    );
    expect(profile.bounds.complexityTier).toBe('large');
  });

  it('tier does not affect resume cap (decoupled)', () => {
    // Trivial tier still gets full resume cap based on ambiguity, not tier
    const profile = buildExecutionProfile(
      makeResolved({ title: 'Update readme with badges', concreteScore: 6, ambiguity: 'none' }),
      'claude',
    );
    expect(profile.bounds.complexityTier).toBe('trivial');
    expect(profile.bounds.maxAutoResumes).toBe(6); // Base resumes, not tier expected
  });
});

// --- classifyComplexityTier ---

describe('classifyComplexityTier', () => {
  it('returns trivial for simple + no ambiguity', () => {
    expect(classifyComplexityTier(true, false, 'none', 0)).toBe('trivial');
  });

  it('returns small for simple + some ambiguity', () => {
    expect(classifyComplexityTier(true, false, 'low', 0)).toBe('small');
  });

  it('returns small for concrete non-heavy task', () => {
    expect(classifyComplexityTier(false, false, 'none', 0)).toBe('small');
  });

  it('returns medium for low-ambiguity non-simple task', () => {
    expect(classifyComplexityTier(false, false, 'low', 0)).toBe('medium');
  });

  it('returns medium for high-ambiguity non-heavy task', () => {
    expect(classifyComplexityTier(false, false, 'high', 0)).toBe('medium');
  });

  it('returns large for heavy coding', () => {
    expect(classifyComplexityTier(false, true, 'none', 0)).toBe('large');
  });

  it('returns large for 3+ pending children', () => {
    expect(classifyComplexityTier(false, false, 'none', 3)).toBe('large');
  });

  it('trivial overrides heavy coding check (simple wins)', () => {
    // If both isSimple and isHeavyCoding are true, isSimple+none → trivial
    // But in practice buildExecutionProfile checks both regexes independently
    expect(classifyComplexityTier(true, true, 'none', 0)).toBe('trivial');
  });
});

// --- TIER_BUDGETS ---

describe('TIER_BUDGETS', () => {
  it('trivial has fastest expected completion', () => {
    expect(TIER_BUDGETS.trivial.expectedWallClockMs).toBeLessThanOrEqual(60_000);
    expect(TIER_BUDGETS.trivial.expectedTools).toBeLessThanOrEqual(5);
  });

  it('budgets increase monotonically', () => {
    const tiers: ComplexityTier[] = ['trivial', 'small', 'medium', 'large'];
    for (let i = 1; i < tiers.length; i++) {
      expect(TIER_BUDGETS[tiers[i]].expectedWallClockMs).toBeGreaterThan(TIER_BUDGETS[tiers[i - 1]].expectedWallClockMs);
      expect(TIER_BUDGETS[tiers[i]].expectedTools).toBeGreaterThan(TIER_BUDGETS[tiers[i - 1]].expectedTools);
    }
  });
});

// --- countScopeAmplifiers ---

describe('countScopeAmplifiers', () => {
  it('returns 0 for a plain title with no amplifiers', () => {
    expect(countScopeAmplifiers('Fix the login button', '')).toBe(0);
  });

  it('detects testing signals', () => {
    expect(countScopeAmplifiers('Add unit tests for auth module', '')).toBeGreaterThanOrEqual(1);
  });

  it('detects extraction signals', () => {
    expect(countScopeAmplifiers('Extract utility functions into a new module', '')).toBeGreaterThanOrEqual(1);
  });

  it('detects package/infra signals in brief', () => {
    // package.json → infra signal (count 1)
    expect(countScopeAmplifiers('Setup project', 'Update package.json')).toBeGreaterThanOrEqual(1);
  });

  it('detects separate infra and testing signals', () => {
    // vitest → infra, "add tests" → testing = 2 separate amplifiers
    expect(countScopeAmplifiers('Add tests with vitest', '')).toBeGreaterThanOrEqual(2);
  });

  it('detects integration signals', () => {
    expect(countScopeAmplifiers('Wire the new service into the router', '')).toBeGreaterThanOrEqual(1);
  });

  it('stacks multiple amplifiers', () => {
    // testing + extraction + package = 3 amplifiers
    const count = countScopeAmplifiers(
      'Add unit tests for calculations',
      'Extract calculations into its own module. Update package.json with test dependencies.',
    );
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('is case insensitive', () => {
    expect(countScopeAmplifiers('Add UNIT TESTS', '')).toBeGreaterThanOrEqual(1);
  });
});

// --- Scope amplifier integration with buildExecutionProfile ---

describe('scope amplifier tier bumping', () => {
  it('bumps small to medium when 2+ amplifiers detected', () => {
    // "Add unit tests for calculations" with extraction brief
    // Base tier: small (concrete, non-heavy, no ambiguity)
    // Amplifiers: testing + extraction = 2 → bump to medium
    const profile = buildExecutionProfile(
      makeResolved({
        title: 'Add unit tests for financial calculations',
        concreteScore: 6,
        ambiguity: 'none',
        executionBrief: 'Extract calculation logic into separate module. Wire into existing code.',
      }),
      'claude',
    );
    expect(profile.bounds.complexityTier).toBe('medium');
  });

  it('bumps trivial to small when 1 amplifier detected', () => {
    // "Update readme" is trivial, but if brief mentions testing → bump to small
    const profile = buildExecutionProfile(
      makeResolved({
        title: 'Update readme with test instructions',
        concreteScore: 8,
        ambiguity: 'none',
        executionBrief: 'Add unit test documentation.',
      }),
      'claude',
    );
    expect(profile.bounds.complexityTier).toBe('small');
  });

  it('does not bump large tier (already at top)', () => {
    const profile = buildExecutionProfile(
      makeResolved({
        title: 'Refactor auth module with unit tests',
        concreteScore: 7,
        ambiguity: 'none',
        executionBrief: 'Extract helpers. Add vitest setup. Wire integration tests.',
      }),
      'claude',
    );
    // Already large from isHeavyCoding — amplifiers don't change it
    expect(profile.bounds.complexityTier).toBe('large');
  });

  it('does not bump when no amplifiers match', () => {
    const profile = buildExecutionProfile(
      makeResolved({
        title: 'Fix the login button color',
        concreteScore: 6,
        ambiguity: 'none',
        executionBrief: 'Change CSS color from blue to green.',
      }),
      'claude',
    );
    expect(profile.bounds.complexityTier).toBe('small');
  });
});

// --- RuntimeRiskProfile (F.20) ---

describe('createRuntimeRiskProfile', () => {
  it('creates a profile with default values', () => {
    const profile = createRuntimeRiskProfile(false);
    expect(profile.level).toBe('low');
    expect(profile.score).toBe(0);
    expect(profile.files.modifiedCount).toBe(0);
    expect(profile.files.configFilesTouched).toEqual([]);
    expect(profile.files.scopeExpanded).toBe(false);
    expect(profile.errors.totalErrors).toBe(0);
    expect(profile.drift.predictedSimple).toBe(false);
    expect(profile.drift.driftDetected).toBe(false);
  });

  it('records predictedSimple flag', () => {
    const profile = createRuntimeRiskProfile(true);
    expect(profile.drift.predictedSimple).toBe(true);
  });
});

describe('isHighRiskFile', () => {
  it('detects package.json as high risk', () => {
    expect(isHighRiskFile('package.json')).toBe(true);
    expect(isHighRiskFile('src/package.json')).toBe(true);
  });

  it('detects wrangler config as high risk', () => {
    expect(isHighRiskFile('wrangler.jsonc')).toBe(true);
    expect(isHighRiskFile('wrangler.toml')).toBe(true);
  });

  it('detects CI files as high risk', () => {
    expect(isHighRiskFile('.github/workflows/deploy.yml')).toBe(true);
  });

  it('detects tsconfig files as high risk', () => {
    expect(isHighRiskFile('tsconfig.json')).toBe(true);
    expect(isHighRiskFile('tsconfig.worker.json')).toBe(true);
  });

  it('does not flag regular source files', () => {
    expect(isHighRiskFile('src/index.ts')).toBe(false);
    expect(isHighRiskFile('src/utils/helpers.ts')).toBe(false);
    expect(isHighRiskFile('README.md')).toBe(false);
  });
});

describe('updateRuntimeRisk', () => {
  it('stays low with few files and no errors', () => {
    const profile = createRuntimeRiskProfile(false);
    updateRuntimeRisk(profile, [
      { toolName: 'github_read_file', isError: false },
    ], ['src/index.ts']);
    expect(profile.level).toBe('low');
    expect(profile.score).toBeLessThan(15);
  });

  it('detects config file modifications', () => {
    const profile = createRuntimeRiskProfile(false);
    updateRuntimeRisk(profile, [
      { toolName: 'workspace_write_file', isError: false },
    ], ['package.json', 'tsconfig.json']);
    expect(profile.files.configFilesTouched).toContain('package.json');
    expect(profile.files.configFilesTouched).toContain('tsconfig.json');
    expect(profile.score).toBeGreaterThan(0);
  });

  it('detects scope expansion (1 file → 5+ files)', () => {
    const profile = createRuntimeRiskProfile(false);
    // First update: 1 file
    updateRuntimeRisk(profile, [
      { toolName: 'workspace_write_file', isError: false },
    ], ['src/a.ts']);
    expect(profile.files.initialModifiedCount).toBe(1);
    expect(profile.files.scopeExpanded).toBe(false);

    // Second update: now 5 files
    updateRuntimeRisk(profile, [
      { toolName: 'workspace_write_file', isError: false },
    ], ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
    expect(profile.files.scopeExpanded).toBe(true);
  });

  it('accumulates errors across iterations', () => {
    const profile = createRuntimeRiskProfile(false);
    updateRuntimeRisk(profile, [
      { toolName: 'github_api', isError: true },
      { toolName: 'github_read_file', isError: false },
    ], []);
    expect(profile.errors.totalErrors).toBe(1);
    expect(profile.errors.consecutiveErrorIterations).toBe(0); // mixed success/fail

    updateRuntimeRisk(profile, [
      { toolName: 'github_api', isError: true },
    ], []);
    expect(profile.errors.totalErrors).toBe(2);
    expect(profile.errors.consecutiveErrorIterations).toBe(1); // all failed
  });

  it('tracks mutation errors separately', () => {
    const profile = createRuntimeRiskProfile(false);
    updateRuntimeRisk(profile, [
      { toolName: 'github_create_pr', isError: true },
      { toolName: 'github_read_file', isError: true },
    ], []);
    expect(profile.errors.mutationErrors).toBe(1); // only github_create_pr is mutation
    expect(profile.errors.totalErrors).toBe(2);
  });

  it('detects drift when simple task touches many files', () => {
    const profile = createRuntimeRiskProfile(true); // predictedSimple = true
    updateRuntimeRisk(profile, [
      { toolName: 'workspace_write_file', isError: false },
    ], ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    expect(profile.drift.driftDetected).toBe(true);
    expect(profile.drift.driftReason).toContain('5 files');
  });

  it('detects drift when simple task modifies config files', () => {
    const profile = createRuntimeRiskProfile(true);
    updateRuntimeRisk(profile, [
      { toolName: 'workspace_write_file', isError: false },
    ], ['package.json', 'tsconfig.json']);
    expect(profile.drift.driftDetected).toBe(true);
    expect(profile.drift.driftReason).toContain('config files');
  });

  it('does not detect drift for non-simple tasks', () => {
    const profile = createRuntimeRiskProfile(false); // predictedSimple = false
    updateRuntimeRisk(profile, [
      { toolName: 'workspace_write_file', isError: false },
    ], ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']);
    expect(profile.drift.driftDetected).toBe(false);
  });

  it('escalates to high risk with config files + errors', () => {
    const profile = createRuntimeRiskProfile(false);
    // Add config files
    updateRuntimeRisk(profile, [], ['package.json', 'wrangler.jsonc', 'tsconfig.json']);
    // Add several errors
    for (let i = 0; i < 4; i++) {
      updateRuntimeRisk(profile, [
        { toolName: 'github_api', isError: true },
      ], ['package.json', 'wrangler.jsonc', 'tsconfig.json']);
    }
    expect(profile.level).toBe('high');
  });

  it('escalates to critical with drift + config + errors', () => {
    const profile = createRuntimeRiskProfile(true); // simple task
    // Touch many files including config
    const files = ['package.json', 'tsconfig.json', 'a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    updateRuntimeRisk(profile, [], files);
    // Add mutation errors
    for (let i = 0; i < 3; i++) {
      updateRuntimeRisk(profile, [
        { toolName: 'github_create_pr', isError: true },
        { toolName: 'github_api', isError: true },
      ], files);
    }
    expect(profile.level).toBe('critical');
    expect(profile.score).toBeGreaterThanOrEqual(60);
  });
});

describe('formatRuntimeRisk', () => {
  it('formats low-risk profile compactly', () => {
    const profile = createRuntimeRiskProfile(false);
    const formatted = formatRuntimeRisk(profile);
    expect(formatted).toContain('Risk: low (0/100)');
  });

  it('includes config file names', () => {
    const profile = createRuntimeRiskProfile(false);
    updateRuntimeRisk(profile, [], ['package.json']);
    const formatted = formatRuntimeRisk(profile);
    expect(formatted).toContain('package.json');
  });

  it('includes drift reason', () => {
    const profile = createRuntimeRiskProfile(true);
    updateRuntimeRisk(profile, [], ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    const formatted = formatRuntimeRisk(profile);
    expect(formatted).toContain('Drift');
  });
});
