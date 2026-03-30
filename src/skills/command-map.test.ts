/**
 * Tests for Gecko Skills — Command Map + Flag Parser
 */

import { describe, it, expect } from 'vitest';
import {
  COMMAND_SKILL_MAP,
  lookupCommand,
  parseFlags,
  parseCommandMessage,
} from './command-map';

describe('COMMAND_SKILL_MAP', () => {
  it('contains all 18 expected command mappings', () => {
    const commands = Object.keys(COMMAND_SKILL_MAP);
    expect(commands.length).toBe(18);
  });

  it('maps /orch to orchestra', () => {
    expect(COMMAND_SKILL_MAP['/orch']).toEqual({
      skillId: 'orchestra',
      defaultSubcommand: 'run',
    });
  });

  it('maps /write to lyra', () => {
    expect(COMMAND_SKILL_MAP['/write']).toEqual({
      skillId: 'lyra',
      defaultSubcommand: 'write',
    });
  });

  it('maps /research to nexus', () => {
    expect(COMMAND_SKILL_MAP['/research']).toEqual({
      skillId: 'nexus',
      defaultSubcommand: 'research',
    });
  });

  it('maps /save and /bookmark to spark save', () => {
    expect(COMMAND_SKILL_MAP['/save']).toEqual({ skillId: 'spark', defaultSubcommand: 'save' });
    expect(COMMAND_SKILL_MAP['/bookmark']).toEqual({ skillId: 'spark', defaultSubcommand: 'save' });
  });
});

describe('lookupCommand', () => {
  it('returns mapping for known command', () => {
    expect(lookupCommand('/orch')).toEqual({ skillId: 'orchestra', defaultSubcommand: 'run' });
  });

  it('handles @botname suffix', () => {
    expect(lookupCommand('/orch@mybot')).toEqual({ skillId: 'orchestra', defaultSubcommand: 'run' });
  });

  it('is case insensitive', () => {
    expect(lookupCommand('/WRITE')).toEqual({ skillId: 'lyra', defaultSubcommand: 'write' });
  });

  it('returns undefined for unknown commands', () => {
    expect(lookupCommand('/help')).toBeUndefined();
    expect(lookupCommand('/models')).toBeUndefined();
  });
});

describe('parseFlags', () => {
  it('parses --key value flags', () => {
    const { flags, rest } = parseFlags('Hello world --for twitter --tone casual');
    expect(flags).toEqual({ for: 'twitter', tone: 'casual' });
    expect(rest).toBe('Hello world');
  });

  it('parses quoted values', () => {
    const { flags, rest } = parseFlags('My text --audience "enterprise devs"');
    expect(flags).toEqual({ audience: 'enterprise devs' });
    expect(rest).toBe('My text');
  });

  it('parses boolean flags', () => {
    const { flags } = parseFlags('Something --verbose');
    expect(flags).toEqual({ verbose: 'true' });
  });

  it('returns empty flags for no flags', () => {
    const { flags, rest } = parseFlags('Just some text');
    expect(flags).toEqual({});
    expect(rest).toBe('Just some text');
  });

  it('handles empty input', () => {
    const { flags, rest } = parseFlags('');
    expect(flags).toEqual({});
    expect(rest).toBe('');
  });
});

describe('parseCommandMessage', () => {
  it('parses /write with flags and text', () => {
    const result = parseCommandMessage('/write --for twitter Check out this feature');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('/write');
    expect(result!.subcommand).toBe('write');
    expect(result!.flags).toEqual({ for: 'twitter' });
    expect(result!.text).toBe('Check out this feature');
    expect(result!.mapping.skillId).toBe('lyra');
  });

  it('parses /orch init with subcommand', () => {
    const result = parseCommandMessage('/orch init Build a REST API');
    expect(result).not.toBeNull();
    expect(result!.subcommand).toBe('init');
    expect(result!.text).toBe('Build a REST API');
  });

  it('defaults subcommand when none given', () => {
    const result = parseCommandMessage('/orch owner/repo');
    expect(result).not.toBeNull();
    expect(result!.subcommand).toBe('run');
    expect(result!.text).toBe('owner/repo');
  });

  it('does NOT parse first word as subcommand for single-command skills', () => {
    // "/write headline ideas for X" should keep subcommand='write', text='headline ideas for X'
    const result = parseCommandMessage('/write headline ideas for my blog');
    expect(result).not.toBeNull();
    expect(result!.subcommand).toBe('write');
    expect(result!.text).toBe('headline ideas for my blog');
  });

  it('DOES parse subcommand for multi-subcommand skills like orchestra', () => {
    const result = parseCommandMessage('/orch status');
    expect(result).not.toBeNull();
    expect(result!.subcommand).toBe('status');
    expect(result!.text).toBe('');
  });

  it('returns null for non-skill commands', () => {
    expect(parseCommandMessage('/help')).toBeNull();
    expect(parseCommandMessage('/models')).toBeNull();
    expect(parseCommandMessage('not a command')).toBeNull();
  });

  it('handles command-only input', () => {
    const result = parseCommandMessage('/brainstorm');
    expect(result).not.toBeNull();
    expect(result!.mapping.skillId).toBe('spark');
    expect(result!.subcommand).toBe('brainstorm');
    expect(result!.text).toBe('');
  });

  it('maps /ideas to list subcommand, not brainstorm', () => {
    const result = parseCommandMessage('/ideas');
    expect(result).not.toBeNull();
    expect(result!.mapping.skillId).toBe('spark');
    expect(result!.subcommand).toBe('list');
  });
});
