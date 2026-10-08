// Declaration Documentation (Session observation, Declaration documentation):
// the block of `--|` line comments directly before a top-level declaration.
import type { Token } from './lexer';
import type { SyntaxElement, SyntaxNode } from './syntax';
import type { Value } from './values';

const MARKER = '--|';

// A whole-line comment's documentation text when the comment is marked: the
// marker and at most one following ASCII space are removed.
const docLine = (token: Token): string | null => {
  const comment = token.leadingTrivia.find(t => t.kind === 'comment');
  if (!comment?.raw.startsWith(MARKER)) {
    return null;
  }
  const text = comment.raw.slice(MARKER.length);
  return text.startsWith(' ') ? text.slice(1) : text;
};

const isLineBreak = (e: SyntaxElement | undefined): e is Token =>
  e?.kind === 'token' && e.t === 'nl';

// The marked whole-line comments directly before `children[at]`. Each line
// break between declarations is a whole line, since a declaration owns the
// line break that ends it, with any trailing comment. A blank line or
// ordinary comment ends the block.
const docBlock = (children: readonly SyntaxElement[], at: number): Token[] => {
  const lines: Token[] = [];
  for (let k = at - 1; k >= 0; k--) {
    const child = children[k];
    if (!isLineBreak(child)) {
      break;
    }
    const text = docLine(child);
    if (text === null) {
      break;
    }
    lines.push(child);
  }
  return lines.reverse();
};

/**
 * Each top-level declaration's Declaration Documentation in a parsed Source,
 * in source order, joined with LF. Imports have none, and a declaration
 * without a block has empty text.
 */
export const declarationDocs = (root: SyntaxNode): Map<SyntaxNode, string> => {
  const docs = new Map<SyntaxNode, string>();
  root.children.forEach((child, at) => {
    if (child.kind === 'node' && child.rule === 'Declaration') {
      const use = child.children.some(
        c => c.kind === 'node' && c.rule === 'Use',
      );
      docs.set(
        child,
        use ? '' : docBlock(root.children, at).map(docLine).join('\n'),
      );
    }
  });
  return docs;
};

/**
 * The source start of a top-level declaration including its attached marked
 * comments. Tooling that submits it as an Entry keeps the exact block, even
 * before an Import (which the Session Host refuses at the prompt).
 */
export const declarationStart = (
  root: SyntaxNode,
  declaration: SyntaxNode,
): number => {
  const first = docBlock(root.children, root.children.indexOf(declaration))[0];
  return first ? (first.leadingTrivia[0]?.pos ?? first.pos) : declaration.start;
};

/** How an Entry's leading documentation block attaches. */
export type EntryDoc = 'none' | 'pending' | 'attached';

/**
 * Classifies the block of `--|` lines before a parsed Entry's first token:
 * `pending` when the input ends after it, `attached` when the Entry follows it
 * directly. A blank line or ordinary comment after a block detaches it.
 */
export const leadingDoc = (entry: SyntaxNode): EntryDoc => {
  const children = entry.children;
  const at = children.findIndex(c => !isLineBreak(c));
  if (at < 0) {
    return 'none';
  }
  const first = children[at]!;
  if (first.kind === 'token' && first.t === 'eof') {
    // A final comment line without its line break is the EOF's leading text.
    if (first.leadingTrivia.some(t => t.kind === 'comment')) {
      return docLine(first) === null ? 'none' : 'pending';
    }
    return docBlock(children, at).length ? 'pending' : 'none';
  }
  return docBlock(children, at).length ? 'attached' : 'none';
};

/**
 * The Declaration Documentation of a Function Value's defining code, or null
 * for any other value. A Lambda's is empty, and a stale Function Value keeps
 * its code's documentation, through save and restore too.
 */
export const functionDoc = (value: Value): string | null => {
  const fn = value.asFunction();
  return fn ? codeDoc(fn.code) : null;
};

// Live code holds its body; stale code that a save dropped keeps only `doc`.
export const codeDoc = (code: unknown): string => {
  const c = code as { body?: { doc?: string }; doc?: string } | null;
  return c?.body?.doc ?? c?.doc ?? '';
};
