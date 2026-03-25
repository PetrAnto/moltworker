/**
 * Tests for Gecko Skills — Validators
 */

import { describe, it, expect } from 'vitest';
import { assertValid, isNonEmptyString, isPlainObject, safeJsonParse } from './validators';

describe('assertValid', () => {
  it('passes when guard returns true', () => {
    expect(() => assertValid('hello', isNonEmptyString, 'test')).not.toThrow();
  });

  it('throws when guard returns false', () => {
    expect(() => assertValid('', isNonEmptyString, 'test')).toThrow('Invalid test');
    expect(() => assertValid(42, isNonEmptyString, 'test')).toThrow('Invalid test');
  });
});

describe('isNonEmptyString', () => {
  it('returns true for non-empty strings', () => {
    expect(isNonEmptyString('hello')).toBe(true);
    expect(isNonEmptyString(' ')).toBe(true);
  });

  it('returns false for empty string and non-strings', () => {
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(42)).toBe(false);
  });
});

describe('isPlainObject', () => {
  it('returns true for plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ key: 'value' })).toBe(true);
  });

  it('returns false for non-objects', () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject('string')).toBe(false);
    expect(isPlainObject(42)).toBe(false);
  });
});

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"key": "value"}')).toEqual({ key: 'value' });
    expect(safeJsonParse('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('returns null for invalid JSON', () => {
    expect(safeJsonParse('not json')).toBeNull();
    expect(safeJsonParse('')).toBeNull();
  });
});
