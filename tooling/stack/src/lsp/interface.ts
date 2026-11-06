// A Script's message interface, read from its Handler Clauses and their
// Clause Shapes (ADR 0171). The Host sets the Message Path at run time, so a
// `send` is matched by Selector against every Clause in the workspace, as
// Find References is (#2059).
import {
  kindNames,
  shapeData,
  type SemanticElement,
  type SemanticNode,
  type ShapeData,
} from '@northtalk/ts';
import { lintCatalogue, type Lint, type LintProfile } from '../lint';
import type { HostManifest } from './manifest';
import { rangeAt } from './protocol';
import type { Analysis } from './workspace';

/** One Handler Clause: its head as written, and each parameter's Shape. */
export type Clause = {
  analysis: Analysis;
  head: string;
  /** Each parameter's Clause Shape as Shape data, or null for none. */
  shapes: (ShapeData | null)[];
  /** Each parameter's Clause Shape as written, or null. */
  written: (string | null)[];
};

const nodes = (node: SemanticNode) =>
  node.children.filter((c): c is SemanticNode => c.kind === 'node');
const tokens = (node: SemanticNode): string[] =>
  node.children.flatMap(c => (c.kind === 'node' ? tokens(c) : [c.text]));
const isToken = (e: SemanticElement | undefined, text: string) =>
  e?.kind === 'token' && e.text === text;

const shapeDeclarations = (analysis: Analysis) => {
  const out = new Map<string, SemanticNode>();
  for (const child of nodes(analysis.checked.tree.root)) {
    let node: SemanticNode | undefined = child;
    if (isToken(node.children[0], 'private')) {
      const inner = node.children[1];
      node = inner?.kind === 'node' ? inner : undefined;
    }
    if (node && isToken(node.children[0], 'shape')) {
      const name = node.children[1];
      if (name?.kind === 'node') {
        out.set(tokens(name)[0] ?? '', node);
      } else if (name) {
        out.set(name.text, node);
      }
    }
  }
  return out;
};

// The Shape data a head's Kind names: a kind, a local Shape's data, or a
// reference the tooling doesn't follow (an imported Shape).
const kindShape = (
  declarations: Map<string, SemanticNode>,
  analysis: Analysis,
  kind: string,
): ShapeData | null => {
  if (kind === 'civil date' || kindNames.has(kind)) {
    return kind;
  }
  const declaration = declarations.get(kind);
  const data = declaration && shapeData.get(declaration);
  if (data) {
    return data;
  }
  const binding = analysis.checked.tree.scopes[0]?.bindings.find(
    b => b.name === kind && b.shape,
  );
  return binding ? { ref: binding } : null;
};

const headOf = (analysis: Analysis, handler: SemanticNode) => {
  const text = analysis.document.text;
  const start = handler.span.start;
  let end = handler.span.end;
  for (const child of handler.children) {
    if (child.kind === 'node' && child.rule === 'Block') {
      end = Math.min(end, child.span.start);
    } else if (isToken(child, 'where') || isToken(child, ',')) {
      end = Math.min(end, child.span.start);
    }
  }
  return text.slice(start, end).split(/\r?\n/)[0]!.trim();
};

const clausesOf = (analysis: Analysis) => {
  const declarations = shapeDeclarations(analysis);
  const out = new Map<string, Clause[]>();
  let fallback = false;
  for (const handler of analysis.nodes) {
    if (handler.rule !== 'Handler') {
      continue;
    }
    if (isToken(handler.children[1], 'any')) {
      fallback = true;
      continue;
    }
    const message = handler.children.find(
      (c): c is SemanticNode => c.kind === 'node' && c.rule === 'MessageName',
    );
    const selector = message && tokensAndNames(message)[0];
    if (!selector) {
      continue;
    }
    const shapes: (ShapeData | null)[] = [];
    const written: (string | null)[] = [];
    for (const child of handler.children) {
      if (child.kind !== 'node') {
        continue;
      }
      if (child.rule === 'Pattern') {
        shapes.push(null);
        written.push(null);
      } else if (child.rule === 'Kind' && shapes.length) {
        const kind = tokens(child).join(' ');
        shapes[shapes.length - 1] = kindShape(declarations, analysis, kind);
        written[written.length - 1] = kind;
      }
    }
    const list = out.get(selector) ?? [];
    list.push({ analysis, head: headOf(analysis, handler), shapes, written });
    out.set(selector, list);
  }
  return { clauses: out, fallback };
};

const tokensAndNames = (node: SemanticNode): string[] =>
  node.children.flatMap(c =>
    c.kind === 'node' ? tokensAndNames(c) : [c.text],
  );

const cache = new WeakMap<Analysis, ReturnType<typeof clausesOf>>();
const interfaceOf = (analysis: Analysis) => {
  let found = cache.get(analysis);
  if (!found) {
    found = clausesOf(analysis);
    cache.set(analysis, found);
  }
  return found;
};

/** Every Script's Clauses for the Selector, in document order. */
export const implementors = (all: Map<string, Analysis>, selector: string) => {
  const clauses: Clause[] = [];
  let fallback = false;
  for (const analysis of [...all.values()].sort((a, b) =>
    a.document.uri < b.document.uri ? -1 : 1,
  )) {
    if (analysis.document.library) {
      continue;
    }
    const found = interfaceOf(analysis);
    const own = found.clauses.get(selector);
    if (own) {
      clauses.push(...own);
      fallback ||= found.fallback;
    }
  }
  return { clauses, fallback };
};

/** Every Selector a workspace Script's Clauses answer, with their heads. */
export const workspaceMessages = (
  all: Map<string, Analysis>,
  except?: Analysis,
) => {
  const out = new Map<string, Clause[]>();
  for (const analysis of all.values()) {
    // The sender's own Handlers are offered as Command Calls instead.
    if (
      analysis.document.library ||
      analysis.document.uri === except?.document.uri
    ) {
      continue;
    }
    for (const [selector, clauses] of interfaceOf(analysis).clauses) {
      out.set(selector, [...(out.get(selector) ?? []), ...clauses]);
    }
  }
  return out;
};

const scriptName = (analysis: Analysis) =>
  decodeURIComponent(analysis.document.uri.split('/').at(-1) ?? '').replace(
    /\.talk$/,
    '',
  );

/** The Clause heads answering a Selector, grouped by Script. */
export const interfaceText = (clauses: Clause[], markdown: boolean) => {
  const byScript = new Map<string, string[]>();
  for (const c of clauses) {
    const name = scriptName(c.analysis);
    byScript.set(name, [...(byScript.get(name) ?? []), c.head]);
  }
  return [...byScript]
    .map(([name, heads]) =>
      markdown
        ? `${name}:\n\`\`\`northtalk\n${heads.join('\n')}\n\`\`\``
        : `${name}:\n${heads.map(h => `  ${h}`).join('\n')}`,
    )
    .join('\n\n');
};

/** Hover on a `send`'s message name: the Clauses that may answer it. */
export const sendHover = (
  all: Map<string, Analysis>,
  analysis: Analysis,
  offset: number,
  markdown: boolean,
) => {
  const name = analysis.names.find(
    n => n.role === 'message' && n.span.start <= offset && offset < n.span.end,
  );
  if (!name) {
    return null;
  }
  const send = analysis.nodes.find(
    n =>
      n.rule === 'Send' &&
      n.span.start <= name.span.start &&
      name.span.end <= n.span.end,
  );
  if (!send) {
    return null;
  }
  // A `send`'s receiver is another Script; the sender's own Handlers answer
  // Command Calls, and Go to Definition covers `send to me`.
  const clauses = implementors(all, name.text).clauses.filter(
    c => c.analysis.document.uri !== analysis.document.uri,
  );
  if (!clauses.length) {
    return null;
  }
  return {
    contents: {
      kind: markdown ? 'markdown' : 'plaintext',
      value: interfaceText(clauses, markdown),
    },
    range: rangeAt(analysis.document.text, name.span.start, name.span.end),
  };
};

// ------------------------------------------------------------ literal checks

/** A literal argument as far as the tooling can see it; `unknown` fits any
 * Shape, so a check never claims a mismatch it can't prove. */
type Literal =
  | { k: 'unknown' }
  | { k: 'nothing' | 'boolean' | 'number' | 'text' }
  | { items: Literal[]; k: 'list' }
  | { entries: Map<string, Literal>; k: 'map' };

const unknown: Literal = { k: 'unknown' };

// The one node a chain of single-child precedence levels wraps.
const unwrap = (node: SemanticNode): SemanticNode => {
  let at = node;
  while (at.children.length === 1 && at.children[0]!.kind === 'node') {
    at = at.children[0] as SemanticNode;
  }
  return at;
};

export const literalOf = (expression: SemanticNode, text: string): Literal => {
  // A List or Map is a Primary's only child, so unwrapping reaches it.
  const at = unwrap(expression);
  if (at.rule !== 'Primary' && at.rule !== 'List' && at.rule !== 'Map') {
    return unknown;
  }
  if (at.rule === 'Primary' && at.children.length !== 1) {
    return unknown;
  }
  const only = at.rule === 'Primary' ? at.children[0]! : at;
  if (only.kind === 'name') {
    return unknown;
  }
  if (only.kind === 'token') {
    const source = text.slice(only.span.start, only.span.end);
    if (/^["“]/.test(source)) {
      return { k: 'text' };
    }
    if (source === 'nothing') {
      return { k: 'nothing' };
    }
    if (source === 'true' || source === 'false') {
      return { k: 'boolean' };
    }
    return /^\d[\d_]*(?:\.[\d_]+)?$/.test(source) ? { k: 'number' } : unknown;
  }
  if (only.rule === 'List') {
    const items = nodes(only);
    if (items.some(i => i.rule !== 'Expression')) {
      return unknown;
    }
    return { k: 'list', items: items.map(i => literalOf(i, text)) };
  }
  if (only.rule === 'Map') {
    const entries = new Map<string, Literal>();
    let key: string | null = null;
    for (const child of only.children) {
      if (child.kind !== 'node') {
        continue;
      }
      if (child.rule === 'MapKey') {
        const first = child.children[0];
        // A computed or spread key hides which keys the map has.
        if (first?.kind !== 'token' || isToken(first, '(')) {
          return unknown;
        }
        key = first.text;
      } else if (child.rule === 'Expression' && key !== null) {
        entries.set(key, literalOf(child, text));
        key = null;
      } else {
        return unknown;
      }
    }
    return { k: 'map', entries };
  }
  return unknown;
};

/** False only when the literal can't conform to the Shape. */
export const mayConform = (value: Literal, shape: ShapeData): boolean => {
  if (value.k === 'unknown') {
    return true;
  }
  if (typeof shape === 'string') {
    return shape === 'any' || shape === 'value' || shape === value.k;
  }
  if ('ref' in shape) {
    return true;
  }
  if ('optional' in shape) {
    return value.k === 'nothing' || mayConform(value, shape.optional);
  }
  if ('oneOf' in shape) {
    return shape.oneOf.some(s => mayConform(value, s));
  }
  if ('list' in shape) {
    return (
      value.k === 'list' && value.items.every(i => mayConform(i, shape.list))
    );
  }
  if ('map' in shape) {
    if (value.k !== 'map') {
      return false;
    }
    const keys = new Set(shape.map.map(f => f.key));
    if (!shape.open && [...value.entries.keys()].some(k => !keys.has(k))) {
      return false;
    }
    return shape.map.every(field => {
      const got = value.entries.get(field.key);
      return got
        ? mayConform(
            got,
            field.optional ? { optional: field.shape } : field.shape,
          )
        : field.optional;
    });
  }
  // A quantity, a Unit Kind or an Object Kind: no literal the tooling reads
  // is one.
  return false;
};

/** Whether a `send`'s literal arguments fit some Clause; null if no Clause. */
export const sendFits = (clauses: Clause[], args: Literal[]): boolean =>
  clauses.some(
    c =>
      c.shapes.length === args.length &&
      c.shapes.every((s, i) => s === null || mayConform(args[i]!, s)),
  );

/** A `send`'s argument expressions, positional or labelled, in order. */
export const sendArguments = (send: SemanticNode) => {
  const list = send.children.find(
    (c): c is SemanticNode => c.kind === 'node' && c.rule === 'ExpressionList',
  );
  return list ? nodes(list).filter(n => n.rule === 'Expression') : [];
};

/**
 * `send-fits-no-clause`: a `send` whose literal arguments fit no Clause of
 * any workspace Script answering its Selector. A Fallback Handler, or a
 * message the Host Manifest declares, may still take it, so neither warns.
 */
export const addSendLints = (
  all: Map<string, Analysis>,
  manifest: HostManifest | null,
  profile: LintProfile,
) => {
  const entry = lintCatalogue.find(l => l.id === 'send-fits-no-clause')!;
  const level: string = entry[profile];
  if (level !== 'warning' && level !== 'hint') {
    return;
  }
  for (const analysis of all.values()) {
    const { text } = analysis.document;
    const lines = text.split('\n');
    const lints: Lint[] = [];
    for (const send of analysis.nodes) {
      if (send.rule !== 'Send') {
        continue;
      }
      const message = send.children.find(
        (c): c is SemanticNode => c.kind === 'node' && c.rule === 'MessageName',
      );
      const name = message && tokensAndNames(message)[0];
      if (!name || manifest?.messages.includes(name)) {
        continue;
      }
      const { clauses, fallback } = implementors(all, name);
      if (!clauses.length || fallback) {
        continue;
      }
      const list = send.children.find(
        (c): c is SemanticNode =>
          c.kind === 'node' && c.rule === 'ExpressionList',
      );
      // A spread hides how many arguments there are.
      if (
        list &&
        nodes(list).some(n => !['Expression', 'Label'].includes(n.rule))
      ) {
        continue;
      }
      const args = sendArguments(send).map(e => literalOf(e, text));
      if (sendFits(clauses, args)) {
        continue;
      }
      const span = message.span;
      if (
        lines[span.line - 2]?.trim() === '-- lint: ignore send-fits-no-clause'
      ) {
        continue;
      }
      lints.push({
        id: 'send-fits-no-clause',
        level,
        message: entry.message.replace(
          '{message}',
          name.replaceAll(':', ' ').trim(),
        ),
        span,
      });
    }
    if (!lints.length) {
      continue;
    }
    analysis.lints = [...analysis.lints, ...lints];
    analysis.diagnostics.push(
      ...lints.map(l => ({
        range: rangeAt(text, l.span.start, l.span.end),
        severity: l.level === 'warning' ? 2 : 4,
        code: l.id,
        source: 'northtalk lint',
        message: l.message,
      })),
    );
  }
};
