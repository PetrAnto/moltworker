/**
 * Dream Machine trust level authentication.
 *
 * Validates the JWT from Storia that includes the dreamTrustLevel claim.
 * Only 'builder' and 'shipper' trust levels can trigger builds.
 */

import type { DreamTrustLevel } from './types';
import { timingSafeEqual } from '../utils/timing-safe-equal';

const ALLOWED_TRUST_LEVELS: DreamTrustLevel[] = ['builder', 'shipper'];

interface DreamJWTPayload {
  sub: string;
  dreamTrustLevel: DreamTrustLevel;
  exp: number;
}

/**
 * Verify a Dream Machine shared-secret Bearer token.
 * In the MVP, this is a simple shared secret check.
 * The trust level is included in the request body (job.userId is authenticated by Storia).
 */
export function verifyDreamSecret(
  authHeader: string | undefined,
  expectedSecret: string | undefined
): { ok: boolean; error?: string } {
  if (!expectedSecret) {
    return { ok: false, error: 'STORIA_MOLTWORKER_SECRET not configured' };
  }

  if (!authHeader) {
    return { ok: false, error: 'Missing Authorization header' };
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return { ok: false, error: 'Invalid Authorization header format (expected Bearer <token>)' };
  }

  const token = parts[1];

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(token, expectedSecret)) {
    return { ok: false, error: 'Invalid secret' };
  }

  return { ok: true };
}

/**
 * Check if a trust level is sufficient for Dream Build.
 */
export function checkTrustLevel(level: string | undefined): { ok: boolean; error?: string } {
  if (!level) {
    return { ok: false, error: 'Missing dreamTrustLevel' };
  }

  if (!ALLOWED_TRUST_LEVELS.includes(level as DreamTrustLevel)) {
    return {
      ok: false,
      error: `Insufficient trust level: ${level}. Required: ${ALLOWED_TRUST_LEVELS.join(' or ')}`,
    };
  }

  return { ok: true };
}
