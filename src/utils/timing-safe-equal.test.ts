import { describe, it, expect } from 'vitest';
import { timingSafeEqual } from './timing-safe-equal';

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('a', 'a')).toBe(true);
    expect(timingSafeEqual('Bearer abc123', 'Bearer abc123')).toBe(true);
  });

  it('returns false for differing equal-length strings', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('Bearer abc', 'Bearer abd')).toBe(false);
  });

  it('returns false for differing-length strings', () => {
    expect(timingSafeEqual('a', 'ab')).toBe(false);
    expect(timingSafeEqual('ab', 'a')).toBe(false);
    expect(timingSafeEqual('', 'x')).toBe(false);
    expect(timingSafeEqual('x', '')).toBe(false);
  });

  it('does not collide when one string is a prefix of the other', () => {
    // The length-difference seed must prevent abc/abcdef from XORing to 0.
    expect(timingSafeEqual('abc', 'abcdef')).toBe(false);
    expect(timingSafeEqual('abcdef', 'abc')).toBe(false);
  });

  it('handles secret-shaped tokens correctly', () => {
    const a = 'sk-' + 'a'.repeat(48);
    const b = 'sk-' + 'a'.repeat(48);
    const c = 'sk-' + 'a'.repeat(47) + 'b';
    expect(timingSafeEqual(a, b)).toBe(true);
    expect(timingSafeEqual(a, c)).toBe(false);
  });
});
