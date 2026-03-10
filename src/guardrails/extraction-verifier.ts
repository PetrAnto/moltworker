/**
 * Post-Execution Extraction Verifier
 *
 * Deterministic verification that runs AFTER the final tool calls but BEFORE
 * the model generates its ORCHESTRA_RESULT summary. For extraction/refactoring
 * tasks, it reads the actual committed files from the branch and asserts:
 *
 * 1. Extracted identifiers are ABSENT from the source file
 * 2. Those identifiers ARE present + exported in the new module file(s)
 * 3. Import statement for the new module exists in the source file
 * 4. Source file line count dropped by a meaningful amount
 *
 * The result is injected into the model's context so the ORCHESTRA_RESULT
 * summary is grounded in reality, not stale cached reads.
 */

import type { ChatMessage } from '../openrouter/client';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExtractionCheck {
  /** The source file that code was extracted FROM */
  sourceFile: string;
  /** New module files that code was extracted TO */
  newFiles: string[];
  /** Identifiers (function/const/component names) that were extracted */
  extractedNames: string[];
  /** Initial line count of source file from github_read_file (if available) */
  sourceInitialLineCount: number | null;
  /** Line count of new module file from workspace_write_file content (if available) */
  newFileLineCount: number | null;
}

export interface ExtractionVerification {
  /** Whether the extraction looks correct */
  passed: boolean;
  /** Human-readable issues found */
  issues: string[];
  /** Summary for context injection */
  summary: string;
}

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Detect whether the current task involves file extraction/splitting by
 * analyzing the tool call patterns in the conversation. An extraction task
 * has BOTH file creation (workspace_write_file or github_push_files) AND
 * file patching (github_create_pr or github_push_files with patch action)
 * in the same session.
 */
export function isExtractionTask(toolsUsed: string[]): boolean {
  const hasFileCreation = toolsUsed.includes('workspace_write_file')
    || toolsUsed.includes('github_push_files');
  const hasPrOrPush = toolsUsed.includes('github_create_pr')
    || toolsUsed.includes('github_push_files');
  // Must have both creation of new files AND modification of existing ones
  return hasFileCreation && hasPrOrPush;
}

/**
 * Extract extraction metadata from tool call/result pairs in conversation.
 * Identifies:
 * - Which files were created (new modules)
 * - Which files were patched (source files)
 * - What identifiers were moved (from patch "find" strings)
 */
export function detectExtractionDetails(
  messages: readonly ChatMessage[],
): ExtractionCheck | null {
  const createdFiles = new Set<string>();
  const patchedFiles = new Set<string>();
  const extractedNames = new Set<string>();

  // Track source file initial line counts from github_read_file results
  const fileLineCounts = new Map<string, number>();
  // Track new file line counts from workspace_write_file content
  const newFileLineCounts = new Map<string, number>();

  for (const msg of messages) {
    // Scan assistant messages for tool calls
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          continue;
        }

        if (tc.function.name === 'workspace_write_file') {
          const path = args.path as string | undefined;
          if (path) {
            createdFiles.add(path);
            // Track line count from the content being written
            const content = args.content as string | undefined;
            if (content) {
              newFileLineCounts.set(path, content.split('\n').length);
            }
          }
        }

        if (tc.function.name === 'github_push_files' || tc.function.name === 'github_create_pr') {
          // IMPORTANT: `changes` is a JSON string, not an array — the tool schema
          // defines it as type: 'string' containing a JSON array
          const changesRaw = args.changes;
          let changes: Array<Record<string, unknown>> = [];
          if (typeof changesRaw === 'string') {
            try {
              changes = JSON.parse(changesRaw);
            } catch { /* malformed JSON */ }
          } else if (Array.isArray(changesRaw)) {
            // Some models may pass it as a direct array
            changes = changesRaw;
          }

          for (const change of changes) {
            const path = change.path as string;
            const action = change.action as string;
            if (!path) continue;

            if (action === 'create') {
              createdFiles.add(path);
              const content = change.content as string | undefined;
              if (content) {
                newFileLineCounts.set(path, content.split('\n').length);
              }
            } else if (action === 'patch') {
              patchedFiles.add(path);
              // Extract identifier names from patch "find" strings
              const patches = change.patches as Array<Record<string, string>> | undefined;
              if (Array.isArray(patches)) {
                for (const patch of patches) {
                  const findStr = patch.find || '';
                  // Look for function/const/class/component declarations being deleted
                  const identifiers = extractIdentifiersFromCode(findStr);
                  for (const id of identifiers) {
                    extractedNames.add(id);
                  }
                }
              }
            } else if (action === 'update') {
              patchedFiles.add(path);
            }
          }
        }
      }
    }

    // Track line counts from github_read_file results
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (msg.tool_call_id) {
        for (const prevMsg of messages) {
          if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
            for (const tc of prevMsg.tool_calls) {
              if (tc.id === msg.tool_call_id && tc.function.name === 'github_read_file') {
                try {
                  const a = JSON.parse(tc.function.arguments);
                  if (a.path) {
                    fileLineCounts.set(a.path, msg.content.split('\n').length);
                  }
                } catch { /* ignore */ }
              }
            }
          }
        }
      }
    }
  }

  // Only proceed if we have both created files and patched files (extraction pattern)
  if (createdFiles.size === 0 || patchedFiles.size === 0) return null;

  // The source file is the patched file that isn't a new creation
  const sourceFiles = [...patchedFiles].filter(f => !createdFiles.has(f));
  // Filter out ROADMAP.md, WORK_LOG.md — those aren't source files
  const codeSourceFiles = sourceFiles.filter(f =>
    !f.toLowerCase().includes('roadmap') && !f.toLowerCase().includes('work_log'),
  );

  if (codeSourceFiles.length === 0) return null;

  const primarySource = codeSourceFiles[0];
  const newFiles = [...createdFiles];

  // Get best available line counts
  const sourceInitialLineCount = fileLineCounts.get(primarySource) ?? null;
  // Sum new file line counts for the expected delta
  let totalNewFileLines = 0;
  for (const nf of newFiles) {
    totalNewFileLines += newFileLineCounts.get(nf) ?? 0;
  }

  return {
    sourceFile: primarySource,
    newFiles,
    extractedNames: [...extractedNames],
    sourceInitialLineCount,
    newFileLineCount: totalNewFileLines > 0 ? totalNewFileLines : null,
  };
}

/**
 * Extract function/const/class/component names from a code snippet.
 * Looks for common JS/TS/JSX declaration patterns.
 */
function extractIdentifiersFromCode(code: string): string[] {
  const names: string[] = [];
  // function declarations
  const funcMatches = code.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+(\w+)/g);
  for (const m of funcMatches) names.push(m[1]);
  // const/let/var declarations (including arrow functions and objects)
  const constMatches = code.matchAll(/\b(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g);
  for (const m of constMatches) names.push(m[1]);
  // class declarations
  const classMatches = code.matchAll(/\b(?:export\s+)?class\s+(\w+)/g);
  for (const m of classMatches) names.push(m[1]);
  return names;
}

// ─── Verification ───────────────────────────────────────────────────────────

/**
 * Verify an extraction by reading the actual post-edit file contents from
 * the GitHub branch. Uses the same githubReadFile infrastructure.
 *
 * @param extraction - Detected extraction metadata
 * @param readFile - Function to read a file from the branch (injected for testability)
 * @returns Verification result with pass/fail and issues
 */
export async function verifyExtraction(
  extraction: ExtractionCheck,
  readFile: (path: string) => Promise<string | null>,
): Promise<ExtractionVerification> {
  const issues: string[] = [];

  // 1. Read the source file post-edit
  const sourceContent = await readFile(extraction.sourceFile);
  if (sourceContent === null) {
    return {
      passed: false,
      issues: [`Could not read source file "${extraction.sourceFile}" from branch — file may not exist`],
      summary: `VERIFICATION ERROR: Source file "${extraction.sourceFile}" not readable from branch.`,
    };
  }

  // 2. Read one of the new module files to confirm it exists and has exports
  let anyNewFileHasContent = false;
  const missingNewFiles: string[] = [];
  for (const newFile of extraction.newFiles) {
    const content = await readFile(newFile);
    if (content === null) {
      missingNewFiles.push(newFile);
    } else if (content.trim().length > 0) {
      anyNewFileHasContent = true;

      // Check that extracted identifiers exist in the new file
      if (extraction.extractedNames.length > 0) {
        const foundInNew = extraction.extractedNames.filter(name =>
          new RegExp(`\\b${escapeRegExp(name)}\\b`).test(content),
        );
        if (foundInNew.length === 0) {
          issues.push(
            `New file "${newFile}" does not contain any of the expected extracted identifiers: ${extraction.extractedNames.join(', ')}`,
          );
        }
      }
    }
  }

  if (missingNewFiles.length > 0) {
    issues.push(`New module file(s) not found on branch: ${missingNewFiles.join(', ')}`);
  }

  if (!anyNewFileHasContent && missingNewFiles.length === extraction.newFiles.length) {
    issues.push('None of the expected new module files were found on the branch');
  }

  // 3. Check that extracted identifiers are ABSENT from the source file
  if (extraction.extractedNames.length > 0) {
    const stillInSource = extraction.extractedNames.filter(name => {
      // Check for declaration patterns (not just usage via import)
      const declPatterns = [
        new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\b`),
        new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=`),
        new RegExp(`\\bclass\\s+${escapeRegExp(name)}\\b`),
      ];
      return declPatterns.some(p => p.test(sourceContent));
    });

    if (stillInSource.length > 0) {
      issues.push(
        `INCOMPLETE EXTRACTION: These identifiers are still DECLARED in "${extraction.sourceFile}" ` +
        `(should have been deleted): ${stillInSource.join(', ')}`,
      );
    }
  }

  // 4. Line count delta check — the source file should have shrunk meaningfully
  const postEditLineCount = sourceContent.split('\n').length;
  if (extraction.sourceInitialLineCount !== null) {
    const linesDelta = extraction.sourceInitialLineCount - postEditLineCount;
    // If we know how many lines were extracted, use that as the expected minimum
    const expectedMinDrop = extraction.newFileLineCount !== null
      ? Math.floor(extraction.newFileLineCount * 0.5) // At least 50% of new file content should have come from source
      : 10; // Minimum meaningful extraction
    if (linesDelta < expectedMinDrop) {
      issues.push(
        `INSUFFICIENT LINE REDUCTION: Source file "${extraction.sourceFile}" went from ${extraction.sourceInitialLineCount} to ${postEditLineCount} lines ` +
        `(delta: ${linesDelta}). Expected at least ~${expectedMinDrop} lines removed for this extraction. ` +
        `The extracted code may still be in the source file as dead/orphaned code.`,
      );
    }
  }

  // 5. Check that import statement exists in source file for new modules
  const newFileBasenames = extraction.newFiles.map(f => {
    const base = f.split('/').pop() || f;
    return base.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '');
  });
  const hasAnyImport = newFileBasenames.some(base =>
    sourceContent.includes(base),
  );
  if (!hasAnyImport && extraction.newFiles.length > 0) {
    issues.push(
      `Source file "${extraction.sourceFile}" does not appear to import from any of the new modules: ${extraction.newFiles.join(', ')}`,
    );
  }

  // Build summary
  const passed = issues.length === 0;
  let summary: string;
  if (passed) {
    summary = `EXTRACTION VERIFIED: "${extraction.sourceFile}" correctly imports from new modules (${extraction.newFiles.join(', ')}). ` +
      (extraction.extractedNames.length > 0
        ? `Extracted identifiers (${extraction.extractedNames.join(', ')}) are present in new files and removed from source.`
        : 'New module files exist on branch.');
  } else {
    summary = `EXTRACTION ISSUES DETECTED (${issues.length}):\n` +
      issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n');
  }

  return { passed, issues, summary };
}

// ─── Context Injection ──────────────────────────────────────────────────────

/**
 * Format the verification result for injection into the model's context
 * before it writes the ORCHESTRA_RESULT block.
 */
export function formatVerificationForContext(
  verification: ExtractionVerification,
): string {
  if (verification.passed) {
    return `[EXTRACTION VERIFICATION — PASSED] ${verification.summary}\n` +
      'Use this verified state (not your cached memory of the files) when writing the ORCHESTRA_RESULT summary.';
  }

  return `[EXTRACTION VERIFICATION — ISSUES FOUND]\n${verification.summary}\n\n` +
    'IMPORTANT: Your ORCHESTRA_RESULT summary MUST reflect these findings. ' +
    'Do NOT claim the extraction was successful if issues were detected. ' +
    'If the extracted identifiers are still declared in the source file, report the extraction as incomplete.';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
