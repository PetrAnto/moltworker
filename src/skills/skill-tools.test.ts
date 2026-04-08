/**
 * Tests for Gecko Skills — Skill Tool Executor
 */

import { describe, it, expect } from 'vitest';
import { getSkillTools, buildSkillToolContext } from './skill-tools';
import type { MoltbotEnv } from '../types';

describe('getSkillTools', () => {
  it('returns filtered tools for orchestra (includes github tools)', () => {
    const tools = getSkillTools('orchestra');
    const names = tools.map(t => t.function.name);
    expect(names).toContain('github_read_file');
    expect(names).toContain('github_push_files');
    expect(names).toContain('web_search');
    expect(names).not.toContain('get_weather');
    expect(names).not.toContain('convert_currency');
  });

  it('returns filtered tools for lyra (fetch + web only)', () => {
    const tools = getSkillTools('lyra');
    const names = tools.map(t => t.function.name);
    expect(names).toContain('fetch_url');
    expect(names).toContain('web_search');
    expect(names).not.toContain('github_push_files');
    expect(names).not.toContain('sandbox_exec');
  });

  it('returns filtered tools for nexus (broad read, no write)', () => {
    const tools = getSkillTools('nexus');
    const names = tools.map(t => t.function.name);
    expect(names).toContain('web_search');
    expect(names).toContain('github_read_file');
    expect(names).toContain('get_crypto');
    expect(names).not.toContain('github_push_files');
    expect(names).not.toContain('sandbox_exec');
  });
});

// Minimal R2 bucket stub — enough for buildSkillToolContext to detect it as
// "available" and for the limiter's `get` call to resolve cleanly.
function createStubR2(): R2Bucket {
  return {
    get: async () => null,
    put: async () => ({}) as R2Object,
  } as unknown as R2Bucket;
}

describe('buildSkillToolContext', () => {
  it('propagates TAVILY_API_KEY from env to the ToolContext', () => {
    const env = {
      MOLTBOT_BUCKET: createStubR2(),
      TAVILY_API_KEY: 'tvly-test-key',
      BRAVE_SEARCH_KEY: 'brave-test-key',
    } as unknown as MoltbotEnv;

    const ctx = buildSkillToolContext(env, 'user-123');

    expect(ctx.tavilyKey).toBe('tvly-test-key');
    expect(ctx.braveSearchKey).toBe('brave-test-key');
  });

  it('attaches a webSearchLimiter when R2 and userId are both present', () => {
    // Regression for PR471 review blocker #2: non-DO paths must enforce
    // rate limits the same way as the DO path.
    const env = {
      MOLTBOT_BUCKET: createStubR2(),
      TAVILY_API_KEY: 'tvly-test-key',
    } as unknown as MoltbotEnv;

    const ctx = buildSkillToolContext(env, 'user-123');

    expect(ctx.webSearchLimiter).toBeDefined();
    // Sanity check that it's actually a limiter (has checkAndIncrement)
    expect(typeof ctx.webSearchLimiter?.checkAndIncrement).toBe('function');
  });

  it('leaves webSearchLimiter undefined when userId is missing', () => {
    const env = {
      MOLTBOT_BUCKET: createStubR2(),
      TAVILY_API_KEY: 'tvly-test-key',
    } as unknown as MoltbotEnv;

    const ctx = buildSkillToolContext(env);

    expect(ctx.webSearchLimiter).toBeUndefined();
  });

  it('leaves webSearchLimiter undefined when R2 is missing', () => {
    const env = {
      TAVILY_API_KEY: 'tvly-test-key',
    } as unknown as MoltbotEnv;

    const ctx = buildSkillToolContext(env, 'user-123');

    expect(ctx.webSearchLimiter).toBeUndefined();
    // Tavily key should still propagate so /info reports it correctly
    expect(ctx.tavilyKey).toBe('tvly-test-key');
  });

  it('limiter reads rate-limit config from env vars (parsed with defaults)', async () => {
    // The env vars should flow through to parseWebSearchLimiterConfig —
    // verify by setting a per-task limit of 1 and confirming the second
    // call blocks.
    const env = {
      MOLTBOT_BUCKET: createStubR2(),
      TAVILY_API_KEY: 'tvly-test-key',
      WEB_SEARCH_TASK_LIMIT: '1',
    } as unknown as MoltbotEnv;

    const ctx = buildSkillToolContext(env, 'user-limit-test');
    const limiter = ctx.webSearchLimiter;
    expect(limiter).toBeDefined();

    const first = await limiter!.checkAndIncrement({ cached: false });
    expect(first.allowed).toBe(true);

    const second = await limiter!.checkAndIncrement({ cached: false });
    expect(second.allowed).toBe(false);
    if (second.allowed === false) {
      expect(second.scope).toBe('task');
    }
  });
});
