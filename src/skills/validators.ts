/**
 * Gecko Skills — Validators
 *
 * Generic runtime type-guard validators for skill inputs/outputs.
 */

/**
 * Assert that a value satisfies a type guard. Throws with a descriptive
 * message if validation fails.
 *
 * @param value - The value to validate
 * @param guard - A type-guard function returning true if valid
 * @param label - Human-readable label for error messages
 */
export function assertValid<T>(
  value: unknown,
  guard: (v: unknown) => v is T,
  label: string,
): asserts value is T {
  if (!guard(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)?.slice(0, 200)}`);
  }
}

/** Check that a value is a non-empty string. */
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Check that a value is a plain object (not null, not array). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Safely parse JSON, returning null on failure. */
export function safeJsonParse<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
