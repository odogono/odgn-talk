// Advice over the Core's recovered bindings. Never execute Script or Host code.
import type {
  SemanticElement,
  SemanticName,
  SemanticNode,
  SemanticTree,
  SourceSpan,
} from '@odgn/northtalk';
import { builtins, properties } from './generated/lints';
import type { LintId } from './lint';
import type { HostManifest } from './lsp/manifest';

type Emit = (
  id: LintId,
  span: SourceSpan,
  params?: Record<string, string | number>,
) => void;
const nodes = (node: SemanticNode) =>
  node.children.filter((e): e is SemanticNode => e.kind === 'node');
const leaves = (node: SemanticNode) =>
  node.children.filter(e => e.kind !== 'node');
const child = (node: SemanticNode, rule: SemanticNode['rule']) =>
  nodes(node).find(e => e.rule === rule);
const boundary = (node: SemanticNode) =>
  ['Handler', 'Function', 'Lambda'].includes(node.rule);
const elements = (
  root: SemanticNode,
  enterBodies = false,
): SemanticElement[] => {
  const out: SemanticElement[] = [];
  const work: SemanticElement[] = [root];
  while (work.length) {
    const e = work.pop()!;
    out.push(e);
    if (e.kind === 'node' && (enterBodies || !boundary(e))) {
      for (let i = e.children.length - 1; i >= 0; i--) {
        work.push(e.children[i]!);
      }
    }
  }
  return out;
};
const first = (node: SemanticNode) => {
  let e: SemanticElement = node;
  while (e.kind === 'node' && e.children.length) {
    e = e.children[0]!;
  }
  return e.kind === 'node' ? undefined : e;
};
const unwrap = (root: SemanticNode): SemanticElement => {
  let e: SemanticElement = root;
  const wrappers = new Set([
    'Expression',
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
    'ChunkLevel',
    'Postfix',
    'Primary',
    'Name',
    'Container',
  ]);
  while (e.kind === 'node' && wrappers.has(e.rule)) {
    const content: SemanticElement[] = e.children.filter(
      c => c.kind !== 'token' || !['(', ')'].includes(c.text),
    );
    if (content.length !== 1) {
      break;
    }
    e = content[0]!;
  }
  return e;
};
// A node's tokens and names, in source order, bodies included.
const words = (node: SemanticNode) =>
  elements(node, true).filter(
    (x): x is Exclude<SemanticElement, SemanticNode> => x.kind !== 'node',
  );
const message = (node: SemanticNode) => {
  const name = child(node, 'MessageName');
  return name && first(name);
};
const propertyNames = new Set<string>(properties);

type Pattern =
  | { kind: 'any' }
  | { kind: 'literal'; signature: string }
  | { items: Pattern[]; kind: 'list'; rest: boolean }
  | { entries: Map<string, Pattern>; kind: 'map' }
  | { kind: 'opaque' };
const any: Pattern = { kind: 'any' };
const opaque: Pattern = { kind: 'opaque' };

// Only prove coverage for names/wildcards, literal patterns and structural
// lists/maps. Pins and Text/Binary Patterns depend on values or matcher rules.
const patternIndex = (order: SemanticElement[]) => {
  const patterns = new Map<SemanticNode, Pattern>();
  for (const e of [...order].reverse()) {
    if (e.kind !== 'node') {
      continue;
    }
    if (e.rule === 'Pattern') {
      patterns.set(e, patterns.get(child(e, 'PatternPrimary')!) ?? opaque);
    } else if (e.rule === 'PatternPrimary') {
      const head = first(e);
      const ps = nodes(e).filter(n => n.rule === 'Pattern');
      if (
        e.children.length === 1 &&
        (head?.kind === 'name' || head?.text === '_')
      ) {
        patterns.set(e, any);
      } else if (head?.text === '[') {
        patterns.set(e, {
          kind: 'list',
          items: ps.map(p => patterns.get(p) ?? opaque),
          rest: leaves(e).some(t => t.text === '...'),
        });
      } else if (head?.text === '{') {
        const entries = new Map<string, Pattern>();
        for (let i = 0; i < e.children.length; i++) {
          const item = e.children[i]!;
          if (item.kind === 'node' && item.rule === 'MapKey') {
            const value = e.children[i + 1];
            entries.set(
              first(item)!.text,
              value?.kind === 'node' ? (patterns.get(value) ?? opaque) : opaque,
            );
          } else if (item.kind === 'node' && item.rule === 'Name') {
            entries.set(first(item)!.text, any);
          }
        }
        patterns.set(e, { kind: 'map', entries });
      } else {
        const content = elements(e).filter(c => c.kind !== 'node');
        if (
          content.every(c => c.kind === 'token') &&
          content.length &&
          head?.kind === 'token' &&
          (['str', 'num'].includes(head.type) ||
            ['-', 'true', 'false', 'nothing'].includes(head.text))
        ) {
          patterns.set(e, {
            kind: 'literal',
            signature: JSON.stringify(
              content.map(c => [c.kind === 'token' ? c.type : c.kind, c.text]),
            ),
          });
        } else {
          patterns.set(e, opaque);
        }
      }
    }
  }
  return patterns;
};
const covers = (earlier: Pattern, later: Pattern): boolean => {
  const work: [Pattern, Pattern][] = [[earlier, later]];
  while (work.length) {
    const [a, b] = work.pop()!;
    if (a.kind === 'any') {
      continue;
    }
    if (a.kind === 'opaque' || a.kind !== b.kind) {
      return false;
    }
    if (a.kind === 'literal' && b.kind === 'literal') {
      if (a.signature !== b.signature) {
        return false;
      }
    } else if (a.kind === 'list' && b.kind === 'list') {
      if (
        a.rest
          ? b.items.length < a.items.length
          : b.rest || b.items.length !== a.items.length
      ) {
        return false;
      }
      for (let i = 0; i < a.items.length; i++) {
        work.push([a.items[i]!, b.items[i]!]);
      }
    } else if (a.kind === 'map' && b.kind === 'map') {
      for (const [key, value] of a.entries) {
        const other = b.entries.get(key);
        if (!other) {
          return false;
        }
        work.push([value, other]);
      }
    }
  }
  return true;
};

type KeyRead = { at: SourceSpan; base: SemanticNode; key: string | null };
const keyRead = (root: SemanticNode): KeyRead | undefined => {
  const e = unwrap(root);
  if (e.kind !== 'node') {
    return;
  }
  if (e.rule === 'The') {
    const direct = leaves(e);
    const base = nodes(e).at(-1);
    if (!base || !direct.some(t => t.text === 'of')) {
      return;
    }
    const keyNode = child(e, 'Key');
    if (
      !keyNode &&
      direct[1]?.kind === 'token' &&
      direct[1].type === 'word' &&
      direct.length > 3
    ) {
      return;
    }
    const key = keyNode ? first(keyNode) : direct[1];
    // Unquoted Built-in properties do not perform a map key lookup.
    if (
      key?.kind === 'token' &&
      key.type === 'word' &&
      propertyNames.has(key.text)
    ) {
      return;
    }
    if (key?.text === '(') {
      return { at: e.span, base, key: null };
    }
    if (key) {
      return { at: key.span, base, key: key.text };
    }
  } else if (e.rule === 'Postfix') {
    const key = nodes(e)
      .filter(n => n.rule === 'Key')
      .at(-1);
    const base = child(e, 'Primary');
    const name = key && first(key);
    if (base && name && !propertyNames.has(name.text)) {
      // A chain's final lookup has a different base; leave it unknown.
      return {
        at: name.span,
        base: nodes(e).length === 2 ? base : e,
        key: name.text,
      };
    }
  }
};
const literalKeys = (root: SemanticNode): Set<string> | undefined => {
  const value = unwrap(root);
  return value.kind === 'node' && value.rule === 'Map'
    ? new Set(
        nodes(value)
          .filter(n => n.rule === 'MapKey')
          .map(n => first(n)!.text),
      )
    : undefined;
};

const sameBinding = (a: SemanticNode, b: SemanticNode) => {
  const left = unwrap(a);
  const right = unwrap(b);
  return (
    left.kind === 'name' &&
    right.kind === 'name' &&
    left.binding !== null &&
    left.binding.id === right.binding?.id
  );
};
const presenceProofs = (
  expression: SemanticNode,
  read: KeyRead,
): SourceSpan[] => {
  const proofs: SourceSpan[] = [];
  const work: SemanticElement[] = [unwrap(expression)];
  while (work.length) {
    const e = work.pop()!;
    if (e.kind !== 'node') {
      continue;
    }
    if (e.rule === 'And') {
      work.push(...nodes(e).map(unwrap));
      continue;
    }
    if (
      e.rule !== 'Comparison' ||
      leaves(e)
        .map(t => t.text)
        .join(' ') !== 'is in'
    ) {
      continue;
    }
    const args = nodes(e).filter(n => n.rule === 'Concat');
    const key = args[0] && unwrap(args[0]);
    const collection = args[1] && unwrap(args[1]);
    if (
      key?.kind !== 'token' ||
      key.type !== 'str' ||
      key.text !== read.key ||
      collection?.kind !== 'node' ||
      collection.rule !== 'The'
    ) {
      continue;
    }
    const property = child(collection, 'Key');
    const base = child(collection, 'Postfix');
    if (
      property &&
      first(property)?.text === 'keys' &&
      base &&
      sameBinding(base, read.base)
    ) {
      proofs.push(e.span);
    }
  }
  return proofs;
};
const unchangedSince = (
  root: SemanticNode,
  read: KeyRead,
  after: number,
  before: number,
) => {
  const base = unwrap(read.base);
  if (base.kind !== 'name' || !base.binding) {
    return false;
  }
  return !elements(root).some(
    e =>
      e.span.start >= after &&
      e.span.start < before &&
      ((e.kind === 'name' &&
        e.role === 'write' &&
        e.binding?.id === base.binding!.id) ||
        (base.binding!.kind === 'script variable' &&
          ((e.kind === 'node' &&
            ['Call', 'AskTell', 'Send', 'Wait'].includes(e.rule)) ||
            (e.kind === 'name' && e.role === 'command')))),
  );
};
const atMostOnce = (node: SemanticNode) => {
  const expression = child(node, 'Expression');
  const count = expression && unwrap(expression);
  return (
    leaves(node).some(t => t.text === 'times') &&
    count?.kind === 'token' &&
    count.type === 'num' &&
    Number(count.text) <= 1
  );
};
const presenceGuard = (
  node: SemanticNode,
  read: KeyRead,
  parents: Map<SemanticElement, SemanticNode>,
): boolean => {
  let current: SemanticElement = node;
  while (parents.has(current)) {
    const parent: SemanticNode = parents.get(current)!;
    if (boundary(parent)) {
      break;
    }
    const valid = (expression: SemanticNode) =>
      presenceProofs(expression, read).some(proof => {
        if (!unchangedSince(parent, read, proof.end, node.span.start)) {
          return false;
        }
        let inside: SemanticElement = node;
        while (inside !== parent && parents.has(inside)) {
          const loop: SemanticNode = parents.get(inside)!;
          if (
            loop.rule === 'Repeat' &&
            loop.span.start >= proof.end &&
            !atMostOnce(loop) &&
            !unchangedSince(loop, read, loop.span.start, loop.span.end)
          ) {
            return false;
          }
          inside = loop;
        }
        return true;
      });
    if (parent.rule === 'And') {
      const before = parent.children.slice(0, parent.children.indexOf(current));
      if (before.some(e => e.kind === 'node' && valid(e))) {
        return true;
      }
    }
    if (parent.rule === 'If') {
      const condition = child(parent, 'Expression');
      const body = nodes(parent).find(
        e => e.rule === 'Block' || e.rule === 'SimpleStatement',
      );
      if (body === current && condition && valid(condition)) {
        return true;
      }
    }
    current = parent;
  }
  return false;
};

// Expression errors are catchable; allocation/Fuel Limit Faults are not.
// Boundaries create code values rather than execute their bodies.
const mayFail = (root: SemanticNode): boolean =>
  elements(root).some(e => {
    if (e.kind !== 'node') {
      return false;
    }
    const direct = leaves(e);
    return (
      [
        'Call',
        'The',
        'Chunk',
        'MatchSearch',
        'ReplaceExpression',
        'Send',
        'AskTell',
        'Wait',
        'BinaryBuild',
      ].includes(e.rule) ||
      (e.rule === 'Postfix' && !!child(e, 'Key')) ||
      ([
        'Conversion',
        'Unary',
        'Power',
        'Multiplicative',
        'Additive',
        'Range',
        'Concat',
        'Comparison',
        'And',
        'Or',
        'Not',
      ].includes(e.rule) &&
        direct.length > 0) ||
      (e.rule === 'Element' && direct.some(t => t.text === '...')) ||
      (e.rule === 'SimpleStatement' &&
        (first(e)?.kind === 'name' ||
          !['put', 'return', 'pass', 'veto', 'exit', 'next'].includes(
            first(e)?.text ?? '',
          )))
    );
  });

type Escape = 'run' | 'loop' | 'next' | 'throw';
type Flow = {
  canError: boolean;
  errors: Set<SemanticName>;
  escapes: Map<Escape, Set<SemanticName>>;
  live: boolean;
  writes: Set<SemanticName>;
};
const flowFrom = (writes: Iterable<SemanticName> = []): Flow => ({
  live: true,
  writes: new Set(writes),
  canError: false,
  errors: new Set(),
  escapes: new Map(),
});
const union = (sets: Iterable<SemanticName>[]) =>
  new Set(sets.flatMap(s => [...s]));
const mergeFlows = (target: Flow, branches: Flow[]) => {
  target.live = branches.some(b => b.live);
  target.writes = union(branches.filter(b => b.live).map(b => b.writes));
  target.canError ||= branches.some(b => b.canError);
  target.errors = union([target.errors, ...branches.map(b => b.errors)]);
  for (const branch of branches) {
    for (const [kind, writes] of branch.escapes) {
      target.escapes.set(kind, union([target.escapes.get(kind) ?? [], writes]));
    }
  }
};

// The work stack follows statement order without recursive syntax walks.
// Branches carry separate writes; finally runs even on an escaping path, and
// loop back edges expose writes to errors reachable on a later iteration.
const lintTry = (body: SemanticNode, emit: Emit) => {
  const work: (() => void)[] = [];
  const emitted = new Set<SemanticName>();
  const fail = (flow: Flow) => {
    flow.canError = true;
    flow.errors = union([flow.errors, flow.writes]);
    for (const write of flow.writes) {
      if (!emitted.has(write)) {
        emitted.add(write);
        emit('try-write-before-fail', write.span, { name: write.text });
      }
    }
  };
  const schedule = (node: SemanticNode, flow: Flow) =>
    work.push(() => {
      if (!flow.live || boundary(node)) {
        return;
      }
      const children = nodes(node);
      const bodies = children.filter(c =>
        ['Block', 'SimpleStatement'].includes(c.rule),
      );
      if (node.rule === 'Block' || node.rule === 'Statement') {
        for (const inner of children.reverse()) {
          schedule(inner, flow);
        }
        return;
      }
      if (node.rule === 'Try') {
        const protectedFlow = flowFrom(flow.writes);
        const finallyIndex = node.children.findIndex(
          e => e.kind === 'token' && e.text === 'finally',
        );
        const cleanup =
          finallyIndex < 0
            ? undefined
            : node.children
                .slice(finallyIndex + 1)
                .find(
                  (e): e is SemanticNode =>
                    e.kind === 'node' && e.rule === 'Block',
                );
        const catches = bodies.slice(1).filter(b => b !== cleanup);
        const finish = () => {
          if (!cleanup) {
            return;
          }
          const wasLive = flow.live;
          const normalWrites = new Set(flow.writes);
          const escapes = new Map(flow.escapes);
          const incoming = union([
            flow.writes,
            flow.errors,
            ...escapes.values(),
          ]);
          const cleanupFlow = flowFrom(incoming);
          work.push(() => {
            flow.canError ||= cleanupFlow.canError;
            flow.errors = union([flow.errors, cleanupFlow.errors]);
            flow.live = wasLive && cleanupFlow.live;
            const introduced = new Set(
              [...cleanupFlow.writes].filter(write => !incoming.has(write)),
            );
            flow.writes = union([normalWrites, introduced]);
            flow.escapes = cleanupFlow.live ? escapes : new Map();
            if (cleanupFlow.live) {
              for (const [kind, writes] of flow.escapes) {
                flow.escapes.set(kind, union([writes, introduced]));
              }
            }
            for (const [kind, writes] of cleanupFlow.escapes) {
              flow.escapes.set(
                kind,
                union([flow.escapes.get(kind) ?? [], writes]),
              );
            }
          });
          schedule(cleanup, cleanupFlow);
        };
        work.push(() => {
          const branches = [protectedFlow];
          work.push(() => {
            mergeFlows(flow, branches);
            finish();
          });
          if (protectedFlow.canError) {
            for (const catcher of [...catches].reverse()) {
              const caughtFlow = flowFrom(protectedFlow.errors);
              branches.push(caughtFlow);
              schedule(catcher, caughtFlow);
            }
          }
        });
        if (bodies[0]) {
          schedule(bodies[0], protectedFlow);
        }
        return;
      }
      if (['If', 'Match', 'Repeat'].includes(node.rule)) {
        const headerFails = children
          .filter(
            c => !['Block', 'SimpleStatement', 'Pattern'].includes(c.rule),
          )
          .some(mayFail);
        if (headerFails) {
          fail(flow);
        }
        const branches = bodies.map(() => flowFrom(flow.writes));
        const skipped = flowFrom(flow.writes);
        if (node.rule === 'Repeat') {
          const once = atMostOnce(node);
          work.push(() => {
            for (const branch of branches) {
              const next = branch.escapes.get('next');
              const back = union([
                branch.live ? branch.writes : [],
                next ?? [],
              ]);
              if (!once && (branch.canError || headerFails) && back.size) {
                fail(flowFrom(back));
              }
              const breaks = branch.escapes.get('loop');
              // A loop transfer reaches the loop's next iteration or successor,
              // while a Run exit remains escaping for an enclosing finally.
              if (next || breaks) {
                branches.push(flowFrom(union([next ?? [], breaks ?? []])));
              }
              branch.escapes.delete('next');
              branch.escapes.delete('loop');
            }
            mergeFlows(flow, [...branches, skipped]);
          });
        } else {
          if (
            node.rule !== 'If' ||
            !leaves(node).some(t => t.text === 'else')
          ) {
            branches.push(skipped);
          }
          work.push(() => mergeFlows(flow, branches));
        }
        for (let i = bodies.length - 1; i >= 0; i--) {
          schedule(bodies[i]!, branches[i]!);
        }
        return;
      }
      if (mayFail(node)) {
        fail(flow);
      }
      for (const e of elements(node)) {
        if (
          e.kind === 'name' &&
          e.role === 'write' &&
          e.binding?.kind === 'script variable'
        ) {
          flow.writes.add(e);
        }
      }
      const head = first(node)?.text;
      if (
        head &&
        ['return', 'throw', 'pass', 'veto', 'exit', 'next'].includes(head)
      ) {
        const kind: Escape =
          head === 'exit'
            ? 'loop'
            : head === 'next'
              ? 'next'
              : head === 'throw'
                ? 'throw'
                : 'run';
        flow.escapes.set(
          kind,
          union([flow.escapes.get(kind) ?? [], flow.writes]),
        );
        flow.live = false;
      }
    });
  schedule(body, flowFrom());
  while (work.length) {
    work.pop()!();
  }
};

// The hint recognizes the adjacent initialization idiom; it never rewrites
// the body. Binding identity avoids advice for a Lambda's shadowing local.
const lintCollecting = (block: SemanticNode, emit: Emit) => {
  const statements = nodes(block).filter(n => n.rule === 'Statement');
  for (let i = 1; i < statements.length; i++) {
    const loop = child(statements[i]!, 'Repeat');
    const init = child(statements[i - 1]!, 'SimpleStatement');
    if (
      !loop ||
      child(loop, 'Collecting') ||
      !init ||
      leaves(init)
        .map(t => t.text)
        .join(' ') !== 'put into'
    ) {
      continue;
    }
    const expression = child(init, 'Expression');
    const value = expression && unwrap(expression);
    const container = child(init, 'Container');
    const target = container && unwrap(container);
    if (
      value?.kind !== 'node' ||
      value.rule !== 'List' ||
      nodes(value).length ||
      target?.kind !== 'name' ||
      !target.binding ||
      !['local', 'parameter'].includes(target.binding.kind)
    ) {
      continue;
    }
    const pattern = child(loop, 'Pattern');
    if (
      pattern &&
      elements(pattern).some(
        e =>
          e.kind === 'name' &&
          e.role === 'binding' &&
          e.binding?.id === target.binding!.id,
      )
    ) {
      continue;
    }
    const body = child(loop, 'Block');
    if (
      body &&
      elements(body).some(e => {
        if (
          e.kind !== 'node' ||
          e.rule !== 'SimpleStatement' ||
          leaves(e)
            .map(t => t.text)
            .join(' ') !== 'put after'
        ) {
          return false;
        }
        const container = child(e, 'Container');
        const appended = container && unwrap(container);
        return (
          appended?.kind === 'name' &&
          appended.binding?.id === target.binding!.id
        );
      })
    ) {
      emit('suggest-collecting', first(loop)!.span, { name: target.text });
    }
  }
};

// A `get` and a later `set` of the same Store key through the same Grant,
// with the value flowing from one to the other, loses an update another
// Script makes in between (ADR 0050). Within one Handler, in source order and
// not into nested Lambdas: the read taints `it`, a `put` of a tainted
// expression taints its target, and a later `ask` replaces `it`. A key is the
// same literal text, or the same binding with no write in between.
type StoreKey = { binding?: number; text: string };
const storeCall = (node: SemanticNode) => {
  const words = leaves(node);
  const target = child(node, 'Expression');
  const grant = target && unwrap(target);
  const args = nodes(child(node, 'ExpressionList') ?? node).filter(
    n => n.rule === 'Expression',
  );
  const key = args[0] && unwrap(args[0]);
  if (
    words[0]?.text !== 'ask' ||
    child(node, 'AndWait')?.children.length ||
    grant?.kind !== 'name' ||
    grant.role !== 'grant' ||
    !key
  ) {
    return undefined;
  }
  const storeKey: StoreKey | undefined =
    key.kind === 'token' && key.type === 'str'
      ? { text: JSON.stringify(key.text) }
      : key.kind === 'name' && key.binding
        ? { binding: key.binding.id, text: key.text }
        : undefined;
  return (
    storeKey && {
      grant: grant.text,
      operation: words[2]?.text,
      key: storeKey,
      value: args[1],
    }
  );
};
const lintStoreRace = (handler: SemanticNode, emit: Emit) => {
  const body = child(handler, 'Block');
  const it = body && itOf(body);
  if (!body || it === undefined) {
    return;
  }
  const order = elements(body).filter(
    (e): e is SemanticNode | SemanticName =>
      e.kind === 'node' || e.kind === 'name',
  );
  type Read = {
    at: number;
    grant: string;
    key: StoreKey;
    tainted: Set<number>;
  };
  const reads: Read[] = [];
  const references = (root: SemanticNode, tainted: Set<number>) =>
    elements(root).some(
      e => e.kind === 'name' && e.binding !== null && tainted.has(e.binding.id),
    );
  for (const e of order) {
    if (e.kind === 'name') {
      continue;
    }
    if (
      e.rule === 'SimpleStatement' &&
      first(e)?.text === 'put' &&
      leaves(e).some(t => t.text === 'into')
    ) {
      const value = child(e, 'Expression');
      const container = child(e, 'Container');
      const target = container && unwrap(container);
      for (const read of reads) {
        if (value && references(value, read.tainted)) {
          for (const write of elements(container!)) {
            if (
              write.kind === 'name' &&
              write.role === 'write' &&
              write.binding
            ) {
              read.tainted.add(write.binding.id);
            }
          }
        } else if (target?.kind === 'name' && target.binding) {
          read.tainted.delete(target.binding.id);
        }
      }
      continue;
    }
    if (
      e.rule !== 'AskTell' &&
      !(e.rule === 'Send' && child(e, 'AndWait')?.children.length)
    ) {
      continue;
    }
    const call = e.rule === 'AskTell' ? storeCall(e) : undefined;
    if (call?.operation === 'set' && call.value) {
      for (const read of reads) {
        const sameKey =
          read.key.binding === undefined
            ? call.key.binding === undefined && read.key.text === call.key.text
            : read.key.binding === call.key.binding &&
              !elements(body).some(
                w =>
                  w.kind === 'name' &&
                  (w.role === 'write' || w.role === 'binding') &&
                  w.binding?.id === read.key.binding &&
                  w.span.start > read.at &&
                  w.span.start < e.span.start,
              );
        if (
          read.grant === call.grant &&
          sameKey &&
          references(call.value, read.tainted)
        ) {
          emit('store-race', leaves(e)[2]!.span, { key: call.key.text });
          break;
        }
      }
    }
    // An `ask` or a waiting `send` replaces `it`.
    for (const read of reads) {
      read.tainted.delete(it);
    }
    if (call?.operation === 'get') {
      reads.push({
        at: e.span.start,
        grant: call.grant,
        key: call.key,
        tainted: new Set([it]),
      });
    }
  }
};
// The binding `it` has in a Handler body, from any use of it there.
const itOf = (body: SemanticNode): number | undefined => {
  for (const e of elements(body)) {
    if (e.kind === 'name' && e.text === 'it' && e.binding) {
      return e.binding.id;
    }
  }
  return undefined;
};

export const lintBindings = (
  tree: SemanticTree,
  manifest: HostManifest | null | undefined,
  emit: Emit,
  unit: 'script' | 'library' = 'script',
) => {
  const all = elements(tree.root, true);
  const parents = new Map<SemanticElement, SemanticNode>();
  for (const e of all) {
    if (e.kind === 'node') {
      for (const c of e.children) {
        parents.set(c, e);
      }
    }
  }
  const patterns = patternIndex(all);
  const constantKeys = new Map<number, Set<string>>();
  for (const e of all) {
    if (
      e.kind !== 'node' ||
      e.rule !== 'Declaration' ||
      first(e)?.text !== 'constant'
    ) {
      continue;
    }
    const name = child(e, 'Name');
    const binding = name && first(name);
    const expression = child(e, 'Expression');
    const keys = expression && literalKeys(expression);
    if (binding?.kind === 'name' && binding.binding && keys) {
      constantKeys.set(binding.binding.id, keys);
    }
  }
  const handlers = new Map<string, SemanticNode[]>();
  for (const e of all) {
    if (e.kind === 'node' && e.rule === 'Handler') {
      const name = message(e);
      if (name) {
        handlers.set(name.text, [...(handlers.get(name.text) ?? []), e]);
      }
    }
  }
  for (const [name, clauses] of handlers) {
    const earlier: Pattern[][] = [];
    for (const clause of clauses) {
      const args = nodes(clause)
        .filter(n => n.rule === 'Pattern')
        .map(p => patterns.get(p) ?? opaque);
      if (
        earlier.some(
          ps =>
            ps.length === args.length &&
            ps.every((p, i) => covers(p, args[i]!)),
        )
      ) {
        emit('unreachable-clause', message(clause)!.span, {
          message: name.replaceAll(':', ' ').trim(),
        });
      }
      if (!leaves(clause).some(t => t.text === 'where')) {
        earlier.push(args);
      }
      if (unit === 'script' && manifest && !manifest.messages.includes(name)) {
        emit('unknown-message', message(clause)!.span, {
          message: name.replaceAll(':', ' ').trim(),
        });
      }
    }
  }
  // A Fallback clause that routes on a Selector the Script has named clauses
  // for runs only when those clauses fail (ADR 0063).
  const known = (t: SemanticElement | undefined) =>
    t?.kind === 'token' && t.type === 'str' && handlers.has(t.text)
      ? t
      : undefined;
  for (const e of all) {
    if (e.kind !== 'node' || e.rule !== 'Handler' || message(e)) {
      continue;
    }
    const head = leaves(e).map(t => t.text);
    if (head[1] !== 'any' || head[2] !== 'message') {
      continue;
    }
    const pattern = child(e, 'Pattern');
    const bound = pattern && words(pattern);
    const param = bound?.length === 1 ? bound[0]!.text : null;
    const routed: Exclude<SemanticElement, SemanticNode>[] = [];
    if (pattern && !param) {
      // `{name: "x", …}` in the head.
      const ws = words(pattern);
      ws.forEach((t, i) => {
        const k = known(ws[i + 2]);
        if (t.text === 'name' && ws[i + 1]?.text === ':' && k) {
          routed.push(k);
        }
      });
    }
    if (param) {
      // `the name of m is "x"`, either way round, in the Guard or body.
      const ws = words(e);
      const read = (j: number) =>
        ws[j]?.text === 'the' &&
        ws[j + 1]?.text === 'name' &&
        ws[j + 2]?.text === 'of' &&
        ws[j + 3]?.text === param;
      ws.forEach((t, i) => {
        if (t.text === 'is' && read(i - 4)) {
          const k = known(ws[i + 1]);
          if (k) {
            routed.push(k);
          }
        } else if (t.text === 'is' && read(i + 1)) {
          const k = known(ws[i - 1]);
          if (k) {
            routed.push(k);
          }
        }
      });
    }
    for (const t of routed) {
      emit('fallback-routes-known', t.span, {
        message: t.text.replaceAll(':', ' ').trim(),
      });
    }
  }
  const scriptNames = new Set(
    tree.scopes[0]?.bindings
      .filter(b => b.kind === 'script variable')
      .map(b => b.name),
  );
  const natives = new Map<string, string>(builtins.map(b => [b.name, b.kind]));
  const shadowed = new Set<number>();
  for (const e of all) {
    if (e.kind === 'name') {
      if (
        e.role === 'binding' &&
        scriptNames.has(e.text) &&
        (['Pattern', 'PatternPrimary', 'Field'].includes(
          parents.get(e)?.rule ?? '',
        ) ||
          (parents.get(e)?.rule === 'Name' &&
            ['Pattern', 'PatternPrimary'].includes(
              parents.get(parents.get(e)!)?.rule ?? '',
            )))
      ) {
        emit('pin-trap', e.span, { name: e.text });
      }
      const binding = e.binding;
      if (
        unit === 'script' &&
        binding?.scope === 0 &&
        binding.span?.start === e.span.start &&
        natives.has(binding.name) &&
        !shadowed.has(binding.id)
      ) {
        shadowed.add(binding.id);
        emit('shadows-builtin', e.span, {
          name: e.text,
          kind: natives.get(e.text)! === 'function' ? 'function' : 'Constant',
        });
      }
      continue;
    }
    if (e.kind !== 'node') {
      continue;
    }
    if (e.rule === 'Block') {
      lintCollecting(e, emit);
    }
    if (e.rule === 'Handler') {
      lintStoreRace(e, emit);
    }
    if (e.rule === 'Try' && leaves(e).some(t => t.text === 'catch')) {
      const body = child(e, 'Block');
      if (body) {
        lintTry(body, emit);
      }
    }
    if (e.rule === 'Send' && child(e, 'AndWait')?.children.length) {
      let ancestor = parents.get(e);
      while (ancestor && !boundary(ancestor) && ancestor.rule !== 'Wait') {
        ancestor = parents.get(ancestor);
      }
      const receiver = child(e, 'Expression');
      const name = message(e);
      const clauses = name && handlers.get(name.text);
      const join =
        ancestor?.rule === 'Wait' &&
        leaves(ancestor)
          .slice(0, 3)
          .map(t => t.text)
          .join(' ') === 'wait for all';
      if (
        join &&
        receiver &&
        unwrap(receiver).kind === 'token' &&
        (unwrap(receiver) as { text: string }).text === 'me' &&
        clauses?.length &&
        clauses.every(c =>
          leaves(c).some(t =>
            ['queued', 'dropping', 'replacing'].includes(t.text),
          ),
        )
      ) {
        emit('serialised-self-join', first(e)!.span, { message: name!.text });
      }
    }
    if (
      e.rule === 'Comparison' &&
      leaves(e)
        .map(t => t.text)
        .join(' ') === 'is empty'
    ) {
      const operand = child(e, 'Concat');
      const read = operand && keyRead(operand);
      if (!read) {
        continue;
      }
      const base = unwrap(read.base);
      if (base.kind === 'name' && base.binding?.kind === 'object') {
        continue;
      }
      if (presenceGuard(e, read, parents)) {
        continue;
      }
      let keys =
        literalKeys(read.base) ??
        (base.kind === 'name' && base.binding?.kind === 'constant'
          ? constantKeys.get(base.binding.id)
          : undefined);
      // A preceding straight-line put of a map literal establishes keys until
      // another write or a call can change the binding. Branches are unknown.
      if (!keys && base.kind === 'name' && base.binding) {
        let statement: SemanticElement = e;
        while (
          parents.get(statement) &&
          parents.get(statement)!.rule !== 'Block'
        ) {
          statement = parents.get(statement)!;
        }
        const block = parents.get(statement);
        if (block?.rule === 'Block') {
          const prior = block.children.slice(
            0,
            block.children.indexOf(statement),
          );
          for (const previous of prior.reverse()) {
            if (previous.kind !== 'node') {
              continue;
            }
            const content = elements(previous);
            const writes = content.filter(
              (c): c is SemanticName =>
                c.kind === 'name' &&
                c.role === 'write' &&
                c.binding?.id === base.binding!.id,
            );
            if (writes.length) {
              const simple = child(previous, 'SimpleStatement');
              const container = simple && child(simple, 'Container');
              const expression = simple && child(simple, 'Expression');
              if (
                first(simple ?? previous)?.text === 'put' &&
                container &&
                unwrap(container).kind === 'name' &&
                expression
              ) {
                keys = literalKeys(expression);
              }
              break;
            }
            if (
              content.some(
                c =>
                  c.kind === 'node' &&
                  ['Call', 'Send', 'AskTell', 'Wait'].includes(c.rule),
              ) ||
              content.some(c => c.kind === 'name' && c.role === 'command')
            ) {
              break;
            }
          }
        }
      }
      if (read.key === null || !keys?.has(read.key)) {
        emit('is-empty-on-missing-key', read.at, {
          key:
            read.key === null ? 'the computed key' : JSON.stringify(read.key),
        });
      }
    }
  }
};
