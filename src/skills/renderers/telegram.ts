/**
 * Gecko Skills — Telegram Renderer
 *
 * Converts SkillResult into Telegram-friendly messages.
 * Each result kind gets a specialized formatter.
 * Long messages are split into chunks respecting Telegram's 4096 char limit.
 */

import type { SkillResult } from '../types';
import { isImageBrief, isVideoBrief, type ImageBrief, type VideoBrief } from '../lyra/media-types';

/** Telegram's message character limit. */
const TELEGRAM_MAX_LENGTH = 4096;
/** Leave some margin for formatting overhead. */
const CHUNK_MAX = 4000;

/** A single Telegram message chunk. */
export interface TelegramChunk {
  text: string;
  parseMode?: 'HTML' | 'Markdown';
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
  return parts.map(text => ({ text, parseMode: raw.parseMode }));
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
  lines.push(escapeHtml(result.body));

  const tel = result.telemetry;
  lines.push(`\n<i>${tel.model} \u2022 ${tel.llmCalls} calls \u2022 ${(tel.durationMs / 1000).toFixed(1)}s</i>`);

  return { text: lines.join('\n'), parseMode: 'HTML' };
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

  return { text: lines.join('\n'), parseMode: 'HTML' };
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
