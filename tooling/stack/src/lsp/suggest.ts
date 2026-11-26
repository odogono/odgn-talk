import {
  type Binding,
  type BindingKind,
  type SemanticElement,
  type SemanticName,
  type SyntaxElement,
  type SyntaxNode,
  type Token,
} from '@northtalk/ts';
import { builtins } from '../generated/lints';
import { operationCall } from './calls';
import type { HostManifest } from './manifest';
import { innermost } from './messages';
import { expression, propertyRead } from './properties';
import { overlaps, rangeAt, type Range } from './protocol';
import { elements, type Analysis } from './workspace';

/**
 * Optimal string alignment distance: Levenshtein, with a swap of two
 * neighbouring characters costing one edit.
 */
export const editDistance = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[a.length]![b.length]!;
};

/**
 * Up to three candidates near `name`: within `max(1, ⌊len/3⌋)` edits, a
 * case-only difference first, then by distance, ties broken by name.
 */
export const nearest = (name: string, candidates: Iterable<string>) => {
  const limit = Math.max(1, Math.floor(name.length / 3));
  const lower = name.toLowerCase();
  return [...new Set(candidates)]
    .filter(c => c !== name)
    .map(c => ({
      c,
      rank: c.toLowerCase() === lower ? 0 : editDistance(name, c),
    }))
    .filter(({ rank }) => rank <= limit)
    .sort((x, y) => x.rank - y.rank || (x.c < y.c ? -1 : x.c > y.c ? 1 : 0))
    .slice(0, 3)
    .map(({ c }) => c);
};

// Bindings that may hold a function, since a call may name a Function Value.
const callable = new Set<BindingKind>([
  'function',
  'builtin function',
  'local',
  'parameter',
  'script variable',
  'constant',
]);
// What each role may name without trading one load error for another.
const fits: Partial<Record<string, (kind: BindingKind) => boolean>> = {
  value: kind => kind !== 'handler' && kind !== 'builtin function',
  call: kind => callable.has(kind),
};

/** Names the checker could resolve at an unknown name, by its role. */
const nameCandidates = (analysis: Analysis, start: number) => {
  const name = analysis.names.find(
    n => n.span.start === start && n.binding === null,
  );
  if (!name) {
    return [];
  }
  if (name.role === 'binary size') {
    // Only a field bound earlier in the same Binary Pattern.
    const pattern = innermost(analysis, start, ['BinaryPattern']);
    return pattern
      ? elements<SemanticElement>(pattern)
          .filter(
            (e): e is SemanticName =>
              e.kind === 'name' &&
              e.binding !== null &&
              e.span.end <= start &&
              (e.role === 'binding' || e.role === 'declaration'),
          )
          .map(e => e.text)
      : [];
  }
  const fit = fits[name.role];
  if (!fit) {
    return [];
  }
  // A Constant's initializer reads only Built-in Constants and the Constants
  // declared before it, and calls only Built-in functions without effects.
  const declaration = innermost(analysis, start, ['Declaration']);
  const constant =
    declaration?.children[0]?.kind === 'token' &&
    declaration.children[0].text === 'constant'
      ? declaration.span.start
      : undefined;
  const allowed = (b: Binding) =>
    constant === undefined
      ? fit(b.kind)
      : name.role === 'call'
        ? b.kind === 'builtin function' && b.name !== 'random'
        : b.kind === 'builtin constant' ||
          (b.kind === 'constant' && b.span !== null && b.span.start < constant);
  const scopes = analysis.checked.tree.scopes;
  const out: string[] = [];
  for (
    let scope =
      analysis.nodes
        .filter(n => n.span.start <= start && start < n.span.end)
        .at(-1)?.scope ?? null;
    scope !== null;
    scope = scopes[scope]?.parent ?? null
  ) {
    for (const b of scopes[scope]?.bindings ?? []) {
      if (allowed(b) && !b.name.includes(':')) {
        out.push(b.name);
      }
    }
  }
  for (const b of builtins) {
    const kind =
      b.kind === 'function' ? 'builtin function' : 'builtin constant';
    if (allowed({ kind, name: b.name, span: null } as Binding)) {
      out.push(b.name);
    }
  }
  return out;
};

/**
 * A misspelt Operation gets its Grant's Operations, and a call's misspelt
 * receiver the Grants the Script holds. Anything else, such as a Host
 * Command, gets nothing.
 */
const operationCandidates = (
  analysis: Analysis,
  manifest: HostManifest,
  start: number,
) => {
  const syntax = elements<SyntaxElement>(analysis.syntax);
  const call = syntax
    .filter(
      (e): e is SyntaxNode =>
        e.kind === 'node' &&
        ['AskTell', 'OperationLine', 'TellBlock'].includes(e.rule) &&
        e.start <= start &&
        start < e.end,
    )
    .at(-1);
  if (!call) {
    return [];
  }
  const operation =
    call.rule === 'TellBlock'
      ? undefined
      : operationCall(syntax, call, analysis.document.text);
  if (operation?.op.pos === start) {
    return [...(manifest.grants.get(operation.grant)?.keys() ?? [])];
  }
  const to = call.children.findIndex(e => e.kind === 'token' && e.v === 'to');
  const receiver =
    call.rule === 'AskTell'
      ? call.children[to - 1]
      : call.rule === 'TellBlock'
        ? call.children[1]
        : undefined;
  return receiver?.kind === 'node' &&
    receiver.start <= start &&
    start < receiver.end
    ? [...manifest.grants.keys()]
    : [];
};

// A Selector's Argument Labels: `to:` of `move:to:`, nothing of `demo`.
const labels = (selector: string) =>
  selector.slice(selector.indexOf(':') + 1 || selector.length);

/** A message Selector's head word, for those with the same labels. */
const messageCandidates = (manifest: HostManifest, selector: string) =>
  manifest.messages
    .filter(m => labels(m) === labels(selector))
    .map(m => m.split(':')[0]!);

/** A Handler's explicit ending, when it repeats the head's name. */
const endingOf = (analysis: Analysis, head: number, name: string) => {
  const handler = elements<SyntaxElement>(analysis.syntax)
    .filter(
      (e): e is SyntaxNode =>
        e.kind === 'node' &&
        e.rule === 'Handler' &&
        e.start <= head &&
        head < e.end,
    )
    .at(-1);
  const tokens = handler
    ? elements<SyntaxElement>(handler).filter(
        (e): e is Token => e.kind === 'token',
      )
    : [];
  const end = tokens
    .map(t => t.t === 'word' && t.v === 'end')
    .lastIndexOf(true);
  const suffix = end >= 0 ? tokens[end + 1] : undefined;
  return suffix?.raw === name ? suffix : undefined;
};

/** Properties of the kinds the object may be; for a `set`, writable ones. */
const propertyCandidates = (
  analysis: Analysis,
  manifest: HostManifest,
  start: number,
) => {
  const node = analysis.nodes.find(
    n =>
      n.rule === 'The' &&
      n.children[1]?.kind === 'node' &&
      n.children[1].span.start === start,
  );
  const read = node && propertyRead(node, manifest, analysis.nodes);
  if (!read) {
    return [];
  }
  const set = analysis.nodes.some(s => {
    const [head, target] = s.children;
    return (
      s.rule === 'SimpleStatement' &&
      head?.kind === 'token' &&
      head.text === 'set' &&
      target?.kind === 'node' &&
      expression(target) === node
    );
  });
  const names = new Set(read.kinds.flatMap(k => [...k.props.keys()]));
  return [...names].filter(
    p =>
      !set ||
      !read.kinds.every(k => {
        const prop = k.props.get(p);
        return !prop || prop.readOnly;
      }),
  );
};

/**
 * Quick fixes that replace an unknown name with a near one. They are never
 * preferred, since a near name is a guess (#2361).
 */
export const suggestionActions = (
  analysis: Analysis,
  manifest: HostManifest | null,
  requested: Range,
) => {
  if (!manifest) {
    return [];
  }
  const text = analysis.document.text;
  // The Core's own diagnostics, not those re-reported from a Library.
  const problems = [
    ...analysis.checked.diagnostics
      .filter(d => d.code === 'unknown name' || d.code === 'unknown operation')
      .map(d => ({ code: d.code, start: d.span.start, end: d.span.end })),
    ...analysis.lints
      .filter(l => l.id === 'unknown-message' || l.id === 'unknown-property')
      .map(l => ({
        code: l.id as string,
        start: l.span.start,
        end: l.span.end,
      })),
  ].filter(p => overlaps(rangeAt(text, p.start, p.end), requested));
  return problems.flatMap(({ code, start, end }) => {
    const name = text.slice(start, end);
    const candidates =
      code === 'unknown name'
        ? nameCandidates(analysis, start)
        : code === 'unknown operation'
          ? operationCandidates(analysis, manifest, start)
          : code === 'unknown-property'
            ? propertyCandidates(analysis, manifest, start)
            : messageCandidates(
                manifest,
                // Each Clause's head names the whole Selector.
                analysis.names.find(
                  n => n.span.start === start && n.role === 'declaration',
                )?.text ?? name,
              );
    const range = rangeAt(text, start, end);
    const ending =
      code === 'unknown-message' ? endingOf(analysis, start, name) : undefined;
    const diagnostics = analysis.diagnostics.filter(
      d =>
        d.code === code &&
        d.range.start.line === range.start.line &&
        d.range.start.character === range.start.character,
    );
    return nearest(name, candidates).map(near => ({
      title: `Change to ${near}`,
      kind: 'quickfix',
      diagnostics,
      edit: {
        changes: {
          [analysis.document.uri]: [
            { range, newText: near },
            ...(ending
              ? [
                  {
                    range: rangeAt(text, ending.pos, ending.end),
                    newText: near,
                  },
                ]
              : []),
          ],
        },
      },
    }));
  });
};
