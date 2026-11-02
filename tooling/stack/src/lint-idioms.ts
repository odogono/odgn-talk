// Chapter 12: advice toward the Beginner Surface's idioms, and the rewrites
// the LSP offers for it. Each rewrite means the same as the code it replaces.
import { kindNames, type SyntaxNode, type Token } from '@northtalk/ts';

export const nodes = (node: SyntaxNode) =>
  node.children.filter((child): child is SyntaxNode => child.kind === 'node');
export const tokens = (node: SyntaxNode) =>
  node.children.filter(
    (child): child is Token =>
      child.kind === 'token' && child.t !== 'nl' && child.t !== 'eof',
  );
export const tokensIn = (
  root: SyntaxNode,
  includeLineEndings = false,
): Token[] => {
  const out: Token[] = [];
  const work = [...root.children].reverse();
  while (work.length) {
    const child = work.pop()!;
    if (child.kind === 'node') {
      if (includeLineEndings || child.rule !== 'Error') {
        for (let i = child.children.length - 1; i >= 0; i--) {
          work.push(child.children[i]!);
        }
      }
    } else if (includeLineEndings || (child.t !== 'nl' && child.t !== 'eof')) {
      out.push(child);
    }
  }
  return out;
};

const isLiteral = (token?: Token) => token?.t === 'str' || token?.t === 'num';

// The name an Expression compares with a number or text literal through a
// plain `=` or `is`, in either order. Only a name is read the same in every
// branch; `match` would evaluate any other subject once.
export const literalComparison = (
  expression: SyntaxNode,
): Token | undefined => {
  let node = expression;
  while (node.rule !== 'Comparison') {
    const inner = nodes(node);
    if (inner.length !== 1 || tokens(node).length > 0) {
      return undefined;
    }
    node = inner[0]!;
  }
  const operator = tokens(node).map(token => token.v);
  const operands = nodes(node).filter(child => child.rule === 'Concat');
  const ignoring = nodes(node).some(
    child => child.rule === 'IgnoringCase' && tokens(child).length > 0,
  );
  if (
    operator.length !== 1 ||
    (operator[0] !== '=' && operator[0] !== 'is') ||
    operands.length !== 2 ||
    ignoring
  ) {
    return undefined;
  }
  const [left, right] = operands.map(operand => {
    const all = tokensIn(operand);
    return all.length === 1 ? all[0]! : undefined;
  });
  if (left?.t === 'word' && isLiteral(right)) {
    return left;
  }
  if (right?.t === 'word' && isLiteral(left)) {
    return right;
  }
  return undefined;
};

/**
 * The `suggest-match` rewrite of the `if` chain whose `if` starts at `start`:
 * `match name`, a `when <literal>` per branch, and every line in between
 * indented one more step. Absent when the chain isn't laid out one branch
 * head per line, or holds fenced text whose content indentation would change.
 */
const suggestMatchEdit = (
  tree: SyntaxNode,
  source: string,
  start: number,
): { end: number; newText: string; start: number } | undefined => {
  const work = [tree];
  let chain: SyntaxNode | undefined;
  while (work.length && !chain) {
    const node = work.pop()!;
    const head = node.children[0];
    if (node.rule === 'If' && head?.kind === 'token' && head.pos === start) {
      chain = node;
    }
    work.push(...nodes(node));
  }
  if (!chain) {
    return undefined;
  }
  const all = tokensIn(chain);
  if (all.some(token => token.raw.includes('\n'))) {
    return undefined;
  }
  const direct = tokens(chain);
  const heads: { from: Token; literal: Token; then: Token }[] = [];
  let name: string | undefined;
  for (let i = 0; i < chain.children.length; i++) {
    const condition = chain.children[i]!;
    const before = chain.children[i - 1];
    if (
      condition.kind !== 'node' ||
      condition.rule !== 'Expression' ||
      before?.kind !== 'token' ||
      before.v !== 'if'
    ) {
      continue;
    }
    const subject = literalComparison(condition);
    const then = chain.children[i + 1];
    const elseToken = chain.children[i - 2];
    const from =
      elseToken?.kind === 'token' && elseToken.v === 'else'
        ? elseToken
        : before;
    if (!subject || then?.kind !== 'token' || then.v !== 'then') {
      return undefined;
    }
    name ??= subject.v;
    const literal = tokensIn(condition).find(
      token => token.t === 'str' || token.t === 'num',
    )!;
    heads.push({ from, then, literal });
  }
  const endIndex = direct.findIndex(token => token.v === 'end');
  const ending = direct[endIndex];
  // Each head and `else` must end its line, so bodies sit on their own lines.
  const lastOnLine = (token: Token) =>
    !all.some(other => other.line === token.line && other.pos > token.pos);
  const elseOnly = direct.filter(
    (token, i) => token.v === 'else' && direct[i + 1]?.v !== 'if',
  );
  if (
    !name ||
    !ending ||
    heads.length < 3 ||
    !heads.every(head => lastOnLine(head.then)) ||
    !elseOnly.every(lastOnLine)
  ) {
    return undefined;
  }
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const indent = source.slice(lineStart, start);
  const suffix = direct[endIndex + 1];
  const end = suffix?.v === 'if' ? suffix.end : ending.end;
  // Replace from the end so earlier offsets stay valid.
  let text = source.slice(lineStart, end);
  const replace = (from: number, to: number, value: string) => {
    text = text.slice(0, from - lineStart) + value + text.slice(to - lineStart);
  };
  if (suffix?.v === 'if') {
    replace(suffix.pos, suffix.end, 'match');
  }
  for (const head of [...heads].reverse()) {
    replace(head.from.pos, head.then.end, `when ${head.literal.raw} then`);
  }
  const lines = text.split('\n');
  const body = lines
    .slice(1, -1)
    .map(line => (line.trim() ? `  ${line}` : line));
  const newText = [
    `${indent}match ${name}`,
    `${indent}  ${lines[0]!.slice(indent.length)}`,
    ...body,
    lines.at(-1)!,
  ].join('\n');
  return { start: lineStart, end, newText };
};

export type IdiomId =
  | 'if-then-return-bool'
  | 'impossible-kind'
  | 'kindof-comparison'
  | 'redundant-guard'
  | 'suggest-arithmetic-command'
  | 'suggest-is-in'
  | 'suggest-match'
  | 'suggest-otherwise'
  | 'suggest-range-loop'
  | 'suggest-word-operator';
/** Advice that holds only if `subject` names a variable, which needs bindings. */
export type IdiomAdvice = {
  at: Token;
  id: IdiomId;
  /** Names that must each bind a local or parameter for the advice to hold. */
  locals?: Token[];
  params: Record<string, string>;
  /** Absent when the advice holds whatever the code's names bind to. */
  subject?: Token;
  /** What the subject must name: a variable, or the Built-in function. */
  subjectIs?: 'builtin function';
};
type Edit = { end: number; newText: string; start: number };

// The innermost node of a chain of wrappers, each with one child and no tokens.
const core = (node: SyntaxNode) => {
  let inner = node;
  while (tokens(inner).length === 0 && nodes(inner).length === 1) {
    inner = nodes(inner)[0]!;
  }
  return inner;
};
// A lone word, such as a variable's name. Bindings decide what it names.
const nameToken = (node: SyntaxNode) => {
  const all = tokensIn(node);
  return all.length === 1 && all[0]!.t === 'word' ? all[0] : undefined;
};
const spanOf = (node: SyntaxNode) => {
  const all = tokensIn(node);
  return { start: all[0]!.pos, end: all.at(-1)!.end };
};
const sourceOf = (source: string, node: SyntaxNode) => {
  const { start, end } = spanOf(node);
  return source.slice(start, end);
};

// `put e into name`, alone in a branch, as its source and target.
const putInto = (branch: SyntaxNode | undefined) => {
  let statement = branch;
  if (statement?.rule === 'Block') {
    const inner = nodes(statement);
    statement = inner.length === 1 ? inner[0] : undefined;
  }
  if (statement?.rule === 'Statement') {
    statement = core(statement);
  }
  if (statement?.rule !== 'SimpleStatement') {
    return undefined;
  }
  const words = tokens(statement).map(token => token.v);
  const [value, container] = nodes(statement);
  const target = container && nameToken(container);
  return words.join(' ') === 'put into' &&
    nodes(statement).length === 2 &&
    container?.rule === 'Container' &&
    target
    ? { at: tokens(statement)[0]!, value: value!, target }
    : undefined;
};

const arithmetic = {
  '+': (by: string, name: string) => `add ${by} to ${name}`,
  '-': (by: string, name: string) => `subtract ${by} from ${name}`,
  '*': (by: string, name: string) => `multiply ${name} by ${by}`,
  '/': (by: string, name: string) => `divide ${name} by ${by}`,
} as const;
// `put name <op> e into name`: `add e to name` puts exactly `name + e` into
// it (chapter 4). Only the name on the left qualifies, since `e + name` may
// keep `e`'s Units, and only one operator, since `name + a + b` adds `a` first.
const arithmeticPut = (node: SyntaxNode) => {
  const put = putInto(node);
  const value = put && core(put.value);
  const operators = value ? tokens(value) : [];
  const [left, right] = value ? nodes(value) : [];
  const operator = operators[0]?.v;
  if (
    !put ||
    !value ||
    (value.rule !== 'Additive' && value.rule !== 'Multiplicative') ||
    operators.length !== 1 ||
    !operator ||
    !(operator in arithmetic) ||
    nodes(value).length !== 2 ||
    nameToken(left!)?.v !== put.target.v
  ) {
    return undefined;
  }
  return {
    put,
    right: right!,
    command: arithmetic[operator as keyof typeof arithmetic],
  };
};

// `name = a or name = b or name = c`, each a literal: `name is in [a, b, c]`
// tests the same equality, and literals evaluate without effects.
const membership = (node: SyntaxNode) => {
  if (node.rule !== 'Or' || !tokens(node).every(token => token.v === 'or')) {
    return undefined;
  }
  const operands = nodes(node);
  const subjects = operands.map(literalComparison);
  const subject = subjects[0];
  return operands.length >= 3 &&
    subject &&
    subjects.every(other => other?.v === subject.v)
    ? {
        subject,
        literals: operands.map(operand =>
          tokensIn(operand).find(token => isLiteral(token))!,
        ),
      }
    : undefined;
};

// `name is nothing` (or `= nothing`), or with `not` (or `<>`) when `negated`.
const nothingTest = (expression: SyntaxNode) => {
  const comparison = core(expression);
  const operator = tokens(comparison)
    .map(token => token.v)
    .join(' ');
  const operands = nodes(comparison).filter(child => child.rule === 'Concat');
  const ignoring = nodes(comparison).some(
    child => child.rule === 'IgnoringCase' && tokens(child).length > 0,
  );
  if (comparison.rule !== 'Comparison' || operands.length !== 2 || ignoring) {
    return undefined;
  }
  const negated = operator === 'is not' || operator === '<>';
  if (!negated && operator !== 'is' && operator !== '=') {
    return undefined;
  }
  const [left, right] = operands.map(nameToken);
  const name =
    right?.v === 'nothing' ? left : left?.v === 'nothing' ? right : undefined;
  return name && name.v !== 'nothing' ? { name, negated } : undefined;
};

// `if name is nothing then put d into t else put name into t`, or the same
// tested with `is not` and its branches swapped, is `put name otherwise d
// into t`; with no `else`, `if t is nothing then put d into t` is `put t
// otherwise d into t`. `otherwise` evaluates `d` only when it is needed.
const nothingDefault = (node: SyntaxNode) => {
  if (node.rule !== 'If') {
    return undefined;
  }
  const direct = tokens(node).map(token => token.v);
  const children = node.children;
  const at = (word: string) =>
    children.findIndex(child => child.kind === 'token' && child.v === word);
  const branch = (word: string) => {
    // A line ending may separate the word from its branch.
    const index = at(word);
    const next = children
      .slice(index + 1)
      .find(child => child.kind === 'node' || child.t !== 'nl');
    return index >= 0 && next?.kind === 'node' ? next : undefined;
  };
  const condition = children[1];
  const test =
    condition?.kind === 'node' && condition.rule === 'Expression'
      ? nothingTest(condition)
      : undefined;
  if (!test || direct.filter(word => word === 'if').length > 2) {
    return undefined;
  }
  const then = putInto(branch('then'));
  const otherwise = at('else') >= 0 ? putInto(branch('else')) : undefined;
  if (at('else') >= 0 && direct[direct.indexOf('else') + 1] === 'if') {
    return undefined;
  }
  if (at('else') < 0) {
    return !test.negated && then && then.target.v === test.name.v
      ? { test, fallback: then.value, target: then.target, value: test.name }
      : undefined;
  }
  const [missing, present] = test.negated
    ? [otherwise, then]
    : [then, otherwise];
  return missing &&
    present &&
    missing.target.v === present.target.v &&
    nameToken(present.value)?.v === test.name.v
    ? {
        test,
        fallback: missing.value,
        target: missing.target,
        value: test.name,
      }
    : undefined;
};

// `kindOf(e) = "k"`, or `"k" = kindOf(e)`, or with `is`, `is not` or `<>`.
// `x is a k` is true exactly when `kindOf(x)` gives `k` (chapter 3), and
// `kindOf` gives only chapter 3's kind names, so any other text never equals it.
const kindComparison = (node: SyntaxNode) => {
  const operator = tokens(node)
    .map(token => token.v)
    .join(' ');
  const operands = nodes(node).filter(child => child.rule === 'Concat');
  const ignoring = nodes(node).some(
    child => child.rule === 'IgnoringCase' && tokens(child).length > 0,
  );
  const negated = operator === 'is not' || operator === '<>';
  if (
    node.rule !== 'Comparison' ||
    operands.length !== 2 ||
    ignoring ||
    (!negated && operator !== 'is' && operator !== '=')
  ) {
    return undefined;
  }
  const call = (operand: SyntaxNode) => {
    const inner = core(operand);
    const [name, open, ...rest] = inner.children.filter(
      child => child.kind === 'node' || (child.t !== 'nl' && child.t !== 'eof'),
    );
    const argument = rest[0];
    return inner.rule === 'Call' &&
      name?.kind === 'token' &&
      name.v === 'kindOf' &&
      open?.kind === 'token' &&
      open.v === '(' &&
      rest.length === 2 &&
      argument?.kind === 'node'
      ? { name, argument }
      : undefined;
  };
  const [left, right] = operands as [SyntaxNode, SyntaxNode];
  const found = call(left) ?? call(right);
  const other = call(left) ? right : left;
  const literal = tokensIn(other);
  if (!found || literal.length !== 1 || literal[0]!.t !== 'str') {
    return undefined;
  }
  return { ...found, negated, kind: literal[0]!.v };
};
const kindTest = (kind: string, negated: boolean) =>
  `is ${negated ? 'not ' : ''}${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;

// `return true` or `return false`, alone in a branch.
const returnsBool = (branch: SyntaxNode | undefined) => {
  let statement = branch;
  if (statement?.rule === 'Block') {
    const inner = nodes(statement);
    statement = inner.length === 1 ? inner[0] : undefined;
  }
  if (statement?.rule === 'Statement') {
    statement = core(statement);
  }
  const [value] = statement ? nodes(statement) : [];
  const word = value && nameToken(value)?.v;
  return statement?.rule === 'SimpleStatement' &&
    tokens(statement)
      .map(token => token.v)
      .join(' ') === 'return' &&
    nodes(statement).length === 1 &&
    (word === 'true' || word === 'false')
    ? { statement, value: word === 'true' }
    : undefined;
};
// A condition that gives a boolean or raises: a comparison, or an `and`, `or`
// or `not`, each of which raises `wrong kind` on any other operand. `if` raises
// on a non-boolean too, so returning such a condition changes no outcome.
const booleanCondition = (expression: SyntaxNode) => {
  const inner = core(expression);
  return ['Comparison', 'Not', 'And', 'Or'].includes(inner.rule) &&
    tokens(inner).length > 0
    ? inner
    : undefined;
};
// `if c then return b else return not b`, or the `if` with no `else` followed
// by the `return`, as the `if` and the statement that ends the rewrite.
const returnedCondition = (node: SyntaxNode, next?: SyntaxNode) => {
  if (node.rule !== 'If') {
    return undefined;
  }
  const children = node.children;
  const direct = tokens(node).map(token => token.v);
  const condition = children[1];
  const test =
    condition?.kind === 'node' && condition.rule === 'Expression'
      ? booleanCondition(condition)
      : undefined;
  const after = (word: string) => {
    const index = children.findIndex(
      child => child.kind === 'token' && child.v === word,
    );
    const branch = children
      .slice(index + 1)
      .find(child => child.kind === 'node' || child.t !== 'nl');
    return index >= 0 && branch?.kind === 'node' ? branch : undefined;
  };
  const then = returnsBool(after('then'));
  const hasElse = direct.includes('else');
  if (
    !test ||
    !then ||
    (hasElse && direct[direct.indexOf('else') + 1] === 'if')
  ) {
    return undefined;
  }
  const otherwise = hasElse ? returnsBool(after('else')) : returnsBool(next);
  return otherwise && otherwise.value !== then.value
    ? { test, negated: !then.value, last: hasElse ? node : next! }
    : undefined;
};
const returnText = (test: SyntaxNode, negated: boolean, text: string) =>
  negated ? `not ${test.rule === 'Comparison' ? text : `(${text})`}` : text;

// `a >= b`, `a <= b` and `a <> b` are `a is at least b`, `a is at most b` and
// `a is not b` (chapter 4). After `is not`, a right operand starting with one
// of these words would read as another test, such as `is not empty`.
const operatorWords = {
  '>=': 'is at least',
  '<=': 'is at most',
  '<>': 'is not',
};
const isTestWords = new Set([
  'a',
  'an',
  'in',
  'empty',
  'greater',
  'less',
  'at',
]);
const symbolComparison = (node: SyntaxNode) => {
  const operators = tokens(node);
  const operands = nodes(node).filter(child => child.rule === 'Concat');
  const operator = operators[0];
  if (
    node.rule !== 'Comparison' ||
    operators.length !== 1 ||
    operands.length !== 2 ||
    !operator ||
    !(operator.v in operatorWords)
  ) {
    return undefined;
  }
  const next = tokensIn(operands[1]!)[0];
  return operator.v === '<>' && next?.t === 'word' && isTestWords.has(next.v)
    ? undefined
    : {
        operator,
        words: operatorWords[operator.v as keyof typeof operatorWords],
      };
};

// `put a into i`, then `repeat while i <= n` (or `i is at most n`) whose body
// ends with `add 1 to i`, is `repeat for each i in a..n` when a is an integer
// literal and n is one or `the length of xs`: both give integers, so the
// range walks the same values. The body must not otherwise write i or xs, nor
// `next repeat`, which in the while loop skips the `add`; and nothing else in
// the declaration may name i, since the loops leave it holding different values.
const intLiteral = (node: SyntaxNode | undefined) => {
  const all = node ? tokensIn(node) : [];
  return all.length === 1 && all[0]!.t === 'num' && /^\d+$/.test(all[0]!.v)
    ? all[0]
    : undefined;
};
const lengthOf = (node: SyntaxNode) => {
  const words = tokensIn(node);
  return words.length === 4 &&
    words
      .slice(0, 3)
      .map(token => token.v)
      .join(' ') === 'the length of' &&
    words[3]!.t === 'word'
    ? words[3]
    : undefined;
};
const statementOf = (node: SyntaxNode | undefined) =>
  node?.rule === 'Statement' ? core(node) : node;
const addOne = (node: SyntaxNode | undefined, name: string) => {
  const statement = statementOf(node);
  const [by, container] = statement ? nodes(statement) : [];
  return statement?.rule === 'SimpleStatement' &&
    tokens(statement)
      .map(token => token.v)
      .join(' ') === 'add to' &&
    nodes(statement).length === 2 &&
    intLiteral(by)?.v === '1' &&
    container?.rule === 'Container' &&
    nameToken(container)?.v === name
    ? statement
    : undefined;
};
// Every Container root and pattern name under `node`: the names it writes.
const written = (node: SyntaxNode) => {
  const out = new Set<string>();
  const work = [node];
  while (work.length) {
    const next = work.pop()!;
    if (next.rule === 'Container') {
      const root = tokensIn(next)[0];
      if (root) {
        out.add(root.v);
      }
    } else if (next.rule.includes('Pattern') || next.rule === 'Collecting') {
      for (const token of tokensIn(next)) {
        out.add(token.v);
      }
    }
    work.push(...nodes(next));
  }
  return out;
};
const rangeLoop = (start: SyntaxNode, loop: SyntaxNode) => {
  const put = putInto(start);
  const from = put && intLiteral(put.value);
  const children = loop.children.filter(
    child => child.kind === 'node' || (child.t !== 'nl' && child.t !== 'eof'),
  );
  const [repeat, whileWord, condition] = children;
  if (
    !put ||
    !from ||
    loop.rule !== 'Repeat' ||
    repeat?.kind !== 'token' ||
    whileWord?.kind !== 'token' ||
    whileWord.v !== 'while' ||
    condition?.kind !== 'node'
  ) {
    return undefined;
  }
  const comparison = core(condition);
  const operator = tokens(comparison)
    .map(token => token.v)
    .join(' ');
  const operands = nodes(comparison).filter(child => child.rule === 'Concat');
  const ignoring = nodes(comparison).some(
    child => child.rule === 'IgnoringCase' && tokens(child).length > 0,
  );
  const name = put.target;
  if (
    comparison.rule !== 'Comparison' ||
    (operator !== '<=' && operator !== 'is at most') ||
    operands.length !== 2 ||
    ignoring ||
    nameToken(operands[0]!)?.v !== name.v
  ) {
    return undefined;
  }
  const bound = operands[1]!;
  const list = lengthOf(bound);
  if (!intLiteral(bound) && !list) {
    return undefined;
  }
  const body = nodes(loop).find(child => child.rule === 'Block');
  const statements = body ? nodes(body) : [];
  const step = addOne(statements.at(-1), name.v);
  if (!body || !step) {
    return undefined;
  }
  const others = statements.slice(0, -1);
  const writes = new Set(others.flatMap(statement => [...written(statement)]));
  if (
    writes.has(name.v) ||
    (list && writes.has(list.v)) ||
    tokensIn(body).some(token => token.v === 'next')
  ) {
    return undefined;
  }
  return { put, from, name, bound, list, step, condition };
};
// Each `put` directly before a `repeat` in a declaration's Blocks.
const rangeLoops = (declaration: SyntaxNode) => {
  const out: (NonNullable<ReturnType<typeof rangeLoop>> & {
    loop: SyntaxNode;
    start: SyntaxNode;
  })[] = [];
  const work = [declaration];
  while (work.length) {
    const node = work.pop()!;
    if (node.rule === 'Block') {
      const statements = nodes(node).map(core);
      for (const [i, start] of statements.entries()) {
        const loop = statements[i + 1];
        const found = loop && rangeLoop(start, loop);
        if (found) {
          out.push({ ...found, start, loop });
        }
      }
    }
    work.push(...nodes(node));
  }
  const all = tokensIn(declaration);
  return out.filter(found => {
    const inside = [...tokensIn(found.start), ...tokensIn(found.loop)];
    const count = (list: Token[]) =>
      list.filter(token => token.t === 'word' && token.v === found.name.v)
        .length;
    return count(all) === count(inside);
  });
};

// What a pattern's match guarantees about the value it matched (chapter 4,
// Destructuring): a list pattern a list, and without a rest its length; a map
// pattern a map; a Text Pattern text; a literal a value `=` to it. A list or
// map pattern with an entry also guarantees the value isn't empty.
const patternFacts = (pattern: SyntaxNode, ignoringCase: boolean) => {
  const [primary, ...rest] = pattern.children.filter(
    child => child.kind === 'node' || (child.t !== 'nl' && child.t !== 'eof'),
  );
  const alias =
    rest.length === 2 &&
    rest[0]!.kind === 'token' &&
    rest[0]!.v === 'as' &&
    rest[1]!.kind === 'node'
      ? nameToken(rest[1]!)
      : undefined;
  if (
    primary?.kind !== 'node' ||
    primary.rule !== 'PatternPrimary' ||
    (rest.length && !alias)
  ) {
    return undefined;
  }
  const open = primary.children[0];
  const inner = nodes(primary);
  if (open?.kind === 'token' && open.v === '[') {
    const elements = inner.filter(child => child.rule === 'Pattern');
    const spread = tokens(primary).some(token => token.v.startsWith('...'));
    return {
      alias,
      kind: 'list',
      length: spread ? undefined : elements.length,
      nonEmpty: elements.length > 0,
    };
  }
  if (open?.kind === 'token' && open.v === '{') {
    const keys = inner.filter(
      child => child.rule === 'MapKey' || child.rule === 'Name',
    );
    return { alias, kind: 'map', nonEmpty: keys.length > 0 };
  }
  if (inner.length === 1 && inner[0]!.rule === 'TextPattern') {
    return { alias, kind: 'text' };
  }
  const literal = tokensIn(primary);
  return isLiteral(literal[0]) &&
    literal.slice(1).every(token => token.t === 'unit') &&
    !ignoringCase
    ? { alias, literal }
    : undefined;
};
const sameTokens = (a: Token[], b: Token[]) =>
  a.length === b.length &&
  a.every((token, i) => token.t === b[i]!.t && token.v === b[i]!.v);
// The test a Guard's conjunct makes of `names`, if the facts guarantee it.
const guaranteed = (
  conjunct: SyntaxNode,
  names: Set<string>,
  facts: NonNullable<ReturnType<typeof patternFacts>>,
) => {
  const comparison = core(conjunct);
  const operator = tokens(comparison)
    .map(token => token.v)
    .join(' ');
  const operands = nodes(comparison).filter(
    child => child.rule === 'Concat' || child.rule === 'Kind',
  );
  const ignoring = nodes(comparison).some(
    child => child.rule === 'IgnoringCase' && tokens(child).length > 0,
  );
  const subject = (node: SyntaxNode | undefined) => {
    const name = node && nameToken(node);
    return name && names.has(name.v) ? name : undefined;
  };
  if (comparison.rule !== 'Comparison' || ignoring) {
    return undefined;
  }
  if (
    operator === 'is not empty' &&
    operands.length === 1 &&
    facts.nonEmpty &&
    subject(operands[0])
  ) {
    return 'is not empty';
  }
  if (operands.length !== 2) {
    return undefined;
  }
  const [left, right] = operands as [SyntaxNode, SyntaxNode];
  if (
    (operator === 'is a' || operator === 'is an') &&
    subject(left) &&
    right.rule === 'Kind' &&
    tokensIn(right)
      .map(token => token.v)
      .join(' ') === facts.kind
  ) {
    return `is ${operator.slice(3)} ${facts.kind}`;
  }
  if (operator !== '=' && operator !== 'is') {
    return undefined;
  }
  for (const [one, other] of [
    [left, right],
    [right, left],
  ] as const) {
    const counted = lengthOf(one);
    const number = intLiteral(other);
    if (
      facts.length !== undefined &&
      counted &&
      names.has(counted.v) &&
      number &&
      Number(number.v) === facts.length
    ) {
      return `has length ${facts.length}`;
    }
    if (
      facts.literal &&
      subject(one) &&
      sameTokens(tokensIn(other), facts.literal)
    ) {
      return `= ${facts.literal.map(token => token.raw).join(' ')}`;
    }
  }
  return undefined;
};
// Each `where` Guard after a pattern, with the conjuncts its pattern makes
// redundant: tests of the pattern's `as` name or a `match` subject's name.
const redundantGuards = (node: SyntaxNode) => {
  const children = node.children.filter(
    child => child.kind === 'node' || (child.t !== 'nl' && child.t !== 'eof'),
  );
  let matchName: Token | undefined;
  let ignoringCase = false;
  if (node.rule === 'Match') {
    const subject = children[1];
    matchName = subject?.kind === 'node' ? nameToken(subject) : undefined;
    ignoringCase = nodes(node).some(
      child => child.rule === 'IgnoringCase' && tokens(child).length > 0,
    );
  }
  const out: { conjunct: SyntaxNode; guard: SyntaxNode; test: string }[] = [];
  for (const [i, child] of children.entries()) {
    const where = children[i + 1];
    const guard = children[i + 2];
    if (
      child.kind !== 'node' ||
      child.rule !== 'Pattern' ||
      where?.kind !== 'token' ||
      where.v !== 'where' ||
      guard?.kind !== 'node'
    ) {
      continue;
    }
    const facts = patternFacts(child, ignoringCase);
    if (!facts) {
      continue;
    }
    // A name the pattern binds hides the subject's.
    const bound = new Set(
      tokensIn(child)
        .filter(token => token.t === 'word')
        .map(token => token.v),
    );
    const names = new Set<string>();
    if (facts.alias) {
      names.add(facts.alias.v);
    }
    if (matchName && !bound.has(matchName.v)) {
      names.add(matchName.v);
    }
    const top = core(guard);
    const conjuncts =
      top.rule === 'And' && tokens(top).every(token => token.v === 'and')
        ? nodes(top)
        : [top];
    for (const conjunct of conjuncts) {
      const test = guaranteed(conjunct, names, facts);
      if (test) {
        out.push({ guard, conjunct, test });
      }
    }
  }
  return out;
};

/** Advice for one node of the tree, before its subjects' bindings are known. */
export const idiomAdvice = (node: SyntaxNode): IdiomAdvice[] => {
  const first = tokensIn(node)[0];
  if (!first) {
    return [];
  }
  const out: IdiomAdvice[] = [];
  if (node.rule === 'If') {
    // Each condition is the Expression after `if` or `else if`. A chain
    // qualifies only if all of them compare one name with a literal.
    const subjects = node.children.flatMap((child, i) =>
      child.kind === 'node' &&
      child.rule === 'Expression' &&
      (node.children[i - 1] as Token | undefined)?.v === 'if'
        ? [literalComparison(child)]
        : [],
    );
    const subject = subjects[0];
    if (
      subjects.length >= 3 &&
      subject !== undefined &&
      subjects.every(other => other?.v === subject.v)
    ) {
      out.push({
        id: 'suggest-match',
        at: first,
        subject,
        params: { name: subject.v },
      });
    }
    const fallback = nothingDefault(node);
    if (fallback) {
      out.push({
        id: 'suggest-otherwise',
        at: first,
        subject: fallback.test.name,
        params: { name: fallback.value.v, target: fallback.target.v },
      });
    }
  }
  const update = node.rule === 'SimpleStatement' && arithmeticPut(node);
  if (update) {
    out.push({
      id: 'suggest-arithmetic-command',
      at: update.put.at,
      subject: update.put.target,
      params: {
        name: update.put.target.v,
        command: update.command('…', update.put.target.v),
      },
    });
  }
  // Every statement sits in a Block, beside the statement after it.
  const statements = node.rule === 'Block' ? nodes(node).map(core) : [];
  for (const [i, statement] of statements.entries()) {
    const returned = returnedCondition(statement, statements[i + 1]);
    if (returned) {
      out.push({
        id: 'if-then-return-bool',
        at: tokensIn(statement)[0]!,
        params: { value: returnText(returned.test, returned.negated, '…') },
      });
    }
  }
  const kinded = kindComparison(node);
  if (kinded) {
    out.push(
      kindNames.has(kinded.kind)
        ? {
            id: 'kindof-comparison',
            at: first,
            subject: kinded.name,
            subjectIs: 'builtin function',
            params: { test: kindTest(kinded.kind, kinded.negated) },
          }
        : {
            id: 'impossible-kind',
            at: first,
            subject: kinded.name,
            subjectIs: 'builtin function',
            params: { kind: kinded.kind },
          },
    );
  }
  if (node.rule === 'Declaration') {
    for (const found of rangeLoops(node)) {
      out.push({
        id: 'suggest-range-loop',
        at: found.put.at,
        locals: found.list ? [found.name, found.list] : [found.name],
        params: { name: found.name.v, from: found.from.v },
      });
    }
  }
  for (const redundant of redundantGuards(node)) {
    out.push({
      id: 'redundant-guard',
      at: tokensIn(redundant.conjunct)[0]!,
      params: { test: redundant.test },
    });
  }
  const symbol = symbolComparison(node);
  if (symbol) {
    out.push({
      id: 'suggest-word-operator',
      at: symbol.operator,
      params: { operator: symbol.operator.v, words: symbol.words },
    });
  }
  const member = membership(node);
  if (member) {
    out.push({
      id: 'suggest-is-in',
      at: first,
      subject: member.subject,
      params: { name: member.subject.v },
    });
  }
  return out;
};

const find = (tree: SyntaxNode, test: (node: SyntaxNode) => boolean) => {
  const work = [tree];
  while (work.length) {
    const node = work.pop()!;
    if (test(node)) {
      return node;
    }
    work.push(...nodes(node));
  }
  return undefined;
};
const startsAt = (node: SyntaxNode, start: number) =>
  tokensIn(node)[0]?.pos === start;
// A comment inside the code a rewrite replaces would be lost.
const hasComment = (node: SyntaxNode) =>
  tokensIn(node, true)
    .slice(1)
    .some(token =>
      token.leadingTrivia.some(trivia => trivia.kind === 'comment'),
    );

// The `suggest-every-of` rewrite, which the Lint reports only after checking
// the loop's names: `put every item of xs whose c into acc`, with the loop
// variable read as `it`. A condition starting with another name is bracketed,
// since a Whose Clause would read that name as a key of `it`.
const everyOfEdit = (
  tree: SyntaxNode,
  source: string,
  start: number,
): Edit | undefined => {
  const block = find(
    tree,
    node =>
      node.rule === 'Block' &&
      nodes(node).some(statement => startsAt(statement, start)),
  );
  const statements = block ? nodes(block).map(core) : [];
  const index = statements.findIndex(statement => startsAt(statement, start));
  const init = statements[index];
  const loop = statements[index + 1];
  const put = init && putInto(init);
  const [pattern, walked, body] = loop ? nodes(loop) : [];
  const name = pattern && nameToken(pattern);
  const branch = body && core(nodes(body)[0]!);
  const condition = branch && nodes(branch)[0];
  if (!put || !loop || !name || !walked || !condition || hasComment(loop)) {
    return undefined;
  }
  // Each read of the loop variable, but not a key spelled the same.
  const keys = new Set<Token>();
  const work = [condition];
  while (work.length) {
    const node = work.pop()!;
    if (node.rule === 'Key' || node.rule === 'MapKey') {
      tokensIn(node).forEach(token => keys.add(token));
    }
    work.push(...nodes(node));
  }
  const reads = tokensIn(condition).filter(
    token => token.t === 'word' && token.v === name.v && !keys.has(token),
  );
  const span = spanOf(condition);
  let text = source.slice(span.start, span.end);
  for (const token of [...reads].reverse()) {
    text =
      text.slice(0, token.pos - span.start) +
      'it' +
      text.slice(token.end - span.start);
  }
  const lead = tokensIn(condition)[0]!;
  if (lead.t === 'word' && lead !== reads[0]) {
    text = `(${text})`;
  }
  const list = tokensIn(walked);
  const walk =
    list.length === 1 || core(walked).rule === 'List'
      ? sourceOf(source, walked)
      : `(${sourceOf(source, walked)})`;
  return {
    start,
    end: spanOf(loop).end,
    newText: `put every item of ${walk} whose ${text} into ${put.target.raw}`,
  };
};

/**
 * The rewrite the LSP offers for the idiom Lint `id` reported at `start`, or
 * absent when this code has no rewrite that keeps its layout and comments.
 */
export const idiomEdit = (
  tree: SyntaxNode,
  source: string,
  id: string,
  start: number,
): Edit | undefined => {
  if (id === 'suggest-match') {
    return suggestMatchEdit(tree, source, start);
  }
  if (id === 'suggest-arithmetic-command') {
    const statement = find(
      tree,
      node => node.rule === 'SimpleStatement' && startsAt(node, start),
    );
    const update = statement && arithmeticPut(statement);
    return update && !hasComment(statement)
      ? {
          ...spanOf(statement),
          newText: update.command(
            sourceOf(source, update.right),
            update.put.target.raw,
          ),
        }
      : undefined;
  }
  if (id === 'if-then-return-bool') {
    const branch = find(
      tree,
      node => node.rule === 'If' && startsAt(node, start),
    );
    const parent =
      branch && find(tree, node => nodes(node).map(core).includes(branch));
    const siblings = parent ? nodes(parent).map(core) : [];
    const returned =
      branch &&
      returnedCondition(branch, siblings[siblings.indexOf(branch) + 1]);
    if (!returned || !parent) {
      return undefined;
    }
    const range = {
      start: spanOf(branch).start,
      end: spanOf(returned.last).end,
    };
    // Line endings between the statements sit in their Block, and carry the
    // comments that end those lines.
    if (
      tokensIn(parent, true).some(
        token =>
          token.pos > range.start &&
          token.pos < range.end &&
          token.leadingTrivia.some(trivia => trivia.kind === 'comment'),
      )
    ) {
      return undefined;
    }
    return {
      ...range,
      newText: `return ${returnText(
        returned.test,
        returned.negated,
        sourceOf(source, returned.test),
      )}`,
    };
  }
  if (id === 'kindof-comparison') {
    const comparison = find(
      tree,
      node => node.rule === 'Comparison' && startsAt(node, start),
    );
    const kinded = comparison && kindComparison(comparison);
    if (!kinded || !kindNames.has(kinded.kind) || hasComment(comparison)) {
      return undefined;
    }
    // A comparison's operands bind tighter than `and`, `or`, `not`, a
    // comparison and `otherwise`, so an argument using one keeps parentheses.
    const loose = ['Default', 'Or', 'And', 'Not', 'Comparison'].includes(
      core(kinded.argument).rule,
    );
    const argument = sourceOf(source, kinded.argument);
    return {
      ...spanOf(comparison),
      newText: `${loose ? `(${argument})` : argument} ${kindTest(
        kinded.kind,
        kinded.negated,
      )}`,
    };
  }
  if (id === 'suggest-is-in') {
    const chain = find(
      tree,
      node => node.rule === 'Or' && startsAt(node, start),
    );
    const member = chain && membership(chain);
    return member && !hasComment(chain)
      ? {
          ...spanOf(chain),
          newText: `${member.subject.raw} is in [${member.literals
            .map(literal => literal.raw)
            .join(', ')}]`,
        }
      : undefined;
  }
  if (id === 'redundant-guard') {
    let found: ReturnType<typeof redundantGuards>[number] | undefined;
    find(tree, node => {
      found = redundantGuards(node).find(
        each => tokensIn(each.conjunct)[0]!.pos === start,
      );
      return !!found;
    });
    if (!found || hasComment(found.guard)) {
      return undefined;
    }
    const { guard, conjunct } = found;
    const top = core(guard);
    const conjuncts = top.rule === 'And' ? nodes(top) : [top];
    if (conjuncts.length === 1) {
      // Remove ` where c`, back to the end of the pattern.
      const end = spanOf(guard).end;
      let from = spanOf(guard).start;
      from = source.lastIndexOf('where', from);
      while (from > 0 && /[\t ]/.test(source[from - 1]!)) {
        from--;
      }
      return { start: from, end, newText: '' };
    }
    // Remove the conjunct and the `and` beside it.
    const index = conjuncts.indexOf(conjunct);
    const span = spanOf(conjunct);
    return index === 0
      ? { start: span.start, end: spanOf(conjuncts[1]!).start, newText: '' }
      : {
          start: spanOf(conjuncts[index - 1]!).end,
          end: span.end,
          newText: '',
        };
  }
  if (id === 'suggest-every-of') {
    return everyOfEdit(tree, source, start);
  }
  if (id === 'suggest-range-loop') {
    const declaration = find(
      tree,
      node =>
        node.rule === 'Declaration' &&
        rangeLoops(node).some(found => found.put.at.pos === start),
    );
    const found =
      declaration &&
      rangeLoops(declaration).find(found => found.put.at.pos === start);
    if (!found) {
      return undefined;
    }
    // Replace the put through the condition, and remove the `add` line.
    const head = { start, end: spanOf(found.condition).end };
    const step = spanOf(found.step);
    const lineStart = source.lastIndexOf('\n', step.start - 1) + 1;
    const lineEnd = source.indexOf('\n', step.end);
    const replaced = [
      ...tokensIn(found.start, true),
      ...tokensIn(found.loop, true),
    ].filter(
      token =>
        (token.pos > head.start && token.pos <= head.end) ||
        (token.pos > lineStart && token.pos <= lineEnd),
    );
    if (
      lineEnd < 0 ||
      source.slice(lineStart, step.start).trim() ||
      source.slice(step.end, lineEnd).trim() ||
      replaced.some(token =>
        token.leadingTrivia.some(trivia => trivia.kind === 'comment'),
      )
    ) {
      return undefined;
    }
    const between = source.slice(head.end, lineStart);
    return {
      start: head.start,
      end: lineEnd + 1,
      newText: `repeat for each ${found.name.raw} in ${found.from.raw}..${sourceOf(
        source,
        found.bound,
      )}${between}`,
    };
  }
  if (id === 'suggest-word-operator') {
    const comparison = find(
      tree,
      node =>
        node.rule === 'Comparison' &&
        tokens(node).some(token => token.pos === start),
    );
    const symbol = comparison && symbolComparison(comparison);
    return symbol
      ? {
          start: symbol.operator.pos,
          end: symbol.operator.end,
          newText: symbol.words,
        }
      : undefined;
  }
  if (id === 'suggest-otherwise') {
    const branch = find(
      tree,
      node => node.rule === 'If' && startsAt(node, start),
    );
    const fallback = branch && nothingDefault(branch);
    return fallback && !hasComment(branch)
      ? {
          ...spanOf(branch),
          newText: `put ${fallback.value.raw} otherwise ${sourceOf(
            source,
            fallback.fallback,
          )} into ${fallback.target.raw}`,
        }
      : undefined;
  }
  return undefined;
};
