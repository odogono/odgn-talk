// `:describe` and `:apropos` (Session observation, Names and passive describe
// and Name discovery). Both read declaration source and the Built-in
// catalogue; only describing a current Script Variable reads the Group,
// through one explicit vars Host Input.
import type { Token } from '../lexer';
import { checkSource } from '../checker';
import { declarationDocs } from '../documentation';
import { builtins } from '../generated/syntax';
import { stdlibSources } from '../generated/stdlib';
import { parseSource } from '../parser';
import { readDisplay } from '../readers';
import type { SyntaxElement, SyntaxNode } from '../syntax';
import { lower } from '../unicode';
import { text, type Value } from '../values';
import { viewSource } from '../view';
import { selectorText } from './observe';
import { valueRows } from './inspect';

/** One declaration of the session source, as `:describe` reads it. */
export type DeclaredName = {
  kind: 'use' | 'handler' | 'function' | 'constant' | 'variable';
  library?: string;
  names: string[];
  source: string;
  uses?: { local: string; name: string }[];
};

/** What the Session Host holds for name lookup. */
export type Names = {
  readonly declarations: readonly DeclaredName[];
  /** Whether a current binding has the name, which shadows a Built-in. */
  has(name: string): boolean;
  /** User Libraries, in the order added, with their current sources. */
  readonly libraries: ReadonlyMap<string, string>;
  /** Refuses the command with `! <reason>`. */
  refuse(reason: string): never;
  /** A current Script Variable's value, from one explicit snapshot. */
  variable(name: string): Value | undefined;
};

/** A canonical describe target, as apropos prints it. */
type Target = { library?: string; name: string; origin: string };

/** One declaration as describe shows it. Handler Clauses are separate. */
type Declared = {
  /** A function's required and total parameter counts. */
  arity?: [number, number];
  clause: number;
  declaration: 'function' | 'handler' | 'constant' | 'variable' | 'builtin';
  doc: string;
  origin: string;
  signature: string;
  /** A session Script Variable, whose value needs a snapshot. */
  variable?: string;
};

const ORIGINS = ['session', 'builtin', 'library'];

const show = (s: string) => text(s).toString();
const targetText = (t: Target) =>
  t.origin === 'library'
    ? `{library: ${show(t.library!)}, name: ${show(t.name)}, origin: "library"}`
    : `{name: ${show(t.name)}, origin: ${show(t.origin)}}`;

// Strings in Unicode code-point order, which UTF-16 comparison is not.
const byCodePoint = (a: string, b: string): number => {
  const x = Array.from(a, c => c.codePointAt(0)!);
  const y = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) {
      return x[i]! - y[i]!;
    }
  }
  return x.length - y.length;
};

const tokens = (node: SyntaxNode): Token[] =>
  node.children.flatMap((c: SyntaxElement) =>
    c.kind === 'node' ? tokens(c) : [c],
  );

// The signature runs from a declaration's first token through its grammar
// head: a function's or Handler's head line without a trailing comment, or a
// Constant's or Script Variable's name, without its initializer.
const signature = (source: string, node: SyntaxNode, kind: string): string => {
  const all = tokens(node);
  let last = all.findIndex(t => t.t === 'nl') - 1;
  if (kind === 'constant' || kind === 'variable') {
    last = all.findIndex(t => t.v === 'constant' || t.v === 'variable') + 1;
  }
  return source.slice(all[0]!.pos, all[last]!.end);
};

// Each public declaration in a source, by name in source order, read once.
// A Handler's Clauses share its Selector.
const declaredIn = (
  source: string,
  origin: string,
  includePrivate = false,
): Map<string, Declared[]> => {
  const out = new Map<string, Declared[]>();
  const tree = parseSource(source).tree;
  const checked = checkSource(source).tree;
  if (!tree || !checked) {
    return out;
  }
  const docs = declarationDocs(tree);
  const nodes = tree.children.filter(
    (c): c is SyntaxNode => c.kind === 'node' && c.rule === 'Declaration',
  );
  viewSource(checked.root).forEach((decl, at) => {
    if (
      decl.k === 'use' ||
      ('private' in decl && decl.private && !includePrivate)
    ) {
      return;
    }
    const name =
      decl.k === 'constant' || decl.k === 'variable'
        ? decl.name.text
        : decl.name;
    const named = out.get(name) ?? [];
    out.set(name, named);
    const node = nodes[at]!;
    const d: Declared = {
      origin,
      declaration: decl.k,
      clause: decl.k === 'handler' ? named.length + 1 : 0,
      doc: docs.get(node) ?? '',
      signature: signature(source, node, decl.k),
    };
    if (decl.k === 'function') {
      d.arity = [
        decl.params.filter(p => p.default === null).length,
        decl.params.length,
      ];
    }
    named.push(d);
  });
  return out;
};

const librarySource = (names: Names, library: string): string | undefined =>
  names.libraries.get(library) ?? stdlibSources[library];

/** A public Library export, from the Library's source, imported or not. */
export const libraryDeclared = (
  names: Names,
  library: string,
  name: string,
): Declared[] => {
  const source = librarySource(names, library);
  return source === undefined
    ? []
    : (declaredIn(source, library).get(name) ?? []);
};

/**
 * A current session name or Selector, as binding precedence resolves it. An
 * Import resolves to its defining Library declaration.
 */
export const sessionDeclared = (names: Names, name: string): Declared[] => {
  const out: Declared[] = [];
  for (const d of names.declarations) {
    if (d.kind === 'use') {
      const imported = d.uses!.find(u => u.local === name);
      if (imported) {
        return libraryDeclared(names, d.library!, imported.name);
      }
      continue;
    }
    if (d.names[0] !== name) {
      continue;
    }
    const [m] = [...declaredIn(d.source, 'session', true).values()][0] ?? [];
    if (!m) {
      continue;
    }
    if (d.kind === 'variable') {
      m.variable = name;
    }
    if (d.kind !== 'handler') {
      return [m];
    }
    m.clause = out.length + 1;
    out.push(m);
  }
  return out;
};

export const builtinDeclared = (name: string): Declared[] => {
  const b = builtins.find(b => b.name === name);
  return b
    ? [
        {
          origin: 'builtin',
          declaration: 'builtin',
          clause: 0,
          doc: b.gives,
          signature: b.call,
        },
      ]
    : [];
};

// A plain name or Selector, or a canonical target map.
const describeTarget = (
  names: Names,
  rest: string,
): { plain: boolean; target: Target } => {
  if (!rest.startsWith('{')) {
    if (!selectorText(rest)) {
      names.refuse('bad arguments');
    }
    return { plain: true, target: { name: rest, origin: 'session' } };
  }
  let v: Value;
  try {
    v = readDisplay(rest);
  } catch {
    names.refuse('bad arguments');
  }
  const fields = new Map(v.entries());
  const field = (key: string) => fields.get(key)?.asText();
  const origin = field('origin');
  const keys = origin === 'library' ? 3 : 2;
  if (
    v.kind !== 'map' ||
    [...fields.values()].some(f => f.kind !== 'text') ||
    !ORIGINS.includes(origin ?? '') ||
    field('name') === undefined ||
    (origin === 'library' && field('library') === undefined) ||
    fields.size !== keys
  ) {
    names.refuse('bad arguments');
  }
  const target: Target = { name: field('name')!, origin: origin! };
  if (origin === 'library') {
    target.library = field('library');
  }
  return { plain: false, target };
};

/** `:describe <target>`'s rows. */
export const describe = (names: Names, rest: string): string[] => {
  const { plain, target } = describeTarget(names, rest);
  let found: Declared[] = [];
  if (target.origin === 'session') {
    found = sessionDeclared(names, target.name);
    if (!found.length && plain) {
      target.origin = 'builtin';
      found = builtinDeclared(target.name);
    }
  } else if (target.origin === 'builtin') {
    found = builtinDeclared(target.name);
  } else {
    found = libraryDeclared(names, target.library!, target.name);
  }
  if (!found.length) {
    names.refuse('no such name');
  }
  const out: string[] = [];
  for (const d of found) {
    const clause = d.declaration === 'handler' ? `, clause: ${d.clause}` : '';
    out.push(
      `describe {target: ${targetText(target)}, origin: ${show(d.origin)}, declaration: ${show(d.declaration)}, signature: ${show(d.signature)}${clause}}`,
      `doc ${show(d.doc)}`,
    );
    if (d.arity) {
      out.push(`arity ${d.arity[0]}..${d.arity[1]}`);
    }
    if (d.variable !== undefined) {
      const value = names.variable(d.variable);
      if (value) {
        out.push(...valueRows(value));
      }
    }
  }
  return out;
};

// One apropos target, with every Handler Clause it groups.
type Found = {
  available: boolean;
  docs: Declared[];
  import: string | null;
  origin: string;
  target: Target;
};

/** `:apropos [query]`'s rows. */
export const apropos = (names: Names, rest: string): string[] => {
  let query = rest;
  if (rest.startsWith('"')) {
    let v: Value;
    try {
      v = readDisplay(rest);
    } catch {
      names.refuse('bad arguments');
    }
    if (v.kind !== 'text') {
      names.refuse('bad arguments');
    }
    query = v.asText()!;
  }
  query = lower(query);
  const all: Found[] = [];
  const add = (f: Found) => {
    if (f.docs.length && lower(f.target.name).includes(query)) {
      all.push(f);
    }
  };
  const seen = new Set<string>();
  for (const d of names.declarations) {
    for (const name of d.names) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const docs = sessionDeclared(names, name);
      if (docs.length) {
        add({
          target: { name, origin: 'session' },
          origin: docs[0]!.origin,
          available: true,
          import: null,
          docs,
        });
      }
    }
  }
  for (const b of builtins) {
    add({
      target: { name: b.name, origin: 'builtin' },
      origin: 'builtin',
      available: !names.has(b.name),
      import: null,
      docs: builtinDeclared(b.name),
    });
  }
  const libraries = [
    ...Object.keys(stdlibSources).sort(byCodePoint),
    ...names.libraries.keys(),
  ];
  for (const library of libraries) {
    const source = librarySource(names, library)!;
    for (const [name, docs] of declaredIn(source, library)) {
      if (docs[0]!.declaration === 'variable') {
        continue;
      }
      const available = names.declarations.some(
        d =>
          d.kind === 'use' &&
          d.library === library &&
          d.uses!.some(u => u.name === name && u.local === name),
      );
      add({
        target: { library, name, origin: 'library' },
        origin: library,
        available,
        import: available ? null : `use ${name} from ${library}`,
        docs,
      });
    }
  }
  all.sort(
    (a, b) =>
      byCodePoint(a.target.name, b.target.name) ||
      ORIGINS.indexOf(a.target.origin) - ORIGINS.indexOf(b.target.origin) ||
      byCodePoint(a.target.library ?? '', b.target.library ?? ''),
  );
  const out: string[] = [];
  for (const f of all) {
    out.push(
      `name {target: ${targetText(f.target)}, origin: ${show(f.origin)}, available: ${f.available}, import: ${f.import === null ? 'nothing' : show(f.import)}}`,
    );
    for (const d of f.docs) {
      out.push(
        d.declaration === 'handler'
          ? `doc ${d.clause} ${show(d.doc)}`
          : `doc ${show(d.doc)}`,
      );
    }
  }
  return out;
};
