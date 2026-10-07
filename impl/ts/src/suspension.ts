// Chapter 5's load-time rules for Suspension Points: which Handlers may
// suspend, inferred over the call graph to a fixpoint; `and wait` written
// exactly on a Command Call to a Handler that may; and no Suspension Point
// in a `finally` block, a named function, or a Handler called function-style.
import { recoveryBody } from './recovery';
import type { Report } from './control';
import type {
  Binding,
  SemanticElement,
  SemanticName,
  SemanticNode,
  SemanticToken,
} from './semantic';

type Leaf = SemanticName | SemanticToken;
const isLeaf = (e: SemanticElement | undefined): e is Leaf =>
  e?.kind === 'name' || e?.kind === 'token';
const word = (e: SemanticElement | undefined, text: string) =>
  e?.kind === 'token' && e.type === 'word' && e.text === text;
const has = (n: SemanticNode, rule: string) =>
  n.children.some(c => c.kind === 'node' && c.rule === rule);
const firstLeaf = (e: SemanticElement): Leaf => {
  let current = e;
  while (!isLeaf(current)) {
    current = current.children[0]!;
  }
  return current;
};

type Facts = {
  /** Calls to a named function or, function-style, to a Handler. */
  calls: { binding: Binding; name: SemanticName; restricted: boolean }[];
  /** Command Calls to a Handler, with or without `and wait`. */
  commands: {
    binding: Binding;
    name: SemanticName;
    restricted: boolean;
    wait: boolean;
  }[];
  /** Its own possible Suspension Points. */
  points: Leaf[];
};
type Body = {
  facts: Facts;
  kind: 'handler' | 'function' | 'lambda';
  name: string;
};

/** Whether each imported Handler may suspend, by `library:name`. */
export type ImportedSuspension = (binding: Binding) => boolean;

// A body's facts, without the Lambdas inside it, which are bodies of their own.
const factsOf = (
  root: SemanticNode,
  report: Report,
  lambdas: SemanticNode[],
): Facts => {
  const facts: Facts = { commands: [], calls: [], points: [] };
  const work: { cleanup: boolean; node: SemanticNode }[] =
    root.children.flatMap(c =>
      c.kind === 'node' ? [{ node: c, cleanup: false }] : [],
    );
  while (work.length) {
    const { node, cleanup } = work.pop()!;
    if (node.rule === 'Lambda') {
      lambdas.push(node);
      continue;
    }
    const point = (leaf: Leaf) => {
      facts.points.push(leaf);
      if (cleanup) {
        report("can't suspend here", leaf);
      }
    };
    const waits = has(node, 'AndWait');
    switch (node.rule) {
      case 'Wait':
        point(firstLeaf(node));
        break;
      case 'Send':
      case 'AskTell':
      case 'OperationLine':
        if (waits) {
          point(firstLeaf(node));
        }
        break;
      case 'SimpleStatement': {
        const [head] = node.children;
        if (head?.kind === 'name' && head.text === 'say') {
          if (waits) {
            report('needless and wait', head);
          }
        } else if (head?.kind === 'name') {
          const binding = head.binding;
          if (binding?.kind === 'handler') {
            facts.commands.push({
              binding,
              name: head,
              wait: waits,
              restricted: cleanup,
            });
            if (waits && cleanup) {
              report("can't suspend here", head);
            }
          } else if (waits) {
            // No Handler: the message climbs the Message Path and waits.
            point(head);
          }
        } else if (head?.kind === 'node' && head.rule === 'Call' && waits) {
          // `f(x) and wait` on a Function Value may suspend.
          point(firstLeaf(head));
        }
        break;
      }
      case 'Call': {
        const [name] = node.children;
        if (
          name?.kind === 'name' &&
          (name.binding?.kind === 'function' ||
            name.binding?.kind === 'handler')
        ) {
          facts.calls.push({
            binding: name.binding,
            name,
            restricted: cleanup,
          });
        }
        break;
      }
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i]!;
      if (child.kind === 'node') {
        // A `finally` block may hold no Suspension Point (chapter 6).
        const inFinally =
          cleanup ||
          word(node.children[i - 1], 'finally') ||
          recoveryBody(node, i);
        work.push({ node: child, cleanup: inFinally });
      }
    }
  }
  return facts;
};

/**
 * Check a unit's Suspension Points, and give whether each of its Handlers
 * may suspend, by name, for the Libraries that export them.
 */
export const checkSuspension = (
  root: SemanticNode,
  imported: ImportedSuspension,
  reportTo: Report,
): Map<string, boolean> => {
  // Each site is reported once, whichever rule finds it first.
  const seen = new Set<Leaf>();
  const report: Report = (code, at) => {
    if (!seen.has(at)) {
      seen.add(at);
      reportTo(code, at);
    }
  };
  const bodies: Body[] = [];
  const lambdas: SemanticNode[] = [];
  for (const decl of root.children) {
    if (decl.kind !== 'node') {
      continue;
    }
    for (const node of decl.children) {
      if (node.kind !== 'node') {
        continue;
      }
      if (node.rule === 'Handler' || node.rule === 'Function') {
        const named = node.children.find(
          (c): c is SemanticNode =>
            c.kind === 'node' &&
            (c.rule === 'MessageName' || c.rule === 'Name'),
        );
        bodies.push({
          kind: node.rule === 'Handler' ? 'handler' : 'function',
          // A Fallback Handler has no MessageName (ADR 0064).
          name: named
            ? firstLeaf(named).text
            : node.rule === 'Handler'
              ? 'any message'
              : '',
          facts: factsOf(node, report, lambdas),
        });
      }
    }
  }
  while (lambdas.length) {
    bodies.push({
      kind: 'lambda',
      name: '',
      facts: factsOf(lambdas.pop()!, report, lambdas),
    });
  }
  // Which local Handlers may suspend: a fixpoint over `and wait` calls.
  const may = new Map<string, boolean>();
  for (const b of bodies) {
    if (b.kind === 'handler') {
      may.set(b.name, (may.get(b.name) ?? false) || b.facts.points.length > 0);
    }
  }
  const maySuspend = (binding: Binding) =>
    binding.importedFrom ? imported(binding) : (may.get(binding.name) ?? false);
  for (let changed = true; changed;) {
    changed = false;
    for (const b of bodies) {
      if (
        b.kind === 'handler' &&
        !may.get(b.name) &&
        b.facts.commands.some(c => c.wait && maySuspend(c.binding))
      ) {
        may.set(b.name, true);
        changed = true;
      }
    }
  }
  // Which functions reach a Suspension Point, through what they call.
  const reaches = new Map<string, boolean>();
  const reach = (b: Body) =>
    b.facts.points.length > 0 ||
    b.facts.commands.some(c => c.wait && maySuspend(c.binding));
  for (const b of bodies) {
    if (b.kind === 'function') {
      reaches.set(b.name, reach(b));
    }
  }
  const reached = (binding: Binding) =>
    binding.kind === 'handler'
      ? maySuspend(binding)
      : !binding.importedFrom && (reaches.get(binding.name) ?? false);
  for (let changed = true; changed;) {
    changed = false;
    for (const b of bodies) {
      if (
        b.kind === 'function' &&
        !reaches.get(b.name) &&
        b.facts.calls.some(c => reached(c.binding))
      ) {
        reaches.set(b.name, true);
        changed = true;
      }
    }
  }
  for (const b of bodies) {
    for (const c of b.facts.commands) {
      if (c.restricted && maySuspend(c.binding)) {
        report("can't suspend here", c.name);
      }
      if (!c.wait && maySuspend(c.binding)) {
        report('missing and wait', c.name);
      } else if (c.wait && !maySuspend(c.binding)) {
        report('needless and wait', c.name);
      } else if (c.wait && (b.kind === 'function' || c.restricted)) {
        report("can't suspend here", c.name);
      }
    }
    if (b.kind === 'function') {
      for (const p of b.facts.points) {
        report("can't suspend here", p);
      }
    }
    for (const c of b.facts.calls) {
      if (
        (c.binding.kind === 'handler' && maySuspend(c.binding)) ||
        ((b.kind === 'function' || c.restricted) && reached(c.binding))
      ) {
        report("can't suspend here", c.name);
      }
    }
  }
  return may;
};
