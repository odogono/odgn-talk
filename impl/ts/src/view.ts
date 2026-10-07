// The constructs chapter 8 lowers, read from a checked semantic tree. Each
// production keeps its tokens' positions and resolved names; parentheses,
// trivia and the precedence ladder are gone. Conversion is post-order over an
// explicit stack, so deep source doesn't depend on the native call stack.
import { grammar } from './generated/syntax';
import type {
  Binding,
  SemanticElement,
  SemanticName,
  SemanticNode,
  SemanticToken,
} from './semantic';

export type Pos = { col: number; line: number };
export type Leaf = SemanticName | SemanticToken;

export type Expr =
  | { k: 'number'; pos: Pos; text: string }
  | { k: 'quantity'; number: string; pos: Pos; unit: string }
  | { k: 'text'; pos: Pos; value: string }
  | { k: 'literal'; pos: Pos; value: 'true' | 'false' | 'nothing' }
  | { k: 'me'; pos: Pos }
  | { k: 'target'; pos: Pos }
  | { k: 'name'; name: SemanticName; pos: Pos }
  | { k: 'pin'; name: SemanticName; pos: Pos }
  | { fold: boolean; k: 'binary'; l: Expr; op: string; pos: Pos; r: Expr }
  | { fold: boolean; k: 'member'; l: Expr; neg: boolean; pos: Pos; r: Expr }
  | { k: 'is-kind'; kind: string; l: Expr; neg: boolean; pos: Pos }
  | { k: 'is-empty'; l: Expr; neg: boolean; pos: Pos }
  | { e: Expr; k: 'can-convert' | 'convert'; kind: string; pos: Pos }
  | { e: Expr; k: 'not' | 'negate'; pos: Pos }
  | { k: 'and' | 'or'; l: Expr; pos: Pos; r: Expr }
  | { base: Expr; k: 'key'; key: string; pos: Pos }
  | { base: Expr; k: 'computed'; key: Expr; pos: Pos }
  | {
      base: Expr;
      delimiter: Expr | null;
      k: 'property';
      name: string;
      pos: Pos;
    }
  | {
      base: Expr;
      delimiter: Expr | null;
      index: Expr | number;
      k: 'chunk';
      kind: string;
      pos: Pos;
    }
  | { items: { e: Expr; spread: boolean }[]; k: 'list'; pos: Pos }
  | { entries: { key: string; value: Expr }[]; k: 'map'; pos: Pos }
  | { k: 'pattern'; pattern: TextPattern; pos: Pos }
  | { fields: BuildField[]; k: 'build'; pos: Pos }
  | { k: 'match-all'; pat: Expr; pos: Pos; src: Expr }
  | Replace
  | { args: Expr[]; k: 'call'; name: SemanticName; pos: Pos }
  | Lambda;

export type Replace = {
  first: boolean;
  k: 'replace';
  pat: Expr;
  pos: Pos;
  target: Expr;
  value: Expr;
};
export type Lambda = {
  body: Expr | Stmt[];
  end: Pos | null;
  k: 'lambda';
  params: Pattern[];
  pos: Pos;
  scope: number;
};

export type TextPattern = { els: PatternElement[]; pos: Pos };
export type PatternElement =
  | { k: 'text'; value: string }
  | { e: PatternElement; k: 'count'; n: string }
  | { els: PatternElement[]; k: 'group' }
  | { e: Expr; k: 'splice' }
  | { e: PatternElement; k: 'capture'; name: SemanticName }
  | { k: 'words'; words: string }
  | {
      e: PatternElement;
      k: 'repeat';
      phrase: 'one or more of' | 'zero or more of' | 'optional';
    }
  | { k: 'typed'; kind: string }
  | { k: 'alternation'; options: PatternElement[] }
  | {
      as: string | null;
      e: PatternElement;
      fold: boolean;
      k: 'suffixed';
      lazily: boolean;
    };

export type Literal =
  | { k: 'number'; negative: boolean; text: string; unit: string | null }
  | { k: 'text'; value: string }
  | { k: 'word'; value: 'true' | 'false' | 'nothing' };
export type Pattern =
  | { k: 'bind'; name: SemanticName; pos: Pos }
  | { k: 'wildcard'; pos: Pos }
  | { k: 'as'; name: SemanticName; p: Pattern; pos: Pos }
  | { k: 'literal'; pos: Pos; value: Literal }
  | { k: 'pin'; name: SemanticName; pos: Pos }
  | {
      items: Pattern[];
      k: 'list';
      pos: Pos;
      rest: { name: SemanticName | null } | null;
    }
  | { entries: { key: string; value: Pattern }[]; k: 'map'; pos: Pos }
  | { k: 'text'; pattern: TextPattern; pos: Pos }
  | { fields: BinaryField[]; k: 'binary'; pos: Pos };

export type Size =
  | { k: 'number'; text: string }
  | { k: 'pin'; name: SemanticName; pos: Pos }
  | { k: 'name'; name: SemanticName; pos: Pos }
  | { e: Expr; k: 'expr' };
export type FieldType =
  | { k: 'int'; order: string | null; type: string }
  | { asText: boolean; k: 'sized'; size: Size; unit: 'bits' | 'bytes' };
export type BinaryField =
  | { k: 'literal'; pos: Pos; value: Literal }
  | { asText: boolean; k: 'rest'; name: SemanticName | null; pos: Pos }
  | { k: 'field'; name: SemanticName | null; pos: Pos; type: FieldType };
export type BuildField = { pos: Pos; type: FieldType | null; value: Expr };

/** A Guard, and its first token, which its test is placed at. */
export type Guard = { e: Expr; pos: Pos };
export type Event = {
  from: Expr | null;
  message: string;
  pats: Pattern[];
  pos: Pos;
};
export type WaitBranch =
  | { body: Stmt[]; event: Event; guard: Guard | null; k: 'when'; pos: Pos }
  | { body: Stmt[]; duration: Expr; k: 'after'; pos: Pos };
export type Collecting = { pos: Pos; target: SemanticName; value: Expr };
export type RepeatHead =
  | { k: 'each'; pat: Pattern; src: Expr }
  | { cond: Expr; k: 'while' | 'until' }
  | { k: 'forever' }
  | { count: Expr; k: 'times' };
export type Offer = {
  body: Stmt[];
  name: string;
  params: SemanticName[];
  pos: Pos;
};
export type Catch = {
  body: Stmt[];
  guard: Guard | null;
  pat: Pattern;
  pos: Pos;
  recovery: boolean;
};
export type Try = {
  body: Stmt[];
  catches: Catch[];
  finally: Stmt[] | null;
  k: 'try';
  offers: Offer[];
  pos: Pos;
};

export type Stmt =
  | { args: Expr[]; k: 'choose-offer'; name: string; pos: Pos }
  | {
      k: 'put';
      pos: Pos;
      prep: 'into' | 'after' | 'before';
      spread: boolean;
      target: Expr;
      value: Expr;
    }
  | { k: 'let'; pat: Pattern; pos: Pos; value: Expr }
  | { k: 'set'; pos: Pos; target: Expr; value: Expr }
  | {
      k: 'arithmetic';
      op: 'add' | 'subtract' | 'multiply' | 'divide';
      pos: Pos;
      target: Expr;
      value: Expr;
    }
  | { k: 'delete'; pos: Pos; target: Expr }
  | {
      args: Expr[];
      k: 'send';
      /** The message name, or for `send (e)` the expression that computes it. */
      message: string | Expr;
      pos: Pos;
      /** Which `with` items are spreads, when any is (ADR 0064). */
      spread?: boolean[];
      target: Expr;
      wait: boolean;
    }
  | {
      args: Expr[];
      grant: string;
      k: 'ask' | 'tell';
      operation: string;
      pos: Pos;
      wait: boolean;
    }
  | { duration: Expr; k: 'wait'; pos: Pos }
  | { event: Event; k: 'wait-for'; pos: Pos; timeout: Expr | null }
  | { branches: WaitBranch[]; k: 'wait-block'; pos: Pos }
  | { body: Stmt[]; end: Pos; k: 'join'; pos: Pos }
  | { k: 'return' | 'veto'; pos: Pos; value: Expr | null }
  | { k: 'pass'; message: string; pos: Pos }
  | { k: 'exit' | 'next'; pos: Pos }
  | { k: 'throw'; pos: Pos; value: Expr }
  | (Omit<Replace, 'k'> & { k: 'replace-statement' })
  | { call: Expr & { k: 'call' }; k: 'call'; pos: Pos; wait: boolean }
  | { args: Expr[]; k: 'command'; name: SemanticName; pos: Pos; wait: boolean }
  | {
      arms: { body: Stmt[]; cond: Expr }[];
      else: Stmt[] | null;
      k: 'if';
      pos: Pos;
    }
  | {
      body: Stmt[];
      collect: Collecting | null;
      head: RepeatHead;
      k: 'repeat';
      pos: Pos;
    }
  | {
      branches: {
        body: Stmt[];
        guard: Guard | null;
        pat: Pattern;
        pos: Pos;
        search: boolean;
      }[];
      else: Stmt[] | null;
      fold: boolean;
      k: 'match';
      pos: Pos;
      subject: Expr;
    }
  | Try;

export type Parameter = {
  default: Expr | null;
  name: SemanticName;
  pos: Pos;
};
export type Handler = {
  body: Stmt[];
  deciding: boolean;
  during: SemanticName | null;
  end: Pos;
  /** A Fallback Handler clause, named `any message` (ADR 0064). */
  fallback: boolean;
  finally: Stmt[] | null;
  finallyPos: Pos | null;
  guard: Guard | null;
  k: 'handler';
  name: string;
  params: Pattern[];
  policy?: 'queued' | 'dropping' | 'replacing';
  pos: Pos;
  private?: boolean;
  scope: number;
};
export type Function = {
  /** The function's own binding, which calls and bare names resolve to. */
  binding: Binding;
  body: Stmt[];
  end: Pos;
  k: 'function';
  name: string;
  params: Parameter[];
  pos: Pos;
  private?: boolean;
  scope: number;
};
export type Decl =
  | {
      imports: { local: SemanticName; name: string }[];
      k: 'use';
      library: string;
    }
  | {
      k: 'constant';
      name: SemanticName;
      pos: Pos;
      private?: boolean;
      value: Expr;
    }
  | { init: Expr | null; k: 'variable'; name: SemanticName; pos: Pos }
  | Handler
  | Function;

const singular = new Map<string, string>(
  grammar.chunk.flatMap(c => [
    [c.singular, c.singular],
    [c.plural, c.singular],
  ]),
);
const properties = new Set<string>(grammar.properties);
const integerTypes = new Set<string>(grammar.binary_patterns.integer_types);
const ordinals = new Map(
  grammar.ordinals.map((o, i) => [o, o === 'last' ? -1 : i + 1]),
);
const comparisons: Record<string, string> = {
  '=': 'equal',
  '<>': 'not-equal',
  '<': 'less',
  '>': 'greater',
  '<=': 'less-or-equal',
  '>=': 'greater-or-equal',
};
const arithmetic: Record<string, string> = {
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
  div: 'div',
  mod: 'mod',
  '^': 'power',
  '&': 'concat',
  '..': 'range',
};

/** A view construction that doesn't match the grammar: a Core bug, not a diagnostic. */
const shape = (node: SemanticNode): never => {
  throw new Error(
    `unexpected ${node.rule} shape at ${node.span.line}:${node.span.col}`,
  );
};
export const pos = (element: SemanticElement): Pos => ({
  line: element.span.line,
  col: element.span.col,
});
const isToken = (
  element: SemanticElement | undefined,
  text?: string,
): element is SemanticToken =>
  element?.kind === 'token' && (text === undefined || element.text === text);
const words = (node: SemanticNode) =>
  node.children
    .map(child => (child.kind === 'node' ? '' : child.text))
    .join(' ');

/** Convert a checked Source tree into its declarations. */
export const viewSource = (root: SemanticNode): Decl[] => {
  const built = new Map<SemanticNode, unknown>();
  const work: [SemanticNode, boolean][] = [[root, false]];
  while (work.length) {
    const [node, ready] = work.pop()!;
    if (ready) {
      built.set(node, convert(node, built));
      continue;
    }
    work.push([node, true]);
    for (const child of node.children) {
      if (child.kind === 'node') {
        work.push([child, false]);
      }
    }
  }
  return built.get(root) as Decl[];
};

// One production, from its children's already-converted results.
const convert = (node: SemanticNode, built: Map<SemanticNode, unknown>) => {
  const { children } = node;
  const of = <T>(element: SemanticElement | undefined): T => {
    if (element?.kind !== 'node') {
      return shape(node);
    }
    return built.get(element) as T;
  };
  const nodeAt = (from: number, rule?: SemanticNode['rule']) => {
    for (let i = from; i < children.length; i++) {
      const child = children[i]!;
      if (child.kind === 'node' && (!rule || child.rule === rule)) {
        return i;
      }
    }
    return -1;
  };
  const first = children[0];
  const at = pos(node);
  switch (node.rule) {
    case 'Source':
      return children.flatMap(child =>
        child.kind === 'node' ? [of<Decl>(child)] : [],
      );
    case 'Declaration':
      return declaration(node, of);
    case 'Use': {
      const from = children.findIndex(child => isToken(child, 'from'));
      const names = children
        .slice(0, from)
        .filter(child => child.kind === 'node')
        .map(child => of<SemanticName>(child));
      const after = children
        .slice(from + 1)
        .filter(child => child.kind === 'node')
        .map(child => of<SemanticName>(child));
      const rename = after[1];
      return {
        k: 'use',
        library: after[0]!.text,
        imports: names.map(name => ({
          name: name.text,
          local: rename ?? name,
        })),
      } satisfies Decl;
    }
    case 'Handler':
      return handler(node, of);
    case 'Function':
      return fn(node, of);
    case 'Parameter':
      return {
        name: of<SemanticName>(first),
        default: children[2] ? of<Expr>(children[2]) : null,
        pos: at,
      } satisfies Parameter;
    case 'Label':
      return (first as Leaf).text;
    case 'Name':
    case 'MessageName':
      return first?.kind === 'node'
        ? of<SemanticName>(first)
        : (first as SemanticName);
    case 'Block':
      return children.map(child => of<Stmt>(child));
    case 'Body':
      return first?.kind === 'node' && first.rule === 'Block'
        ? of<Stmt[]>(first)
        : [of<Stmt>(first)];
    case 'Statement':
    case 'Container':
    case 'Expression':
      return of(first);
    case 'SimpleStatement':
      return simpleStatement(node, of);
    case 'ExpressionList':
      return children.flatMap(child =>
        child.kind === 'node' && child.rule === 'Expression'
          ? [of<Expr>(child)]
          : [],
      );
    case 'AndWait':
    case 'IgnoringCase':
    case 'AsText':
      return true;
    case 'Send': {
      const withAt = children.findIndex(child => isToken(child, 'with'));
      const toAt = children.findIndex(child => isToken(child, 'to'));
      const targetFirst = toAt === 1;
      const nameAt = targetFirst ? 4 : 1;
      const listAt = nodeAt(nameAt + 1, 'ExpressionList');
      // `send (e) …`: the bracketed expression computes the name (ADR 0057).
      const computed = isToken(children[1], '(');
      // A `...` leaf before a `with` item spreads it (ADR 0064).
      const list = withAt >= 0 ? children[withAt + 1] : undefined;
      const spread =
        !targetFirst && list?.kind === 'node'
          ? list.children.flatMap((child, i) =>
              child.kind === 'node'
                ? [isToken(list.children[i - 1], '...')]
                : [],
            )
          : [];
      return {
        ...(spread.includes(true) ? { spread } : {}),
        k: 'send',
        pos: at,
        message: computed
          ? of<Expr>(children[2])
          : of<SemanticName>(children[nameAt]).text,
        args: targetFirst
          ? listAt >= 0
            ? of<Expr[]>(children[listAt])
            : []
          : withAt >= 0
            ? of<Expr[]>(children[withAt + 1])
            : [],
        target: of<Expr>(children[toAt + 1]),
        wait: nodeAt(0, 'AndWait') >= 0,
      } satisfies Stmt;
    }
    case 'AskTell': {
      const target = of<Expr>(children[1]);
      if (target.k !== 'name') {
        return shape(node);
      }
      const list = nodeAt(4, 'ExpressionList');
      return {
        k: isToken(first, 'ask') ? 'ask' : 'tell',
        pos: at,
        grant: target.name.text,
        operation: (children[3] as Leaf).text,
        args: list >= 0 ? of<Expr[]>(children[list]) : [],
        wait: nodeAt(4, 'AndWait') >= 0,
      } satisfies Stmt;
    }
    case 'Wait':
      return wait(node, of);
    case 'Event': {
      const fromAt = children.findIndex(child => isToken(child, 'from'));
      const end = fromAt < 0 ? children.length : fromAt;
      return {
        message: of<SemanticName>(first).text,
        pos: at,
        pats: children
          .slice(1, end)
          .flatMap(child =>
            child.kind === 'node' && child.rule === 'Pattern'
              ? [of<Pattern>(child)]
              : [],
          ),
        from: fromAt < 0 ? null : of<Expr>(children[fromAt + 1]),
      } satisfies Event;
    }
    case 'If':
      return ifStatement(node, of);
    case 'Repeat':
      return repeat(node, of);
    case 'Collecting':
      return {
        pos: at,
        value: of<Expr>(children[1]),
        target: of<SemanticName>(children[3]),
      } satisfies Collecting;
    case 'Match':
      return match(node, of);
    case 'OfferParameter':
      return of<SemanticName>(first);
    case 'RecoveryMarker':
      return true;
    case 'OfferClause':
      return {
        name: of<SemanticName>(children[1]).text,
        params: children
          .filter(c => c.kind === 'node' && c.rule === 'OfferParameter')
          .map(c => of<SemanticName>(c)),
        body: blockAt(
          node,
          children.findIndex(c => c.kind === 'node' && c.rule === 'Block'),
          of,
        ),
        pos: at,
      } satisfies Offer;
    case 'ChooseOffer': {
      const list = nodeAt(0, 'ExpressionList');
      return {
        k: 'choose-offer',
        name: of<SemanticName>(children[2]).text,
        args: list >= 0 ? of<Expr[]>(children[list]) : [],
        pos: at,
      } satisfies Stmt;
    }
    case 'Try':
      return tryStatement(node, of);
    case 'Replace': {
      const operands = children.filter(child => child.kind === 'node');
      return {
        k: 'replace',
        pos: at,
        first: isToken(children[1], 'first'),
        pat: of<Expr>(operands[0]),
        target: of<Expr>(operands[1]),
        value: of<Expr>(operands[2]),
      } satisfies Replace;
    }
    case 'Lambda': {
      const colon = children.findIndex(child => isToken(child, ':'));
      const block = nodeAt(1, 'Block');
      const end = children.findIndex(child => isToken(child, 'end'));
      const params = children
        .slice(1, colon >= 0 ? colon : block >= 0 ? block : end)
        .flatMap(child => (child.kind === 'node' ? [of<Pattern>(child)] : []));
      return {
        k: 'lambda',
        pos: at,
        scope: node.scope,
        params,
        body:
          colon >= 0
            ? of<Expr>(children[colon + 1])
            : block >= 0
              ? of<Stmt[]>(children[block])
              : [],
        end: colon >= 0 ? null : pos(children[end]!),
      } satisfies Lambda;
    }
    case 'Or':
    case 'And':
    case 'Concat':
    case 'Range':
    case 'Additive':
    case 'Multiplicative':
    case 'Power': {
      // Power is right-associative, and its right operand is already a Power.
      let left = of<Expr>(first);
      for (let i = 1; i + 1 < children.length; i += 2) {
        const op = children[i] as SemanticToken;
        const right = of<Expr>(children[i + 1]);
        left =
          op.text === 'and' || op.text === 'or'
            ? { k: op.text, pos: pos(op), l: left, r: right }
            : {
                k: 'binary',
                pos: pos(op),
                op: arithmetic[op.text]!,
                l: left,
                r: right,
                fold: false,
              };
      }
      return left;
    }
    case 'Not':
    case 'Unary':
      return isToken(first)
        ? {
            k: first.text === 'not' ? 'not' : 'negate',
            pos: pos(first),
            e: of<Expr>(children[1]),
          }
        : of(first);
    case 'Comparison':
      return comparison(node, of);
    case 'Conversion': {
      let e = of<Expr>(first);
      for (let i = 1; i + 1 < children.length; i += 2) {
        const kind = children[i + 1]!;
        e = {
          k: 'convert',
          pos: pos(children[i]!),
          e,
          kind: kind.kind === 'node' ? words(kind) : kind.text,
        };
      }
      return e;
    }
    case 'Kind':
    case 'Key':
      return words(node);
    case 'ChunkLevel': {
      const e = of<Expr>(first);
      if (children.length === 1) {
        return e;
      }
      if (e.k !== 'chunk' && e.k !== 'property') {
        return shape(node);
      }
      return { ...e, delimiter: of<Expr>(children[3]) };
    }
    case 'Postfix': {
      let e = of<Expr>(first);
      for (let i = 1; i + 1 < children.length; i += 2) {
        const key = of<string>(children[i + 1]);
        e = properties.has(key)
          ? {
              k: 'property',
              pos: pos(children[i]!),
              name: key,
              base: e,
              delimiter: null,
            }
          : { k: 'key', pos: pos(children[i]!), key, base: e };
      }
      return e;
    }
    case 'Call': {
      const list = nodeAt(1, 'ExpressionList');
      return {
        k: 'call',
        pos: at,
        name: first as SemanticName,
        args: list >= 0 ? of<Expr[]>(children[list]) : [],
      } satisfies Expr;
    }
    case 'Interpolated': {
      let result: Expr = { k: 'text', value: (first as Leaf).text, pos: at };
      for (let i = 1; i < children.length; i += 3) {
        const holePos = pos(children[i]!);
        result = {
          k: 'binary',
          op: 'concat',
          l: result,
          r: of<Expr>(children[i + 1]),
          pos: holePos,
          fold: false,
        };
        const value = (children[i + 2] as Leaf).text;
        if (value) {
          result = {
            k: 'binary',
            op: 'concat',
            l: result,
            r: { k: 'text', value, pos: holePos },
            pos: holePos,
            fold: false,
          };
        }
      }
      return result;
    }
    case 'Primary':
      return primary(node, of);
    case 'Chunk': {
      const index = nodeAt(0);
      const kind = children
        .slice(0, index)
        .map(child => (child as Leaf).text)
        .join(' ');
      return {
        k: 'chunk',
        pos: at,
        kind: singular.get(kind) ?? shape(node),
        index: of<Expr>(children[index]),
        base: of<Expr>(children.at(-1)),
        delimiter: null,
      } satisfies Expr;
    }
    case 'The':
      return the(node, of);
    case 'List': {
      const items: { e: Expr; spread: boolean }[] = [];
      for (let i = 1; i < children.length; i++) {
        const child = children[i]!;
        if (child.kind === 'node') {
          items.push({
            e: of<Expr>(child),
            spread: isToken(children[i - 1], '...'),
          });
        }
      }
      return { k: 'list', pos: at, items } satisfies Expr;
    }
    case 'MapKey':
      return (first as Leaf).text;
    case 'Map': {
      const entries: { key: string; value: Expr }[] = [];
      for (let i = 1; i + 1 < children.length; i++) {
        const child = children[i]!;
        if (child.kind === 'node' && child.rule === 'MapKey') {
          entries.push({
            key: of<string>(child),
            value: of<Expr>(children[i + 1]),
          });
        }
      }
      return { k: 'map', pos: at, entries } satisfies Expr;
    }
    case 'Pattern': {
      const p = of<Pattern>(first);
      return children.length > 1
        ? ({
            k: 'as',
            pos: at,
            p,
            name: of<SemanticName>(children[2]),
          } satisfies Pattern)
        : p;
    }
    case 'PatternPrimary':
      return patternPrimary(node, of);
    case 'TextPattern':
      return {
        pos: at,
        els: children.flatMap(child =>
          child.kind === 'node' ? [of<PatternElement>(child)] : [],
        ),
      } satisfies TextPattern;
    case 'Alternation': {
      const options = children.flatMap(child =>
        child.kind === 'node' ? [of<PatternElement>(child)] : [],
      );
      return options.length === 1
        ? options[0]
        : ({ k: 'alternation', options } satisfies PatternElement);
    }
    case 'Element': {
      const e = of<PatternElement>(first);
      if (children.length === 1) {
        return e;
      }
      let as: string | null = null;
      let fold = false;
      let lazily = false;
      for (let i = 1; i < children.length; i++) {
        const child = children[i]!;
        if (child.kind === 'node') {
          if (child.rule === 'IgnoringCase') {
            fold = true;
          } else {
            as = of<string>(child);
          }
        } else if (child.text === 'lazily') {
          lazily = true;
        }
      }
      return { k: 'suffixed', e, as, fold, lazily } satisfies PatternElement;
    }
    case 'Atom':
      return atom(node, of);
    case 'BinaryPattern':
      return {
        k: 'binary',
        pos: at,
        fields: children.flatMap(child =>
          child.kind === 'node' ? [of<BinaryField>(child)] : [],
        ),
      } satisfies Pattern;
    case 'Field':
      return field(node, of);
    case 'FieldType':
      return fieldType(node, of);
    case 'BinaryBuild': {
      const fields: BuildField[] = [];
      for (let i = 1; i < children.length; i++) {
        const child = children[i]!;
        if (child.kind !== 'node' || child.rule === 'FieldType') {
          continue;
        }
        const typed = isToken(children[i + 1], 'as');
        fields.push({
          pos: pos(child),
          value: of<Expr>(child),
          type: typed ? of<FieldType>(children[i + 2]) : null,
        });
      }
      return { k: 'build', pos: at, fields } satisfies Expr;
    }
  }
  return shape(node);
};

type Of = <T>(element: SemanticElement | undefined) => T;

const guardAt = (element: SemanticElement | undefined, of: Of): Guard => ({
  e: of<Expr>(element),
  pos: pos(element!),
});

const declaration = (node: SemanticNode, of: Of): Decl => {
  const [first, , third, fourth, fifth] = node.children;
  if (first?.kind === 'node') {
    return of<Decl>(first);
  }
  if (isToken(first, 'private')) {
    return { ...of<Decl>(node.children[1]), private: true } as Decl;
  }
  if (isToken(first, 'constant')) {
    return {
      k: 'constant',
      pos: pos(node),
      name: of<SemanticName>(node.children[1]),
      value: of<Expr>(fourth),
    };
  }
  return {
    k: 'variable',
    pos: pos(node),
    name: of<SemanticName>(third),
    init: fifth ? of<Expr>(fifth) : null,
  };
};

// The statements after a block's opening keyword, which an empty block omits.
const blockAt = (node: SemanticNode, i: number, of: Of): Stmt[] => {
  const child = node.children[i];
  return child?.kind === 'node' &&
    (child.rule === 'Block' || child.rule === 'Body')
    ? of<Stmt[]>(child)
    : [];
};

const handler = (node: SemanticNode, of: Of): Handler => {
  const { children } = node;
  // `on any message m`: the Fallback Handler (ADR 0064).
  const fallback = isToken(children[1], 'any');
  const params: Pattern[] = [];
  let guard: Guard | null = null;
  let during: SemanticName | null = null;
  let body: Stmt[] = [];
  let fin: Stmt[] | null = null;
  let finallyPos: Pos | null = null;
  let end = pos(node);
  for (let i = 2; i < children.length; i++) {
    const child = children[i]!;
    if (child.kind === 'node') {
      if (child.rule === 'Pattern') {
        params.push(of<Pattern>(child));
      } else if (child.rule === 'Block') {
        body = of<Stmt[]>(child);
      }
    } else if (child.text === 'during') {
      during = children[++i] as SemanticName;
    } else if (child.text === 'where') {
      guard = guardAt(children[++i], of);
    } else if (child.text === 'finally' && child.kind === 'token') {
      finallyPos = pos(child);
      fin = blockAt(node, i + 1, of);
      if (fin.length) {
        i++;
      }
    } else if (child.text === 'end' && child.kind === 'token') {
      end = pos(child);
      break;
    }
  }
  return {
    k: 'handler',
    during,
    deciding: children.some(c => c.kind === 'token' && c.text === 'deciding'),
    policy: children
      .filter(c => c.kind === 'token')
      .map(c => c.text)
      .find(t =>
        ['queued', 'dropping', 'replacing'].includes(t),
      ) as Handler['policy'],
    pos: pos(node),
    name: fallback ? 'any message' : of<SemanticName>(children[1]).text,
    fallback,
    scope: node.scope,
    params,
    guard,
    body,
    finally: fin,
    finallyPos,
    end,
  };
};

const fn = (node: SemanticNode, of: Of): Function => {
  const { children } = node;
  const params: Parameter[] = [];
  let body: Stmt[] = [];
  let end = pos(node);
  for (const child of children.slice(2)) {
    if (child.kind === 'node') {
      if (child.rule === 'Parameter') {
        params.push(of<Parameter>(child));
      } else if (child.rule === 'Block') {
        body = of<Stmt[]>(child);
      }
    } else if (child.text === 'end' && child.kind === 'token') {
      end = pos(child);
      break;
    }
  }
  return {
    k: 'function',
    pos: pos(node),
    name: of<SemanticName>(children[1]).text,
    binding: of<SemanticName>(children[1]).binding!,
    scope: node.scope,
    params,
    body,
    end,
  };
};

const simpleStatement = (node: SemanticNode, of: Of): Stmt => {
  const { children } = node;
  const first = children[0]!;
  const at = pos(node);
  if (first.kind === 'node') {
    switch (first.rule) {
      case 'Call':
        return {
          k: 'call',
          pos: at,
          call: of<Expr & { k: 'call' }>(first),
          wait: children.length > 1,
        };
      case 'Replace':
        return { ...of<Replace>(first), k: 'replace-statement' };
      default:
        return of<Stmt>(first);
    }
  }
  if (first.kind === 'name') {
    const list = children.findIndex(
      child => child.kind === 'node' && child.rule === 'ExpressionList',
    );
    return {
      k: 'command',
      pos: at,
      name: first,
      args: list >= 0 ? of<Expr[]>(children[list]) : [],
      wait: children.some(
        child => child.kind === 'node' && child.rule === 'AndWait',
      ),
    };
  }
  const operands = children.filter(child => child.kind === 'node');
  switch (first.text) {
    case 'put': {
      const prep = children.find(
        child =>
          isToken(child) && ['into', 'after', 'before'].includes(child.text),
      ) as SemanticToken;
      return {
        k: 'put',
        pos: at,
        spread: isToken(children[1], '...'),
        value: of<Expr>(operands[0]),
        prep: prep.text as 'into' | 'after' | 'before',
        target: of<Expr>(operands[1]),
      };
    }
    case 'let':
      return {
        k: 'let',
        pos: at,
        pat: of<Pattern>(operands[0]),
        value: of<Expr>(operands[1]),
      };
    case 'set':
      return {
        k: 'set',
        pos: at,
        target: of<Expr>(operands[0]),
        value: of<Expr>(operands[1]),
      };
    case 'add':
    case 'subtract':
      return {
        k: 'arithmetic',
        op: first.text,
        pos: at,
        value: of<Expr>(operands[0]),
        target: of<Expr>(operands[1]),
      };
    case 'multiply':
    case 'divide':
      return {
        k: 'arithmetic',
        op: first.text,
        pos: at,
        target: of<Expr>(operands[0]),
        value: of<Expr>(operands[1]),
      };
    case 'delete':
      return { k: 'delete', pos: at, target: of<Expr>(operands[0]) };
    case 'return':
    case 'veto':
      return {
        k: first.text,
        pos: at,
        value: operands[0] ? of<Expr>(operands[0]) : null,
      };
    case 'pass':
      return {
        k: 'pass',
        pos: at,
        // `pass any message` passes a Fallback Handler's message (ADR 0064).
        message: isToken(children[1], 'any')
          ? 'any message'
          : of<SemanticName>(operands[0]).text,
      };
    case 'exit':
    case 'next':
      return { k: first.text, pos: at };
    case 'throw':
      return { k: 'throw', pos: at, value: of<Expr>(operands[0]) };
  }
  return shape(node);
};

const wait = (node: SemanticNode, of: Of): Stmt => {
  const { children } = node;
  const at = pos(node);
  if (!isToken(children[1], 'for')) {
    return { k: 'wait', pos: at, duration: of<Expr>(children[1]) };
  }
  if (isToken(children[2], 'all')) {
    return {
      k: 'join',
      pos: at,
      end: pos(children.find(child => isToken(child, 'end'))!),
      body: blockAt(node, 3, of),
    };
  }
  const third = children[2];
  if (third?.kind === 'node') {
    const event = of<Event>(third);
    return {
      k: 'wait-for',
      pos: at,
      event,
      timeout: children[4] ? of<Expr>(children[4]) : null,
    };
  }
  const branches: WaitBranch[] = [];
  for (let i = 2; i < children.length; i++) {
    const child = children[i]!;
    if (isToken(child, 'when')) {
      const event = of<Event>(children[i + 1]);
      let j = i + 2;
      let guard: Guard | null = null;
      if (isToken(children[j], 'where')) {
        guard = guardAt(children[j + 1], of);
        j += 2;
      }
      // children[j] is `then`.
      const body = blockAt(node, j + 1, of);
      branches.push({ k: 'when', pos: pos(child), event, guard, body });
      i = children[j + 1]?.kind === 'node' ? j + 1 : j;
    } else if (isToken(child, 'after')) {
      const duration = of<Expr>(children[i + 1]);
      const body = blockAt(node, i + 3, of);
      branches.push({ k: 'after', pos: pos(child), duration, body });
      i = children[i + 3]?.kind === 'node' ? i + 3 : i + 2;
    } else if (isToken(child, 'end')) {
      break;
    }
  }
  return { k: 'wait-block', pos: at, branches };
};

const ifStatement = (node: SemanticNode, of: Of): Stmt => {
  const { children } = node;
  const at = pos(node);
  const cond = of<Expr>(children[1]);
  const then = children[3];
  if (then?.kind === 'node' && then.rule === 'SimpleStatement') {
    const els = children[5];
    return {
      k: 'if',
      pos: at,
      arms: [{ cond, body: [of<Stmt>(then)] }],
      else: els ? [of<Stmt>(els)] : null,
    };
  }
  const arms = [{ cond, body: blockAt(node, 3, of) }];
  let els: Stmt[] | null = null;
  for (let i = 3; i < children.length; i++) {
    const child = children[i]!;
    if (!isToken(child, 'else')) {
      if (isToken(child, 'end')) {
        break;
      }
      continue;
    }
    if (isToken(children[i + 1], 'if')) {
      arms.push({
        cond: of<Expr>(children[i + 2]),
        body: blockAt(node, i + 4, of),
      });
      i += 3;
    } else {
      els = blockAt(node, i + 1, of);
    }
  }
  return { k: 'if', pos: at, arms, else: els };
};

const repeat = (node: SemanticNode, of: Of): Stmt => {
  const { children } = node;
  const word = children[1]!;
  let head: RepeatHead;
  let next: number;
  if (isToken(word, 'for')) {
    head = {
      k: 'each',
      pat: of<Pattern>(children[3]),
      src: of<Expr>(children[5]),
    };
    next = 6;
  } else if (isToken(word, 'while') || isToken(word, 'until')) {
    head = {
      k: (word as SemanticToken).text as 'while' | 'until',
      cond: of<Expr>(children[2]),
    };
    next = 3;
  } else if (isToken(word, 'forever')) {
    head = { k: 'forever' };
    next = 2;
  } else {
    head = { k: 'times', count: of<Expr>(word) };
    next = 3;
  }
  const clause = children[next];
  const collect =
    clause?.kind === 'node' && clause.rule === 'Collecting'
      ? of<Collecting>(clause)
      : null;
  return {
    k: 'repeat',
    pos: pos(node),
    head,
    collect,
    body: blockAt(node, next + (collect ? 1 : 0), of),
  };
};

const match = (node: SemanticNode, of: Of): Stmt => {
  const { children } = node;
  const fold =
    children[2]?.kind === 'node' && children[2].rule === 'IgnoringCase';
  const branches: (Stmt & { k: 'match' })['branches'] = [];
  let els: Stmt[] | null = null;
  for (let i = fold ? 3 : 2; i < children.length; i++) {
    const child = children[i]!;
    if (isToken(child, 'when')) {
      const search = isToken(children[i + 1], 'contains');
      let j = search ? i + 2 : i + 1;
      const pat = of<Pattern>(children[j++]);
      let guard: Guard | null = null;
      if (isToken(children[j], 'where')) {
        guard = guardAt(children[j + 1], of);
        j += 2;
      }
      const body = blockAt(node, j + 1, of);
      branches.push({ pos: pos(child), search, pat, guard, body });
      i = children[j + 1]?.kind === 'node' ? j + 1 : j;
    } else if (isToken(child, 'else')) {
      els = blockAt(node, i + 1, of);
    }
  }
  return {
    k: 'match',
    pos: pos(node),
    subject: of<Expr>(children[1]),
    fold,
    branches,
    else: els,
  };
};

const tryStatement = (node: SemanticNode, of: Of): Try => {
  const { children } = node;
  const catches: Catch[] = [];
  let fin: Stmt[] | null = null;
  for (let i = 1; i < children.length; i++) {
    const child = children[i]!;
    if (isToken(child, 'catch')) {
      let j = i + 1;
      const pat = of<Pattern>(children[j++]);
      const recovery =
        children[j]?.kind === 'node' &&
        (children[j] as SemanticNode).rule === 'RecoveryMarker';
      if (recovery) {
        j++;
      }
      let guard: Guard | null = null;
      if (isToken(children[j], 'where')) {
        guard = guardAt(children[j + 1], of);
        j += 2;
      }
      const body = blockAt(node, j, of);
      catches.push({ pos: pos(child), pat, guard, body, recovery });
      i = children[j]?.kind === 'node' ? j : j - 1;
    } else if (isToken(child, 'finally')) {
      fin = blockAt(node, i + 1, of);
    }
  }
  return {
    k: 'try',
    pos: pos(node),
    body: blockAt(node, 1, of),
    catches,
    offers: children
      .filter(c => c.kind === 'node' && c.rule === 'OfferClause')
      .map(c => of<Offer>(c)),
    finally: fin,
  };
};

const comparison = (node: SemanticNode, of: Of): Expr => {
  const { children } = node;
  const l = of<Expr>(children[0]);
  if (children.length === 1) {
    return l;
  }
  const op = children[1] as SemanticToken;
  const at = pos(op);
  const fold = children.some(
    child => child.kind === 'node' && child.rule === 'IgnoringCase',
  );
  const operand = (i: number) => of<Expr>(children[i]);
  if (op.text in comparisons && op.type === 'op') {
    return {
      k: 'binary',
      pos: at,
      op: comparisons[op.text]!,
      l,
      r: operand(2),
      fold,
    };
  }
  switch (op.text) {
    case 'is': {
      const neg = isToken(children[2], 'not');
      const i = neg ? 3 : 2;
      const next = children[i]!;
      if (isToken(next, 'in')) {
        return { k: 'member', pos: at, neg, l, r: operand(i + 1), fold };
      }
      if (isToken(next, 'a') || isToken(next, 'an')) {
        return {
          k: 'is-kind',
          pos: at,
          neg,
          l,
          kind: of<string>(children[i + 1]),
        };
      }
      if (isToken(next, 'empty')) {
        return { k: 'is-empty', pos: at, neg, l };
      }
      return {
        k: 'binary',
        pos: at,
        op: neg ? 'not-equal' : 'equal',
        l,
        r: operand(i),
        fold,
      };
    }
    case 'can': {
      const kind = children.find(
        child => child.kind === 'node' && child.rule === 'Kind',
      );
      return { k: 'can-convert', pos: at, e: l, kind: of<string>(kind) };
    }
    case 'contains':
    case 'matches':
      return { k: 'binary', pos: at, op: op.text, l, r: operand(2), fold };
    case 'begins':
    case 'ends':
      return {
        k: 'binary',
        pos: at,
        op: `${op.text}-with`,
        l,
        r: operand(3),
        fold,
      };
  }
  return shape(node);
};

const primary = (node: SemanticNode, of: Of): Expr => {
  const { children } = node;
  const first = children[0]!;
  const at = pos(node);
  if (first.kind === 'node') {
    if (first.rule === 'TextPattern') {
      return { k: 'pattern', pos: at, pattern: of<TextPattern>(first) };
    }
    return of<Expr>(first);
  }
  if (first.kind === 'name') {
    return { k: 'name', pos: at, name: first };
  }
  switch (first.type) {
    case 'num':
      return children[1]
        ? {
            k: 'quantity',
            pos: at,
            number: first.text,
            unit: (children[1] as Leaf).text,
          }
        : { k: 'number', pos: at, text: first.text };
    case 'str':
      return { k: 'text', pos: at, value: first.text };
    case 'op':
      if (first.text === '(') {
        return of<Expr>(children[1]);
      }
      if (first.text === '^') {
        return { k: 'pin', pos: at, name: of<SemanticName>(children[1]) };
      }
      break;
    case 'word':
      switch (first.text) {
        case 'true':
        case 'false':
        case 'nothing':
          return { k: 'literal', pos: at, value: first.text };
        case 'me':
          return { k: 'me', pos: at };
        case 'every':
          return {
            k: 'match-all',
            pos: at,
            pat: of<Expr>(children[3]),
            src: of<Expr>(children[5]),
          };
      }
  }
  return shape(node);
};

const the = (node: SemanticNode, of: Of): Expr => {
  const { children } = node;
  const at = pos(node);
  const second = children[1]!;
  const base = () => of<Expr>(children.at(-1));
  if (isToken(second, '(')) {
    return { k: 'computed', pos: at, key: of<Expr>(children[2]), base: base() };
  }
  const token = second as SemanticElement;
  if (token.kind === 'token' && token.type === 'str') {
    return { k: 'key', pos: at, key: token.text, base: base() };
  }
  if (isToken(second, 'target') && children.length === 2) {
    return { k: 'target', pos: at };
  }
  if (second.kind === 'node') {
    const key = of<string>(second);
    return properties.has(key)
      ? { k: 'property', pos: at, name: key, base: base(), delimiter: null }
      : { k: 'key', pos: at, key, base: base() };
  }
  const index = ordinals.get(second.text);
  const ofAt = children.findIndex(child => isToken(child, 'of'));
  const kind = children
    .slice(2, ofAt)
    .map(child => (child as Leaf).text)
    .join(' ');
  if (index === undefined || !singular.has(kind)) {
    return shape(node);
  }
  return {
    k: 'chunk',
    pos: pos(children[2]!),
    kind: singular.get(kind)!,
    index,
    base: base(),
    delimiter: null,
  };
};

const literal = (children: readonly SemanticElement[]): Literal | null => {
  const first = children[0];
  if (first?.kind !== 'token') {
    return null;
  }
  if (first.type === 'str') {
    return { k: 'text', value: first.text };
  }
  if (
    first.type === 'word' &&
    ['true', 'false', 'nothing'].includes(first.text)
  ) {
    return { k: 'word', value: first.text as 'true' | 'false' | 'nothing' };
  }
  const negative = isToken(first, '-');
  const number = children[negative ? 1 : 0];
  if (number?.kind !== 'token' || number.type !== 'num') {
    return null;
  }
  const unit = children[negative ? 2 : 1];
  return {
    k: 'number',
    negative,
    text: number.text,
    unit: unit?.kind === 'token' && unit.type === 'unit' ? unit.text : null,
  };
};

const patternPrimary = (node: SemanticNode, of: Of): Pattern => {
  const { children } = node;
  const first = children[0]!;
  const at = pos(node);
  if (first.kind === 'name') {
    return { k: 'bind', pos: at, name: first };
  }
  if (first.kind === 'node') {
    return first.rule === 'TextPattern'
      ? { k: 'text', pos: at, pattern: of<TextPattern>(first) }
      : of<Pattern>(first);
  }
  if (isToken(first, '[')) {
    const items: Pattern[] = [];
    let rest: { name: SemanticName | null } | null = null;
    for (let i = 1; i < children.length; i++) {
      const child = children[i]!;
      if (isToken(child, '...')) {
        const name = children[i + 1];
        rest = { name: name?.kind === 'name' ? name : null };
      } else if (child.kind === 'node') {
        items.push(of<Pattern>(child));
      }
    }
    return { k: 'list', pos: at, items, rest };
  }
  if (isToken(first, '{')) {
    const entries: { key: string; value: Pattern }[] = [];
    for (let i = 1; i < children.length; i++) {
      const child = children[i]!;
      if (child.kind !== 'node') {
        continue;
      }
      if (child.rule === 'Name') {
        const name = of<SemanticName>(child);
        entries.push({
          key: name.text,
          value: { k: 'bind', pos: pos(child), name },
        });
      } else if (child.rule === 'MapKey') {
        entries.push({
          key: of<string>(child),
          value: of<Pattern>(children[++i]),
        });
      }
    }
    return { k: 'map', pos: at, entries };
  }
  if (isToken(first, '^')) {
    return { k: 'pin', pos: at, name: of<SemanticName>(children[1]) };
  }
  if (isToken(first, '_')) {
    return { k: 'wildcard', pos: at };
  }
  const value = literal(children);
  return value ? { k: 'literal', pos: at, value } : shape(node);
};

const atom = (node: SemanticNode, of: Of): PatternElement => {
  const { children } = node;
  const first = children[0]!;
  if (first.kind === 'node') {
    return { k: 'group', els: of<TextPattern>(first).els };
  }
  if (first.kind === 'name') {
    return { k: 'capture', name: first, e: of<PatternElement>(children[2]) };
  }
  switch (first.type) {
    case 'str':
      return { k: 'text', value: first.text };
    case 'num':
      return { k: 'count', n: first.text, e: of<PatternElement>(children[1]) };
    case 'op':
      return { k: 'splice', e: of<Expr>(children[1]) };
  }
  const last = children.at(-1)!;
  switch (first.text) {
    case 'one':
    case 'zero':
      return {
        k: 'repeat',
        phrase: `${first.text} or more of` as 'one or more of',
        e: of<PatternElement>(last),
      };
    case 'optional':
      if (last.kind === 'node') {
        return { k: 'repeat', phrase: 'optional', e: of<PatternElement>(last) };
      }
      break;
    case 'a':
    case 'an':
      if (last.kind === 'node') {
        return { k: 'typed', kind: of<string>(last) };
      }
  }
  return { k: 'words', words: words(node) };
};

const field = (node: SemanticNode, of: Of): BinaryField => {
  const { children } = node;
  const first = children[0]!;
  const at = pos(node);
  if (isToken(first, '...')) {
    const name = children[1];
    return {
      k: 'rest',
      pos: at,
      name: name?.kind === 'name' ? name : null,
      asText: children.at(-1)?.kind === 'node',
    };
  }
  if (isToken(children[1], ':')) {
    return {
      k: 'field',
      pos: at,
      name: first.kind === 'name' ? first : null,
      type: of<FieldType>(children[2]),
    };
  }
  const value = literal(children);
  return value ? { k: 'literal', pos: at, value } : shape(node);
};

const fieldType = (node: SemanticNode, of: Of): FieldType => {
  const { children } = node;
  const first = children[0]!;
  if (first.kind === 'token' && integerTypes.has(first.text)) {
    const order = children[1];
    return {
      k: 'int',
      type: first.text,
      order: order?.kind === 'token' ? order.text : null,
    };
  }
  let size: Size;
  let i: number;
  if (first.kind === 'name') {
    size = { k: 'name', pos: pos(first), name: first };
    i = 1;
  } else if (isToken(first, '^')) {
    size = { k: 'pin', pos: pos(first), name: of<SemanticName>(children[1]) };
    i = 2;
  } else if (isToken(first, '(')) {
    size = { k: 'expr', e: of<Expr>(children[1]) };
    i = 3;
  } else {
    size = { k: 'number', text: (first as SemanticElement as Leaf).text };
    i = 1;
  }
  const unit = (children[i] as Leaf).text;
  return {
    k: 'sized',
    size,
    unit: unit === 'bit' || unit === 'bits' ? 'bits' : 'bytes',
    asText: children[i + 1]?.kind === 'node',
  };
};
