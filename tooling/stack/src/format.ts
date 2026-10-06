import {
  parseSource,
  Lexer,
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
  attachLeft?: boolean;
  attachRight: boolean;
  depth: number;
  token: Token;
};

// Change only prefixes owned by this literal, never lines in a hole. The
// parser has already checked that every prefix matches the exact old margin.
const withMargin = (
  token: Token,
  source: string,
  margin: string | null,
  depth: number,
): Token => {
  if (margin === null) {
    return token;
  }
  const raw = token.raw.replaceAll(
    /(^(?=[\t ])|\r\n|\r|\n)([\t ]*)/g,
    (match, newline: string, prefix: string, offset: number) => {
      const start = token.pos + offset + newline.length;
      if (start > 0 && !/[\n\r]/.test(source[start - 1]!)) {
        return match;
      }
      const removed = Math.min(prefix.length, margin.length);
      const rest = prefix.slice(removed);
      const end = offset + newline.length + prefix.length;
      // Short blank prefixes become empty; trailing spaces beyond the margin
      // still belong to the value and must survive.
      const next = source[token.pos + end];
      const blank = next === undefined || /[\n\r]/.test(next);
      return newline + (blank && !rest ? '' : indent(depth) + rest);
    },
  );
  return { ...token, raw };
};
const marginOf = (
  source: string,
  open: number,
  end: number,
  width: number,
): string | null => {
  if (!/[\n\r]/.test(source[open + width] ?? '')) {
    return null;
  }
  const close = end - width;
  let start = close;
  while (start > 0 && !/[\n\r]/.test(source[start - 1]!)) {
    start--;
  }
  return source.slice(start, close);
};
const leaves = (tree: SyntaxNode, source: string): Leaf[] => {
  const out: Leaf[] = [];
  const lexer = new Lexer(source);
  const stack: {
    attachLeft?: boolean;
    attachRight: boolean;
    depth: number;
    element: SyntaxElement;
  }[] = [{ element: tree, depth: 0, attachRight: false }];
  while (stack.length) {
    const { element, depth, attachRight, attachLeft } = stack.pop()!;
    if (element.kind === 'token') {
      const width = element.raw.startsWith('`')
        ? 1
        : /^"{3,}/.exec(element.raw)?.[0].length;
      const token =
        element.t === 'str' && width
          ? withMargin(
              element,
              source,
              marginOf(source, element.pos, element.end, width),
              depth,
            )
          : element;
      out.push({ token, depth, attachRight, attachLeft });
      continue;
    }
    if (element.rule === 'Interpolated') {
      const first = element.children[0] as Token;
      const margin = marginOf(source, first.pos, element.end, 1);
      const children: typeof stack = [];
      for (const [index, child] of element.children.entries()) {
        if (child.kind === 'node') {
          children.push({ element: child, depth, attachRight: false });
        } else if (child.v === '${' && child.t === 'op') {
          children.push({
            element: child,
            depth,
            attachRight: true,
            attachLeft: true,
          });
        } else {
          let literal = child;
          if (index > 0) {
            // The lossless literal segment includes the hole's closing trivia
            // and brace. Give those back to ordinary code formatting.
            let cursor = child.pos;
            const trivia: Token['leadingTrivia'][number][] = [];
            let closer = lexer.lex(cursor, 'operator');
            while (closer.t === 'nl') {
              trivia.push(...closer.leadingTrivia, {
                kind: 'continuation',
                pos: closer.pos,
                end: closer.end,
                raw: closer.raw,
                line: closer.line,
                col: closer.col,
              });
              cursor = closer.end;
              closer = lexer.lex(cursor, 'operator');
            }
            children.push({
              element: {
                ...closer,
                leadingTrivia: [...trivia, ...closer.leadingTrivia],
              },
              depth,
              attachRight: true,
            });
            literal = {
              ...child,
              pos: closer.end,
              raw: source.slice(closer.end, child.end),
            };
          }
          children.push({
            element: {
              ...withMargin(literal, source, margin, depth),
              t: 'template',
            },
            depth,
            attachRight: index < element.children.length - 1,
            attachLeft: index > 0,
          });
        }
      }
      stack.push(...children.reverse());
      continue;
    }
    // Empty choice arguments have one canonical spelling. Keep all trivia
    // while omitting their parentheses, including comments on continued lines.
    if (
      element.rule === 'ChooseOffer' &&
      !element.children.some(
        c => c.kind === 'node' && c.rule === 'ExpressionList',
      )
    ) {
      stack.push(
        ...[...element.children].reverse().map(child => ({
          element:
            child.kind === 'token' && (child.v === '(' || child.v === ')')
              ? { ...child, t: 'eof' as const, raw: '' }
              : child,
          depth,
          attachRight: false,
        })),
      );
      continue;
    }
    // Branch heads in match and block wait sit inside their block; their
    // Block productions add the second level for multiline branch bodies.
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
  if (next.attachLeft) {
    return '';
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
  for (const leaf of leaves(parsed.tree, source)) {
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
