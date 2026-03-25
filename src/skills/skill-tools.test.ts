/**
 * Tests for Gecko Skills — Skill Tool Executor
 */

import { describe, it, expect } from 'vitest';
import { getSkillTools } from './skill-tools';

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
