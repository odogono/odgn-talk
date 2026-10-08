// Chapter 7's and 9's Libraries: a Library is compiled once per process,
// added to any number of Groups, and linked into each Script and Library
// that imports it. A unit's code identity covers the identities of the
// Libraries it imports directly.
import {
  checkSource,
  type CheckResult,
  type CheckOptions,
  type ExistingName,
} from './checker';
import {
  checkEffectCall,
  operationUses,
  type EffectUse,
  type GrantDecls,
} from './effects';
import type { SemanticNode } from './semantic';
import { LoadError, type LoadDiagnostic } from './errors';
import { costModel, languageVersion } from './generated/machine';
import { libraryExports, diagnosticCodes } from './generated/syntax';
import { compareText } from './text';
import { exportsOf, importsOf, lowerTree } from './lowering';
import { loadLibrary, UnitLoadError, type Code } from './machine';
import { stdlibSources } from './generated/stdlib';
import type { LibraryExport } from './semantic';
import { sha256 } from './sha256';
import { viewSource } from './view';

export type OperationRef = { capability: string; operation: string };
export type LibrarySource = { name: string; source: string; version: string };
/** A compiled Library, which any Group may add (chapter 9). */
export type Library = {
  /** 32 bytes. */
  readonly identity: Uint8Array;
  readonly imports: readonly Library[];
  readonly name: string;
  readonly needs: readonly OperationRef[];
  readonly source: string;
  readonly version: string;
};

/** The seven stdlib Library names, which a Host may not register. */
export const stdlibNames: ReadonlySet<string> = new Set(
  libraryExports.map(entry => entry.library),
);

/** A unit's code identity, given its direct imports' identities (chapter 9). */
export const codeIdentity = (
  unit: 'script' | 'library' | 'extension',
  name: string,
  source: string,
  imports: readonly string[] = [],
) =>
  sha256(
    [
      'odgn-talk code identity 1',
      languageVersion,
      costModel.version,
      unit,
      name,
      ...imports,
      'source',
      source,
    ].join('\n'),
  );

type CallSite = EffectUse & {
  identity: string;
  unit: string;
};
type Compiled = {
  code: Code;
  declarations: GrantDecls;
  exports: Record<string, LibraryExport>;
  hex: string;
  sites: readonly CallSite[];
};
const compiled = new WeakMap<Library, Compiled>();
// The compile cache: one code unit per code identity, for the process.
const cache = new Map<string, Pick<Compiled, 'code' | 'exports'>>();

const bytesOfHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!, pair => Number.parseInt(pair, 16));

/** A Library's code identity, as lowercase hexadecimal. */
export const identityOf = (l: Library): string => compiled.get(l)!.hex;
/** A Library's loaded code, linked to its own imports. */
export const codeOf = (l: Library): Code => compiled.get(l)!.code;
/** The code of the Libraries a unit imports, by name, to link it to. */
export const linksOf = (imports: readonly Library[]) =>
  new Map(imports.map(l => [l.name, codeOf(l)]));

// A checked unit's load diagnostics, or none.
const diagnosticsOf = (
  checked: CheckResult,
  unit: string,
): LoadDiagnostic[] | null => {
  if (checked.error) {
    const { code, tok, message } = checked.error;
    return [{ code, message, unit, line: tok.line, col: tok.col }];
  }
  if (!checked.ok) {
    return checked.diagnostics.map(d => ({
      code: d.code,
      message: d.message,
      unit,
      line: d.span.line,
      col: d.span.col,
    }));
  }
  return null;
};

/** Check a Library's original call sites in the importing Script's context. */
const checkLibraryNeeds = (
  name: string,
  root: SemanticNode,
  available: ReadonlyMap<string, Library>,
  grants: GrantDecls,
): LoadDiagnostic[] => {
  const diagnostics: LoadDiagnostic[] = [];
  const uses = new Map(
    viewSource(root).flatMap(d =>
      d.k === 'use'
        ? [[d.imports[0]!.local.span.line, d.library] as const]
        : [],
    ),
  );
  const work = [root];
  while (work.length) {
    const use = work.pop()!;
    for (let i = use.children.length - 1; i >= 0; i--) {
      const child = use.children[i]!;
      if (child.kind === 'node') {
        work.push(child);
      }
    }
    if (use.rule !== 'Use') {
      continue;
    }
    const library = available.get(uses.get(use.span.line) ?? '');
    if (!library) {
      continue;
    }
    const missing = new Set<string>();
    for (const site of compiled.get(library)!.sites) {
      const reference = `${site.capability}.${site.operation}`;
      const report = (code: string) =>
        diagnostics.push({
          code,
          unit: name,
          line: use.span.line,
          col: use.span.col,
          message: `${code}: ${reference} at ${site.unit}:${site.node.span.line}:${site.node.span.col}`,
        });
      const operations = Object.hasOwn(grants, site.capability)
        ? grants[site.capability]
        : undefined;
      if (!operations || !Object.hasOwn(operations, site.operation)) {
        if (!missing.has(reference)) {
          report('missing grant');
          missing.add(reference);
        }
      } else {
        checkEffectCall(site, grants, code => report(code));
      }
    }
  }
  return diagnostics;
};

/**
 * Check a Script's or Library's source against the Libraries it may import,
 * and work out its direct imports and code identity. A source that doesn't
 * parse names no imports.
 */
export const prepare = (
  unit: 'script' | 'library',
  name: string,
  source: string,
  available: ReadonlyMap<string, Library>,
  objects?: readonly string[],
  grants?: GrantDecls,
  existing?: Readonly<Record<string, ExistingName>>,
  properties?: Pick<CheckOptions, 'objectProperties' | 'ownerProperties'>,
) => {
  const checked = checkSource(source, {
    unit,
    existing,
    objects,
    ...properties,
    grants,
    libraries: Object.fromEntries(
      [...available.values()].map(l => [l.name, compiled.get(l)!.exports]),
    ),
  });
  const diagnostics = diagnosticsOf(checked, name) ?? [];
  if (unit === 'script' && grants && checked.tree) {
    diagnostics.push(
      ...checkLibraryNeeds(name, checked.tree.root, available, grants),
    );
  }
  const names = checked.tree ? importsOf(checked.tree) : [];
  const imports = names.flatMap(
    n => available.get(n) ?? (stdlibNames.has(n) ? [stdlibLibrary(n)] : []),
  );
  return {
    checked,
    diagnostics: diagnostics.length
      ? diagnostics.sort(
          (a, b) =>
            a.line - b.line ||
            a.col - b.col ||
            (diagnosticCodes as readonly string[]).indexOf(a.code) -
              (diagnosticCodes as readonly string[]).indexOf(b.code),
        )
      : null,
    imports,
    identity: codeIdentity(unit, name, source, imports.map(identityOf)),
  };
};

/** Lower a checked unit, turning a failure to load into its diagnostic. */
export const loadOrReject = <T>(name: string, load: () => T): T => {
  try {
    return load();
  } catch (error) {
    if (error instanceof UnitLoadError) {
      throw new LoadError([
        {
          code: error.code,
          message: error.message,
          unit: name,
          line: error.line,
          col: error.col,
        },
      ]);
    }
    throw error;
  }
};

/** How a Host asks a Library to be compiled, outside the Spec. */
export type LibraryOptions = {
  /**
   * An error raised in it gets an `at` naming the call that entered it, as
   * for stdlib code (ADR 0037), rather than its own position.
   */
  atCaller?: boolean;
};

/**
 * Compile a Library, once per process for each code identity. `imports` holds
 * every Library its `use` lines name, other than the stdlib's, which are
 * always there. Throws LoadError.
 */
export const compileLibrary = (
  src: LibrarySource,
  imports: readonly Library[] = [],
  declarations: GrantDecls = {},
  options: LibraryOptions = {},
): Library => build(src, imports, false, declarations, options.atCaller);

const stdlib = new Map<string, Library>();
/** A stdlib Library, compiled from its normative source on first use. */
export const stdlibLibrary = (name: string): Library => {
  let l = stdlib.get(name);
  if (!l) {
    l = build(
      { name, version: languageVersion, source: stdlibSources[name]! },
      [],
      true,
    );
    stdlib.set(name, l);
  }
  return l;
};

const build = (
  src: LibrarySource,
  imports: readonly Library[],
  isStdlib: boolean,
  declarations: GrantDecls = {},
  atCaller = false,
): Library => {
  const available = new Map(imports.map(l => [l.name, l]));
  const p = prepare(
    'library',
    src.name,
    src.source,
    available,
    undefined,
    declarations,
  );
  if (p.diagnostics) {
    throw new LoadError(p.diagnostics);
  }
  // The same source compiled to name its caller is a separate code unit.
  const key = atCaller && !isStdlib ? `${p.identity} at caller` : p.identity;
  let entry = cache.get(key);
  if (!entry) {
    const tree = p.checked.tree!;
    entry = {
      exports: exportsOf(tree),
      code: loadOrReject(src.name, () =>
        loadLibrary(
          lowerTree(tree, { name: src.name, unit: 'library' }),
          linksOf(p.imports),
          p.identity,
        ),
      ),
    };
    entry.code.stdlib = isStdlib;
    entry.code.atCaller = isStdlib || atCaller;
    cache.set(key, entry);
  }
  const sites: CallSite[] = operationUses(p.checked.tree!.root).map(site => ({
    ...site,
    unit: src.name,
    identity: p.identity,
  }));
  const seen = new Set(
    sites.map(site => `${site.identity}:${site.node.span.start}`),
  );
  for (const imported of p.imports) {
    for (const site of compiled.get(imported)!.sites) {
      const key = `${site.identity}:${site.node.span.start}`;
      if (!seen.has(key)) {
        sites.push(site);
        seen.add(key);
      }
    }
  }
  const needed = new Map<string, OperationRef>();
  for (const site of sites) {
    needed.set(
      `${site.capability}\u0000${site.operation}`,
      Object.freeze({ capability: site.capability, operation: site.operation }),
    );
  }
  const library: Library = Object.freeze({
    name: src.name,
    version: src.version,
    source: src.source,
    identity: bytesOfHex(p.identity),
    imports: Object.freeze([...p.imports]),
    needs: Object.freeze(
      [...needed.values()].sort(
        (a, b) =>
          compareText(a.capability, b.capability) ||
          compareText(a.operation, b.operation),
      ),
    ),
  });
  compiled.set(library, {
    ...entry,
    hex: p.identity,
    sites: Object.freeze(sites),
    declarations,
  });
  return library;
};

/** Recompile the complete dependent Library graph without changing its registrations. */
export const replacementLibraries = (
  available: ReadonlyMap<string, Library>,
  replacement: Library,
): Map<string, Library> => {
  const affected = new Set([replacement.name]);
  for (let changed = true; changed;) {
    changed = false;
    for (const held of available.values()) {
      if (
        !affected.has(held.name) &&
        held.imports.some(i => affected.has(i.name))
      ) {
        affected.add(held.name);
        changed = true;
      }
    }
  }
  const cyclic = replacement.imports.find(i => affected.has(i.name));
  if (cyclic) {
    const p = prepare(
      'library',
      replacement.name,
      replacement.source,
      new Map(replacement.imports.map(i => [i.name, i])),
    );
    const use = viewSource(p.checked.tree!.root).find(
      d => d.k === 'use' && d.library === cyclic.name,
    );
    const line = use?.k === 'use' ? use.imports[0]!.local.span.line : 1;
    throw new LoadError([
      {
        code: 'import cycle',
        unit: replacement.name,
        line,
        col: 1,
        message: 'import cycle',
      },
    ]);
  }
  const libraries = new Map(available);
  libraries.set(replacement.name, replacement);
  const pending = [...available.values()].filter(
    i => i.name !== replacement.name && affected.has(i.name),
  );
  const rebuilt = new Set([replacement.name]);
  while (pending.length) {
    const at = pending.findIndex(i =>
      i.imports.every(d => !affected.has(d.name) || rebuilt.has(d.name)),
    );
    const old = pending.splice(at, 1)[0]!;
    libraries.set(
      old.name,
      compileLibrary(
        { name: old.name, source: old.source, version: old.version },
        [...libraries.values()],
        compiled.get(old)!.declarations,
        { atCaller: compiled.get(old)!.code.atCaller },
      ),
    );
    rebuilt.add(old.name);
  }
  return libraries;
};
