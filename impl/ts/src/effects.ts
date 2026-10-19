// The load-time checks of `ask`, `tell` and `say` against a Script's Grants
// (chapter 2, Load-time diagnostics; chapter 9, Shapes): the Grant and
// Operation exist, the call fits the Operation's mode, it passes as many
// arguments as its required and Optional positions permit, any Argument
// Labels it writes are the declared ones, and each literal argument fits its
// Shape.
import { acceptsArgumentCount, type Shape } from './capabilities';
import type { Report } from './control';
import {
  hostCommands,
  toldLines,
  type SemanticElement,
  type SemanticName,
  type SemanticNode,
  type SemanticToken,
} from './semantic';
import { parseUnit, unitEntry, unitText, UnitError } from './units';

export type OperationMode = 'immediate' | 'suspending' | 'fire-and-forget';
/** Each Grant's Operations, by the name the Script uses. */
export type GrantDecls = Readonly<
  Record<
    string,
    Readonly<
      Record<
        string,
        {
          args: readonly Shape[];
          command?: boolean;
          labels?: readonly string[];
          mode: OperationMode;
        }
      >
    >
  >
>;

type Leaf = SemanticName | SemanticToken;
const isLeaf = (e: SemanticElement | undefined): e is Leaf =>
  e?.kind === 'name' || e?.kind === 'token';
const firstLeaf = (e: SemanticElement): Leaf | undefined => {
  let current: SemanticElement | undefined = e;
  while (current && !isLeaf(current)) {
    current = current.children[0];
  }
  return current;
};
const nodesOf = (n: SemanticNode, rule: string) =>
  n.children.filter(
    (c): c is SemanticNode => c.kind === 'node' && c.rule === rule,
  );
// An Expression that is a single Primary, down the chain of one-child nodes.
const primaryOf = (e: SemanticNode): SemanticNode | undefined => {
  let current: SemanticNode = e;
  while (current.rule !== 'Primary') {
    const only = current.children.filter(c => c.kind === 'node');
    if (only.length !== 1 || current.children.length !== 1) {
      return undefined;
    }
    current = only[0] as SemanticNode;
  }
  return current;
};

// A literal argument, as far as the load-time check can see it.
type Literal =
  | { k: 'kind'; kind: string }
  | { k: 'quantity'; unit: string | null }
  | { k: 'list' }
  | { k: 'map'; keys: string[] };
const literalOf = (e: SemanticNode): Literal | undefined => {
  const p = primaryOf(e);
  if (!p) {
    return undefined;
  }
  const [a, b] = p.children;
  if (p.children.length === 1 && a?.kind === 'token') {
    if (a.type === 'num') {
      return { k: 'kind', kind: 'number' };
    }
    if (a.type === 'str') {
      return { k: 'kind', kind: 'text' };
    }
    if (a.type === 'word' && (a.text === 'true' || a.text === 'false')) {
      return { k: 'kind', kind: 'boolean' };
    }
    if (a.type === 'word' && a.text === 'nothing') {
      return { k: 'kind', kind: 'nothing' };
    }
  }
  if (
    p.children.length === 2 &&
    a?.kind === 'token' &&
    a.type === 'num' &&
    b?.kind === 'token' &&
    b.type === 'unit'
  ) {
    try {
      return { k: 'quantity', unit: unitText(parseUnit(b.text)) };
    } catch (error) {
      if (error instanceof UnitError) {
        return { k: 'quantity', unit: null };
      }
      throw error;
    }
  }
  if (p.children.length === 1 && a?.kind === 'node' && a.rule === 'List') {
    return { k: 'list' };
  }
  if (p.children.length === 1 && a?.kind === 'node' && a.rule === 'Map') {
    return {
      k: 'map',
      keys: nodesOf(a, 'MapKey').map(key => firstLeaf(key)?.text ?? ''),
    };
  }
  return undefined;
};

// Whether a literal can fit a Shape; only what a literal shows is checked.
const fits = (l: Literal, s: Shape): boolean => {
  switch (s.k) {
    case 'any':
    case 'value':
      return true;
    case 'oneOf':
      return s.of.some(option => fits(l, option));
    case 'optional':
      return (l.k === 'kind' && l.kind === 'nothing') || fits(l, s.of);
    case 'kind':
      return (
        (l.k === 'kind' && l.kind === s.kind) ||
        (l.k === 'quantity' && s.kind === 'quantity')
      );
    case 'object':
      // Host Objects have no Script literal form.
      return false;
    case 'quantity':
      return l.k === 'quantity' && (l.unit === null || l.unit === s.unit);
    case 'unitKind': {
      if (l.k !== 'quantity') {
        return false;
      }
      if (l.unit === null) {
        return true;
      }
      const slots = parseUnit(l.unit);
      return (
        slots.length === 1 &&
        slots[0]!.exponent === 1 &&
        unitEntry(slots[0]!.unit)?.kind === s.kind
      );
    }
    case 'list':
      return l.k === 'list';
    case 'map': {
      if (l.k !== 'map') {
        return false;
      }
      const declared = new Set(s.fields.map(f => f.key));
      return (
        s.fields.every(f => f.optional || l.keys.includes(f.key)) &&
        (s.open || l.keys.every(key => declared.has(key)))
      );
    }
  }
};

/**
 * A Capability call: a one-line `ask` or `tell`, a line of a `tell` block,
 * whose Grant is the block's receiver (ADR 0063), a Host Command (ADR 0094),
 * or `say`.
 */
export type EffectUse = {
  capability: string;
  grant: Leaf;
  node: SemanticNode;
  op: Leaf;
  operation: string;
};

/** Every Capability call in source order, retaining the call for import checks. */
export const operationUses = (root: SemanticNode): EffectUse[] => {
  const found: EffectUse[] = [];
  const work: SemanticNode[] = [root];
  while (work.length) {
    const node = work.pop()!;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i]!;
      if (child.kind === 'node') {
        work.push(child);
      }
    }
    if (node.rule === 'SimpleStatement') {
      const head = node.children[0];
      const command = hostCommands.get(node);
      if (command && head?.kind === 'name') {
        found.push({
          capability: command.grant,
          operation: command.operation,
          node,
          grant: head,
          op: head,
        });
      } else if (head?.kind === 'name' && head.text === 'say') {
        found.push({
          capability: 'console',
          operation: 'write',
          node,
          grant: head,
          op: head,
        });
      }
    } else if (node.rule === 'AskTell') {
      const target = node.children[1];
      const grant = target && firstLeaf(target);
      const op = node.children[3];
      if (grant && isLeaf(op)) {
        found.push({
          capability: grant.text,
          operation: op.text,
          node,
          grant,
          op,
        });
      }
    } else if (node.rule === 'TellBlock') {
      const target = node.children[1];
      const grant = target && firstLeaf(target);
      for (const line of nodesOf(node, 'OperationLine')) {
        const op = line.children[0];
        if (grant && isLeaf(op)) {
          found.push({
            capability: grant.text,
            operation: op.text,
            node: line,
            grant,
            op,
          });
        }
      }
    }
  }
  return found.sort((a, b) => a.node.span.start - b.node.span.start);
};

/** Check one call without revisiting any Lambda inside its arguments. */
export const checkEffectCall = (
  use: EffectUse,
  grants: GrantDecls,
  report: Report,
) => {
  const { node, grant, op } = use;
  // A Host Command is checked as the `tell` or `ask` it stands for, called
  // as its checker chose, as a `tell` block's line is.
  const command = hostCommands.has(node);
  const say = node.rule === 'SimpleStatement' && !command;
  const line = node.rule === 'OperationLine' || command;
  const ops = Object.hasOwn(grants, use.capability)
    ? grants[use.capability]
    : null;
  if (!ops) {
    report('unknown operation', grant);
    return;
  }
  const decl = Object.hasOwn(ops, use.operation) ? ops[use.operation] : null;
  if (!decl) {
    report('unknown operation', op);
    return;
  }
  const wait = nodesOf(node, 'AndWait').length > 0;
  // A `tell` block's line is called as its checker chose (ADR 0063).
  const asked = line
    ? !toldLines.has(node)
    : !say && (node.children[0] as Leaf).text === 'ask';
  const fitsMode = asked
    ? decl.mode === (wait ? 'suspending' : 'immediate')
    : decl.mode === 'fire-and-forget';
  if (!fitsMode || (!asked && nodesOf(node, 'ResultTarget').length > 0)) {
    report('wrong mode', line ? op : (node.children[0] as Leaf));
    return;
  }
  const list = nodesOf(node, 'ExpressionList')[0];
  const args = list ? nodesOf(list, 'Expression') : [];
  if (
    (say && args.length !== 1) ||
    !acceptsArgumentCount(decl.args, args.length)
  ) {
    report('wrong argument count', op);
    return;
  }
  // A labelled call writes the declared labels in order, so one that leaves
  // off trailing Optional arguments writes a prefix of them (ADR 0115).
  const declared = decl.labels ?? [];
  const wrong = (list ? nodesOf(list, 'Label') : []).find(
    (label, i) => firstLeaf(label)?.text !== declared[i],
  );
  if (wrong) {
    report('wrong labels', firstLeaf(wrong)!);
  }
  args.forEach((arg, i) => {
    const literal = literalOf(arg);
    if (literal && !fits(literal, decl.args[i]!)) {
      report('wrong argument', firstLeaf(arg)!);
    }
  });
};

/**
 * The Selectors a Host Command answers: its name, and for an Operation with
 * `labels`, its name and the labels of each argument count it accepts past
 * the first, so `move` with `labels = ["to"]` answers `move` and `move:to:`
 * (ADR 0115).
 */
const commandSelectors = (
  operation: string,
  decl: { args: readonly Shape[]; labels?: readonly string[] },
): string[] => {
  const selectors = [operation];
  const labels = decl.labels ?? [];
  for (let n = 2; n <= labels.length + 1; n++) {
    if (acceptsArgumentCount(decl.args, n)) {
      selectors.push(`${[operation, ...labels.slice(0, n - 1)].join(':')}:`);
    }
  }
  return selectors;
};

/**
 * Resolve each Command Call that names no Handler of the unit, local or
 * imported, to a Host Command: an Operation its Grants declare `command`
 * (ADR 0094), by any of its Selectors (ADR 0115). A labelled call whose
 * Selector the Operation doesn't spell stays a message. A fire-and-forget
 * one without `and wait` is called as `tell`, and any other as `ask`,
 * decided here once, so an importer's recheck never changes it. An Import
 * named like a Host Command, or a call that two Grants offer, is a
 * `name clash`. Gives each resolved call for the compile cache key.
 */
export const resolveHostCommands = (
  root: SemanticNode,
  grants: GrantDecls,
  report: Report,
): string[] => {
  const offered = new Map<
    string,
    { grant: string; mode: OperationMode; operation: string }[]
  >();
  for (const [grant, ops] of Object.entries(grants)) {
    for (const [operation, decl] of Object.entries(ops)) {
      if (decl.command) {
        for (const selector of commandSelectors(operation, decl)) {
          offered.set(selector, [
            ...(offered.get(selector) ?? []),
            { grant, mode: decl.mode, operation },
          ]);
        }
      }
    }
  }
  const commands: { at: number; key: string }[] = [];
  const work: SemanticElement[] = offered.size ? [root] : [];
  while (work.length) {
    const element = work.pop()!;
    if (element.kind === 'name') {
      // An Import's local name, bound to what it imports.
      if (
        element.role === 'import' &&
        element.binding?.importedFrom &&
        offered.has(element.text)
      ) {
        report('name clash', element);
      }
      continue;
    }
    if (element.kind !== 'node') {
      continue;
    }
    work.push(...element.children);
    const head = element.children[0];
    if (
      element.rule !== 'SimpleStatement' ||
      head?.kind !== 'name' ||
      head.role !== 'command' ||
      head.binding?.kind === 'handler' ||
      head.text === 'say'
    ) {
      continue;
    }
    const found = offered.get(head.text);
    if (!found) {
      continue;
    }
    if (found.length > 1) {
      report('name clash', head);
      continue;
    }
    const { grant, mode, operation } = found[0]!;
    hostCommands.set(element, { grant, operation });
    const told =
      mode === 'fire-and-forget' && !nodesOf(element, 'AndWait').length;
    if (told) {
      toldLines.add(element);
    }
    commands.push({
      at: element.span.start,
      key: `${element.span.start} ${grant}.${operation} ${told ? 'tell' : 'ask'}`,
    });
  }
  return commands.sort((a, b) => a.at - b.at).map(c => c.key);
};

/**
 * Check every Capability call in a Script against its Grants. A `tell`
 * block's line is called as `tell` when its Operation is fire-and-forget and
 * it has no `and wait`, and as `ask` otherwise, decided here once (ADR 0063),
 * so an importer's recheck never changes it. A Grant the Script doesn't hold
 * is reported once for a block, at its receiver.
 */
export const checkEffects = (
  root: SemanticNode,
  grants: GrantDecls,
  report: Report,
) => {
  const reported = new Set<Leaf>();
  for (const use of operationUses(root)) {
    if (use.node.rule !== 'OperationLine') {
      checkEffectCall(use, grants, report);
      continue;
    }
    const ops = Object.hasOwn(grants, use.capability)
      ? grants[use.capability]!
      : {};
    const decl = Object.hasOwn(ops, use.operation)
      ? ops[use.operation]
      : undefined;
    if (
      decl?.mode === 'fire-and-forget' &&
      !nodesOf(use.node, 'AndWait').length
    ) {
      toldLines.add(use.node);
    }
    checkEffectCall(use, grants, (code, at) => {
      if (!reported.has(at)) {
        reported.add(at);
        report(code, at);
      }
    });
  }
};
