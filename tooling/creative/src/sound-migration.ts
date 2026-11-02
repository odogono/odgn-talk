// Format 6 to 7 (ADR 0159, #1896): `tell sound to loop` now loops a Sound
// Pattern in Mini-Notation on the bar. It used to repeat a whole Project
// sound end to end, which is now `play … with {repeat: true}`, so each older
// `loop` of the `sound` Grant is rewritten to that.
import { parseSource } from '@northtalk/ts';

type Node = {
  children?: readonly Node[];
  end?: number;
  kind: string;
  pos?: number;
  rule?: string;
  v?: string;
};

const REPEAT = ' with {repeat: true}';

const tokens = (node: Node): Node[] =>
  node.kind === 'token' ? [node] : (node.children ?? []).flatMap(tokens);

const namesSound = (node: Node | undefined) =>
  node !== undefined &&
  tokens(node)
    .map(t => t.v)
    .join('') === 'sound';

const lastEnd = (node: Node): number | undefined => tokens(node).at(-1)?.end;

/**
 * Rewrites one Script's `tell sound to loop x` calls, and `loop x` lines of
 * `tell sound` blocks, to `play x with {repeat: true}`. A Script that doesn't
 * parse is returned unchanged.
 */
export const migrateSoundSource = (source: string): string => {
  let tree: Node | null;
  try {
    const parsed = parseSource(source);
    tree = parsed.error ? null : (parsed.tree as unknown as Node | null);
  } catch {
    return source;
  }
  if (!tree) {
    return source;
  }
  const edits: { from: number; text: string; to: number }[] = [];
  // `operation` is the `loop` token; `list` its one-argument list.
  const rewrite = (operation: Node | undefined, list: Node | undefined) => {
    const end = list && lastEnd(list);
    if (
      operation?.v !== 'loop' ||
      operation.pos === undefined ||
      end === undefined ||
      list!.children?.filter(c => c.rule === 'Expression').length !== 1
    ) {
      return;
    }
    edits.push(
      { from: operation.pos, to: operation.end!, text: 'play' },
      { from: end, to: end, text: REPEAT },
    );
  };
  const listOf = (node: Node) =>
    node.children?.find(c => c.rule === 'ExpressionList');
  const visit = (node: Node) => {
    const [head, target, , operation] = node.children ?? [];
    if (node.rule === 'AskTell' && head?.v === 'tell' && namesSound(target)) {
      rewrite(operation, listOf(node));
    } else if (node.rule === 'TellBlock' && namesSound(target)) {
      for (const line of node.children ?? []) {
        if (line.rule === 'OperationLine') {
          rewrite(line.children?.[0], listOf(line));
        }
      }
    }
    for (const c of node.children ?? []) {
      if (c.kind === 'node') {
        visit(c);
      }
    }
  };
  visit(tree);
  let out = source;
  for (const { from, to, text } of edits.sort((a, b) => b.from - a.from)) {
    out = out.slice(0, from) + text + out.slice(to);
  }
  return out;
};

type Obj = Record<string, unknown>;

/** Applies `migrateSoundSource` to every Script in parsed `project.json`. */
export const migrateSounds = (data: Obj): Obj => {
  const script = (holder: unknown, key: 'script' | 'source') => {
    if (holder && typeof holder === 'object') {
      const value = (holder as Obj)[key];
      if (typeof value === 'string') {
        (holder as Obj)[key] = migrateSoundSource(value);
      }
    }
  };
  const elements = (list: unknown) => {
    for (const element of Array.isArray(list) ? list : []) {
      script(element, 'script');
      elements((element as Obj | null)?.members);
    }
  };
  const out = structuredClone(data);
  script(out, 'script');
  for (const page of Array.isArray(out.pages) ? out.pages : []) {
    script(page, 'script');
    elements((page as Obj | null)?.elements);
  }
  for (const key of ['libraries', 'testScripts']) {
    const list = out[key];
    for (const unit of Array.isArray(list) ? list : []) {
      script(unit, 'source');
    }
  }
  return out;
};
