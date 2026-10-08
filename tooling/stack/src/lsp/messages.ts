/** Senders and implementors of a message, by Selector across the workspace.
 * A `send` reaches its Handler along the Message Path, whose parents the Host
 * sets at run time (ADR 0016), so nothing here narrows by receiver. */
import type { SemanticName, SemanticNode } from '@odgn/northtalk';
import { semanticElements, type Analysis } from './workspace';
import { rangeAt, type Location, type Range } from './protocol';

type SiteKind =
  | 'send'
  | 'pass'
  | 'command'
  | 'handler'
  | 'wait'
  | 'computed send'
  | 'pass any message';
/** `selector` is null where the name can't be seen: a computed `send` name
 * or `pass any message`. */
export type MessageSite = {
  analysis: Analysis;
  end: number;
  kind: SiteKind;
  selector: string | null;
  start: number;
};
const senderKinds = new Set<SiteKind>(['send', 'pass', 'command']);
const implementorKinds = new Set<SiteKind>(['handler', 'wait']);

const innermost = (analysis: Analysis, start: number, rules: string[]) =>
  analysis.nodes
    .filter(
      n =>
        rules.includes(n.rule) && n.span.start <= start && start < n.span.end,
    )
    .at(-1);
const leaves = (node: SemanticNode) =>
  node.children.filter(c => c.kind !== 'node');

const siteOf = (analysis: Analysis, name: SemanticName): SiteKind | null => {
  if (name.binding?.kind === 'handler') {
    if (name.role === 'declaration' && !name.binding.importedFrom) {
      return 'handler';
    }
    if (name.role === 'command') {
      return 'command';
    }
  }
  if (name.role !== 'message') {
    return null;
  }
  const rule = innermost(analysis, name.span.start, [
    'Send',
    'Event',
    'SimpleStatement',
  ])?.rule;
  return rule === 'Send' ? 'send' : rule === 'Event' ? 'wait' : 'pass';
};

const sitesIn = (analysis: Analysis): MessageSite[] => {
  const out: MessageSite[] = [];
  for (const name of analysis.names) {
    const kind = siteOf(analysis, name);
    if (kind) {
      out.push({
        analysis,
        kind,
        selector: name.text,
        start: name.span.start,
        end: name.span.end,
      });
    }
  }
  for (const node of analysis.nodes) {
    const direct = leaves(node);
    const words = direct.map(c => c.text);
    if (node.rule === 'Send' && words[1] === '(') {
      // `send (<name>) …` (ADR 0057): mark the parenthesised name.
      const close = direct.findIndex((c, i) => i > 1 && c.text === ')');
      out.push({
        analysis,
        kind: 'computed send',
        selector: null,
        start: direct[1]!.span.start,
        end: direct[close]?.span.end ?? node.span.end,
      });
    } else if (
      node.rule === 'SimpleStatement' &&
      words.slice(0, 3).join(' ') === 'pass any message'
    ) {
      out.push({
        analysis,
        kind: 'pass any message',
        selector: null,
        start: direct[0]!.span.start,
        end: direct[2]!.span.end,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
};
/** By document URI, then source order, so results don't depend on which
 * documents are open. */
export const messageSites = (all: Map<string, Analysis>): MessageSite[] =>
  [...all.values()]
    .sort((a, b) =>
      a.document.uri < b.document.uri
        ? -1
        : a.document.uri > b.document.uri
          ? 1
          : 0,
    )
    .flatMap(sitesIn);

/** The Selector named at `offset`: a Handler head, `send`, `pass`, `wait for`
 * event or Command Call of a Handler. */
export const selectorAt = (
  analysis: Analysis,
  offset: number,
): string | null => {
  const name = analysis.names.find(
    n => n.span.start <= offset && offset < n.span.end,
  );
  return name && siteOf(analysis, name) ? name.text : null;
};

const location = (site: MessageSite): Location => ({
  uri: site.analysis.document.uri,
  range: rangeAt(site.analysis.document.text, site.start, site.end),
});
/** Every `send`, `pass` and Command Call naming the Selector, with each
 * Handler Clause and `wait for` event too when `withImplementors` is set. */
export const senders = (
  all: Map<string, Analysis>,
  selector: string,
  withImplementors: boolean,
): Location[] =>
  messageSites(all)
    .filter(
      s =>
        s.selector === selector &&
        (senderKinds.has(s.kind) ||
          (withImplementors && implementorKinds.has(s.kind))),
    )
    .map(location);
/** Every Handler Clause, in a Script or a Library, and `wait for` event that
 * receives the Selector. */
export const implementors = (
  all: Map<string, Analysis>,
  selector: string,
): Location[] =>
  messageSites(all)
    .filter(s => s.selector === selector && implementorKinds.has(s.kind))
    .map(location);

// The call hierarchy: an item is a Handler Clause, a function or a Script's
// top level, and its data says how to find it again in a later request.
type ItemData = { selector: string | null; start: number; uri: string };
export type CallHierarchyItem = {
  data: ItemData;
  detail: string;
  kind: number;
  name: string;
  range: Range;
  selectionRange: Range;
  uri: string;
};
const SYMBOL_FILE = 1;
const SYMBOL_METHOD = 6;
const SYMBOL_FUNCTION = 12;
const UNKNOWN = 'unknown message name';

const unitName = (analysis: Analysis) =>
  analysis.document.library ??
  decodeURIComponent(analysis.document.uri.split('/').at(-1) ?? '');
const headLine = (analysis: Analysis, node: SemanticNode) =>
  analysis.document.text
    .slice(node.span.start, node.span.end)
    .split(/\r\n|\r|\n/)[0]!
    .trim()
    .replace(/^(?:on|function)\s+/u, '');
const item = (analysis: Analysis, node: SemanticNode | undefined) => {
  const text = analysis.document.text;
  if (!node) {
    const top = rangeAt(text, 0, 0);
    return {
      name: unitName(analysis),
      kind: SYMBOL_FILE,
      detail: analysis.document.library ? 'Library' : 'Script',
      uri: analysis.document.uri,
      range: top,
      selectionRange: top,
      data: { selector: null, start: 0, uri: analysis.document.uri },
    } satisfies CallHierarchyItem;
  }
  const head = semanticElements(node).find(
    (e): e is SemanticName => e.kind === 'name' && e.role === 'declaration',
  );
  const selection = head?.span ?? leaves(node)[0]!.span;
  return {
    name: headLine(analysis, node),
    kind: node.rule === 'Function' ? SYMBOL_FUNCTION : SYMBOL_METHOD,
    detail: unitName(analysis),
    uri: analysis.document.uri,
    range: rangeAt(text, node.span.start, node.span.end),
    selectionRange: rangeAt(text, selection.start, selection.end),
    data: {
      selector:
        node.rule === 'Handler' && head?.binding?.kind === 'handler'
          ? head.text
          : null,
      start: node.span.start,
      uri: analysis.document.uri,
    },
  } satisfies CallHierarchyItem;
};
const enclosing = (analysis: Analysis, start: number) =>
  innermost(analysis, start, ['Handler', 'Function']);

/** One item per Handler Clause for the Selector at `offset`, or the clause
 * itself on a Handler head. A Selector with no Handler is its own site. */
export const prepareCallHierarchy = (
  all: Map<string, Analysis>,
  analysis: Analysis,
  offset: number,
): CallHierarchyItem[] | null => {
  const selector = selectorAt(analysis, offset);
  if (!selector) {
    return null;
  }
  const own = enclosing(analysis, offset);
  const name = analysis.names.find(
    n => n.span.start <= offset && offset < n.span.end,
  )!;
  if (own && name.role === 'declaration') {
    return [item(analysis, own)];
  }
  const clauses = messageSites(all).filter(
    s => s.selector === selector && s.kind === 'handler',
  );
  if (clauses.length) {
    return clauses.map(s => item(s.analysis, enclosing(s.analysis, s.start)));
  }
  const text = analysis.document.text;
  const at = rangeAt(text, name.span.start, name.span.end);
  return [
    {
      name: selector,
      kind: SYMBOL_METHOD,
      detail: 'no Handler in the workspace',
      uri: analysis.document.uri,
      range: at,
      selectionRange: at,
      data: { selector, start: name.span.start, uri: analysis.document.uri },
    },
  ];
};

const group = <T>(
  sites: MessageSite[],
  key: (site: MessageSite) => string,
  make: (site: MessageSite) => T,
) => {
  const out = new Map<string, { at: T; fromRanges: Range[] }>();
  for (const site of sites) {
    const entry = out.get(key(site)) ?? { at: make(site), fromRanges: [] };
    entry.fromRanges.push(location(site).range);
    out.set(key(site), entry);
  }
  return [...out.values()];
};
/** The places that send the item's Selector, by the clause they're in. A
 * computed `send` or `pass any message` might send any Selector, so each is
 * listed as well, marked with an unknown message name. */
export const incomingCalls = (all: Map<string, Analysis>, data: ItemData) => {
  if (!data.selector) {
    return [];
  }
  const sites = messageSites(all).filter(
    s =>
      (s.selector === data.selector && senderKinds.has(s.kind)) ||
      s.kind === 'computed send' ||
      s.kind === 'pass any message',
  );
  return group(
    sites,
    s =>
      `${s.analysis.document.uri}:${enclosing(s.analysis, s.start)?.span.start ?? -1}:${s.selector === null}`,
    s => {
      const from = item(s.analysis, enclosing(s.analysis, s.start));
      return s.selector === null ? { ...from, detail: UNKNOWN } : from;
    },
  ).map(({ at, fromRanges }) => ({ from: at, fromRanges }));
};
/** The Selectors the item's clause sends, each to its first Handler Clause
 * when one exists; computed names are one item marked unknown. */
export const outgoingCalls = (all: Map<string, Analysis>, data: ItemData) => {
  const analysis = all.get(data.uri);
  const node = analysis?.nodes.find(
    n =>
      (n.rule === 'Handler' || n.rule === 'Function') &&
      n.span.start === data.start,
  );
  if (!analysis || !node) {
    return [];
  }
  const everywhere = messageSites(all);
  const sites = sitesIn(analysis).filter(
    s =>
      (senderKinds.has(s.kind) || s.kind === 'computed send') &&
      enclosing(analysis, s.start) === node,
  );
  return group(
    sites,
    s => s.selector ?? '',
    s => {
      const clause =
        s.selector &&
        everywhere.find(e => e.selector === s.selector && e.kind === 'handler');
      if (clause) {
        return item(clause.analysis, enclosing(clause.analysis, clause.start));
      }
      const at = location(s).range;
      return {
        name: s.selector ?? '(…)',
        kind: SYMBOL_METHOD,
        detail: s.selector ? 'no Handler in the workspace' : UNKNOWN,
        uri: analysis.document.uri,
        range: at,
        selectionRange: at,
        data: { selector: s.selector, start: s.start, uri: data.uri },
      } satisfies CallHierarchyItem;
    },
  ).map(({ at, fromRanges }) => ({ to: at, fromRanges }));
};
