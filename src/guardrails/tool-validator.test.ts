import { describe, it, expect } from 'vitest';
import {
  validateToolResult,
  isMutationToolCall,
  createToolErrorTracker,
  trackToolError,
  generateCompletionWarning,
  adjustConfidence,
  isTransientApiError,
  isPermanentApiError,
} from './tool-validator';

describe('validateToolResult', () => {
  it('detects explicit error prefix', () => {
    const result = validateToolResult('get_weather', 'Error: API timeout after 30s');
    expect(result.isError).toBe(true);
    expect(result.errorType).toBe('timeout');
    expect(result.severity).toBe('low');
  });

  it('detects "Error executing" prefix', () => {
    const result = validateToolResult('fetch_url', 'Error executing fetch: 500 server error');
    expect(result.isError).toBe(true);
    expect(result.errorType).toBe('http_error');
    expect(result.severity).toBe('low');
  });

  it('detects HTTP 404 with error keyword', () => {
    const result = validateToolResult('github_read_file', 'GitHub API returned 404: Not found');
    expect(result.isError).toBe(true);
    expect(result.errorType).toBe('not_found');
  });

  it('detects 403 forbidden as auth error', () => {
    const result = validateToolResult('github_api', 'Error: 403 Forbidden - bad credentials');
    expect(result.isError).toBe(true);
    expect(result.errorType).toBe('auth_error');
    expect(result.severity).toBe('high'); // mutation tool
  });

  it('detects 429 rate limit', () => {
    const result = validateToolResult('web_search', 'Error: 429 Too Many Requests - rate limit exceeded');
    expect(result.isError).toBe(true);
    expect(result.errorType).toBe('rate_limit');
    expect(result.severity).toBe('medium'); // rate limit is always medium
  });

  it('returns no error for successful results', () => {
    const result = validateToolResult('get_weather', 'Weather: Sunny, 21°C, humidity 45%');
    expect(result.isError).toBe(false);
    expect(result.errorType).toBeUndefined();
  });

  it('returns no error for results with numbers that look like HTTP codes', () => {
    // "500" appears but without error keywords
    const result = validateToolResult('get_crypto', 'BTC price: $50,000.00, market cap: $500B');
    expect(result.isError).toBe(false);
  });

  it('detects server error in tool result body', () => {
    const result = validateToolResult('fetch_url', 'Response: 502 Bad Gateway - server error occurred');
    expect(result.isError).toBe(true);
    expect(result.errorType).toBe('http_error');
  });

  it('classifies Cloudflare 530 origin-unreachable as http_error', () => {
    // Regression: previously fell through to generic_error because 530 was not
    // in the 500|502|503|504 pattern — meant the transient-outage guardrail
    // could not detect it and the model kept retrying against a dead service.
    const result = validateToolResult(
      'run_code',
      'Error executing run_code: Acontext API POST /api/v1/sandbox/execute failed: 530 error code: 1016',
    );
    expect(result.isError).toBe(true);
    expect(result.errorType).toBe('http_error');
  });

  it('classifies invalid args errors', () => {
    const result = validateToolResult('generate_chart', 'Error: Invalid JSON arguments: {broken');
    expect(result.isError).toBe(true);
    expect(result.errorType).toBe('invalid_args');
  });

  it('mutation tool errors get high severity', () => {
    const result = validateToolResult('github_create_pr', 'Error: 422 Unprocessable Entity - branch already exists');
    expect(result.isError).toBe(true);
    expect(result.severity).toBe('high');
  });

  it('sandbox_exec errors get high severity', () => {
    const result = validateToolResult('sandbox_exec', 'Error: Command failed with exit code 1');
    expect(result.isError).toBe(true);
    expect(result.severity).toBe('high');
  });

  it('truncates message to 200 chars', () => {
    const longError = 'Error: ' + 'x'.repeat(300);
    const result = validateToolResult('fetch_url', longError);
    expect(result.isError).toBe(true);
    expect(result.message!.length).toBe(200);
  });
});

describe('isMutationToolCall', () => {
  it('github_create_pr is always mutation', () => {
    expect(isMutationToolCall('github_create_pr', '{}')).toBe(true);
  });

  it('sandbox_exec is always mutation', () => {
    expect(isMutationToolCall('sandbox_exec', '{"command":"ls"}')).toBe(true);
  });

  it('github_api GET is not mutation', () => {
    expect(isMutationToolCall('github_api', '{"method":"GET","endpoint":"/repos/test/test"}')).toBe(false);
  });

  it('github_api POST is mutation', () => {
    expect(isMutationToolCall('github_api', '{"method":"POST","endpoint":"/repos/test/test/issues"}')).toBe(true);
  });

  it('github_api DELETE is mutation', () => {
    expect(isMutationToolCall('github_api', '{"method":"DELETE","endpoint":"/repos/test/test/branches/old"}')).toBe(true);
  });

  it('github_api with invalid args defaults to mutation', () => {
    expect(isMutationToolCall('github_api', 'not json')).toBe(true);
  });

  it('read-only tools are not mutations', () => {
    expect(isMutationToolCall('get_weather', '{"lat":0,"lon":0}')).toBe(false);
    expect(isMutationToolCall('fetch_url', '{"url":"https://example.com"}')).toBe(false);
    expect(isMutationToolCall('web_search', '{"query":"test"}')).toBe(false);
  });
});

describe('ToolErrorTracker', () => {
  it('starts empty', () => {
    const tracker = createToolErrorTracker();
    expect(tracker.totalErrors).toBe(0);
    expect(tracker.mutationErrors).toBe(0);
    expect(tracker.errors).toHaveLength(0);
  });

  it('tracks read-only tool errors', () => {
    const tracker = createToolErrorTracker();
    const validation = validateToolResult('get_weather', 'Error: timeout');
    trackToolError(tracker, 'get_weather', validation, 3, '{"lat":0,"lon":0}');

    expect(tracker.totalErrors).toBe(1);
    expect(tracker.mutationErrors).toBe(0);
    expect(tracker.errors[0]).toEqual({ tool: 'get_weather', errorType: 'timeout', iteration: 3 });
  });

  it('tracks mutation tool errors separately', () => {
    const tracker = createToolErrorTracker();
    const validation = validateToolResult('github_create_pr', 'Error: 422 failed to create branch');
    trackToolError(tracker, 'github_create_pr', validation, 5, '{"owner":"test"}');

    expect(tracker.totalErrors).toBe(1);
    expect(tracker.mutationErrors).toBe(1);
  });

  it('ignores non-error results', () => {
    const tracker = createToolErrorTracker();
    const validation = validateToolResult('get_weather', 'Sunny 21°C');
    trackToolError(tracker, 'get_weather', validation, 1, '{"lat":0}');

    expect(tracker.totalErrors).toBe(0);
  });

  it('tracks github_api POST errors as mutation', () => {
    const tracker = createToolErrorTracker();
    const validation = validateToolResult('github_api', 'Error: 403 Forbidden');
    trackToolError(tracker, 'github_api', validation, 2, '{"method":"POST","endpoint":"/repos/test/issues"}');

    expect(tracker.mutationErrors).toBe(1);
  });

  it('tracks github_api GET errors as non-mutation', () => {
    const tracker = createToolErrorTracker();
    const validation = validateToolResult('github_api', 'Error: 404 Not found');
    trackToolError(tracker, 'github_api', validation, 2, '{"method":"GET","endpoint":"/repos/test/issues"}');

    expect(tracker.totalErrors).toBe(1);
    expect(tracker.mutationErrors).toBe(0);
  });
});

describe('isTransientApiError', () => {
  it('classifies 502 Bad Gateway as transient', () => {
    expect(isTransientApiError('HTTP 502 Bad Gateway')).toBe(true);
  });

  it('classifies 503 Service Unavailable as transient', () => {
    expect(isTransientApiError('Error: 503 Service Unavailable')).toBe(true);
  });

  it('classifies 504 Gateway Timeout as transient', () => {
    expect(isTransientApiError('504 Gateway Timeout')).toBe(true);
  });

  it('classifies 429 rate limit as transient', () => {
    expect(isTransientApiError('429 Too Many Requests - rate limit exceeded')).toBe(true);
  });

  it('classifies timeout errors as transient', () => {
    expect(isTransientApiError('Streaming read timeout (no data for 45s after 12 chunks)')).toBe(true);
  });

  it('classifies overloaded/capacity errors as transient', () => {
    expect(isTransientApiError('Model is currently overloaded')).toBe(true);
    expect(isTransientApiError('Server at capacity, please retry')).toBe(true);
  });

  it('classifies Cloudflare origin errors (520-530) as transient', () => {
    // Cloudflare returns 520-527 when origin misbehaves and 530 when origin is
    // unreachable. 1016 is the DNS sub-code reported inside 530 bodies.
    expect(isTransientApiError('Acontext API POST /api/v1/sessions failed: 530 error code: 1016')).toBe(true);
    expect(isTransientApiError('Error: 521 Web Server Is Down')).toBe(true);
    expect(isTransientApiError('522 Connection Timed Out')).toBe(true);
    expect(isTransientApiError('524 A Timeout Occurred')).toBe(true);
  });

  it('classifies "origin unreachable" and "connection lost" as transient', () => {
    expect(isTransientApiError('Origin unreachable')).toBe(true);
    expect(isTransientApiError('Network connection lost')).toBe(true);
  });

  it('does NOT classify 401 as transient', () => {
    expect(isTransientApiError('401 Unauthorized')).toBe(false);
  });

  it('does NOT classify 422 as transient', () => {
    expect(isTransientApiError('422 Unprocessable Entity')).toBe(false);
  });

  it('does NOT classify generic errors as transient', () => {
    expect(isTransientApiError('Something went wrong')).toBe(false);
  });
});

describe('isPermanentApiError', () => {
  it('classifies 401 Unauthorized as permanent', () => {
    expect(isPermanentApiError('401 Unauthorized - invalid key')).toBe(true);
  });

  it('classifies 403 Forbidden as permanent', () => {
    expect(isPermanentApiError('403 Forbidden - bad credentials')).toBe(true);
  });

  it('classifies 402 Payment Required as permanent', () => {
    expect(isPermanentApiError('402 Payment Required')).toBe(true);
  });

  it('does NOT classify 429 as permanent', () => {
    expect(isPermanentApiError('429 Too Many Requests')).toBe(false);
  });

  it('does NOT classify 503 as permanent', () => {
    expect(isPermanentApiError('503 Service Unavailable')).toBe(false);
  });

  it('does NOT classify timeout as permanent', () => {
    expect(isPermanentApiError('Connection timed out')).toBe(false);
  });
});

describe('generateCompletionWarning', () => {
  it('returns empty string when no mutation errors', () => {
    const tracker = createToolErrorTracker();
    expect(generateCompletionWarning(tracker)).toBe('');
  });

  it('returns empty string when only read errors', () => {
    const tracker = createToolErrorTracker();
    const validation = validateToolResult('get_weather', 'Error: timeout');
    trackToolError(tracker, 'get_weather', validation, 1, '{}');

    expect(generateCompletionWarning(tracker)).toBe('');
  });

  it('returns warning when mutation errors exist', () => {
    const tracker = createToolErrorTracker();
    const validation = validateToolResult('github_create_pr', 'Error: 422 branch exists');
    trackToolError(tracker, 'github_create_pr', validation, 3, '{}');

    const warning = generateCompletionWarning(tracker);
    expect(warning).toContain('1 mutation tool error(s)');
    expect(warning).toContain('github_create_pr');
    expect(warning).toContain('Verify');
  });

  it('lists multiple mutation tool names', () => {
    const tracker = createToolErrorTracker();

    const v1 = validateToolResult('github_create_pr', 'Error: 422 failed');
    trackToolError(tracker, 'github_create_pr', v1, 1, '{}');

    const v2 = validateToolResult('sandbox_exec', 'Error: command failed');
    trackToolError(tracker, 'sandbox_exec', v2, 2, '{"command":"test"}');

    const warning = generateCompletionWarning(tracker);
    expect(warning).toContain('2 mutation tool error(s)');
    expect(warning).toContain('github_create_pr');
    expect(warning).toContain('sandbox_exec');
  });
});

describe('adjustConfidence', () => {
  it('does not adjust when no errors', () => {
    const tracker = createToolErrorTracker();
    const result = adjustConfidence('High', tracker);
    expect(result.confidence).toBe('High');
    expect(result.reason).toBe('');
  });

  it('downgrades High to Medium on mutation errors', () => {
    const tracker = createToolErrorTracker();
    const v = validateToolResult('github_create_pr', 'Error: 422 failed');
    trackToolError(tracker, 'github_create_pr', v, 1, '{}');

    const result = adjustConfidence('High', tracker);
    expect(result.confidence).toBe('Medium');
    expect(result.reason).toContain('mutation tool error');
  });

  it('keeps Low as Low on mutation errors', () => {
    const tracker = createToolErrorTracker();
    const v = validateToolResult('github_api', 'Error: 403 denied');
    trackToolError(tracker, 'github_api', v, 1, '{"method":"POST"}');

    const result = adjustConfidence('Low', tracker);
    expect(result.confidence).toBe('Low');
  });

  it('downgrades High to Medium on many read-only errors', () => {
    const tracker = createToolErrorTracker();
    for (let i = 0; i < 3; i++) {
      const v = validateToolResult('fetch_url', 'Error: 500 server error');
      trackToolError(tracker, 'fetch_url', v, i, '{}');
    }

    const result = adjustConfidence('High', tracker);
    expect(result.confidence).toBe('Medium');
    expect(result.reason).toContain('3 tool errors');
  });

  it('does not adjust Medium on few read-only errors', () => {
    const tracker = createToolErrorTracker();
    const v = validateToolResult('fetch_url', 'Error: 500 server error');
    trackToolError(tracker, 'fetch_url', v, 1, '{}');

    const result = adjustConfidence('Medium', tracker);
    expect(result.confidence).toBe('Medium');
    expect(result.reason).toBe('');
  });
});
