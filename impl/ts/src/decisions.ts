// Chapter 5's Decision load checks. A small control-flow graph carries the
// fact that a path has crossed a possible Suspension Point, including loop
// back edges, catches and early exits. Preemption is never such a point.
import type { Report } from './control';
import type { SemanticElement, SemanticNode } from './semantic';
import { runTask, type Task } from './tasks';
import { viewSource, type Stmt, type Pos, type Leaf } from './view';

const firstLeaf = (element: SemanticElement): Leaf => {
  let current = element;
  while (current.kind === 'node') {
    current = current.children[0]!;
  }
  return current;
};

type Node = {
  edges: { after: boolean; to: number }[];
  point: boolean;
  stmt?: Stmt;
};
type Context = { errors: number[]; exit: number; join: boolean; next: number };

class Flow {
  nodes: Node[] = [];
  constructor(private readonly suspends: (s: Stmt) => boolean) {}

  node(stmt?: Stmt): number {
    const index = this.nodes.length;
    this.nodes.push({
      stmt,
      edges: [],
      point: stmt ? this.suspends(stmt) : false,
    });
    return index;
  }

  *block(body: Stmt[], next: number, context: Context): Task<number> {
    let at = next;
    for (let i = body.length - 1; i >= 0; i--) {
      at = (yield this.statement(body[i]!, at, context)) as number;
    }
    return at;
  }

  *statement(s: Stmt, next: number, context: Context): Task<number> {
    const at = this.node(s);
    const node = this.nodes[at]!;
    // Join Members do not suspend; the Join's end does.
    if (context.join) {
      node.point = false;
    }
    const edge = (to: number, after = true) => {
      if (to >= 0) {
        node.edges.push({ to, after });
      }
    };
    for (const to of context.errors) {
      edge(to, false);
      if (
        s.k === 'ask' ||
        s.k === 'send' ||
        s.k === 'call' ||
        s.k === 'command'
      ) {
        edge(to, true);
      }
    }
    switch (s.k) {
      case 'return':
      case 'veto':
      case 'pass':
      case 'throw':
        break;
      case 'exit':
        edge(context.exit);
        break;
      case 'next':
        edge(context.next);
        break;
      case 'if':
        for (const arm of s.arms) {
          edge((yield this.block(arm.body, next, context)) as number);
        }
        edge(
          s.else ? ((yield this.block(s.else, next, context)) as number) : next,
        );
        break;
      case 'match':
        for (const branch of s.branches) {
          edge((yield this.block(branch.body, next, context)) as number);
        }
        edge(
          s.else ? ((yield this.block(s.else, next, context)) as number) : next,
        );
        break;
      case 'repeat':
        edge(next);
        edge(
          (yield this.block(s.body, at, {
            ...context,
            exit: next,
            next: at,
          })) as number,
        );
        break;
      case 'try': {
        const fin = s.finally
          ? ((yield this.block(s.finally, next, context)) as number)
          : next;
        const forwarding = this.node();
        this.nodes[forwarding]!.edges = context.errors.map(to => ({
          to,
          after: false,
        }));
        const exceptional = s.finally
          ? ((yield this.block(s.finally, forwarding, context)) as number)
          : forwarding;
        const catches: number[] = [];
        for (const c of s.catches) {
          catches.push(
            (yield this.block(c.body, fin, {
              ...context,
              errors: [exceptional],
            })) as number,
          );
        }
        edge(
          (yield this.block(s.body, fin, {
            ...context,
            errors: [...catches, exceptional],
          })) as number,
        );
        break;
      }
      case 'join': {
        const end = this.node();
        this.nodes[end]!.point = true;
        this.nodes[end]!.edges.push({ to: next, after: true });
        for (const to of context.errors) {
          this.nodes[end]!.edges.push({ to, after: true });
        }
        edge(
          (yield this.block(s.body, end, { ...context, join: true })) as number,
        );
        break;
      }
      case 'wait-block':
        for (const b of s.branches) {
          edge((yield this.block(b.body, next, context)) as number);
        }
        break;
      default:
        edge(next);
    }
    return at;
  }

  afterSuspension(body: Stmt[]): Stmt[] {
    const start = runTask(
      this.block(body, -1, { errors: [], exit: -1, next: -1, join: false }),
    );
    const pending: [number, boolean][] = [[start, false]];
    const seen = new Set<string>();
    const found = new Set<Stmt>();
    while (pending.length) {
      const [at, suspended] = pending.pop()!;
      if (at < 0 || seen.has(`${at}:${suspended}`)) {
        continue;
      }
      seen.add(`${at}:${suspended}`);
      const node = this.nodes[at]!;
      if (suspended && (node.stmt?.k === 'veto' || node.stmt?.k === 'pass')) {
        found.add(node.stmt);
      }
      for (const e of node.edges) {
        pending.push([e.to, suspended || (e.after && node.point)]);
      }
    }
    return [...found];
  }
}

const decisionFacts = (root: SemanticNode) => {
  const leaves = new Map<string, Leaf>();
  const called = new Set<string>();
  const vetoes: { deciding: boolean; handler: string | null; leaf: Leaf }[] =
    [];
  const work: {
    deciding: boolean;
    element: SemanticElement;
    handler: string | null;
  }[] = [{ element: root, deciding: false, handler: null }];
  while (work.length) {
    const { element, ...context } = work.pop()!;
    let { deciding, handler } = context;
    if (element.kind !== 'node') {
      leaves.set(`${element.span.line}:${element.span.col}`, element);
      continue;
    }
    if (element.rule === 'Handler') {
      deciding = element.children.some(
        c => c.kind === 'token' && c.text === 'deciding',
      );
      const named = element.children.find(
        c => c.kind === 'node' && c.rule === 'MessageName',
      );
      handler = named?.kind === 'node' ? firstLeaf(named).text : null;
    } else if (element.rule === 'Lambda' || element.rule === 'Function') {
      deciding = false;
      handler = null;
    }
    if (element.rule === 'SimpleStatement') {
      const head = element.children[0];
      if (head?.kind === 'token' && head.text === 'veto') {
        vetoes.push({ deciding, handler, leaf: head });
      }
      if (
        head?.kind === 'name' &&
        head.binding?.kind === 'handler' &&
        (!head.binding.importedFrom ||
          head.binding.importedFrom.library.startsWith('@'))
      ) {
        called.add(head.binding.name);
      }
    }
    if (element.rule === 'Call') {
      const head = element.children[0];
      if (
        head?.kind === 'name' &&
        head.binding?.kind === 'handler' &&
        (!head.binding.importedFrom ||
          head.binding.importedFrom.library.startsWith('@'))
      ) {
        called.add(head.binding.name);
      }
    }
    for (const child of element.children) {
      work.push({ element: child, deciding, handler });
    }
  }
  return { leaves, called, vetoes };
};

/** Validate local Handler calls across all of a Script's unchanged code units. */
export const checkDecisionCalls = (
  units: readonly { report: Report; root: SemanticNode }[],
) => {
  const facts = units.map(unit => ({
    ...decisionFacts(unit.root),
    report: unit.report,
  }));
  const called = new Set(facts.flatMap(f => [...f.called]));
  for (const unit of facts) {
    for (const v of unit.vetoes) {
      if (!v.deciding || (v.handler && called.has(v.handler))) {
        unit.report('veto outside a decision', v.leaf);
      }
    }
  }
};

export const checkDecisions = (
  root: SemanticNode,
  maySuspend: (
    binding: NonNullable<import('./semantic').SemanticName['binding']>,
  ) => boolean,
  report: Report,
): void => {
  checkDecisionCalls([{ root, report }]);
  const { leaves } = decisionFacts(root);
  const leafAt = (p: Pos) => leaves.get(`${p.line}:${p.col}`)!;
  for (const decl of viewSource(root)) {
    if (decl.k !== 'handler' || !decl.deciding) {
      continue;
    }
    const flow = new Flow(s => {
      switch (s.k) {
        case 'wait':
        case 'wait-for':
        case 'wait-block':
          return true;
        case 'ask':
        case 'send':
          return s.wait;
        case 'command':
          return (
            s.wait &&
            (!s.name.binding ||
              s.name.binding.kind !== 'handler' ||
              maySuspend(s.name.binding))
          );
        case 'call':
          return s.wait;
        default:
          return false;
      }
    });
    for (const s of flow.afterSuspension(decl.body)) {
      report('after a suspension', leafAt(s.pos));
    }
  }
};
