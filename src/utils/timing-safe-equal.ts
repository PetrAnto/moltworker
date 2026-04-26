/**
 * Constant-time string comparison.
 *
 * Use whenever comparing a user-supplied secret/token against an expected
 * value. Plain `===` / `!==` short-circuits on the first differing byte,
 * which leaks the matching prefix length and is enough to mount a remote
 * timing attack against any side-channel-observable endpoint.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
