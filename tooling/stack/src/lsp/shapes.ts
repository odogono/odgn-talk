// Named Shapes in the editor (ADR 0168): hover shows a Shape's source
// spelling, and completion offers kinds and Shape names where a Shape goes.
import {
  kindNames,
  type Binding,
  type SemanticNode,
  type SemanticToken,
  type SyntaxElement,
  type SyntaxNode,
} from '@northtalk/ts';
import { rangeAt } from './protocol';
import { elements, semanticElements, type Analysis } from './workspace';

/** The Built-ins whose second argument is a Shape. */
const shapeBuiltins = ['conforms', 'check', 'explain'];
const scalars = [...kindNames, 'any', 'value'];

const shapesInScope = (analysis: Analysis): Binding[] =>
  analysis.checked.tree.scopes[0]?.bindings.filter(b => b.shape) ?? [];

/** The declaration of a Shape, unwrapped from `private`. */
const shapeDeclaration = (node: SemanticNode): SemanticNode | null => {
  const [first, second] = node.children;
  if (first?.kind === 'token' && first.text === 'private') {
    return second?.kind === 'node' ? shapeDeclaration(second) : null;
  }
  return first?.kind === 'token' && first.text === 'shape' ? node : null;
};

// A Shape's source spelling, with its Declaration Documentation, from the
// unit that declares it.
const declarationText = (home: Analysis, name: string) => {
  const declarations = home.checked.tree.root.children.filter(
    (c): c is SemanticNode => c.kind === 'node' && c.rule === 'Declaration',
  );
  for (const [index, declaration] of declarations.entries()) {
    const shape = shapeDeclaration(declaration);
    const named =
      shape &&
      semanticElements(shape).some(
        e => e.kind === 'name' && e.role === 'declaration' && e.text === name,
      );
    if (named) {
      const { start, end } = declaration.span;
      const doc = home.checked.tree.docs?.[index] ?? '';
      const source = home.document.text.slice(start, end).trimEnd();
      return doc ? `${source}\n\n${doc}` : source;
    }
  }
  return null;
};

// The Shape name under the cursor: a declared or imported name, or a Name
// the Core read as a kind, after `is a` or inside a Shape Expression.
const shapeAt = (analysis: Analysis, offset: number) => {
  for (const node of analysis.nodes) {
    for (const child of node.children) {
      const { span } = child as { span: SemanticToken['span'] };
      if (span.start > offset || offset >= span.end) {
        continue;
      }
      if (child.kind === 'name' && child.binding?.shape) {
        return { binding: child.binding, span };
      }
      if (child.kind === 'token' && node.rule === 'Kind') {
        const binding = shapesInScope(analysis).find(
          b => b.name === child.text,
        );
        if (binding) {
          return { binding, span };
        }
      }
    }
  }
  return null;
};

export const shapeHover = (
  all: Map<string, Analysis>,
  analysis: Analysis,
  offset: number,
  markdown: boolean,
) => {
  const at = shapeAt(analysis, offset);
  if (!at) {
    return null;
  }
  const from = at.binding.importedFrom;
  const home = from
    ? [...all.values()].find(a => a.document.library === from.library)
    : analysis;
  const text = home && declarationText(home, from?.name ?? at.binding.name);
  if (!text) {
    return null;
  }
  return {
    contents: markdown
      ? { kind: 'markdown', value: '```northtalk\n' + text + '\n```' }
      : { kind: 'plaintext', value: text },
    range: rangeAt(analysis.document.text, at.span.start, at.span.end),
  };
};

const item = (label: string, kind: number, detail: string) => ({
  label,
  kind,
  detail,
});

// Inside a Shape declaration, after its `is`: on the header's line, in an
// open bracket it started, or in a ShapeExpr the parser recovered.
const inShapeExpression = (analysis: Analysis, offset: number) => {
  const before = analysis.document.text.slice(0, offset);
  const header = [
    ...before.matchAll(
      /^[\t ]*(?:private\s+)?shape\s+[\p{L}\p{N}_]+\s+is\s/gmu,
    ),
  ].at(-1);
  if (header) {
    // A line break with every bracket closed ends the declaration.
    let depth = 0;
    let open = true;
    for (const char of before.slice(header.index)) {
      depth += '{('.includes(char) ? 1 : '})'.includes(char) ? -1 : 0;
      if ((char === '\n' || char === '\r') && depth <= 0) {
        open = false;
        break;
      }
    }
    if (open) {
      return true;
    }
  }
  return elements<SyntaxElement>(analysis.syntax).some(
    (e): e is SyntaxNode =>
      e.kind === 'node' &&
      e.rule === 'ShapeExpr' &&
      e.start < offset &&
      offset <= e.end,
  );
};

/**
 * Kinds and Shape names after `is a` and in a Shape Expression; Shape names,
 * and kinds as text, in a Shape-taking Built-in's Shape argument.
 */
export const shapeCompletion = (
  analysis: Analysis,
  offset: number,
  line: string,
) => {
  const shapes = shapesInScope(analysis).map(b =>
    item(
      b.name,
      22,
      b.importedFrom ? `shape from ${b.importedFrom.library}` : 'shape',
    ),
  );
  const inShape = inShapeExpression(analysis, offset);
  // A map key is the author's own word.
  if (inShape && /(?:^|[{,])\s*[\p{L}\p{N}_]*$/u.test(line)) {
    return [];
  }
  if (inShape || /\bis\s+(?:not\s+)?an?\s+[\p{L}\p{N}_]*$/u.test(line)) {
    return [...scalars.map(k => item(k, 14, 'kind')), ...shapes];
  }
  const call = new RegExp(
    String.raw`\b(?:${shapeBuiltins.join('|')})\s*\([^()]*,\s*[\p{L}\p{N}_]*$`,
    'u',
  );
  if (call.test(line)) {
    return [
      ...shapes,
      ...scalars.map(k => ({
        ...item(JSON.stringify(k), 14, 'kind'),
        filterText: k,
      })),
    ];
  }
  return null;
};
