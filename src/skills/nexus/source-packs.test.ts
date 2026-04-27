/**
 * Tests for nexus source-pack helpers.
 */

import { describe, it, expect } from 'vitest';
import { isToolError } from './source-packs';

describe('isToolError', () => {
  it('matches the canonical "Error: ..." prefix', () => {
    expect(isToolError('Error: Tool "fetch_url" is not allowed for skill "nexus".')).toBe(true);
    expect(isToolError('Error: Invalid JSON arguments: {bad}')).toBe(true);
  });

  it('matches the "Error executing <tool>: ..." prefix surfaced by caught exceptions', () => {
    // This is the path that previously slipped through, causing Reddit 403
    // and Wikipedia 404 to be counted as successful evidence sources.
    expect(isToolError('Error executing fetch_url: HTTP 403: Forbidden')).toBe(true);
    expect(isToolError('Error executing web_search: HTTP 500')).toBe(true);
  });

  it('does not flag normal payloads as errors', () => {
    expect(isToolError('{"hits":[]}')).toBe(false);
    expect(isToolError('Some search result text')).toBe(false);
    expect(isToolError('Article about Error handling in Go')).toBe(false);
  });
});
