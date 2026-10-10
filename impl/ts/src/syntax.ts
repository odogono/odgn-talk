import type { Token } from './lexer';

export type SyntaxErrorCode =
  | 'unterminated interpolation'
  | 'empty interpolation'
  | 'invalid text escape'
  | 'invalid text indentation'
  | 'invalid text delimiter'
  | 'bad character'
  | 'unterminated text'
  | 'bad unit'
  | 'unexpected token'
  | 'not a container';

/** All offsets index the original TS string; line and col count Unicode scalars. */
export type Trivia = {
  col: number;
  end: number;
  kind: 'bom' | 'space' | 'comment' | 'continuation';
  line: number;
  pos: number;
  raw: string;
};

export type SyntaxRule =
  | 'Source'
  | 'Entry'
  | 'Error'
  | 'Declaration'
  | 'Use'
  | 'Handler'
  | 'Parameter'
  | 'Function'
  | 'Block'
  | 'Body'
  | 'Statement'
  | 'SimpleStatement'
  | 'ExpressionList'
  | 'Container'
  | 'AndWait'
  | 'Send'
  | 'AskTell'
  | 'TellBlock'
  | 'TimeoutBlock'
  | 'OperationLine'
  | 'Wait'
  | 'Event'
  | 'If'
  | 'Repeat'
  | 'Collecting'
  | 'Match'
  | 'Try'
  | 'OfferClause'
  | 'OfferParameter'
  | 'RecoveryMarker'
  | 'ChooseOffer'
  | 'Replace'
  | 'IgnoringCase'
  | 'Expression'
  | 'Lambda'
  | 'Whose'
  | 'EveryHead'
  | 'WhoseKey'
  | 'Or'
  | 'And'
  | 'Not'
  | 'Comparison'
  | 'Concat'
  | 'Range'
  | 'Additive'
  | 'Multiplicative'
  | 'Power'
  | 'Unary'
  | 'Conversion'
  | 'Kind'
  | 'ChunkLevel'
  | 'Postfix'
  | 'Key'
  | 'Call'
  | 'Primary'
  | 'Interpolated'
  | 'Chunk'
  | 'The'
  | 'List'
  | 'MapKey'
  | 'Map'
  | 'Pattern'
  | 'PatternPrimary'
  | 'TextPattern'
  | 'Alternation'
  | 'Element'
  | 'Atom'
  | 'BinaryPattern'
  | 'Field'
  | 'AsText'
  | 'FieldType'
  | 'BinaryBuild'
  | 'Name'
  | 'MessageName'
  | 'Label';

export type SyntaxElement = SyntaxNode | Token;

/** Children are ordered and own each source character exactly once. Spans include trivia. */
export type SyntaxNode = {
  children: readonly SyntaxElement[];
  end: number;
  kind: 'node';
  rule: SyntaxRule;
  start: number;
};

/** Reconstruct source by walking the tree, without retaining a second source copy. */
export const syntaxText = (tree: SyntaxNode): string => {
  const stack: SyntaxElement[] = [tree];
  const parts: string[] = [];
  while (stack.length) {
    const element = stack.pop()!;
    if (element.kind === 'node') {
      for (let i = element.children.length - 1; i >= 0; i--) {
        stack.push(element.children[i]!);
      }
    } else {
      for (const trivia of element.leadingTrivia) {
        parts.push(trivia.raw);
      }
      parts.push(element.raw);
    }
  }
  return parts.join('');
};

/** A labelled message uses its Selector as its semantic and dispatch name. */
export const syntaxSelector = (node: SyntaxNode, name: string): string => {
  const labels = node.children
    .flatMap(child => {
      if (child.kind !== 'node') {
        return [];
      }
      if (child.rule === 'ExpressionList') {
        return child.children.filter(
          (c): c is SyntaxNode => c.kind === 'node' && c.rule === 'Label',
        );
      }
      return child.rule === 'Label' ? [child] : [];
    })
    .map(label => (label.children[0] as Token).v);
  return labels.length ? `${[name, ...labels].join(':')}:` : name;
};
