// The messages a Script answers, as its Handler Clause heads, for Info
// (#2059): with Clause Shapes (ADR 0171) a head says what each message takes.
import {
  parseSourceRecovering,
  type SyntaxElement,
  type SyntaxNode,
} from '@northtalk/ts';

const cache = new Map<string, string[]>();

/** Each named Handler Clause's head, `on move item is a Line`, in order. */
export const scriptMessages = (source: string | undefined): string[] => {
  if (!source?.trim()) {
    return [];
  }
  const known = cache.get(source);
  if (known) {
    return known;
  }
  const heads: string[] = [];
  const visit = (node: SyntaxElement) => {
    if (node.kind !== 'node') {
      return;
    }
    if (node.rule === 'Handler') {
      heads.push(head(source, node));
      return;
    }
    node.children.forEach(visit);
  };
  try {
    visit(parseSourceRecovering(source).tree);
  } catch {
    return [];
  }
  const named = heads.filter(h => !/^on\s+any\s+message\b/u.test(h));
  if (cache.size > 64) {
    cache.clear();
  }
  cache.set(source, named);
  return named;
};

// A head ends at its line's end, its Guard or its first suffix.
const head = (source: string, node: SyntaxNode) => {
  let end = node.end;
  for (const child of node.children) {
    if (
      child.kind === 'token' &&
      (child.t === 'nl' || child.v === 'where' || child.v === ',')
    ) {
      end = child.pos;
      break;
    }
  }
  return source.slice(node.start, end).trim();
};
