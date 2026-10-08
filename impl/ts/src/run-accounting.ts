import type { Value } from './values';

export type RunAncestry = {
  parentCall?: string;
  parentRun?: string;
  rootDelivery: string;
};
export type RunStarted = RunAncestry & {
  args: Value[];
  delivery?: string;
  fn?: Value;
  kind: 'run started';
  run: string;
  script: string;
  selector?: string;
};
export type RunDiscarded = RunAncestry & {
  kind: 'run discarded';
  reason: string;
  run: string;
  script: string;
};
export type RunAccounting = RunAncestry & {
  fuel: number;
  kind: 'run accounting';
  run: string;
  script: string;
  state: 'live' | 'terminal' | 'discarded';
};
export type CausalWork = {
  discardedMessages: number;
  kind: 'causal work';
  liveRuns: number;
  queuedMessages: number;
  rootDelivery: string;
};
export type AccountingReport =
  RunStarted | RunDiscarded | RunAccounting | CausalWork;

// Plain data: the snapshot graph saves this alongside Runs and queued ancestry.
export type AccountingState = {
  next: number;
  roots: Map<string, { discarded: number; reported?: string }>;
  runs: Map<
    string,
    { order: number; report: RunAccounting; reportedFuel?: number }
  >;
};
export const emptyAccounting = (): AccountingState => ({
  next: 0,
  runs: new Map(),
  roots: new Map(),
});

export const accountRoot = (state: AccountingState, root: string) => {
  if (!state.roots.has(root)) {
    state.roots.set(root, { discarded: 0 });
  }
};

export const accountingTail = (
  state: AccountingState,
  queued: ReadonlyMap<string, number>,
): AccountingReport[] => {
  const reports: AccountingReport[] = [];
  const changed = new Set<string>();
  const live = new Map<string, number>();
  for (const [id, row] of [...state.runs].sort(
    (a, b) => a[1].order - b[1].order,
  )) {
    const r = row.report;
    if (r.state === 'live') {
      live.set(r.rootDelivery, (live.get(r.rootDelivery) ?? 0) + 1);
    }
    if (row.reportedFuel !== r.fuel || r.state !== 'live') {
      reports.push({ ...r });
      changed.add(r.rootDelivery);
    }
    row.reportedFuel = r.fuel;
    if (r.state !== 'live') {
      state.runs.delete(id);
    }
  }
  for (const [root, row] of [...state.roots].sort(
    (a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)),
  )) {
    const r: CausalWork = {
      kind: 'causal work',
      rootDelivery: root,
      liveRuns: live.get(root) ?? 0,
      queuedMessages: queued.get(root) ?? 0,
      discardedMessages: row.discarded,
    };
    const key = `${r.liveRuns}/${r.queuedMessages}/${r.discardedMessages}`;
    if (row.reported !== key || changed.has(root)) {
      reports.push(r);
    }
    row.reported = key;
    if (!r.liveRuns && !r.queuedMessages) {
      state.roots.delete(root);
    }
  }
  return reports;
};
