/**
 * Gecko Skills — Telegram Renderer
 *
 * Converts SkillResult into Telegram-friendly messages.
 * Each result kind gets a specialized formatter.
 */

import type { SkillResult } from '../types';

/**
 * Render a SkillResult for Telegram display.
 *
 * Returns an object with:
 *   - text: The formatted message text
 *   - parseMode: 'HTML' | 'Markdown' | undefined
 */
export function renderForTelegram(result: SkillResult): {
  text: string;
  parseMode?: 'HTML' | 'Markdown';
} {
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

function renderDraft(result: SkillResult): { text: string; parseMode?: 'HTML' | 'Markdown' } {
  const lines: string[] = [];
  lines.push('<b>Draft</b>\n');
  lines.push(escapeHtml(result.body));

  const tel = result.telemetry;
  lines.push(`\n<i>${tel.model} \u2022 ${(tel.durationMs / 1000).toFixed(1)}s</i>`);

  return { text: lines.join('\n'), parseMode: 'HTML' };
}

function renderHeadlines(result: SkillResult): { text: string; parseMode?: 'HTML' | 'Markdown' } {
  const lines: string[] = [];
  lines.push('<b>Headline Options</b>\n');
  lines.push(escapeHtml(result.body));
  return { text: lines.join('\n'), parseMode: 'HTML' };
}

function renderDossier(result: SkillResult): { text: string; parseMode?: 'HTML' | 'Markdown' } {
  const lines: string[] = [];
  lines.push('<b>Research Dossier</b>\n');
  lines.push(escapeHtml(result.body));

  const tel = result.telemetry;
  lines.push(`\n<i>${tel.model} \u2022 ${tel.llmCalls} calls \u2022 ${(tel.durationMs / 1000).toFixed(1)}s</i>`);

  return { text: lines.join('\n'), parseMode: 'HTML' };
}

function renderSourcePlan(result: SkillResult): { text: string; parseMode?: 'HTML' | 'Markdown' } {
  const lines: string[] = [];
  lines.push('<b>Source Plan</b> (reply "go" to proceed)\n');
  lines.push(escapeHtml(result.body));
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
