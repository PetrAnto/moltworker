#!/usr/bin/env node
/**
 * Audit Skill — benchmark harness.
 *
 * Drives a deployed Moltworker bot through /audit --analyze on a list of
 * real GitHub repos, captures cost/latency/tokens/findings per run, and
 * appends rows to a CSV so trends are visible run-over-run.
 *
 * NOT a CI gate — too slow, too expensive (real LLM spend), too
 * stochastic. Run when you want fresh numbers for the design doc.
 *
 * Quickstart:
 *   export MOLTBOT_URL=https://your-bot.workers.dev
 *   export DEBUG_API_KEY=$(wrangler secret get DEBUG_API_KEY ...)
 *   npm run audit:bench
 *
 * What it does:
 *   For each repo × depth × lens tuple in the repos config:
 *     1. POST /simulate/command with /audit <repo> --analyze --lens X --depth Y
 *     2. Parse the audit_run body for the cost/tokens/duration footer
 *     3. Append a row to brainstorming/audit-bench-results.csv
 *
 * What it does NOT do:
 *   - Compare findings to a ground-truth baseline (precision/recall is
 *     a separate effort — needs hand-curated finding lists per repo).
 *   - Retry failed runs. A run that errored shows up as one row with
 *     `error` populated; rerun manually.
 *   - Dispatch to orchestra. We're benchmarking analysis, not fix.
 *
 * Output columns (CSV):
 *   timestamp, repo, repo_sha, depth, lens, runtime_source,
 *   duration_ms, llm_calls, tokens_in, tokens_out, cost_usd,
 *   github_api_calls, findings_count, suppressed_count,
 *   parse_errors_count, body_bytes, error
 */

import { readFile, appendFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_REPOS_PATH = resolve(REPO_ROOT, 'brainstorming', 'audit-bench-repos.json');
const DEFAULT_OUT_PATH   = resolve(REPO_ROOT, 'brainstorming', 'audit-bench-results.csv');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) printUsageAndExit(0);

const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
};
const has = (name) => args.includes(`--${name}`);

const BOT_URL = flag('bot-url')   ?? process.env.MOLTBOT_URL ?? '';
const API_KEY = flag('api-key')   ?? process.env.DEBUG_API_KEY ?? '';
const REPOS   = flag('repos')     ?? DEFAULT_REPOS_PATH;
const OUT     = flag('out')       ?? DEFAULT_OUT_PATH;
const DEPTH   = flag('depth')     ?? null;       // null → use per-repo config
const LENS    = flag('lens')      ?? null;       // null → all lenses in config
const TIMEOUT = Number(flag('timeout') ?? 120_000);
const DRY_RUN = has('dry-run');

if (!BOT_URL) die('--bot-url or MOLTBOT_URL is required');
if (!API_KEY && !DRY_RUN) die('--api-key or DEBUG_API_KEY is required');
if (DEPTH && !['quick', 'standard', 'deep'].includes(DEPTH)) die(`bad --depth: ${DEPTH}`);

function printUsageAndExit(code) {
  console.log(`Usage: node scripts/audit-bench.mjs [options]

Options:
  --bot-url <url>      Deployed Moltworker base URL (or env MOLTBOT_URL)
  --api-key <key>      Bearer token for /simulate (or env DEBUG_API_KEY)
  --repos <path>       JSON config of repos × depth × lens (default: brainstorming/audit-bench-repos.json)
  --out <path>         CSV output path (appends, creates if missing). Default: brainstorming/audit-bench-results.csv
  --depth <tier>       Override per-repo depth: quick | standard | deep
  --lens <name>        Override per-repo lens (single)
  --timeout <ms>       Per-run timeout for the /simulate call (default: 120000)
  --dry-run            Print what would be done; don't call the bot or write CSV
  --help, -h           Show this message

Repo config (brainstorming/audit-bench-repos.json) — array of:
  { "repo": "owner/name", "depth": "quick", "lenses": ["security", "deps"] }
A starter file is created on first run if missing.

Output CSV: one row per (repo × depth × lens) tuple, appended.`);
  process.exit(code);
}

function die(msg) { console.error('[bench] ERROR:', msg); process.exit(1); }
function log(...m) { console.log('[bench]', ...m); }

// ---------------------------------------------------------------------------
// Repo config — load or seed a starter file
// ---------------------------------------------------------------------------

const STARTER_REPOS = [
  // Tiny sanity (~10 files) — should fit the inline envelope.
  { repo: 'octocat/hello-world', depth: 'quick', lenses: ['security'] },
  // Small TS repo with auth-shaped paths — exercises the security lens.
  { repo: 'sindresorhus/p-map',  depth: 'quick', lenses: ['security', 'deps'] },
  // Slightly larger TS — exercises types / deadcode lenses.
  { repo: 'sindresorhus/got',    depth: 'quick', lenses: ['types', 'deadcode'] },
];

async function loadRepoConfig() {
  let raw;
  try {
    raw = await readFile(REPOS, 'utf8');
  } catch {
    log(`config not found at ${REPOS} — seeding with starter repos`);
    await mkdir(dirname(REPOS), { recursive: true });
    await writeFile(REPOS, JSON.stringify(STARTER_REPOS, null, 2) + '\n', 'utf8');
    return STARTER_REPOS;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('repos config must be an array');
    return parsed;
  } catch (err) {
    die(`bad repos config: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// /simulate/command call + body parsing
// ---------------------------------------------------------------------------

async function runOne({ repo, depth, lens }) {
  const command = `/audit ${repo} --analyze --lens ${lens} --depth ${depth}`;
  if (DRY_RUN) {
    log(`dry-run: POST /simulate/command  ${command}`);
    return { ok: true, dryRun: true };
  }

  const url = new URL('/simulate/command', BOT_URL).toString();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  const start = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ command, timeout: TIMEOUT }),
      signal: ctrl.signal,
    });
  } catch (err) {
    return { ok: false, error: `network: ${err.message ?? String(err)}`, durationMs: Date.now() - start };
  } finally {
    clearTimeout(t);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { ok: false, error: `${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`, durationMs: Date.now() - start };
  }

  const data = await resp.json();
  // /simulate/command returns { command, messages[], allCaptured[], durationMs, doResult? }
  // The audit body is the text of the latest message tagged audit_run-ish.
  // We grep for the cost footer + the tree header to identify the right message.
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const auditMsg = messages.find(m => typeof m.text === 'string' && /Audit report:/.test(m.text))
                ?? messages.find(m => typeof m.text === 'string' && /\bAudit Report\b/.test(m.text));
  const errorMsg = messages.find(m => typeof m.text === 'string' && /^⚠️/.test(m.text));

  if (!auditMsg) {
    return {
      ok: false,
      error: errorMsg?.text?.slice(0, 200) ?? `no audit_run message in ${messages.length} captured`,
      durationMs: Date.now() - start,
      captured: messages.length,
    };
  }

  const body = auditMsg.text;
  return { ok: true, body, durationMs: Date.now() - start, simulateMs: data.durationMs };
}

/** Parse the formatRun text for telemetry numbers. */
function parseAuditBody(body) {
  const out = {
    repo_sha: '',
    runtime_source: '',
    findings_count: 0,
    suppressed_count: 0,
    parse_errors_count: 0,
    duration_ms: 0,
    llm_calls: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    github_api_calls: 0,
    body_bytes: body.length,
  };
  // Header: "Audit report: owner/repo@<sha7> ..."
  const m1 = /Audit report:\s+([^@]+)@([0-9a-f]+)/i.exec(body);
  if (m1) out.repo_sha = m1[2];
  // "runtime: r2" or "runtime: bundled"
  const m2 = /runtime:\s+(r2|bundled)/.exec(body);
  if (m2) out.runtime_source = m2[1];
  // "Findings (N):"
  const m3 = /Findings\s+\((\d+)\)/.exec(body);
  if (m3) out.findings_count = Number(m3[1]);
  // "🔇 N finding(s) suppressed"
  const m4 = /([0-9]+)\s+finding\(s\)\s+suppressed/.exec(body);
  if (m4) out.suppressed_count = Number(m4[1]);
  // "⚠️ N file(s) had parse issues"
  const m5 = /([0-9]+)\s+file\(s\)\s+had\s+parse\s+issues/.exec(body);
  if (m5) out.parse_errors_count = Number(m5[1]);
  // Footer: "Cost: $X • Y LLM calls • A → B tokens • C API calls • Ts"
  const m6 = /Cost:\s*\$([0-9.]+)\s*•\s*(\d+)\s+LLM calls\s*•\s*([\d,]+)\s*→\s*([\d,]+)\s+tokens\s*•\s*(\d+)\s+API calls\s*•\s*([\d.]+)s/.exec(body);
  if (m6) {
    out.cost_usd = Number(m6[1]);
    out.llm_calls = Number(m6[2]);
    out.tokens_in = Number(m6[3].replace(/,/g, ''));
    out.tokens_out = Number(m6[4].replace(/,/g, ''));
    out.github_api_calls = Number(m6[5]);
    out.duration_ms = Math.round(Number(m6[6]) * 1000);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSV append
// ---------------------------------------------------------------------------

const CSV_HEADER = [
  'timestamp', 'repo', 'repo_sha', 'depth', 'lens', 'runtime_source',
  'duration_ms', 'llm_calls', 'tokens_in', 'tokens_out', 'cost_usd',
  'github_api_calls', 'findings_count', 'suppressed_count',
  'parse_errors_count', 'body_bytes', 'error',
].join(',') + '\n';

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function appendRow(row) {
  if (DRY_RUN) {
    log('dry-run row:', row);
    return;
  }
  await mkdir(dirname(OUT), { recursive: true });
  let needHeader = true;
  try {
    const info = await stat(OUT);
    if (info.size > 0) needHeader = false;
  } catch { /* missing — write header */ }
  const values = CSV_HEADER.trim().split(',').map(k => csvEscape(row[k]));
  const line = (needHeader ? CSV_HEADER : '') + values.join(',') + '\n';
  await appendFile(OUT, line, 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const repos = await loadRepoConfig();
  log(`bench against ${BOT_URL} • ${repos.length} repo entry/ies • out: ${OUT}`);
  if (DRY_RUN) log('DRY RUN — no network or file writes');

  // Expand the config into individual (repo, depth, lens) runs.
  const runs = [];
  for (const r of repos) {
    if (!r.repo || typeof r.repo !== 'string') {
      log('skipping malformed entry:', r);
      continue;
    }
    const depth = DEPTH ?? r.depth ?? 'quick';
    const lenses = LENS ? [LENS] : (Array.isArray(r.lenses) && r.lenses.length > 0 ? r.lenses : ['security']);
    for (const lens of lenses) runs.push({ repo: r.repo, depth, lens });
  }
  log(`${runs.length} run(s) total`);

  let i = 0;
  for (const run of runs) {
    i++;
    const tag = `[${i}/${runs.length}] ${run.repo} • ${run.depth} • ${run.lens}`;
    log(`${tag} → starting`);
    const result = await runOne(run);
    const timestamp = new Date().toISOString();
    if (result.ok && result.dryRun) continue;
    if (!result.ok) {
      log(`${tag} FAILED: ${result.error}`);
      await appendRow({
        timestamp, repo: run.repo, depth: run.depth, lens: run.lens,
        error: result.error, duration_ms: result.durationMs ?? '',
      });
      continue;
    }
    const parsed = parseAuditBody(result.body);
    const row = {
      timestamp,
      repo: run.repo,
      depth: run.depth,
      lens: run.lens,
      ...parsed,
      // Prefer the parsed footer's duration over the simulate wall-clock
      // (simulate includes Worker overhead + Telegram round-trips); fall
      // back if the regex didn't match.
      duration_ms: parsed.duration_ms || result.durationMs || '',
      error: '',
    };
    await appendRow(row);
    log(`${tag} OK • $${row.cost_usd} • ${row.llm_calls} LLM calls • ${row.findings_count} findings • ${row.duration_ms}ms`);
  }

  log('done.');
}

main().catch(err => die(err.stack ?? err.message ?? String(err)));
