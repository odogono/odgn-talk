// Format 4 to 5 (ADR 0145): `click` now carries a map, so a Handler with no
// parameters would never match one. Each `on click` becomes
// `on click {button: 0}`, which keeps it to the primary button as before,
// and each argument-free `click` a Script sends gains the same map.
import { parseSource } from '@northtalk/ts';
import { PRIMARY_CLICK as PRIMARY } from './pointer';

type Node = {
  children?: readonly Node[];
  end?: number;
  kind: string;
  pos?: number;
  rule?: string;
  v?: string;
};

const child = (node: Node, rule: string) =>
  node.children?.find(c => c.rule === rule);

const namesClick = (name: Node) =>
  child(name, 'Name')?.children?.[0]?.v === 'click';

/**
 * Rewrites one Script's `click` Handlers and sends. A Script that doesn't
 * parse is returned unchanged, as is a send whose name is computed.
 */
export const migrateClickSource = (source: string): string => {
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
  const inserts: { at: number; text: string }[] = [];
  const visit = (node: Node) => {
    const name = child(node, 'MessageName') as
      (Node & { end: number }) | undefined;
    if (node.rule === 'Handler' && name && namesClick(name)) {
      if (!child(node, 'Pattern')) {
        inserts.push({ at: name.end, text: ` ${PRIMARY}` });
      }
    } else if (node.rule === 'Send' && name && namesClick(name)) {
      const targetFirst = node.children!.some(c => c.v === ':');
      if (targetFirst && !child(node, 'ExpressionList')) {
        inserts.push({ at: name.end, text: ` ${PRIMARY}` });
      } else if (!targetFirst && !node.children!.some(c => c.v === 'with')) {
        inserts.push({ at: name.end, text: ` with ${PRIMARY}` });
      }
    } else if (
      node.rule === 'SimpleStatement' &&
      node.children?.[0]?.kind === 'token' &&
      node.children[0].v === 'click' &&
      !child(node, 'ExpressionList')
    ) {
      const word = node.children[0];
      inserts.push({ at: word.end!, text: ` ${PRIMARY}` });
    }
    for (const c of node.children ?? []) {
      if (c.kind === 'node') {
        visit(c);
      }
    }
  };
  visit(tree);
  let out = source;
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, at) + text + out.slice(at);
  }
  return out;
};

type Obj = Record<string, unknown>;

/** Applies `migrateClickSource` to every Script in parsed `project.json`. */
export const migrateClicks = (data: Obj): Obj => {
  const script = (holder: unknown, key: 'script' | 'source') => {
    if (holder && typeof holder === 'object') {
      const value = (holder as Obj)[key];
      if (typeof value === 'string') {
        (holder as Obj)[key] = migrateClickSource(value);
      }
    }
  };
  const out = structuredClone(data);
  script(out, 'script');
  for (const page of Array.isArray(out.pages) ? out.pages : []) {
    script(page, 'script');
    const elements = (page as Obj | null)?.elements;
    for (const element of Array.isArray(elements) ? elements : []) {
      script(element, 'script');
    }
  }
  for (const key of ['libraries', 'testScripts']) {
    const list = out[key];
    for (const unit of Array.isArray(list) ? list : []) {
      script(unit, 'source');
    }
  }
  return out;
};
