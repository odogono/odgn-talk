// Advice, never an error (ADR 0145): a `click` clause that doesn't constrain
// `button`, such as `on click {}`, also runs on middle and secondary clicks.
import { parseSource } from '@northtalk/ts';
import { rangeAt, type LspDiagnostic } from '@northtalk/tooling/lsp';
import { PRIMARY_CLICK } from './pointer';

type Node = {
  children?: readonly Node[];
  end?: number;
  kind: string;
  pos?: number;
  rule?: string;
  v?: string;
};

const words = (node: Node): string[] =>
  node.kind === 'token' ? [node.v ?? ''] : (node.children ?? []).flatMap(words);

/** Advice for each `click` clause that every button reaches. */
export const clickAdvice = (source: string): LspDiagnostic[] => {
  let tree: Node | null;
  try {
    const parsed = parseSource(source);
    tree = parsed.error ? null : (parsed.tree as unknown as Node | null);
  } catch {
    return [];
  }
  const clauses = (tree?.children ?? [])
    .map(declaration =>
      declaration.children?.find(child => child.rule === 'Handler'),
    )
    .filter((handler): handler is Node => {
      const name = handler?.children?.find(c => c.rule === 'MessageName');
      return words(name ?? { kind: 'node' }).join('') === 'click';
    });
  // A Script that already tells buttons apart has seen the difference.
  const head = (handler: Node) =>
    words({
      kind: 'node',
      children: handler.children?.filter(c => c.rule !== 'Block'),
    });
  if (clauses.some(handler => head(handler).includes('button'))) {
    return [];
  }
  return clauses
    .filter(handler => !head(handler).includes('where'))
    .map(handler => {
      const name = handler.children!.find(c => c.rule === 'MessageName')!;
      const word = name.children![0]!.children![0]!;
      const bare = !handler.children!.some(c => c.rule === 'Pattern');
      return {
        code: bare ? 'click without its map' : 'click any button',
        message: bare
          ? `A click carries a map, so a Handler without a parameter never runs on one; write \`on click ${PRIMARY_CLICK}\`.`
          : `This Handler also runs on middle and right clicks; write \`on click ${PRIMARY_CLICK}\` to keep it to the primary button.`,
        range: rangeAt(source, word.pos!, word.end!),
        severity: bare ? 2 : 3,
        source: 'folio',
      };
    });
};
