/**
 * Constant-time string comparison.
 *
 * Use whenever comparing a user-supplied secret/token against an expected
 * value. Plain `===` / `!==` short-circuits on the first differing byte,
 * which leaks the matching prefix length and is enough to mount a remote
 * timing attack against any side-channel-observable endpoint.
 *
 * The implementation runs a fixed-length loop over `max(a.length, b.length)`
 * so the work done is independent of where (or whether) the strings agree,
 * and the length difference itself is folded into `result`. An early return
 * on length mismatch would still leak the expected token's length through
 * timing — usually low-impact but easy to avoid.
 *
 * Comparison is over UTF-16 code units, which is fine for the secrets we
 * handle (tokens are ASCII / hex / base64 — no surrogate pairs).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  // Seed `result` with the length-difference so unequal-length inputs can't
  // collide to 0 even if every overlapping char happens to match.
  let result = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    // charCodeAt returns NaN past end-of-string; `| 0` coerces to int.
    result |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return result === 0;
}
