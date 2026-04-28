/**
 * Gecko Skills — Telegram Renderer
 *
 * Converts SkillResult into Telegram-friendly messages.
 * Each result kind gets a specialized formatter.
 * Long messages are split into chunks respecting Telegram's 4096 char limit.
 */

import type { SkillResult } from '../types';
import type { AuditFinding, AuditRun } from '../audit/types';
import { isImageBrief, isVideoBrief, type ImageBrief, type VideoBrief } from '../lyra/media-types';
import { isNexusDossier, type NexusDossier } from '../nexus/types';
import { computeConfidence, confidenceLabel } from '../nexus/evidence';

/** Telegram's message character limit. */
const TELEGRAM_MAX_LENGTH = 4096;
/** Leave some margin for formatting overhead. */
const CHUNK_MAX = 4000;

/** Inline-keyboard button shape. Mirrors the Telegram Bot API. */
export interface ChunkButton {
  text: string;
  /** Opaque payload routed by handleCallback. Convention:
   *  `<skillId>:<action>:<arg1>:...`. Keep ≤64 bytes — Telegram's hard limit. */
  callback_data: string;
}

/** A single Telegram message chunk. */
export interface TelegramChunk {
  text: string;
  parseMode?: 'HTML' | 'Markdown';
  /** Optional inline keyboard. The handler attaches via sendMessageWithButtons. */
  replyMarkup?: ChunkButton[][];
}

/**
 * Render a SkillResult for Telegram display.
 *
 * Returns an array of chunks — one for short messages, multiple for long ones.
 * The caller should send each chunk as a separate message.
 */
export function renderForTelegram(result: SkillResult): TelegramChunk[] {
  const raw = renderSingle(result);

  // Short enough for one message — fast path
  if (raw.text.length <= TELEGRAM_MAX_LENGTH) {
    return [raw];
  }

  // Split into chunks — use tag-aware splitter for HTML to avoid broken markup
  const parts = raw.parseMode === 'HTML'
    ? splitHtmlMessage(raw.text, CHUNK_MAX)
    : splitMessage(raw.text, CHUNK_MAX);
  // The replyMarkup (if any) MUST land on the last chunk only — Telegram
  // shows the inline keyboard attached to the message containing it, and
  // duplicating across chunks is both ugly and confusing for callbacks.
  const out = parts.map((text, i) => ({
    text,
    parseMode: raw.parseMode,
    replyMarkup: i === parts.length - 1 ? raw.replyMarkup : undefined,
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Single-message renderer (may exceed limit)
// ---------------------------------------------------------------------------

function renderSingle(result: SkillResult): TelegramChunk {
  switch (result.kind) {
    case 'text':
    case 'orchestra':
      return { text: result.body };

    case 'draft':
      return renderDraft(result);

    case 'headlines':
      return renderHeadlines(result);

    case 'repurpose':
      return { text: result.body };

    case 'capture_ack':
      return { text: `\u2705 ${result.body}` };

    case 'digest':
      return { text: result.body };

    case 'gauntlet':
      return { text: result.body };

    case 'dossier':
      return renderDossier(result);

    case 'audit_plan':
    case 'audit_run':
      return renderAudit(result);

    case 'image_brief':
      return renderImageBrief(result);

    case 'video_brief':
      return renderVideoBrief(result);

    case 'source_plan':
      return renderSourcePlan(result);

    case 'error':
      return { text: `\u26a0\ufe0f ${result.body}` };

    default:
      return { text: result.body };
  }
}

// ---------------------------------------------------------------------------
// Per-kind renderers
// ---------------------------------------------------------------------------

function renderDraft(result: SkillResult): TelegramChunk {
  const lines: string[] = [];
  lines.push('<b>Draft</b>\n');
  lines.push(escapeHtml(result.body));

  const tel = result.telemetry;
  lines.push(`\n<i>${tel.model} \u2022 ${(tel.durationMs / 1000).toFixed(1)}s</i>`);

  return { text: lines.join('\n'), parseMode: 'HTML' };
}

function renderHeadlines(result: SkillResult): TelegramChunk {
  const lines: string[] = [];
  lines.push('<b>Headline Options</b>\n');
  lines.push(escapeHtml(result.body));
  return { text: lines.join('\n'), parseMode: 'HTML' };
}

function renderDossier(result: SkillResult): TelegramChunk {
  const lines: string[] = [];
  lines.push('<b>Research Dossier</b>\n');

  // Prefer rendering from the structured dossier so source URLs go through
  // explicit <a> tags. Telegram's auto-linker does NOT decode HTML entities
  // inside an auto-linked URL, so escapeHtml-ing the raw body would surface
  // literal "&amp;" inside ?query=...&tags= URLs and produce broken links.
  const dossier = isNexusDossier(result.data) ? result.data : null;
  if (dossier) {
    lines.push(escapeHtml(`Research: ${dossier.query}`));
    const confidence = confidenceLabel(computeConfidence(dossier.evidence));
    lines.push(escapeHtml(`${confidence} (${dossier.evidence.length} sources, ${dossier.mode} mode)\n`));

    lines.push(escapeHtml(dossier.synthesis));

    if (dossier.decision) {
      lines.push('');
      lines.push('<b>--- Decision Analysis ---</b>');
      if (dossier.decision.pros.length > 0) {
        lines.push('\n<b>Pros:</b>');
        dossier.decision.pros.forEach(p => lines.push(escapeHtml(`  + ${p}`)));
      }
      if (dossier.decision.cons.length > 0) {
        lines.push('\n<b>Cons:</b>');
        dossier.decision.cons.forEach(c => lines.push(escapeHtml(`  - ${c}`)));
      }
      if (dossier.decision.risks.length > 0) {
        lines.push('\n<b>Risks:</b>');
        dossier.decision.risks.forEach(r => lines.push(escapeHtml(`  ! ${r}`)));
      }
      lines.push(`\n<b>Recommendation:</b> ${escapeHtml(dossier.decision.recommendation)}`);
    }

    lines.push('\n<b>Sources:</b>');
    lines.push(renderEvidenceLinks(dossier));

    // Diagnostic block: when any classifier-asked source failed, surface
    // the per-source reasons inline. Means the next thin dossier reveals
    // its own root cause without needing wrangler tail.
    const attemptsBlock = renderAttemptsDiagnostics(dossier);
    if (attemptsBlock) lines.push(attemptsBlock);
  } else {
    // Fallback when data is missing \u2014 best-effort plain-text body. URLs in
    // this path may still be entity-mangled, but this branch shouldn't fire
    // for normal nexus output.
    lines.push(escapeHtml(result.body));
  }

  const tel = result.telemetry;
  lines.push(`\n<i>${escapeHtml(tel.model)} \u2022 ${tel.llmCalls} calls \u2022 ${(tel.durationMs / 1000).toFixed(1)}s</i>`);

  return { text: lines.join('\n'), parseMode: 'HTML' };
}

function renderAttemptsDiagnostics(dossier: NexusDossier): string | null {
  const attempts = dossier.attempts;
  if (!attempts || attempts.length === 0) return null;
  const failed = attempts.filter(a => a.status === 'failed');
  if (failed.length === 0) return null; // all green — no diagnostics needed

  const succeeded = attempts.length - failed.length;
  const lines: string[] = [];
  lines.push(`\n<b>Source attempts (${succeeded}/${attempts.length} succeeded):</b>`);
  for (const a of failed) {
    const reason = a.reason ? `: ${a.reason}` : '';
    lines.push(escapeHtml(`✗ ${a.source} (${a.durationMs}ms)${reason}`));
  }
  return lines.join('\n');
}

function renderEvidenceLinks(dossier: NexusDossier): string {
  if (dossier.evidence.length === 0) return escapeHtml('No sources found.');
  return dossier.evidence
    .map(e => {
      const head = `\u2022 ${escapeHtml(e.source)} (${escapeHtml(e.confidence)})`;
      if (!e.url) return head;
      // Anchor href values still need entity-escaping per the HTML spec \u2014
      // and Telegram's HTML parser does decode &amp; back to & inside
      // attributes. So we escape both the href attribute and the visible
      // text identically.
      return `${head} \u2014 <a href="${escapeAttr(e.url)}">${escapeHtml(e.url)}</a>`;
    })
    .join('\n');
}

function renderImageBrief(result: SkillResult): TelegramChunk {
  const brief = result.data as ImageBrief | undefined;
  if (!brief || !isImageBrief(brief)) {
    return { text: result.body };
  }

  const lines: string[] = [];
  lines.push(`<b>Image Brief: ${escapeHtml(brief.title)}</b>\n`);
  lines.push(`<b>Style:</b> ${escapeHtml(brief.style)}`);
  lines.push(`<b>Platform:</b> ${escapeHtml(brief.platform)} (${brief.dimensions.width}x${brief.dimensions.height})`);
  lines.push('');
  lines.push(`<b>Description:</b>\n${escapeHtml(brief.description)}`);
  lines.push('');
  lines.push(`<b>Prompt:</b>\n<code>${escapeHtml(brief.prompt)}</code>`);
  if (brief.negativePrompt) {
    lines.push(`\n<b>Negative:</b>\n<code>${escapeHtml(brief.negativePrompt)}</code>`);
  }
  if (brief.referenceNotes) {
    lines.push(`\n<b>References:</b>\n${escapeHtml(brief.referenceNotes)}`);
  }
  if (brief.tags.length > 0) {
    lines.push(`\n<b>Tags:</b> ${brief.tags.map(t => `#${escapeHtml(t)}`).join(' ')}`);
  }

  const tel = result.telemetry;
  lines.push(`\n<i>${tel.model} \u2022 ${(tel.durationMs / 1000).toFixed(1)}s</i>`);

  return { text: lines.join('\n'), parseMode: 'HTML' };
}

function renderVideoBrief(result: SkillResult): TelegramChunk {
  const brief = result.data as VideoBrief | undefined;
  if (!brief || !isVideoBrief(brief)) {
    return { text: result.body };
  }

  const lines: string[] = [];
  lines.push(`<b>Video Brief: ${escapeHtml(brief.title)}</b>\n`);
  lines.push(`<b>Concept:</b> ${escapeHtml(brief.concept)}`);
  lines.push(`<b>Platform:</b> ${escapeHtml(brief.platform)} (${brief.specs.width}x${brief.specs.height}, ${brief.specs.fps}fps)`);
  lines.push(`<b>Duration:</b> ${brief.script.totalDuration}s`);
  lines.push('');

  for (const scene of brief.script.scenes) {
    lines.push(`<b>Scene ${scene.sceneNumber}: ${escapeHtml(scene.title)}</b> (${scene.duration}s)`);
    lines.push(escapeHtml(scene.description));
    for (const shot of scene.shots) {
      lines.push(`  \u2022 [${escapeHtml(shot.shotType)}] ${escapeHtml(shot.description)} (${shot.duration}s)`);
    }
    if (scene.voiceover) {
      lines.push(`  <i>VO: ${escapeHtml(scene.voiceover)}</i>`);
    }
    lines.push('');
  }

  lines.push(`<b>Music:</b> ${escapeHtml(brief.musicDirection)}`);
  if (brief.tags.length > 0) {
    lines.push(`<b>Tags:</b> ${brief.tags.map(t => `#${escapeHtml(t)}`).join(' ')}`);
  }

  const tel = result.telemetry;
  lines.push(`\n<i>${tel.model} \u2022 ${(tel.durationMs / 1000).toFixed(1)}s</i>`);

  return { text: lines.join('\n'), parseMode: 'HTML' };
}

function renderSourcePlan(result: SkillResult): TelegramChunk {
  const lines: string[] = [];
  lines.push('<b>Source Plan</b> (reply "go" to proceed)\n');
  lines.push(escapeHtml(result.body));
  return { text: lines.join('\n'), parseMode: 'HTML' };
}

function renderAudit(result: SkillResult): TelegramChunk {
  const heading = result.kind === 'audit_run' ? 'Audit Report' : 'Audit Plan';
  const lines: string[] = [];
  lines.push(`<b>🔍 ${heading}</b>\n`);
  lines.push(`<pre>${escapeHtml(result.body)}</pre>`);

  const tel = result.telemetry;
  const parts: string[] = [];
  if (tel.model && tel.model !== 'none') parts.push(tel.model);
  if (tel.llmCalls > 0) parts.push(`${tel.llmCalls} LLM calls`);
  if (tel.toolCalls > 0) parts.push(`${tel.toolCalls} API calls`);
  parts.push(`${(tel.durationMs / 1000).toFixed(1)}s`);
  lines.push(`\n<i>${parts.join(' • ')}</i>`);

  // Inline keyboard: only on completed audit_run results that carry a
  // structured AuditRun in `data` (not on plan-only previews). Buttons
  // route through handleCallback's `audit:*` action prefix.
  const replyMarkup = result.kind === 'audit_run'
    ? buildAuditRunKeyboard(result.data as AuditRun | undefined)
    : undefined;

  return { text: lines.join('\n'), parseMode: 'HTML', replyMarkup };
}

/**
 * Build the per-finding inline keyboard for an audit_run.
 *
 * Layout: one row of two action buttons (🔧 Fix / 🔇 Suppress) per top-3
 * finding, plus a final 📄 Full report row that triggers /audit export.
 * Top-3 keeps the keyboard compact (Telegram caps practical row counts
 * around 8) and matches the precision discipline already applied to the
 * top-N body view.
 *
 * callback_data shape: `audit:<action>:<runId>:<findingId>` for per-finding
 * actions; `audit:export:<runId>` for the export shortcut. Strict 64-byte
 * Telegram cap → we use the runId in full (36 chars) and the finding's
 * stable id (lens-prefixed hash, ~20 chars) — fits comfortably.
 */
function buildAuditRunKeyboard(run: AuditRun | undefined): ChunkButton[][] | undefined {
  if (!run || run.findings.length === 0) return undefined;
  const rows: ChunkButton[][] = [];
  for (const f of run.findings.slice(0, 3) as AuditFinding[]) {
    // callback_data uses short verb codes (`fix`, `sup`) to stay within
    // Telegram's 64-byte cap on the longest payload:
    //   audit:sup:<36-char-uuid>:<finding-id> ≤ 64 bytes for finding-ids
    //   up to ~16 chars (the validator's `${lens}-${hash}` shape comes in
    //   well under that). Button labels remain human-readable.
    //
    // Note: "Prepare fix" (not "Fix") because the click PREPARES a
    // confirmation dialog — actually dispatching to orchestra requires a
    // second tap on ✅ Dispatch fix. Closes GPT slice-4d review finding 4
    // (button text shouldn't promise immediate mutation).
    rows.push([
      { text: `🔧 Prepare fix #${shortId(f.id)}`, callback_data: `audit:fix:${run.runId}:${f.id}` },
      { text: `🔇 Suppress #${shortId(f.id)}`, callback_data: `audit:sup:${run.runId}:${f.id}` },
    ]);
  }
  rows.push([{ text: '📄 Full report', callback_data: `audit:export:${run.runId}` }]);
  return rows;
}

/** Last segment of a finding-id, for compact button labels. */
function shortId(id: string): string {
  const dash = id.lastIndexOf('-');
  return (dash === -1 ? id : id.slice(dash + 1)).slice(0, 6);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

/**
 * Split a long message into chunks, preferring to break at newlines or spaces.
 * Same algorithm used by handler.ts splitMessage.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // No good newline, split at space
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // No good space, hard split
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks;
}

/**
 * Tag-aware HTML message splitter for Telegram.
 *
 * Splits HTML text into chunks that don't exceed maxLength, ensuring
 * that HTML tags (<b>, <i>, <code>) are properly closed in each chunk
 * and re-opened in the next.
 *
 * The raw split is done at a reduced limit to leave room for tag
 * repair markup (closing/reopening tags) so the final output stays
 * within the intended maxLength.
 */
export function splitHtmlMessage(text: string, maxLength: number): string[] {
  // Fast path: fits in one message
  if (text.length <= maxLength) return [text];

  // Reserve headroom for tag repair — worst case is ~60 chars of tags
  const TAG_OVERHEAD = 80;
  const innerLimit = Math.max(maxLength - TAG_OVERHEAD, Math.floor(maxLength / 2));
  const rawChunks = splitMessage(text, innerLimit);
  const result: string[] = [];

  const TRACKED_TAGS = ['b', 'i', 'code', 'pre'] as const;
  type TrackedTag = (typeof TRACKED_TAGS)[number];
  let openTags: string[] = [];

  for (const chunk of rawChunks) {
    // Prepend any tags that were open from the previous chunk
    const prefix = openTags.map(t => `<${t}>`).join('');
    let patched = prefix + chunk;

    // Scan the FULL patched content (including prefix) from scratch
    // to determine which tags are left open at the end
    const tagStack: string[] = [];
    const tagRegex = /<\/?([a-z]+)>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(patched)) !== null) {
      const fullMatch = m[0];
      const tagName = m[1].toLowerCase();
      if (!TRACKED_TAGS.includes(tagName as TrackedTag)) continue;
      if (fullMatch.startsWith('</')) {
        const idx = tagStack.lastIndexOf(tagName);
        if (idx !== -1) tagStack.splice(idx, 1);
      } else {
        tagStack.push(tagName);
      }
    }

    // Close any unclosed tags at the end of this chunk (in reverse order)
    for (let i = tagStack.length - 1; i >= 0; i--) {
      patched += `</${tagStack[i]}>`;
    }

    result.push(patched);
    openTags = tagStack;
  }

  return result;
}
