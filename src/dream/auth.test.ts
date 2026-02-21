import { describe, it, expect } from 'vitest';
import { verifyDreamSecret, checkTrustLevel } from './auth';

describe('verifyDreamSecret', () => {
  const secret = 'test-secret-12345';

  it('should accept valid bearer token', () => {
    const result = verifyDreamSecret(`Bearer ${secret}`, secret);
    expect(result.ok).toBe(true);
  });

  it('should reject missing header', () => {
    const result = verifyDreamSecret(undefined, secret);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Missing Authorization');
  });

  it('should reject wrong token', () => {
    const result = verifyDreamSecret('Bearer wrong-token', secret);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid secret');
  });

  it('should reject non-Bearer scheme', () => {
    const result = verifyDreamSecret(`Basic ${secret}`, secret);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Bearer');
  });

  it('should reject when secret not configured', () => {
    const result = verifyDreamSecret(`Bearer ${secret}`, undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not configured');
  });

  it('should reject empty auth header', () => {
    const result = verifyDreamSecret('', secret);
    expect(result.ok).toBe(false);
  });
});

describe('checkTrustLevel', () => {
  it('should allow builder', () => {
    expect(checkTrustLevel('builder').ok).toBe(true);
  });

  it('should allow shipper', () => {
    expect(checkTrustLevel('shipper').ok).toBe(true);
  });

  it('should reject observer', () => {
    const result = checkTrustLevel('observer');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Insufficient trust level');
  });

  it('should reject planner', () => {
    const result = checkTrustLevel('planner');
    expect(result.ok).toBe(false);
  });

  it('should reject undefined', () => {
    const result = checkTrustLevel(undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Missing dreamTrustLevel');
  });

  it('should reject unknown level', () => {
    const result = checkTrustLevel('admin');
    expect(result.ok).toBe(false);
  });
});
