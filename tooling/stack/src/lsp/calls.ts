import type { SyntaxElement, SyntaxNode, Token } from '@northtalk/ts';

// The Operation an `ask`, a one-line `tell` or a `tell` block's line calls,
// by its Grant's and Operation's name tokens, in the syntax tree of `source`.
export const operationCall = (
  syntax: SyntaxElement[],
  node: SyntaxNode,
  source: string,
): { grant: string; op: Token } | undefined => {
  let receiver: SyntaxElement | undefined;
  let op: SyntaxElement | undefined;
  if (node.rule === 'AskTell') {
    const to = node.children.findIndex(e => e.kind === 'token' && e.v === 'to');
    receiver = node.children[to - 1];
    op = node.children[to + 1];
  } else {
    // A `tell` block's line calls an Operation of the block's receiver.
    receiver = syntax.find(
      (e): e is SyntaxNode =>
        e.kind === 'node' &&
        e.rule === 'TellBlock' &&
        e.children.includes(node),
    )?.children[1];
    op = node.children[0];
  }
  const grant =
    receiver?.kind === 'node'
      ? source.slice(receiver.start, receiver.end).trim()
      : '';
  return op?.kind === 'token' &&
    op.t === 'word' &&
    /^[\p{L}\p{N}_]+$/u.test(grant)
    ? { grant, op }
    : undefined;
};
