import { parseSourceRecovering, type SyntaxElement } from '@odgn/northtalk';

export type SyntaxView = {
  children: SyntaxView[];
  from: number;
  label: string;
  to: number;
};
const wrappers = new Set([
  'Declaration',
  'Statement',
  'SimpleStatement',
  'Expression',
  'Primary',
  'Or',
  'And',
  'Not',
  'Comparison',
  'Concat',
  'Range',
  'Additive',
  'Multiplicative',
  'Power',
  'Unary',
  'Conversion',
  'Postfix',
]);

/** A readable projection of the recovering tree, always in editor offsets. */
export const inspectSyntax = (source: string): SyntaxView => {
  const project = (node: SyntaxElement): SyntaxView | null => {
    if (node.kind === 'token') {
      if (node.t === 'nl' || node.t === 'eof') {
        return null;
      }
      return { label: node.raw, from: node.pos, to: node.end, children: [] };
    }
    const children = node.children
      .map(project)
      .filter((n): n is SyntaxView => n !== null);
    if (wrappers.has(node.rule) && children.length === 1) {
      return children[0]!;
    }
    return {
      label: node.rule,
      from: children[0]?.from ?? node.start,
      to: children.at(-1)?.to ?? node.end,
      children,
    };
  };
  return project(parseSourceRecovering(source).tree)!;
};

export const enclosingNode = (
  node: SyntaxView,
  from: number,
  to: number,
): SyntaxView | null => {
  if (from < node.from || to > node.to) {
    return null;
  }
  for (const child of node.children) {
    const found = enclosingNode(child, from, to);
    if (found) {
      return found;
    }
  }
  return node;
};
