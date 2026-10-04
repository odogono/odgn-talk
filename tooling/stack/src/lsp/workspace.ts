import {
  checkSyntax,
  exportsOf,
  loadScript,
  lowerTree,
  parseSourceRecovering,
  stdlibSources,
  UnitLoadError,
  type Binding,
  type LibraryExport,
  type SemanticElement,
  type SemanticName,
  type SemanticNode,
  type SemanticResult,
  type SyntaxNode,
  type Script,
} from '@odgn/northtalk';
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
  loaded?: Script;
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

/** Rebuild bindings as one snapshot so edits in an imported Library update its consumers. */
export const analyzeWorkspace = (
  documents: readonly Document[],
  manifest: HostManifest | null,
  profile: LintProfile,
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
  const parsed = new Map(
    [...sources].map(([uri, doc]) => [
      uri,
      cached(doc)
        ? { tree: cached(doc)!.syntax, diagnostics: [] }
        : parseSourceRecovering(doc.text),
    ]),
  );
  let exports: Record<string, Record<string, LibraryExport>> = {};
  const checked = new Map<string, SemanticResult>();
  // Export kinds/contracts are available on the first pass; suspension can
  // propagate through a chain of Library imports on subsequent passes.
  for (let pass = 0; pass <= libraries.size; pass++) {
    const next: typeof exports = {};
    for (const [name, doc] of libraries) {
      const result =
        cached(doc)?.checked ??
        checkSyntax(parsed.get(doc.uri)!.tree, {
          unit: 'library',
          libraries: exports,
        });
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
      : checkSyntax(p.tree, {
          libraries: exports,
          ...(manifest
            ? { grants: grantDeclarations(manifest), objects: manifest.objects }
            : {}),
        });
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
    out.set(document.uri, {
      document,
      syntax: p.tree,
      checked: result,
      names: all.filter((e): e is SemanticName => e.kind === 'name'),
      nodes: all.filter((e): e is SemanticNode => e.kind === 'node'),
      diagnostics,
      lints,
    });
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const load = (analysis: Analysis): Script | undefined => {
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
    const links = new Map<string, Script>();
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
    if (
      checked.ok &&
      !parsed.get(document.uri)!.diagnostics.length &&
      importsReady
    ) {
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
    }
    visiting.delete(document.uri);
    visited.add(document.uri);
    return analysis.loaded;
  };
  for (const analysis of out.values()) {
    load(analysis);
  }
  if (manifest) {
    const grants = grantDeclarations(manifest);
    const contextual = new Map(
      [...libraries].map(([name, doc]) => [
        name,
        cached(doc)?.checked.diagnostics ??
          checkSyntax(parsed.get(doc.uri)!.tree, {
            unit: 'library',
            libraries: exports,
            grants,
          }).diagnostics,
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
