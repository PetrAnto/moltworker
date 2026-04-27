/**
 * Audit Skill — Prompt-injection pre-pass
 *
 * The audit pipeline ingests arbitrary GitHub repos and feeds excerpts
 * straight into LLM prompts. Any source file is therefore an untrusted
 * input channel: a malicious or pranked repo can plant
 * "IGNORE PREVIOUS INSTRUCTIONS" in a comment, fake `<system>` blocks,
 * huge base64 blobs, or invisible Unicode and try to derail the
 * Analyst's behavior.
 *
 * Conservative posture (per ironclaw's Block / Sanitize / Warn pattern,
 * adapted for our use case):
 *
 *   1. Sanitize: redact known injection markers in place. Leaves the
 *      surrounding code intact so the Analyst can still reason about
 *      the file, but the model never sees the literal injection text.
 *   2. Truncate: replace very long contiguous base64-charset runs with
 *      a placeholder. A single 200kB blob in a comment can blow the
 *      LLM context for no useful signal.
 *   3. Strip: remove zero-width / RTL-override Unicode that has no
 *      legitimate place in source code and is a known obfuscation
 *      vector for both injection and homoglyph tricks.
 *
 * Conservative means: DO NOT delete legitimate source. A variable
 * named `ignorePrevious`, the substring `IGNORE` in a constant, or a
 * regex like /system/ in a parser — none of these match the patterns
 * here. We only mask obvious instruction-injection phrases and the
 * literal role-tag markers used by chat templates.
 *
 * Notices are returned alongside the sanitized text so the audit
 * telemetry can surface a count and the operator can spot sustained
 * injection attempts across runs.
 */

export type SanitizeNoticeKind =
  | 'injection-masked' // matched a prompt-injection phrase
  | 'role-tag-masked' // matched a chat-template role marker
  | 'base64-truncated' // large contiguous base64-charset run
  | 'zero-width-stripped'; // U+200B-class invisible chars

export interface SanitizeNotice {
  kind: SanitizeNoticeKind;
  /** Subtype label (e.g. "ignore-previous-instructions"). */
  label: string;
  /** Bytes/occurrences depending on kind. */
  size?: number;
  /** Optional path attribution when sanitizing a snippet collection. */
  path?: string;
}

// ---------------------------------------------------------------------------
// Pattern catalog
// ---------------------------------------------------------------------------
//
// All patterns are case-insensitive and match WHOLE phrases / specific
// markers, not single words. The bar for adding a new pattern is "could
// this realistically appear in benign source code?" — if yes, leave it
// out. False positives here produce mysteriously redacted code that the
// auditor can't reason about.

interface InjectionPattern {
  pattern: RegExp;
  kind: SanitizeNoticeKind;
  label: string;
}

const INJECTION_PATTERNS: InjectionPattern[] = [
  // Direct "ignore your instructions" family.
  {
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|earlier|the\s+above)\s+instructions?/gi,
    kind: 'injection-masked',
    label: 'ignore-previous-instructions',
  },
  {
    pattern:
      /disregard\s+(?:all\s+)?(?:previous|prior|earlier|the\s+above)\s+(?:instructions?|prompts?|context)/gi,
    kind: 'injection-masked',
    label: 'disregard-previous',
  },
  {
    pattern: /forget\s+(?:everything|all)\s+(?:above|before|prior|previous)/gi,
    kind: 'injection-masked',
    label: 'forget-previous',
  },
  // Explicit role takeover.
  {
    pattern: /you\s+are\s+now\s+(?:a|an|in)\s+(?:dan|developer\s+mode|jailbroken|unrestricted)/gi,
    kind: 'injection-masked',
    label: 'role-takeover',
  },
  // Chat-template role tags. Matches HTML-style and ChatML-style markers.
  // The opening/closing-pair shape is what makes these distinct from
  // ordinary mentions of words like "system" or "user" in code.
  {
    pattern: /<\s*\/?\s*(?:system|assistant|user|tool)\s*>/gi,
    kind: 'role-tag-masked',
    label: 'fake-role-tag',
  },
  {
    pattern: /<\|im_(?:start|end)\|>/g,
    kind: 'role-tag-masked',
    label: 'chatml-marker',
  },
  {
    pattern: /\[INST\]|\[\/INST\]/g,
    kind: 'role-tag-masked',
    label: 'llama-inst-marker',
  },
  {
    pattern: /<\|endoftext\|>/g,
    kind: 'role-tag-masked',
    label: 'gpt-eos-marker',
  },
];

/** Contiguous base64-character runs of at least this length get truncated.
 *  A real source file rarely embeds inline base64 longer than this; an
 *  attacker stuffing a multi-megabyte payload into a comment to blow the
 *  LLM context absolutely will. Calibrated to be loose enough that a
 *  reasonable inline data: URI or SVG path slips through unchanged. */
const BASE64_RUN_THRESHOLD = 256;
const BASE64_RUN = new RegExp(`[A-Za-z0-9+/=]{${BASE64_RUN_THRESHOLD},}`, 'g');

/** Zero-width spaces, joiners, and bidi overrides. None of these have a
 *  legitimate role in source code; they're commonly used for both
 *  homoglyph attacks (rendering visually distinct identifiers as the
 *  same string) and injection obfuscation. Stripping is silent — we
 *  count occurrences in notices but don't bother with placeholders. */
const ZERO_WIDTH = /[​-‏‪-‮⁠-⁩﻿]/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for inclusion in an LLM prompt. Returns the cleaned
 * text plus a list of what was redacted/truncated/stripped. The original
 * is never mutated.
 */
export function sanitizeText(input: string): { text: string; notices: SanitizeNotice[] } {
  const notices: SanitizeNotice[] = [];

  // 1. Strip zero-width / bidi characters first. They could otherwise
  // hide inside one of the injection patterns and prevent the regex
  // from matching ("IGN<U+200B>ORE PREVIOUS INSTRUCTIONS").
  let out = input;
  const zwMatches = out.match(ZERO_WIDTH);
  if (zwMatches && zwMatches.length > 0) {
    out = out.replace(ZERO_WIDTH, '');
    notices.push({
      kind: 'zero-width-stripped',
      label: 'invisible-chars',
      size: zwMatches.length,
    });
  }

  // 2. Truncate huge base64 runs before pattern-matching to keep the
  // regex engine from chewing through pathological inputs.
  out = out.replace(BASE64_RUN, (match) => {
    notices.push({
      kind: 'base64-truncated',
      label: 'large-base64-blob',
      size: match.length,
    });
    return `[REDACTED-BASE64: ${match.length}B]`;
  });

  // 3. Mask injection / role-tag patterns. Each match is replaced
  // verbatim with a tagged placeholder so the Analyst can still see
  // *where* the suspicious content sat in the file.
  for (const { pattern, kind, label } of INJECTION_PATTERNS) {
    out = out.replace(pattern, () => {
      notices.push({ kind, label });
      return `[REDACTED: ${label}]`;
    });
  }

  return { text: out, notices };
}

/**
 * Sanitize an audit-snippet collection. Returns a parallel array of
 * snippets (with `text` cleaned in place when needed) plus a flat
 * notice list with each notice tagged with the originating path.
 *
 * Snippet identity (path/lines/kind/name) and other fields are
 * preserved exactly; only the `text` field can change.
 */
export function sanitizeSnippets<S extends { path: string; text: string }>(
  snippets: ReadonlyArray<S>,
): { snippets: S[]; notices: SanitizeNotice[] } {
  const allNotices: SanitizeNotice[] = [];
  const out: S[] = [];
  for (const s of snippets) {
    const { text, notices } = sanitizeText(s.text);
    if (text === s.text) {
      out.push(s);
    } else {
      out.push({ ...s, text });
      for (const n of notices) {
        allNotices.push({ ...n, path: s.path });
      }
    }
  }
  return { snippets: out, notices: allNotices };
}

/**
 * Sanitize the description fields of GitHub Code Scanning alerts. These
 * come from external scanners (CodeQL, Semgrep, etc.) — typically
 * trusted, but a self-hosted scanner could be attacker-controlled.
 * Cheap to defend against by running the same pre-pass.
 */
export function sanitizeCodeScanningAlerts<A extends { description: string; path: string }>(
  alerts: ReadonlyArray<A>,
): { alerts: A[]; notices: SanitizeNotice[] } {
  const allNotices: SanitizeNotice[] = [];
  const out: A[] = [];
  for (const a of alerts) {
    const { text, notices } = sanitizeText(a.description);
    if (text === a.description) {
      out.push(a);
    } else {
      out.push({ ...a, description: text });
      for (const n of notices) {
        allNotices.push({ ...n, path: a.path });
      }
    }
  }
  return { alerts: out, notices: allNotices };
}
