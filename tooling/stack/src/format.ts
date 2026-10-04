import {
  parseSource,
  syntaxText,
  type ParseError,
  type SyntaxElement,
  type SyntaxNode,
  type Token,
} from '@odgn/northtalk';

export type FormatResult = {
  error: ParseError | null;
  /** The original source when parsing fails; otherwise the formatted source. */
  source: string;
};

type Leaf = {
  attachRight: boolean;
  depth: number;
  token: Token;
};

// Branch heads in match and block wait sit inside their block; their Block
// productions add the second level for multiline branch bodies.
const leaves = (tree: SyntaxNode): Leaf[] => {
  const out: Leaf[] = [];
  const stack: {
    attachRight: boolean;
    depth: number;
    element: SyntaxElement;
  }[] = [{ element: tree, depth: 0, attachRight: false }];
  while (stack.length) {
    const { element, depth, attachRight } = stack.pop()!;
    if (element.kind === 'token') {
      out.push({ token: element, depth, attachRight });
      continue;
    }
    // Literal interiors are lossless: format surrounding code, never content.
    if (element.rule === 'Interpolated') {
      const first = element.children[0] as Token;
      out.push({
        token: {
          ...first,
          raw: syntaxText(element).slice(
            first.leadingTrivia.reduce((n, t) => n + t.raw.length, 0),
          ),
          end: element.end,
          t: 'template',
        },
        depth,
        attachRight,
      });
      continue;
    }
    const branchBlock =
      element.rule === 'Match' ||
      (element.rule === 'Wait' &&
        element.children.some(
          child =>
            child.kind === 'token' && ['when', 'after'].includes(child.v),
        ));
    let branchDepth = 0;
    const children = element.children.map(child => {
      if (branchBlock && child.kind === 'token' && child.v === 'end') {
        branchDepth = 0;
      }
      const next = {
        element: child,
        depth: depth + (element.rule === 'Block' ? 1 : 0) + branchDepth,
        attachRight:
          child.kind === 'token' &&
          child.t === 'op' &&
          ((element.rule === 'Unary' && child.v === '-') ||
            (child.v === '^' && child.mode !== 'operator')),
      };
      if (branchBlock && child.kind === 'token' && child.t === 'nl') {
        branchDepth = 1;
      }
      return next;
    });
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]!);
    }
  }
  return out;
};

const gap = (previous: Leaf, next: Leaf): string => {
  const a = previous.token;
  const b = next.token;
  // Joining two minus tokens would turn them into a comment.
  if (
    (a.t === 'op' && a.v === '-' && b.t === 'op' && b.v === '-') ||
    (a.t === 'patopen' && b.t === 'patopen')
  ) {
    return ' ';
  }
  if (
    (b.t === 'op' && [')', ']', '}', ',', ':', "'s", '..'].includes(b.v)) ||
    b.t === 'patclose'
  ) {
    return '';
  }
  if (
    previous.attachRight ||
    (a.t === 'op' && ['(', '[', '{', '..', '...'].includes(a.v)) ||
    a.t === 'patopen'
  ) {
    return '';
  }
  // `say (x)` is a Command Call; `say(x)` is a function call. The parser
  // deliberately records this lexical distinction, which layout must keep.
  if (b.t === 'op' && b.v === '(') {
    return b.spaceBefore ? ' ' : '';
  }
  return ' ';
};

const indent = (depth: number) => '  '.repeat(depth);

/** Chapter 12's option-free formatter, using only the Core's lossless parse. */
export const formatSource = (source: string): FormatResult => {
  const parsed = parseSource(source);
  if (parsed.error) {
    return { source, error: parsed.error };
  }
  const parts: string[] = [];
  let line = '';
  let previous: Leaf | null = null;
  let previousDepth = 0;
  let blank = false;
  let continuation = false;
  const newline = (raw: string, continued: boolean) => {
    // Empty physical lines alone may be collapsed. Every other line ending
    // is emitted exactly as supplied, including CRLF and a final newline.
    if (line || !blank) {
      parts.push(line, raw);
    }
    blank = !line;
    line = '';
    previous = null;
    continuation = continued;
  };
  for (const leaf of leaves(parsed.tree)) {
    const { token, depth } = leaf;
    for (const trivia of token.leadingTrivia) {
      switch (trivia.kind) {
        case 'bom':
          line += trivia.raw;
          break;
        case 'space':
          break;
        case 'comment':
          line +=
            line && line !== '\uFEFF'
              ? ' '
              : indent(Math.max(previousDepth, depth));
          line += trivia.raw;
          break;
        case 'continuation':
          newline(trivia.raw, true);
          break;
      }
    }
    if (token.t === 'nl') {
      newline(token.raw, false);
    } else if (token.t !== 'eof') {
      line += previous
        ? gap(previous, leaf)
        : indent(depth + (continuation ? 1 : 0));
      line += token.raw;
      previous = leaf;
      previousDepth = depth;
    }
  }
  parts.push(line);
  return { source: parts.join(''), error: null };
};
