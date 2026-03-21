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
 * 5. No unbalanced brackets/braces in the source file (syntax integrity)
 * 6. No stale references to extracted identifiers in sibling files
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

  // 5. Syntax integrity — check for unbalanced brackets/braces/parens in source
  const syntaxIssue = checkBracketBalance(sourceContent);
  if (syntaxIssue) {
    issues.push(
      `SYNTAX CORRUPTION in "${extraction.sourceFile}": ${syntaxIssue}. ` +
      `The patch likely removed a declaration line but left the body (orphaned code).`,
    );
  }

  // 6. Check that import statement exists in source file for new modules
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

// ─── Cross-File Reference Scanner ───────────────────────────────────────────

/**
 * Scan sibling files in the same directory for stale references to extracted
 * identifiers. When code is extracted from App.jsx → utils.js, other files
 * that imported from App.jsx may still reference the moved identifiers and
 * need their imports updated.
 *
 * @param extraction - Extraction metadata
 * @param readFile - File reader (injected)
 * @param listFiles - List files in a directory (injected)
 * @returns Array of warning strings for stale references found
 */
export async function scanCrossFileReferences(
  extraction: ExtractionCheck,
  readFile: (path: string) => Promise<string | null>,
  listFiles: (dir: string) => Promise<string[]>,
): Promise<string[]> {
  if (extraction.extractedNames.length === 0) return [];

  const warnings: string[] = [];

  // Get the directory of the source file
  const sourceDir = extraction.sourceFile.includes('/')
    ? extraction.sourceFile.substring(0, extraction.sourceFile.lastIndexOf('/'))
    : '';

  // Build list of directories to scan: source dir + parent dirs (up to 2 levels)
  // This catches consumers in parent directories (e.g., src/App.jsx importing from src/components/UIAtoms.jsx)
  const dirsToScan = [sourceDir];
  let parentDir = sourceDir;
  for (let i = 0; i < 2 && parentDir.includes('/'); i++) {
    parentDir = parentDir.substring(0, parentDir.lastIndexOf('/'));
    dirsToScan.push(parentDir);
  }
  // Also scan root if source is nested (e.g., src/components/ → also scan '')
  if (parentDir !== '' && !dirsToScan.includes('')) {
    dirsToScan.push('');
  }

  // List files from all directories (parallel), deduplicate
  const seenFiles = new Set<string>();
  const allFiles: string[] = [];
  const dirResults = await Promise.allSettled(dirsToScan.map(d => listFiles(d)));
  for (const result of dirResults) {
    if (result.status === 'fulfilled') {
      for (const f of result.value) {
        if (!seenFiles.has(f)) {
          seenFiles.add(f);
          allFiles.push(f);
        }
      }
    }
  }
  if (allFiles.length === 0) return [];

  // Filter to code files, exclude source file and new files
  const codeExtensions = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']);
  const excludeFiles = new Set([
    extraction.sourceFile,
    ...extraction.newFiles,
  ]);
  const filesToScan = allFiles.filter(f => {
    if (excludeFiles.has(f)) return false;
    const ext = f.split('.').pop()?.toLowerCase() || '';
    return codeExtensions.has(ext);
  });

  // Limit to 8 files to keep API calls lightweight (increased from 5 to cover parent dirs)
  const scanTargets = filesToScan.slice(0, 8);

  // Build source file basename for import detection (e.g., "App" from "src/App.jsx")
  const sourceBasename = (extraction.sourceFile.split('/').pop() || '')
    .replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '');

  for (const filePath of scanTargets) {
    const content = await readFile(filePath);
    if (!content) continue;

    // Check if this file imports from the source file
    const importsFromSource = content.includes(sourceBasename);
    if (!importsFromSource) continue;

    // Check if any extracted identifiers are referenced
    const staleRefs = extraction.extractedNames.filter(name =>
      new RegExp(`\\b${escapeRegExp(name)}\\b`).test(content),
    );

    if (staleRefs.length > 0) {
      // Find the actual import line for a concrete fix suggestion
      const lines = content.split('\n');
      const importLine = lines.find(l =>
        l.includes('import') && l.includes(sourceBasename),
      );

      // Build concrete fix: derive the new module's import path relative to the consumer
      const newFile = extraction.newFiles[0] || 'new-module';
      const newBasename = (newFile.split('/').pop() || '')
        .replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '');

      // Derive relative path from consumer to new file
      const consumerDir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
      const newFileDir = newFile.includes('/') ? newFile.substring(0, newFile.lastIndexOf('/')) : '';
      const newFileWithExt = newFile.split('/').pop() || newFile;
      let relativePath: string;
      if (consumerDir === newFileDir) {
        relativePath = `./${newFileWithExt}`;
      } else if (newFile.startsWith(consumerDir + '/')) {
        relativePath = './' + newFile.substring(consumerDir.length + 1);
      } else {
        relativePath = `./${newFileDir ? newFileDir.split('/').slice(-1)[0] + '/' : ''}${newFileWithExt}`;
      }

      let fixSuggestion = '';
      if (importLine) {
        fixSuggestion = `\nFIX: In "${filePath}", add a new import: \`import { ${staleRefs.join(', ')} } from '${relativePath}';\``;
        // If all refs from this import are stale, suggest removing the old import entirely
        const otherNamesUsed = extraction.extractedNames.length < 10 &&
          lines.some(l => l.includes('import') && l.includes(sourceBasename) &&
            !staleRefs.every(r => l.includes(r)));
        if (!otherNamesUsed) {
          fixSuggestion += `\nIf "${sourceBasename}" has no other exports used in this file, you can also change the import to: \`import { ${staleRefs.join(', ')} } from '${relativePath}';\``;
        }
        fixSuggestion += `\nFound import line: \`${importLine.trim()}\``;
      }

      warnings.push(
        `STALE REFERENCES: "${filePath}" imports from "${sourceBasename}" and references ` +
        `extracted identifiers [${staleRefs.join(', ')}] — these imports need updating to point ` +
        `at the new module(s): ${extraction.newFiles.join(', ')}` + fixSuggestion,
      );
    }
  }

  return warnings;
}

// ─── Syntax Integrity ───────────────────────────────────────────────────────

/**
 * Lightweight bracket/brace/paren balance check for JS/JSX/TS/TSX.
 * Catches the exact failure mode from PR #79: patch removes a `const X = [`
 * line but leaves the array body, creating unbalanced brackets.
 *
 * Skips contents inside string literals and comments to avoid false positives.
 * Returns null if balanced, or a description string if unbalanced.
 */
export function checkBracketBalance(source: string): string | null {
  const stack: string[] = [];
  const openToClose: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const closeToOpen: Record<string, string> = { '}': '{', ']': '[', ')': '(' };

  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];

    // Skip single-line comments
    if (ch === '/' && source[i + 1] === '/') {
      while (i < len && source[i] !== '\n') i++;
      continue;
    }

    // Skip multi-line comments
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < len - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Skip template literals
    if (ch === '`') {
      i++;
      while (i < len && source[i] !== '`') {
        if (source[i] === '\\') i++; // skip escaped chars
        i++;
      }
      i++; // skip closing `
      continue;
    }

    // Skip string literals
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < len && source[i] !== quote) {
        if (source[i] === '\\') i++; // skip escaped chars
        i++;
      }
      i++; // skip closing quote
      continue;
    }

    // Skip regex literals (heuristic: / after = or ( or , or ; or { or [ or ! or & or | or :)
    if (ch === '/' && i > 0) {
      const prev = source.substring(Math.max(0, i - 5), i).trimEnd();
      const lastChar = prev[prev.length - 1];
      if (lastChar && '=({[,;!&|:?'.includes(lastChar)) {
        i++;
        while (i < len && source[i] !== '/') {
          if (source[i] === '\\') i++;
          i++;
        }
        i++; // skip closing /
        continue;
      }
    }

    if (openToClose[ch]) {
      stack.push(ch);
    } else if (closeToOpen[ch]) {
      const expected = closeToOpen[ch];
      if (stack.length === 0) {
        return `Unexpected closing '${ch}' with no matching opening '${expected}'`;
      }
      const top = stack.pop()!;
      if (top !== expected) {
        return `Mismatched bracket: expected closing for '${top}' but found '${ch}'`;
      }
    }

    i++;
  }

  if (stack.length > 0) {
    const unclosed = stack.map(c => `'${c}'`).reverse().slice(0, 3).join(', ');
    return `Unclosed brackets: ${unclosed} (${stack.length} total unclosed)`;
  }

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
