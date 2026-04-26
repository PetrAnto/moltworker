/**
 * Audit Skill — Per-language node-type maps
 *
 * Tree-sitter node names that map to our SnippetKinds. Kept here (data-only)
 * so the extractor can stay generic. Names are checked against the actual
 * tree-sitter-typescript / tree-sitter-python / etc. grammars via tests —
 * if upstream renames a node type, the test fails and we update the map
 * (rather than silently producing zero snippets).
 */

import type { GrammarLanguage, SnippetKind } from '../types';

interface NodeTypeMap {
  function: ReadonlySet<string>;
  class: ReadonlySet<string>;
  import: ReadonlySet<string>;
  export: ReadonlySet<string>;
}

const TS: NodeTypeMap = {
  function: new Set([
    'function_declaration',
    'method_definition',
    'method_signature',
    'arrow_function', // only those bound to an exported symbol; filtered at extract time
    'function_expression',
  ]),
  class: new Set([
    'class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
  ]),
  import: new Set(['import_statement', 'import_clause']),
  export: new Set(['export_statement']),
};

const PY: NodeTypeMap = {
  function: new Set(['function_definition']),
  class: new Set(['class_definition']),
  import: new Set(['import_statement', 'import_from_statement']),
  export: new Set(), // Python has no export statements
};

const GO: NodeTypeMap = {
  function: new Set(['function_declaration', 'method_declaration']),
  class: new Set(['type_declaration']),
  import: new Set(['import_declaration']),
  export: new Set(), // Go capitalization-based; no statement
};

const JS: NodeTypeMap = {
  function: new Set([
    'function_declaration',
    'method_definition',
    'arrow_function',
    'function_expression',
  ]),
  class: new Set(['class_declaration']),
  import: new Set(['import_statement', 'import_clause']),
  export: new Set(['export_statement']),
};

const MAPS: Record<GrammarLanguage, NodeTypeMap> = {
  typescript: TS,
  tsx: TS,
  javascript: JS,
  python: PY,
  go: GO,
};

/**
 * Look up the SnippetKind for a tree-sitter node type in a given language.
 * Returns null for nodes we don't care about (whitespace, comments, etc.).
 */
export function classifyNode(language: GrammarLanguage, nodeType: string): SnippetKind | null {
  const map = MAPS[language];
  if (map.function.has(nodeType)) return 'function';
  if (map.class.has(nodeType)) return 'class';
  if (map.import.has(nodeType)) return 'import';
  if (map.export.has(nodeType)) return 'export';
  return null;
}

/** All node types we care about for a language — used to flatten descendantsOfType. */
export function relevantNodeTypes(language: GrammarLanguage): string[] {
  const m = MAPS[language];
  return [...m.function, ...m.class, ...m.import, ...m.export];
}
