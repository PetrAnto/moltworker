#!/usr/bin/env node
/**
 * Pre-deploy cleanup: purge stale R2 checkpoints and reset orphaned DO task state.
 *
 * Usage:
 *   node scripts/predeploy-cleanup.mjs                  # dry-run (default)
 *   node scripts/predeploy-cleanup.mjs --execute         # actually delete
 *   node scripts/predeploy-cleanup.mjs --max-age 1h      # custom age threshold
 *
 * What it does:
 *   1. Lists all R2 objects under checkpoints/ prefix
 *   2. Deletes checkpoints older than --max-age (default: 2 hours)
 *   3. Reports what was deleted/would be deleted
 *
 * Requires: wrangler CLI authenticated with your Cloudflare account.
 * Uses `wrangler r2 object list` and `wrangler r2 object delete` commands.
 */

import { execSync } from 'node:child_process';

const BUCKET = 'moltbot-data';
const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

function parseArgs() {
  const args = process.argv.slice(2);
  let execute = false;
  let maxAgeMs = DEFAULT_MAX_AGE_MS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute') {
      execute = true;
    } else if (args[i] === '--max-age' && args[i + 1]) {
      const val = args[++i];
      const match = val.match(/^(\d+)(h|m|d)$/);
      if (!match) {
        console.error(`Invalid --max-age value: ${val}. Use format: 2h, 30m, 1d`);
        process.exit(1);
      }
      const num = parseInt(match[1], 10);
      const unit = match[2];
      maxAgeMs = num * (unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 86400000);
    }
  }

  return { execute, maxAgeMs };
}

function listR2Objects(prefix) {
  try {
    const output = execSync(
      `npx wrangler r2 object list ${BUCKET} --prefix "${prefix}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    // wrangler r2 object list returns JSON array
    return JSON.parse(output);
  } catch (err) {
    // If the command fails (no objects, auth issue), return empty
    console.error(`Warning: failed to list R2 objects with prefix "${prefix}":`, err.message);
    return [];
  }
}

function deleteR2Object(key) {
  try {
    execSync(
      `npx wrangler r2 object delete ${BUCKET}/${key} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000 }
    );
    return true;
  } catch {
    return false;
  }
}

function main() {
  const { execute, maxAgeMs } = parseArgs();
  const cutoff = Date.now() - maxAgeMs;
  const mode = execute ? 'EXECUTE' : 'DRY-RUN';

  console.log(`\n🧹 Pre-deploy R2 cleanup (${mode})`);
  console.log(`   Bucket: ${BUCKET}`);
  console.log(`   Max age: ${maxAgeMs / 3600000}h (cutoff: ${new Date(cutoff).toISOString()})`);
  console.log('');

  // List checkpoint objects
  const objects = listR2Objects('checkpoints/');
  if (objects.length === 0) {
    console.log('✅ No checkpoints found — nothing to clean up.');
    return;
  }

  console.log(`Found ${objects.length} checkpoint(s):`);

  let deleted = 0;
  let skipped = 0;

  for (const obj of objects) {
    const uploaded = new Date(obj.uploaded || obj.last_modified || 0).getTime();
    const age = Date.now() - uploaded;
    const ageStr = `${Math.round(age / 60000)}min`;
    const isStale = uploaded < cutoff;

    if (isStale) {
      if (execute) {
        const ok = deleteR2Object(obj.key);
        console.log(`  ${ok ? '🗑️  Deleted' : '❌ Failed'}: ${obj.key} (${ageStr} old)`);
      } else {
        console.log(`  🔍 Would delete: ${obj.key} (${ageStr} old)`);
      }
      deleted++;
    } else {
      console.log(`  ✅ Keep: ${obj.key} (${ageStr} old)`);
      skipped++;
    }
  }

  console.log('');
  console.log(`Summary: ${deleted} stale, ${skipped} kept`);
  if (!execute && deleted > 0) {
    console.log('Run with --execute to actually delete.');
  }
}

main();
