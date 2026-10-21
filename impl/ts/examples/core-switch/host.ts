// A Host written once against the embedding interface both packages export
// (ADR 0121), given the package it runs on: ts.ts passes @northtalk/ts and
// wasm.ts @northtalk/ts/wasm. Nothing else differs.
//
// It loads a Script whose Handler waits on a suspending Operation, Pumps it
// to that wait, saves the Group, restores the save into a fresh Group, answers
// the pending call there and Pumps the Run to its end.
import type { CapabilityDef, Core, Report, Value } from '../../src/index';

const shop = `script variable ledger = []

on order sku, qty
  ask stock to price sku
  put it * qty into total
  ask stock to reserve sku, qty and wait
  put [sku, it, total] after ledger
  return it
end order
`;

/** What the Host takes from either package. */
export type NorthTalk = {
  createCore(o?: { wasm?: unknown }): Core | Promise<Core>;
  num(n: number): Value;
  shape: (typeof import('../../src/index'))['shape'];
  text(s: string): Value;
};

export type Outcome = {
  ledger: string;
  pending: number;
  result: string;
  saveBytes: number;
  trace: string[];
};

const second = 1_000_000n;
const ends = (reports: Report[]) =>
  reports.flatMap(r => (r.kind === 'run end' ? [r] : []));

export const runShop = async (
  nt: NorthTalk,
  options?: { wasm?: unknown },
): Promise<Outcome> => {
  const core = await nt.createCore(options);
  const reserved: string[] = [];
  const stock: CapabilityDef<string> = core.defineCapability<string>()(
    'stock',
    {
      price: {
        mode: 'immediate',
        args: [nt.shape.text],
        result: nt.shape.number,
        cost: { fuel: 1 },
        do: (_call, sku) => BigInt(sku.length),
      },
      reserve: {
        mode: 'suspending',
        args: [nt.shape.text, nt.shape.number],
        result: nt.shape.text,
        cost: { fuel: 2 },
        start: call => {
          reserved.push(call.id);
        },
      },
    },
  );
  const grant = stock.grant('all', 'warehouse');
  const trace: string[] = [];
  const group = core.newGroup({ name: 'shop', trace: l => trace.push(l) });
  group
    .load({ name: 'shop', source: shop, grants: { stock: grant } })
    .request({ name: 'order', args: [nt.text('apple'), nt.num(3)] });
  group.pump(1n * second);

  // The Run waits on its reservation. Save it, and carry on in a new Group.
  const save = group.save();
  const { group: restored, result } = core.restore(save, {
    name: 'shop',
    libraries: [],
    grants: () => grant,
    resolve: () => undefined,
    onMismatch: 'reject',
    trace: l => trace.push(l),
  });
  for (const call of result.pending) {
    restored.settle(call.id, { answer: nt.text(`R-${reserved.length}`) });
  }
  const finished = ends(restored.pump(2n * second).reports);
  const ledger = restored
    .inspect()
    .scripts[0]!.vars.find(([name]) => name === 'ledger')![1];
  return {
    result: finished.map(r => `${r.outcome} ${r.result}`).join(', '),
    ledger: ledger.toString(),
    pending: result.pending.length,
    saveBytes: save.length,
    trace,
  };
};
