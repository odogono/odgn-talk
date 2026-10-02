import type { DiagnosticCode } from './checker';
import { grammar, units } from './generated/syntax';
import type {
  SemanticElement,
  SemanticName,
  SemanticNode,
  SemanticToken,
} from './semantic';
import { normalizeNFC } from './unicode';
import { literalDigits } from './values';

type Leaf = SemanticName | SemanticToken;
export type ConstructReport = (code: DiagnosticCode, at: Leaf) => void;

/** Chapter 3's kind names. */
export const kindNames: ReadonlySet<string> = new Set([
  'nothing',
  'boolean',
  'number',
  'quantity',
  'text',
  'bytes',
  'list',
  'map',
  'range',
  'instant',
  'civil date',
  'pattern',
  'function',
  'object',
]);
/** Chapter 3's kinds that `as` can't convert to. */
export const unconvertibleKinds: ReadonlySet<string> = new Set([
  'list',
  'map',
  'boolean',
  'range',
  'pattern',
  'function',
  'object',
  'nothing',
  'quantity',
]);
const unitNames = new Set(
  units.flatMap(unit =>
    'plural' in unit && unit.plural ? [unit.name, unit.plural] : [unit.name],
  ),
);
const anchors = new Set(grammar.text_patterns.anchors);

const nodes = (node: SemanticNode) =>
  node.children.filter((child): child is SemanticNode => child.kind === 'node');
const leaves = (node: SemanticNode) =>
  node.children.filter((child): child is Leaf => child.kind !== 'node');
const firstLeaf = (element: SemanticElement): Leaf => {
  while (element.kind === 'node') {
    element = element.children[0]!;
  }
  return element;
};
const text = (node: SemanticNode) =>
  leaves(node)
    .map(leaf => leaf.text)
    .join(' ');
/** Descend through single-child productions to the construct they wrap. */
const unwrap = (node: SemanticNode): SemanticNode => {
  while (node.children.length === 1 && node.children[0]!.kind === 'node') {
    node = node.children[0] as SemanticNode;
  }
  return node;
};
const isOp = (element: SemanticElement | undefined, op: string) =>
  element?.kind === 'token' && element.type === 'op' && element.text === op;

/** The kind after `is a`, `as` or `can be`: chapter 3 decides which names each allows. */
const checkKind = (
  kind: SemanticNode,
  position: 'is' | 'as' | 'can be',
  report: ConstructReport,
): string | null => {
  const name = text(kind);
  const known =
    kindNames.has(name) ||
    (position === 'is' ? name === 'integer' : unitNames.has(name));
  if (!known) {
    report('unknown kind', firstLeaf(kind));
    return null;
  }
  return name;
};

const checkComparison = (node: SemanticNode, report: ConstructReport) => {
  const words = leaves(node).map(leaf => leaf.text);
  const kind = nodes(node).find(child => child.rule === 'Kind');
  const is = words.includes('is');
  if (kind) {
    checkKind(kind, is ? 'is' : 'can be', report);
  }
  const folding = nodes(node).find(child => child.rule === 'IgnoringCase');
  if (folding && (kind || (is && words.includes('empty')))) {
    report('nothing to fold', firstLeaf(folding));
  }
};

const checkConversion = (node: SemanticNode, report: ConstructReport) => {
  const { children } = node;
  for (let index = 1; index < children.length; index++) {
    const as = children[index - 1]!;
    const kind = children[index]!;
    if (kind.kind !== 'node' || kind.rule !== 'Kind' || as.kind === 'node') {
      continue;
    }
    const name = checkKind(kind, 'as', report);
    if (name && unconvertibleKinds.has(name)) {
      report('no conversion', as);
    }
  }
};

const checkMap = (node: SemanticNode, report: ConstructReport) => {
  const seen = new Set<string>();
  for (const key of nodes(node).filter(child => child.rule === 'MapKey')) {
    const leaf = firstLeaf(key);
    const name = leaf.kind === 'token' ? normalizeNFC(leaf.text) : leaf.text;
    if (seen.has(name)) {
      report('duplicate key', leaf);
    }
    seen.add(name);
  }
};

/** Follow a `delimited by` chain through its Chunk Expressions to an `item` chunk. */
const checkDelimited = (node: SemanticNode, report: ConstructReport) => {
  const delimited = node.children.find(
    child => child.kind !== 'node' && child.text === 'delimited',
  ) as Leaf | undefined;
  if (!delimited) {
    return;
  }
  let base: SemanticNode | undefined = unwrap(node.children[0] as SemanticNode);
  while (base) {
    const words = leaves(base).map(leaf => leaf.text);
    if (base.rule === 'Chunk') {
      if (words[0] === 'item' || words[0] === 'items') {
        return;
      }
    } else if (base.rule === 'The') {
      const key = nodes(base).find(child => child.rule === 'Key');
      if (key) {
        // `the items of s` is the one property `delimited by` splits.
        if (text(key) === 'items') {
          return;
        }
        break;
      }
      const ordinal =
        base.children[1]?.kind === 'token' &&
        base.children[1].type === 'word' &&
        words[1] !== 'target';
      if (!ordinal) {
        break;
      }
      // An ordinal chunk, as in `the first item of s`.
      if (words[2] === 'item') {
        return;
      }
    } else if (base.rule === 'Postfix') {
      const key = nodes(base).at(-1);
      if (key?.rule === 'Key' && text(key) === 'items') {
        return;
      }
      break;
    } else {
      break;
    }
    const next = base.children.at(-1);
    base = next?.kind === 'node' ? unwrap(next) : undefined;
  }
  report('no item chunk', delimited);
};

const checkNumber = (token: SemanticToken, report: ConstructReport) => {
  if (!literalDigits(token.text)) {
    report('bad number', token);
  }
};

/** A list pattern's or Binary Pattern's `...` must be its last item. */
const checkRest = (node: SemanticNode, report: ConstructReport) => {
  const { children } = node;
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    const rest =
      node.rule === 'PatternPrimary'
        ? isOp(child, '...')
          ? (child as Leaf)
          : null
        : child.kind === 'node' &&
            child.rule === 'Field' &&
            isOp(child.children[0], '...')
          ? (child.children[0] as Leaf)
          : null;
    if (rest && children.slice(index + 1).some(later => isOp(later, ','))) {
      report('rest not last', rest);
    }
  }
};

/** Each run of consecutive bit fields must add up to whole bytes. */
const checkBits = (node: SemanticNode, report: ConstructReport) => {
  type Field = { first: Leaf; type: SemanticNode | undefined };
  const fields: Field[] = [];
  if (node.rule === 'BinaryPattern') {
    for (const field of nodes(node)) {
      fields.push({
        first: firstLeaf(field),
        type: nodes(field).find(child => child.rule === 'FieldType'),
      });
    }
  } else {
    // A build field is its value, optionally followed by `as` and a FieldType.
    for (const child of node.children) {
      if (child.kind !== 'node') {
        continue;
      }
      if (child.rule === 'FieldType') {
        fields.at(-1)!.type = child;
      } else {
        fields.push({ first: firstLeaf(child), type: undefined });
      }
    }
  }
  /** A bit field's width, null when it isn't an integer literal, or undefined. */
  const bits = (field: Field): number | null | undefined => {
    const unit = field.type && leaves(field.type).at(-1);
    if (unit?.text !== 'bit' && unit?.text !== 'bits') {
      return undefined;
    }
    const size = field.type!.children[0];
    const digits =
      size?.kind === 'token' && size.type === 'num'
        ? literalDigits(size.text)
        : null;
    return digits && !digits.fraction ? Number(digits.whole) : null;
  };
  for (let index = 0; index < fields.length;) {
    if (bits(fields[index]!) === undefined) {
      index++;
      continue;
    }
    const first = fields[index]!.first;
    let total: number | null = 0;
    for (; index < fields.length; index++) {
      const width = bits(fields[index]!);
      if (width === undefined) {
        break;
      }
      total = total === null || width === null ? null : total + width;
    }
    // A size that isn't an integer literal leaves the run to later checks.
    if (total !== null && total % 8 !== 0) {
      report('bits not whole bytes', first);
    }
  }
};

type Digits = { nonEmpty: boolean; only: boolean };
const anything: Digits = { only: false, nonEmpty: false };

/** Combine one production's digit facts from its children's. */
const digitsAt = (node: SemanticNode, of: (child: SemanticNode) => Digits) => {
  const [head] = node.children;
  const children = nodes(node);
  switch (node.rule) {
    case 'TextPattern': {
      // A sequence: only digits throughout, and at least one element non-empty.
      const parts = children.map(of);
      return {
        only: parts.every(part => part.only),
        nonEmpty: parts.some(part => part.nonEmpty),
      };
    }
    case 'Alternation': {
      const elements = children.map(of);
      return {
        only: elements.every(element => element.only),
        nonEmpty: elements.every(element => element.nonEmpty),
      };
    }
    case 'Element':
      return of(children[0]!);
    case 'Atom':
      break;
    default:
      return anything;
  }
  const words = leaves(node).map(leaf => leaf.text);
  if (isOp(head, '(')) {
    return anything;
  }
  if (head?.kind === 'token' && head.type === 'str') {
    return { only: /^\d*$/.test(head.text), nonEmpty: head.text !== '' };
  }
  const inner = children.find(
    child =>
      child.rule === 'Atom' ||
      child.rule === 'TextPattern' ||
      child.rule === 'Alternation',
  );
  if (inner?.rule === 'Atom') {
    // A repetition: `n e`, `one or more of e`, `zero or more of e` or `optional e`.
    const repeated = of(inner);
    const count =
      head?.kind === 'token' && head.type === 'num'
        ? /[1-9]/.test(head.text)
        : words[0] === 'one';
    return { only: repeated.only, nonEmpty: repeated.nonEmpty && count };
  }
  if (inner) {
    // A nested Text Pattern, or a Capture's Alternation.
    return of(inner);
  }
  if (anchors.has(words.join(' '))) {
    return { only: true, nonEmpty: false };
  }
  return words.length === 1 && (words[0] === 'digit' || words[0] === 'digits')
    ? { only: true, nonEmpty: true }
    : anything;
};
/** Whether a Text Pattern atom matches only ASCII digits, and always at least one. */
const atomDigits = (
  atom: SemanticNode,
  cache: Map<SemanticNode, Digits>,
): Digits => {
  const order: SemanticNode[] = [];
  const stack = [atom];
  while (stack.length) {
    const node = stack.pop()!;
    if (!cache.has(node)) {
      order.push(node);
      // Splices are evaluated at run time, so their contents never count.
      if (node.rule !== 'Expression') {
        stack.push(...nodes(node));
      }
    }
  }
  for (const node of order.reverse()) {
    cache.set(
      node,
      digitsAt(node, child => cache.get(child)!),
    );
  }
  return cache.get(atom)!;
};
const isTypedNumber = (atom: SemanticNode) => {
  const kind = nodes(atom).find(child => child.rule === 'Kind');
  return Boolean(kind && text(kind) === 'number' && leaves(atom).length === 1);
};

const checkAtom = (
  atom: SemanticNode,
  repeated: boolean,
  report: ConstructReport,
) => {
  const [head, colon] = atom.children;
  if (repeated && head?.kind === 'name' && isOp(colon, ':')) {
    report('capture in repetition', head);
  }
  const kind = nodes(atom).find(child => child.rule === 'Kind');
  if (kind && leaves(atom).length === 1 && text(kind) !== 'number') {
    report('unknown kind', firstLeaf(kind));
  }
};

const checkElement = (
  element: SemanticNode,
  cache: Map<SemanticNode, Digits>,
  report: ConstructReport,
) => {
  const atom = nodes(element)[0]!;
  const { children } = element;
  for (let index = 1; index < children.length; index++) {
    const as = children[index - 1]!;
    const kind = children[index]!;
    if (kind.kind !== 'node' || kind.rule !== 'Kind' || as.kind === 'node') {
      continue;
    }
    const name = text(kind);
    if (!kindNames.has(name) && !unitNames.has(name)) {
      report('unknown kind', firstLeaf(kind));
      continue;
    }
    const digits = atomDigits(atom, cache);
    if (
      name !== 'number' ||
      !(isTypedNumber(atom) || (digits.only && digits.nonEmpty))
    ) {
      report('no conversion', as);
    }
  }
};

/**
 * Check the load rules local to one construct: map keys, number literals,
 * kinds and conversions, `ignoring case` and `delimited by`, and the
 * structure of Text and Binary Patterns.
 */
export const checkConstructs = (
  root: SemanticNode,
  report: ConstructReport,
) => {
  const work: { node: SemanticNode; repeated: boolean }[] = [
    { node: root, repeated: false },
  ];
  const digits = new Map<SemanticNode, Digits>();
  while (work.length) {
    const { node, repeated } = work.pop()!;
    let inner = repeated;
    switch (node.rule) {
      case 'Comparison':
        checkComparison(node, report);
        break;
      case 'Conversion':
        checkConversion(node, report);
        break;
      case 'Map':
        checkMap(node, report);
        break;
      case 'ChunkLevel':
        checkDelimited(node, report);
        break;
      case 'PatternPrimary':
        if (isOp(node.children[0], '[')) {
          checkRest(node, report);
        }
        break;
      case 'BinaryPattern':
        checkRest(node, report);
        checkBits(node, report);
        break;
      case 'BinaryBuild':
        checkBits(node, report);
        break;
      case 'Atom':
        checkAtom(node, repeated, report);
        // Only a repetition holds an Atom directly: `n e`, `optional e`, `… of e`.
        inner ||= nodes(node).some(child => child.rule === 'Atom');
        break;
      case 'Element':
        checkElement(node, digits, report);
        break;
      case 'Expression':
        // A splice is evaluated, not repeated by the pattern around it.
        inner = false;
        break;
    }
    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = node.children[index]!;
      if (child.kind === 'node') {
        work.push({ node: child, repeated: inner });
      } else if (child.kind === 'token' && child.type === 'num') {
        checkNumber(child, report);
      }
    }
  }
};
