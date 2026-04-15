/**
 * Configuration constants for Moltbot Sandbox
 */

/** Port that the Moltbot gateway listens on inside the container */
export const MOLTBOT_PORT = 18789;

/** Maximum time to wait for Moltbot to start (3 minutes) */
export const STARTUP_TIMEOUT_MS = 180_000;

/**
 * Timeout for `sandbox.containerFetch(...)` on HTML requests.
 *
 * A stuck gateway can otherwise burn the Worker wall-clock budget (30s) and
 * yield a 1101 instead of the loading page. HTML-only because non-HTML
 * responses (SSE, large downloads) may legitimately take longer.
 */
export const HTML_FETCH_TIMEOUT_MS = 15_000;

/**
 * Timeout for reading the body of an HTML response from the gateway.
 * Prevents a hung/streaming body from draining CPU time after the headers arrive.
 */
export const HTML_BODY_READ_TIMEOUT_MS = 10_000;

/**
 * Poll interval when waiting for the gateway port to close after `killGateway()`.
 * Short enough to restart quickly, long enough to avoid hammering the container.
 */
export const GATEWAY_SHUTDOWN_POLL_INTERVAL_MS = 250;

/**
 * Maximum time to wait for the gateway port to close after `killGateway()`.
 * After this we stop polling and return, letting the next spawn attempt handle
 * the edge case of a stuck port.
 */
export const GATEWAY_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * R2 bucket name for persistent storage.
 * Can be overridden via R2_BUCKET_NAME env var for test isolation.
 */
export function getR2BucketName(env?: { R2_BUCKET_NAME?: string }): string {
  return env?.R2_BUCKET_NAME || 'moltbot-data';
}
