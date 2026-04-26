/**
 * buildSkillEnv contract tests.
 *
 * Slice 3's audit DO dispatch raised a sharp question (GPT review of PR 507):
 * if the DO doesn't restore MOLTBOT_BUCKET into the rebuilt skillEnv, then
 * /audit --analyze dispatch will "succeed" from the worker but fail inside
 * the DO at runtime-WASM loading. This file pins the contract so a
 * regression on the env-rebuild path fails noisily in CI rather than
 * mysteriously in production.
 *
 * Lives in a dedicated file (not lifecycle.test.ts) because the assertion
 * is purely on the env-rebuild logic — no need for the heavyweight DO
 * + OpenRouter mocks that lifecycle uses.
 */

import { describe, it, expect, vi } from 'vitest';

// task-processor.ts pulls in the Cloudflare runtime module; stub it so the
// import succeeds in Node. We don't instantiate TaskProcessor here — we
// only call the pure buildSkillEnv() helper — so the stubs can be minimal.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class { constructor(public state: unknown, public env: unknown) {} },
}));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

import { buildSkillEnv, type SkillTaskRequest, type TaskProcessorEnv } from './task-processor';

function fakeDoEnv(overrides: Partial<TaskProcessorEnv> = {}): TaskProcessorEnv {
  return {
    MOLTBOT_BUCKET: { _id: 'bucket-1' } as unknown as R2Bucket,
    NEXUS_KV: { _id: 'kv-1' } as unknown as KVNamespace,
    OPENROUTER_API_KEY: 'do-openrouter-key',
    GITHUB_TOKEN: 'do-github-token',
    BRAVE_SEARCH_KEY: 'do-brave',
    TAVILY_API_KEY: 'do-tavily',
    CLOUDFLARE_API_TOKEN: 'do-cf',
    ANTHROPIC_API_KEY: 'do-anthropic',
    DASHSCOPE_API_KEY: 'do-dashscope',
    MOONSHOT_API_KEY: 'do-moonshot',
    DEEPSEEK_API_KEY: 'do-deepseek',
    NVIDIA_NIM_API_KEY: 'do-nvidia',
    ACONTEXT_API_KEY: 'do-acontext',
    ACONTEXT_BASE_URL: 'https://acontext.example',
    ARTIFICIAL_ANALYSIS_KEY: 'do-aa',
    WEB_SEARCH_USER_DAILY_LIMIT: '20',
    WEB_SEARCH_TASK_LIMIT: '5',
    WEB_SEARCH_GLOBAL_DAILY_LIMIT: '200',
    WEB_SEARCH_ALLOWLIST_USERS: '1,2,3',
    ...overrides,
  };
}

function fakeSkillTaskRequest(overrides: Partial<SkillTaskRequest> = {}): SkillTaskRequest {
  return {
    kind: 'skill',
    taskId: 'task-1',
    chatId: 12345,
    userId: 'user-1',
    telegramToken: 'tg-token',
    skillRequest: {
      skillId: 'audit',
      subcommand: 'plan',
      text: 'octocat/demo',
      flags: {},
      transport: 'telegram',
      userId: 'user-1',
      env: undefined as never, // wire payload — env is stripped by the dispatcher
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// THE finding: MOLTBOT_BUCKET reaches the skill via skillEnv
// ---------------------------------------------------------------------------

describe('buildSkillEnv — bindings flow through from doEnv (closes GPT slice-3 finding #1)', () => {
  it('passes the live MOLTBOT_BUCKET reference through to skillEnv (audit needs this for R2 grammars + runtime WASM)', () => {
    const doEnv = fakeDoEnv();
    const env = buildSkillEnv(doEnv, fakeSkillTaskRequest());
    // Identity equality — not just "some bucket exists" but THE bucket from doEnv.
    expect(env.MOLTBOT_BUCKET).toBe(doEnv.MOLTBOT_BUCKET);
  });

  it('passes the live NEXUS_KV reference through to skillEnv', () => {
    const doEnv = fakeDoEnv();
    const env = buildSkillEnv(doEnv, fakeSkillTaskRequest());
    expect(env.NEXUS_KV).toBe(doEnv.NEXUS_KV);
  });

  it('clears TASK_PROCESSOR so nested skills cannot re-dispatch (we are already in a DO)', () => {
    const doEnv = fakeDoEnv();
    const env = buildSkillEnv(doEnv, fakeSkillTaskRequest());
    expect(env.TASK_PROCESSOR).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Secret precedence: request override wins; DO env is the fallback
// ---------------------------------------------------------------------------

describe('buildSkillEnv — secret precedence', () => {
  it('uses the request secret when supplied (per-task override path)', () => {
    const env = buildSkillEnv(fakeDoEnv(), fakeSkillTaskRequest({
      openrouterKey: 'override-openrouter',
      githubToken: 'override-gh',
    }));
    expect(env.OPENROUTER_API_KEY).toBe('override-openrouter');
    expect(env.GITHUB_TOKEN).toBe('override-gh');
  });

  it('falls back to the DO env when the request omits the secret', () => {
    const env = buildSkillEnv(fakeDoEnv(), fakeSkillTaskRequest());
    expect(env.OPENROUTER_API_KEY).toBe('do-openrouter-key');
    expect(env.GITHUB_TOKEN).toBe('do-github-token');
    expect(env.ANTHROPIC_API_KEY).toBe('do-anthropic');
    expect(env.DASHSCOPE_API_KEY).toBe('do-dashscope');
    expect(env.MOONSHOT_API_KEY).toBe('do-moonshot');
  });

  it('takes ACONTEXT secrets only from the DO env (no request override path)', () => {
    const env = buildSkillEnv(fakeDoEnv(), fakeSkillTaskRequest());
    expect(env.ACONTEXT_API_KEY).toBe('do-acontext');
    expect(env.ACONTEXT_BASE_URL).toBe('https://acontext.example');
  });
});

// ---------------------------------------------------------------------------
// Negative path: missing doEnv binding propagates as undefined
// ---------------------------------------------------------------------------

describe('buildSkillEnv — missing doEnv bindings', () => {
  it('returns env with MOLTBOT_BUCKET=undefined when the DO has no bucket binding', () => {
    const env = buildSkillEnv(fakeDoEnv({ MOLTBOT_BUCKET: undefined }), fakeSkillTaskRequest());
    // The skill is responsible for handling this (audit's runtime-WASM gate
    // refuses with a clear message). Returning undefined > silently passing
    // a hollow {}.
    expect(env.MOLTBOT_BUCKET).toBeUndefined();
  });
});
