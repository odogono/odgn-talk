import {
  checkSyntax,
  exportsOf,
  loadScript,
  lowerTree,
  parseSourceRecovering,
  stdlibSources,
  syntaxSelector,
  type SyntaxElement,
  type Token,
  UnitLoadError,
  type Binding,
  type LibraryExport,
  type SemanticElement,
  type SemanticName,
  type SemanticNode,
  type SemanticResult,
  type SyntaxNode,
  type CompiledScript,
} from '@northtalk/ts';
import { lintSyntax, type Lint, type LintProfile } from '../lint';
import { grantDeclarations, type HostManifest } from './manifest';
import { rangeAt, type LspDiagnostic } from './protocol';

export type WorkspaceSource = { library?: string; text: string; uri: string };
export type Document = WorkspaceSource & { version?: number };
export type Analysis = {
  checked: SemanticResult;
  diagnostics: LspDiagnostic[];
  document: Document;
  lints: Lint[];
  loaded?: CompiledScript;
  names: SemanticName[];
  nodes: SemanticNode[];
  syntax: SyntaxNode;
};
export const elements = <T extends { children?: readonly T[]; kind: string }>(
  root: T,
): T[] => {
  const out: T[] = [];
  const work = [root];
  while (work.length) {
    const node = work.pop()!;
    out.push(node);
    if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        work.push(node.children[i]!);
      }
    }
  }
  return out;
};
export const semanticElements = (root: SemanticNode) =>
  elements<SemanticElement>(root);
export const libraryUri = (name: string) =>
  `northtalk-library:///${encodeURIComponent(name)}.talk`;

let standardWorkspace: Map<string, Analysis> | undefined;

type Parsed = ReturnType<typeof parseSourceRecovering>;
/** What one document's last analysis kept, so the next can reuse it. */
type Entry = {
  analysis?: { base: Analysis; checked: SemanticResult };
  /** Each check of this text by the Libraries it imports' export summaries. */
  checks: Map<string, SemanticResult>;
  contextual?: { diagnostics: SemanticResult['diagnostics']; key: string };
  load?: {
    checked: SemanticResult;
    diagnostics: LspDiagnostic[];
    links: (CompiledScript | undefined)[];
    loaded?: CompiledScript;
  };
  parsed: Parsed;
  text: string;
};
type Memo = Map<string, Entry>;
const importNames = new WeakMap<SemanticResult, string[]>();

/** Rebuild bindings as one snapshot so edits in an imported Library update its consumers. */
export const analyzeWorkspace = (
  documents: readonly Document[],
  manifest: HostManifest | null,
  profile: LintProfile,
): Map<string, Analysis> => analyze(documents, manifest, profile, new Map());

/**
 * An LSP workspace that keeps each document's analysis between calls and
 * redoes only what an edit changed. Its results match `analyzeWorkspace`.
 */
export const createWorkspace = () => {
  let memo: Memo = new Map();
  let last: { manifest: HostManifest | null; profile: LintProfile } | undefined;
  return {
    analyze: (
      documents: readonly Document[],
      manifest: HostManifest | null,
      profile: LintProfile,
    ): Map<string, Analysis> => {
      if (last?.manifest !== manifest || last.profile !== profile) {
        memo = new Map();
      }
      last = { manifest, profile };
      const next: Memo = new Map();
      const out = analyze(documents, manifest, profile, memo, next);
      memo = next;
      return out;
    },
  };
};

const analyze = (
  documents: readonly Document[],
  manifest: HostManifest | null,
  profile: LintProfile,
  memo: Memo,
  next: Memo = new Map(),
): Map<string, Analysis> => {
  if (!standardWorkspace && (documents.length || manifest)) {
    standardWorkspace = analyzeWorkspace([], null, 'standard');
  }
  const sources = new Map<string, Document>();
  for (const [name, text] of Object.entries(stdlibSources)) {
    sources.set(libraryUri(name), {
      uri: libraryUri(name),
      text,
      library: name,
    });
  }
  for (const lib of manifest?.libraries ?? []) {
    sources.set(libraryUri(lib.name), {
      uri: libraryUri(lib.name),
      text: lib.source,
      library: lib.name,
    });
  }
  for (const document of documents) {
    sources.set(document.uri, document);
  }
  // A workspace source with the same Library name overrides its manifest copy.
  const libraries = new Map<string, Document>();
  for (const doc of sources.values()) {
    if (doc.library) {
      libraries.set(doc.library, doc);
    }
  }
  for (const [uri, doc] of sources) {
    if (doc.library && libraries.get(doc.library) !== doc) {
      sources.delete(uri);
    }
  }
  const cached = (doc: Document) => {
    const existing =
      standardWorkspace?.get(doc.uri) ??
      (doc.library
        ? standardWorkspace?.get(libraryUri(doc.library))
        : undefined);
    return existing?.document.text === doc.text && doc.version === undefined
      ? { ...existing, document: doc }
      : undefined;
  };
  const entries = new Map<string, Entry>();
  for (const [uri, doc] of sources) {
    if (cached(doc)) {
      continue;
    }
    const previous = memo.get(uri);
    const entry: Entry =
      previous?.text === doc.text
        ? { ...previous, checks: new Map() }
        : {
            text: doc.text,
            parsed: parseSourceRecovering(doc.text),
            checks: new Map(),
          };
    entries.set(uri, entry);
    next.set(uri, entry);
  }
  const parsed = new Map(
    [...sources].map(([uri, doc]) => [
      uri,
      cached(doc)
        ? { tree: cached(doc)!.syntax, diagnostics: [] }
        : entries.get(uri)!.parsed,
    ]),
  );
  // A check reads only the export summaries of the Libraries it imports, and
  // the manifest, which clears the memo when it changes.
  const importsOf = (result: SemanticResult) => {
    let imports = importNames.get(result);
    if (!imports) {
      imports = semanticElements(result.tree.root)
        .filter(
          (e): e is SemanticName => e.kind === 'name' && e.role === 'library',
        )
        .map(e => e.text);
      importNames.set(result, imports);
    }
    return imports;
  };
  const summaryKey = (imports: readonly string[], libraries: typeof exports) =>
    JSON.stringify(imports.map(name => libraries[name] ?? null));
  const memoCheck = (
    uri: string,
    libraries: typeof exports,
    check: () => SemanticResult,
  ): SemanticResult => {
    const entry = entries.get(uri)!;
    const previous = memo.get(uri);
    if (previous?.text === entry.text) {
      for (const [key, result] of previous.checks) {
        if (summaryKey(importsOf(result), libraries) === key) {
          entry.checks.set(key, result);
          return result;
        }
      }
    }
    for (const [key, result] of entry.checks) {
      if (summaryKey(importsOf(result), libraries) === key) {
        return result;
      }
    }
    const result = check();
    entry.checks.set(summaryKey(importsOf(result), libraries), result);
    return result;
  };
  let exports: Record<string, Record<string, LibraryExport>> = {};
  const checked = new Map<string, SemanticResult>();
  // Export kinds/contracts are available on the first pass; suspension can
  // propagate through a chain of Library imports on subsequent passes.
  for (let pass = 0; pass <= libraries.size; pass++) {
    const next: typeof exports = {};
    for (const [name, doc] of libraries) {
      const libraries = exports;
      const result =
        cached(doc)?.checked ??
        memoCheck(doc.uri, libraries, () =>
          checkSyntax(parsed.get(doc.uri)!.tree, {
            unit: 'library',
            libraries,
          }),
        );
      checked.set(doc.uri, result);
      next[name] = exportsOf(result.tree);
    }
    if (JSON.stringify(next) === JSON.stringify(exports)) {
      exports = next;
      break;
    }
    exports = next;
  }
  const out = new Map<string, Analysis>();
  for (const document of sources.values()) {
    const existing = cached(document);
    if (existing) {
      out.set(document.uri, existing);
      continue;
    }
    const p = parsed.get(document.uri)!;
    const result = document.library
      ? checked.get(document.uri)!
      : memoCheck(document.uri, exports, () =>
          checkSyntax(p.tree, {
            libraries: exports,
            ...(manifest
              ? {
                  grants: grantDeclarations(manifest),
                  objects: manifest.objects,
                }
              : {}),
          }),
        );
    const entry = entries.get(document.uri)!;
    if (entry.analysis?.checked === result) {
      const base = entry.analysis.base;
      out.set(document.uri, {
        ...base,
        document,
        diagnostics: [...base.diagnostics],
      });
      continue;
    }
    const all = semanticElements(result.tree.root);
    const diagnostics: LspDiagnostic[] = [];
    const syntaxError = p.diagnostics[0]?.error;
    if (syntaxError) {
      diagnostics.push({
        range: rangeAt(document.text, syntaxError.tok.pos, syntaxError.tok.end),
        severity: 1,
        code: syntaxError.code,
        source: 'northtalk syntax',
        message: syntaxError.message,
      });
    }
    // ADR 0055's accidental-label traps fail only after the likely word. Keep
    // the Core error, and offer advice only when that Selector has no Handler.
    if (syntaxError && ['nl', 'eof'].includes(syntaxError.tok.t)) {
      const syntax = elements<SyntaxElement>(p.tree);
      const label = syntax
        .filter((e): e is SyntaxNode => e.kind === 'node' && e.rule === 'Label')
        .map(e => e.children[0] as Token)
        .find(
          t =>
            t.line === syntaxError.tok.line &&
            document.text.slice(t.end, syntaxError.tok.pos).trim() === '',
        );
      const command =
        label &&
        syntax.find(
          (e): e is SyntaxNode =>
            e.kind === 'node' &&
            e.rule === 'SimpleStatement' &&
            e.start <= label.pos &&
            label.end <= e.end,
        );
      const head = command?.children[0];
      if (label && command && head?.kind === 'token') {
        const selector = syntaxSelector(command, head.v);
        const known =
          result.tree.scopes[0]?.bindings.some(
            b => b.kind === 'handler' && b.name === selector,
          ) || manifest?.messages.includes(selector);
        if (!known) {
          diagnostics.push({
            range: rangeAt(document.text, label.pos, label.end),
            severity: 4,
            code: 'likely-argument-label',
            source: 'northtalk advice',
            message: `“${label.raw}” is read as an Argument Label and needs an argument. No known Handler has this Selector; check this word or separate positional arguments with a comma.`,
          });
        }
      }
    }
    // Without a manifest we deliberately offer grammar-only diagnostics.
    if (manifest) {
      diagnostics.push(
        ...result.diagnostics.map(d => ({
          range: rangeAt(document.text, d.span.start, d.span.end),
          severity: 1,
          code: d.code,
          source: 'northtalk',
          message: d.message,
        })),
      );
    }
    const lints = lintSyntax(p.tree, {
      profile,
      manifest,
      bindings: result.tree,
      checkOptions: { unit: document.library ? 'library' : 'script' },
    });
    diagnostics.push(
      ...lints.map(l => ({
        range: rangeAt(document.text, l.span.start, l.span.end),
        severity: l.level === 'warning' ? 2 : 4,
        code: l.id,
        source: 'northtalk lint',
        message: l.message,
      })),
    );
    const base: Analysis = {
      document,
      syntax: p.tree,
      checked: result,
      names: all.filter((e): e is SemanticName => e.kind === 'name'),
      nodes: all.filter((e): e is SemanticNode => e.kind === 'node'),
      diagnostics,
      lints,
    };
    entry.analysis = { checked: result, base };
    out.set(document.uri, { ...base, diagnostics: [...diagnostics] });
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const load = (analysis: Analysis): CompiledScript | undefined => {
    const { document, checked } = analysis;
    if (cached(document)) {
      return analysis.loaded;
    }
    if (visited.has(document.uri)) {
      return analysis.loaded;
    }
    if (visiting.has(document.uri)) {
      return undefined;
    }
    visiting.add(document.uri);
    const links = new Map<string, CompiledScript>();
    let importsReady = true;
    for (const use of analysis.names.filter(n => n.role === 'library')) {
      const lib = libraries.get(use.text);
      if (lib && visiting.has(lib.uri)) {
        if (manifest) {
          analysis.diagnostics.push({
            range: rangeAt(document.text, use.span.start, use.span.end),
            severity: 1,
            code: 'import cycle',
            source: 'northtalk',
            message: `import cycle: ${use.text}`,
          });
        }
        importsReady = false;
        continue;
      }
      const loaded = lib && load(out.get(lib.uri)!);
      if (loaded) {
        links.set(use.text, loaded);
      } else {
        importsReady = false;
      }
    }
    const entry = entries.get(document.uri)!;
    const previous = entry.load;
    const linked = [...links.values()];
    if (
      importsReady &&
      previous?.checked === checked &&
      previous.links.length === linked.length &&
      previous.links.every((l, i) => l === linked[i])
    ) {
      analysis.loaded = previous.loaded;
      analysis.diagnostics.push(...previous.diagnostics);
    } else if (
      checked.ok &&
      !parsed.get(document.uri)!.diagnostics.length &&
      importsReady
    ) {
      const before = analysis.diagnostics.length;
      try {
        analysis.loaded = loadScript(
          lowerTree(checked.tree, {
            name: document.library ?? document.uri,
            unit: document.library ? 'library' : 'script',
          }),
          {},
          links,
        );
      } catch (error) {
        // The Core's initializer and literal-pattern load diagnostics also
        // belong in the editor; unsupported lowering doesn't erase bindings.
        if (manifest && error instanceof UnitLoadError) {
          const node = analysis.nodes.find(
            n => n.span.line === error.line && n.span.col === error.col,
          );
          analysis.diagnostics.push({
            range: rangeAt(
              document.text,
              node?.span.start ?? 0,
              node?.span.end ?? 0,
            ),
            severity: 1,
            code: error.code,
            source: 'northtalk',
            message: error.message,
          });
        }
      }
      entry.load = {
        checked,
        links: linked,
        loaded: analysis.loaded,
        diagnostics: analysis.diagnostics.slice(before),
      };
    }
    visiting.delete(document.uri);
    visited.add(document.uri);
    return analysis.loaded;
  };
  for (const analysis of out.values()) {
    load(analysis);
  }
  // A Library checked with the manifest's Grants, for its importers' advice.
  const contextualOf = (
    doc: Document,
    grants: ReturnType<typeof grantDeclarations>,
  ) => {
    const entry = entries.get(doc.uri)!;
    const key = summaryKey(importsOf(checked.get(doc.uri)!), exports);
    if (entry.contextual?.key !== key) {
      entry.contextual = {
        key,
        diagnostics: checkSyntax(parsed.get(doc.uri)!.tree, {
          unit: 'library',
          libraries: exports,
          grants,
        }).diagnostics,
      };
    }
    return entry.contextual.diagnostics;
  };
  if (manifest) {
    const grants = grantDeclarations(manifest);
    const contextual = new Map(
      [...libraries].map(([name, doc]) => [
        name,
        cached(doc)?.checked.diagnostics ?? contextualOf(doc, grants),
      ]),
    );
    for (const analysis of out.values()) {
      if (analysis.document.library) {
        continue;
      }
      for (const use of analysis.names.filter(n => n.role === 'library')) {
        const work = [use.text];
        const visited = new Set<string>();
        while (work.length) {
          const name = work.pop()!;
          if (visited.has(name)) {
            continue;
          }
          visited.add(name);
          const doc = libraries.get(name);
          if (!doc) {
            continue;
          }
          const library = out.get(doc.uri)!;
          const diagnostics = [
            ...library.diagnostics.filter(d => d.severity === 1),
            ...(contextual.get(name) ?? []),
          ];
          for (const diagnostic of diagnostics) {
            const code =
              diagnostic.code === 'unknown operation'
                ? 'missing grant'
                : diagnostic.code;
            const message = `${name}: ${diagnostic.message}`;
            if (
              !analysis.diagnostics.some(
                d =>
                  d.code === code &&
                  d.message === message &&
                  d.range.start.line === use.span.line - 1,
              )
            ) {
              analysis.diagnostics.push({
                range: rangeAt(
                  analysis.document.text,
                  use.span.start,
                  use.span.end,
                ),
                severity: 1,
                code,
                source: 'northtalk',
                message,
              });
            }
          }
          work.push(
            ...library.names.filter(n => n.role === 'library').map(n => n.text),
          );
        }
      }
    }
  }
  return out;
};
export const bindingKey = (analysis: Analysis, binding: Binding): string => {
  if (binding.importedFrom) {
    return `library:${binding.importedFrom.library}:${binding.importedFrom.name}`;
  }
  if (analysis.document.library && binding.scope === 0) {
    return `library:${analysis.document.library}:${binding.name}`;
  }
  return `${analysis.document.uri}:${binding.id}`;
};
