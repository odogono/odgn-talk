// The load-time checks of `ask`, `tell` and `say` against a Script's Grants
// (chapter 2, Load-time diagnostics; chapter 9, Shapes): the Grant and
// Operation exist, the call fits the Operation's mode, it passes as many
// arguments as the Operation takes, and each literal argument fits its Shape.
import type { Shape } from './capabilities';
import type { Report } from './control';
import type {
  SemanticElement,
  SemanticName,
  SemanticNode,
  SemanticToken,
} from './semantic';
import { parseUnit, unitEntry, unitText, UnitError } from './units';

export type OperationMode = 'immediate' | 'suspending' | 'fire-and-forget';
/** Each Grant's Operations, by the name the Script uses. */
export type GrantDecls = Readonly<
  Record<
    string,
    Readonly<Record<string, { args: readonly Shape[]; mode: OperationMode }>>
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
      return true;
    case 'oneOf':
      return s.of.some(option => fits(l, option));
    case 'optional':
      return (l.k === 'kind' && l.kind === 'nothing') || fits(l, s.of);
    case 'kind':
      return l.k === 'kind' && l.kind === s.kind;
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

const effectNodes = (root: SemanticNode): SemanticNode[] => {
  const found: SemanticNode[] = [];
  const work: SemanticNode[] = [root];
  while (work.length) {
    const node = work.pop()!;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i]!;
      if (child.kind === 'node') {
        work.push(child);
      }
    }
    if (
      node.rule === 'AskTell' ||
      (node.rule === 'SimpleStatement' &&
        node.children[0]?.kind === 'name' &&
        node.children[0].text === 'say')
    ) {
      found.push(node);
    }
  }
  return found;
};

/** Operation references in source order, retaining the call for import checks. */
export const operationUses = (root: SemanticNode) =>
  effectNodes(root).flatMap(node => {
    if (node.rule === 'SimpleStatement') {
      return [{ capability: 'console', operation: 'write', node }];
    }
    const target = node.children[1];
    const op = node.children[3];
    const grant = target && firstLeaf(target);
    return grant && isLeaf(op)
      ? [{ capability: grant.text, operation: op.text, node }]
      : [];
  });

/** Check one call without revisiting any Lambda inside its arguments. */
export const checkEffectCall = (
  node: SemanticNode,
  grants: GrantDecls,
  report: Report,
) => {
  const say = node.rule === 'SimpleStatement';
  if (!say && node.rule !== 'AskTell') {
    return;
  }
  const head = node.children[0] as Leaf;
  const target = node.children[1];
  const grant = say ? head : target && firstLeaf(target);
  const op = say ? head : node.children[3];
  if (!grant || !isLeaf(op)) {
    return;
  }
  const grantName = say ? 'console' : grant.text;
  const operation = say ? 'write' : op.text;
  const ops = Object.hasOwn(grants, grantName) ? grants[grantName] : null;
  if (!ops) {
    report('unknown operation', grant);
    return;
  }
  const decl = Object.hasOwn(ops, operation) ? ops[operation] : null;
  if (!decl) {
    report('unknown operation', op);
    return;
  }
  const wait = nodesOf(node, 'AndWait').length > 0;
  const asked = !say && head.text === 'ask';
  const fitsMode = asked
    ? decl.mode === (wait ? 'suspending' : 'immediate')
    : decl.mode === 'fire-and-forget';
  if (!fitsMode) {
    report('wrong mode', head);
    return;
  }
  const list = nodesOf(node, 'ExpressionList')[0];
  const args = list ? nodesOf(list, 'Expression') : [];
  if (args.length !== decl.args.length) {
    report('wrong argument count', op);
    return;
  }
  args.forEach((arg, i) => {
    const literal = literalOf(arg);
    if (literal && !fits(literal, decl.args[i]!)) {
      report('wrong argument', firstLeaf(arg)!);
    }
  });
};

/** Check every Capability call in a Script against its Grants. */
export const checkEffects = (
  root: SemanticNode,
  grants: GrantDecls,
  report: Report,
) => {
  for (const node of effectNodes(root)) {
    checkEffectCall(node, grants, report);
  }
};
