// Named Shapes (spec chapter 7, Shape declarations; ADR 0168): the load
// rules of `shape Name is …`, and the Shape data each declaration lowers to.
import { unitKinds } from './generated/syntax';
import { kindNames, unitNames, type ConstructReport } from './constructs';
import type {
  Binding,
  SemanticElement,
  SemanticName,
  SemanticNode,
  SemanticToken,
} from './semantic';

type Leaf = SemanticName | SemanticToken;

/**
 * Shape data before it becomes a value: `ref` is a named Shape from another
 * unit, read from its Constant at load; a local one is inlined.
 */
export type ShapeData =
  | string
  | { quantity: string }
  | { unitKind: string }
  | { object: string }
  | { list: ShapeData }
  | { optional: ShapeData }
  | { oneOf: ShapeData[] }
  | {
      map: { key: string; optional: boolean; shape: ShapeData }[];
      open: boolean;
    }
  | { ref: Binding };

/** Each loadable Shape declaration's data, by its Declaration node. */
export const shapeData = new WeakMap<SemanticNode, ShapeData>();

const scalarNames = new Set([...kindNames, 'any', 'value']);
const unitKindNames = new Set<string>(unitKinds);

const nodes = (node: SemanticNode) =>
  node.children.filter((child): child is SemanticNode => child.kind === 'node');
const leaves = (node: SemanticNode): Leaf[] =>
  node.children.flatMap(child =>
    child.kind === 'node' ? leaves(child) : [child],
  );
const isToken = (element: SemanticElement | undefined, text: string) =>
  element?.kind === 'token' && element.text === text;

/** A Shape declaration, unwrapped from `private`, or null. */
export const shapeDeclaration = (node: SemanticNode): SemanticNode | null => {
  if (node.rule !== 'Declaration') {
    return null;
  }
  const [first, second] = node.children;
  if (isToken(first, 'private') && second?.kind === 'node') {
    return shapeDeclaration(second);
  }
  return isToken(first, 'shape') ? node : null;
};

// The parsed form, with each Name still to resolve.
type Term =
  | { at: Leaf; k: 'name'; name: string }
  | { k: 'unit'; unit: string }
  | { at: Leaf; k: 'unitKind'; kind: string }
  | { k: 'object'; kind: string }
  | { k: 'list' | 'optional'; of: Term }
  | { k: 'oneOf'; of: Term[] }
  | {
      fields: { at: Leaf; key: string; optional: boolean; shape: Term }[];
      k: 'map';
      open: boolean;
    };

const expression = (node: SemanticNode): Term => {
  const terms = nodes(node).map(term);
  return terms.length === 1 ? terms[0]! : { k: 'oneOf', of: terms };
};

const term = (node: SemanticNode): Term => {
  if (node.rule === 'ShapeExpr') {
    return expression(node);
  }
  const [first, second] = node.children;
  if (first?.kind === 'node') {
    // A Shape Map, or a kind or Name.
    if (first.rule === 'ShapeMap') {
      return map(first);
    }
    const words = leaves(first);
    return {
      k: 'name',
      at: words[0]!,
      name: words.map(word => word.text).join(' '),
    };
  }
  if (first?.kind === 'token' && first.type === 'unit') {
    return { k: 'unit', unit: first.text };
  }
  if (isToken(first, '(')) {
    return expression(second as SemanticNode);
  }
  if (isToken(first, 'optional')) {
    return { k: 'optional', of: term(second as SemanticNode) };
  }
  const last = node.children.at(-1)!;
  const name = last.kind === 'node' ? leaves(last)[0]! : last;
  if (isToken(first, 'list')) {
    return { k: 'list', of: term(last as SemanticNode) };
  }
  if (isToken(first, 'object')) {
    return { k: 'object', kind: name.text };
  }
  return { k: 'unitKind', at: name, kind: name.text };
};

const map = (node: SemanticNode): Term => ({
  k: 'map',
  open: node.children.some(child => isToken(child, '...')),
  fields: nodes(node).map(field => {
    const [key, ...rest] = field.children;
    const at = leaves(key as SemanticNode)[0]!;
    return {
      at,
      key: at.text,
      optional: isToken(rest[0], 'optional'),
      shape: expression(rest.at(-1) as SemanticNode),
    };
  }),
});

/**
 * Check every Shape declaration in a unit, report `bad shape` at each
 * offending token, and record the data of each one that loads.
 */
export const checkShapes = (
  root: SemanticNode,
  lookup: (name: string) => Binding | undefined,
  report: ConstructReport,
) => {
  const declared = new Map<string, { node: SemanticNode; term: Term }>();
  const order: { name: SemanticName; node: SemanticNode; term: Term }[] = [];
  for (const child of nodes(root)) {
    const node = shapeDeclaration(child);
    if (!node) {
      continue;
    }
    const name = leaves(node.children[1] as SemanticNode)[0] as SemanticName;
    const shape = term(node.children[3] as SemanticNode);
    order.push({ name, node, term: shape });
    if (!declared.has(name.text)) {
      declared.set(name.text, { node, term: shape });
    }
    if (
      scalarNames.has(name.text) ||
      unitNames.has(name.text) ||
      unitKindNames.has(name.text)
    ) {
      report('bad shape', name);
    }
  }
  if (!order.length) {
    return;
  }

  // Resolve every Name, and find the local Shapes each declaration names.
  const edges = new Map<SemanticNode, { at: Leaf; to: SemanticNode }[]>();
  let failed = false;
  const resolve = (from: SemanticNode, t: Term) => {
    switch (t.k) {
      case 'name': {
        if (scalarNames.has(t.name) || unitNames.has(t.name)) {
          return;
        }
        const binding = lookup(t.name);
        const local = declared.get(t.name);
        if (local && binding?.shape && !binding.importedFrom) {
          edges.get(from)!.push({ at: t.at, to: local.node });
        } else if (!binding?.shape) {
          report('bad shape', t.at);
          failed = true;
        }
        return;
      }
      case 'unitKind':
        if (!unitKindNames.has(t.kind)) {
          report('bad shape', t.at);
          failed = true;
        }
        return;
      case 'list':
      case 'optional':
        return resolve(from, t.of);
      case 'oneOf':
        return t.of.forEach(alternative => resolve(from, alternative));
      case 'map': {
        const keys = new Set<string>();
        for (const field of t.fields) {
          if (keys.has(field.key)) {
            report('bad shape', field.at);
            failed = true;
          }
          keys.add(field.key);
          resolve(from, field.shape);
        }
      }
    }
  };
  for (const { node, term: t } of order) {
    edges.set(node, []);
    resolve(node, t);
  }

  // A reference is on a cycle when the Shape it names reaches back to it.
  const reaches = (from: SemanticNode, to: SemanticNode) => {
    const seen = new Set<SemanticNode>();
    const work = [from];
    while (work.length) {
      const node = work.pop()!;
      if (node === to) {
        return true;
      }
      if (!seen.has(node)) {
        seen.add(node);
        work.push(...edges.get(node)!.map(edge => edge.to));
      }
    }
    return false;
  };
  const cyclic = new Set<SemanticNode>();
  const firstOnCycle = new Map<string, Leaf>();
  for (const [from, list] of edges) {
    for (const edge of list) {
      if (!reaches(edge.to, from)) {
        continue;
      }
      cyclic.add(from);
      // One report per cycle: name it by the Shapes on it.
      const members = order
        .filter(
          ({ node }) =>
            node === from || (reaches(from, node) && reaches(node, from)),
        )
        .map(({ name }) => name.text)
        .join(' ');
      const seen = firstOnCycle.get(members);
      if (!seen || edge.at.span.start < seen.span.start) {
        firstOnCycle.set(members, edge.at);
      }
    }
  }
  for (const at of firstOnCycle.values()) {
    report('bad shape', at);
  }
  if (failed || cyclic.size) {
    return;
  }

  const lower = (t: Term): ShapeData => {
    switch (t.k) {
      case 'name': {
        if (scalarNames.has(t.name)) {
          return t.name;
        }
        if (unitNames.has(t.name)) {
          return { quantity: t.name };
        }
        const local = declared.get(t.name);
        const binding = lookup(t.name)!;
        return local && !binding.importedFrom
          ? lower(local.term)
          : { ref: binding };
      }
      case 'unit':
        return { quantity: t.unit };
      case 'unitKind':
        return { unitKind: t.kind };
      case 'object':
        return { object: t.kind };
      case 'list':
        return { list: lower(t.of) };
      case 'optional':
        return { optional: lower(t.of) };
      case 'oneOf':
        return { oneOf: t.of.map(lower) };
      case 'map':
        return {
          map: t.fields.map(field => ({
            key: field.key,
            optional: field.optional,
            shape: lower(field.shape),
          })),
          open: t.open,
        };
    }
  };
  for (const { node, term: t } of order) {
    shapeData.set(node, lower(t));
  }
};
