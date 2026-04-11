#!/usr/bin/env node
/**
 * Codex auth fs.watch helper.
 *
 * Watches ~/.codex/auth.json for modifications and triggers an immediate
 * `rclone copyto` to R2 on every change. Debounced at 500ms to collapse
 * bursty writes (Codex CLI may touch the file multiple times during a
 * single refresh exchange).
 *
 * Runs alongside the 30s bulk rclone sync loop in start-openclaw.sh. The
 * bulk loop is the safety net; this watcher is the fast path that catches
 * refreshed tokens before they can be lost to a container eviction.
 *
 * Environment:
 *   CODEX_DIR     — directory containing auth.json (default: /root/.codex)
 *   R2_BUCKET     — R2 bucket name (required; no default)
 *   WATCH_DEBOUNCE_MS — debounce window in ms (default: 500)
 *
 * Exit behavior: this script is deliberately long-running. Any uncaught
 * error is logged and the process exits; the parent supervisor (bash &)
 * will not restart it automatically, which is the right call — if the
 * watcher is broken, the 30s bulk loop is still catching changes and we
 * don't want a restart storm masking the underlying issue.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';

const CODEX_DIR = process.env.CODEX_DIR || '/root/.codex';
const R2_BUCKET = process.env.R2_BUCKET;
const AUTH_FILE = join(CODEX_DIR, 'auth.json');
const DEBOUNCE_MS = Number(process.env.WATCH_DEBOUNCE_MS || 500);

if (!R2_BUCKET) {
  console.error('[codex-watcher] R2_BUCKET env var not set, exiting');
  process.exit(1);
}

if (!existsSync(CODEX_DIR)) {
  console.error(`[codex-watcher] ${CODEX_DIR} does not exist, exiting`);
  process.exit(1);
}

console.log(`[codex-watcher] watching ${AUTH_FILE} (debounce ${DEBOUNCE_MS}ms)`);

let syncInProgress = false;
let syncPending = false;
let debounceTimer = null;
let lastMtimeMs = 0;

/** Push auth.json to R2 via rclone copyto. */
function pushToR2(reason) {
  if (syncInProgress) {
    syncPending = true;
    return;
  }

  // Skip if the file doesn't exist (e.g. during atomic rename window)
  if (!existsSync(AUTH_FILE)) {
    return;
  }

  // Skip if mtime hasn't advanced — fs.watch can fire spuriously on metadata
  let mtime;
  try {
    mtime = statSync(AUTH_FILE).mtimeMs;
  } catch {
    return;
  }
  if (mtime <= lastMtimeMs) {
    return;
  }
  lastMtimeMs = mtime;

  syncInProgress = true;
  const startedAt = Date.now();
  console.log(`[codex-watcher] push start (reason=${reason}, mtime=${mtime})`);

  const proc = spawn(
    'rclone',
    [
      'copyto',
      AUTH_FILE,
      `r2:${R2_BUCKET}/codex/auth.json`,
      '--s3-no-check-bucket',
      '--no-update-modtime',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  proc.on('exit', (code) => {
    const durationMs = Date.now() - startedAt;
    if (code === 0) {
      console.log(`[codex-watcher] push ok (${durationMs}ms)`);
    } else {
      console.error(`[codex-watcher] push failed (code=${code}, ${durationMs}ms): ${stderr.trim()}`);
    }
    syncInProgress = false;
    if (syncPending) {
      syncPending = false;
      // Re-run with the latest state
      setImmediate(() => pushToR2('pending-retry'));
    }
  });

  proc.on('error', (err) => {
    console.error(`[codex-watcher] spawn error: ${err.message}`);
    syncInProgress = false;
  });
}

function scheduleSync(reason) {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    pushToR2(reason);
  }, DEBOUNCE_MS);
}

// Watch the directory rather than the file directly. fs.watch on a file
// path breaks when the file is atomically replaced (write tmp → mv), which
// is exactly what Codex CLI does. Watching the parent dir catches the new
// inode transparently.
try {
  const watcher = watch(CODEX_DIR, { persistent: true }, (eventType, filename) => {
    if (filename !== 'auth.json') return;
    scheduleSync(`${eventType}:${filename}`);
  });

  watcher.on('error', (err) => {
    console.error(`[codex-watcher] watch error: ${err.message}`);
    process.exit(2);
  });

  // Initial sync on startup in case the file was written before we started
  // (bootstrap path, or R2 restore that landed just before this helper).
  if (existsSync(AUTH_FILE)) {
    scheduleSync('startup');
  }
} catch (err) {
  console.error(`[codex-watcher] failed to start watcher: ${err.message}`);
  process.exit(3);
}

// Keep the process alive. fs.watch holds the event loop open on its own,
// but this makes the intent explicit.
process.stdin.resume();
