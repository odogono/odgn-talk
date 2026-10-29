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
  | 'suggest-arithmetic-command'
  | 'suggest-is-in'
  | 'suggest-match'
  | 'suggest-otherwise';
/** Advice that holds only if `subject` names a variable, which needs bindings. */
export type IdiomAdvice = {
  at: Token;
  id: IdiomId;
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
