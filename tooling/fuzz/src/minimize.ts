import {
  parseSource,
  type SyntaxElement,
  type SyntaxNode,
} from '@odgn/northtalk';
import { regenerate } from './generator';
import {
  signatureKey,
  type Finding,
  type FuzzCase,
  type Signature,
} from './model';

const walk = (tree: SyntaxElement): SyntaxElement[] => [
  tree,
  ...(tree.kind === 'node' ? tree.children.flatMap(walk) : []),
];
const size = (c: FuzzCase): number[] => {
  const source = c.setup.scripts!.map(s => s.text ?? '').join('\n');
  const tokens =
    source.match(/[\p{L}_][\p{L}\p{N}_]*|\d+|[^\s]/gu)?.length ?? 0;
  const magnitudes = [...source.matchAll(/\b\d+\b/g)].reduce(
    (n, m) => n + Number(m[0]),
    0,
  );
  return [c.inputs.length, tokens, magnitudes, source.length];
};
const smaller = (a: FuzzCase, b: FuzzCase) => {
  const x = size(a),
    y = size(b);
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) {
      return x[i]! < y[i]!;
    }
  }
  return false;
};
const deletable = new Set([
  'Handler',
  'Function',
  'Declaration',
  'Statement',
  'StatementLine',
  'If',
  'Repeat',
  'Try',
  'Put',
  'Add',
  'Return',
  'Ask',
  'Send',
  'Wait',
]);
const deletions = (source: string): { end: number; start: number }[] => {
  const parsed = parseSource(source);
  if (!parsed.tree) {
    return [];
  }
  return walk(parsed.tree)
    .filter((n): n is SyntaxNode => n.kind === 'node' && deletable.has(n.rule))
    .map(n => ({ start: n.start, end: n.end }))
    .sort((a, b) => b.end - b.start - (a.end - a.start));
};
export type Reduction = {
  attempts: number;
  case: FuzzCase;
  exhausted: boolean;
  stages: ('choices' | 'concrete')[];
};
export const minimize = async (
  initial: FuzzCase,
  signature: Signature,
  evaluate: (c: FuzzCase, remainingMs: number) => Promise<Finding[]>,
  { budgetMs = 300_000 }: { budgetMs?: number } = {},
): Promise<Reduction> => {
  const deadline = performance.now() + budgetMs;
  let best = structuredClone(initial);
  let attempts = 0;
  const stages: Reduction['stages'] = [];
  const expired = () => performance.now() >= deadline;
  const attempt = async (candidate: FuzzCase) => {
    if (expired() || !smaller(candidate, best)) {
      return false;
    }
    attempts++;
    try {
      const found = await evaluate(
        candidate,
        Math.max(1, deadline - performance.now()),
      );
      // Only the first finding counts: no wandering through an easier preceding failure.
      if (
        found[0] &&
        signatureKey(found[0].signature) === signatureKey(signature)
      ) {
        best = candidate;
        return true;
      }
    } catch {
      // A missing Stub/invalid Host reference is an invalid candidate, never a reduction win.
    }
    return false;
  };
  const reduceInputs = async (choices: boolean) => {
    let width = Math.ceil(best.inputs.length / 2);
    while (width >= 1 && !expired()) {
      let changed = false;
      for (
        let start = 0;
        start < best.inputs.length && !expired();
        start += width
      ) {
        const c = structuredClone(best);
        if (choices) {
          c.choices.inputs.splice(start, width);
          if (await attempt(regenerate(c))) {
            changed = true;
            break;
          }
        } else {
          c.inputs.splice(start, width);
          if (await attempt(c)) {
            changed = true;
            break;
          }
        }
      }
      if (!changed) {
        width = width === 1 ? 0 : Math.ceil(width / 2);
      }
    }
  };
  stages.push('choices');
  if (initial.generator === 'scheduler-1' && !initial.mutation) {
    await reduceInputs(true);
    for (let s = 0; s < best.choices.scripts.length && !expired(); s++) {
      for (
        let h = 0;
        h < best.choices.scripts[s]!.handlers.length && !expired();
      ) {
        const c = structuredClone(best);
        c.choices.scripts[s]!.handlers.splice(h, 1);
        if (await attempt(regenerate(c))) {
          continue;
        }
        const simpler = structuredClone(best);
        simpler.choices.scripts[s]!.handlers[h]!.value = 1;
        simpler.choices.scripts[s]!.handlers[h]!.repetitions = 1;
        await attempt(regenerate(simpler));
        h++;
      }
    }
  }
  stages.push('concrete');
  let changed = true;
  while (changed && !expired()) {
    const previous = JSON.stringify(best);
    await reduceInputs(false);
    for (const [i, script] of best.setup.scripts!.entries()) {
      if (expired()) {
        break;
      }
      const source = script.text ?? '';
      for (const span of deletions(source)) {
        const c = structuredClone(best);
        c.setup.scripts![i]!.text =
          source.slice(0, span.start) + source.slice(span.end);
        if (await attempt(c)) {
          break;
        }
      }
      for (const match of source.matchAll(/\b\d+\b/g)) {
        const c = structuredClone(best);
        c.setup.scripts![i]!.text =
          source.slice(0, match.index) +
          '0' +
          source.slice(match.index + match[0].length);
        if (await attempt(c)) {
          break;
        }
      }
    }
    changed = JSON.stringify(best) !== previous;
  }
  return { case: best, exhausted: expired(), attempts, stages };
};
