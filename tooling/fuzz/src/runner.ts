import { createReplayHost, parseRecord } from '@odgn/northtalk/replay';
import type { Action, Execution, FuzzCase } from './model';

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const ids = (value: string | undefined) =>
  (value ?? '[]').slice(1, -1).split(', ').filter(Boolean);
const choose = (items: readonly string[], nth: number) =>
  items.length
    ? items[((nth % items.length) + items.length) % items.length]
    : undefined;

/** Each runner resolves its own references; the controller never supplies another Core's ids. */
export const execute = (c: FuzzCase): Execution => {
  const host = createReplayHost(file => {
    throw new Error(`Missing inline source ${file}`);
  }, c.setup);
  const pending = new Set<string>();
  const settlements = new Set<string>();
  const scheduled = new Set<string>();
  const savedRefs = new Map<string, { deliveries: string[]; runs: string[] }>();
  const runs = new Set<string>();
  const deliveries = new Set<string>();
  let offset = 0;
  const counts: Execution['counts'] = {
    applied: 0,
    noops: 0,
    actions: {},
    records: {},
  };
  const fingerprints: Execution['fingerprints'] = [];
  const update = () => {
    for (const line of host.trace.slice(offset)) {
      const r = parseRecord(line);
      const name = `${r.input ? '>' : ''}${r.name}`;
      counts.records[name] = (counts.records[name] ?? 0) + 1;
      if (
        !r.input &&
        ['seg', 'preempt'].includes(r.name) &&
        r.ids[1] === 'start'
      ) {
        runs.add(r.ids[0]!);
      }
      if (!r.input && r.name === 'call') {
        const [grant, operation] = (r.fields.get('op') ?? '').split('.');
        const script = c.setup.scripts!.find(
          s => s.name === r.ids[0]!.split('/r')[0],
        );
        const capability = script?.grants?.[grant!]?.capability ?? grant;
        const mode = c.setup.operations?.find(
          o => o.capability === capability && o.name === operation,
        )?.mode;
        if (
          mode === 'suspending' &&
          !r.fields.has('result') &&
          !r.fields.has('error') &&
          !scheduled.has(r.ids[0]!)
        ) {
          pending.add(r.ids[0]!);
        }
      }
      if (r.input && ['answer', 'fail', 'settle'].includes(r.name)) {
        pending.delete(r.ids[0]!);
        settlements.delete(r.ids[0]!);
        if (
          r.name === 'settle' &&
          ['adopt', 'reissue'].includes(r.fields.get('how')!)
        ) {
          pending.add(r.ids[0]!);
        }
      }
      if (!r.input && ['abandon', 'timeout'].includes(r.name)) {
        pending.delete(r.ids[0]!);
      }
      if (!r.input && r.name === 'run') {
        runs.delete(r.ids[0]!);
        for (const call of pending) {
          if (call.startsWith(`${r.ids[0]}.c`)) {
            pending.delete(call);
          }
        }
      }
      if (
        r.input &&
        [
          'deliver',
          'request',
          'decide',
          'broadcast',
          'decide-broadcast',
        ].includes(r.name)
      ) {
        deliveries.add(r.ids[0]!);
      }
      if (!r.input && ['seg', 'preempt', 'run'].includes(r.name)) {
        deliveries.delete(r.fields.get('delivery')!);
      }
      if (r.input && r.name === 'restore') {
        runs.clear();
        pending.clear();
        settlements.clear();
        deliveries.clear();
        scheduled.clear();
        const refs = savedRefs.get(r.fields.get('from')!);
        if (r.fields.get('mode') !== 'variables-only' && refs) {
          for (const run of refs.runs) {
            runs.add(run);
          }
          for (const delivery of refs.deliveries) {
            deliveries.add(delivery);
          }
        }
        for (const id of ids(r.fields.get('pending'))) {
          settlements.add(id);
        }
      }
      if (!r.input && r.name === 'stopped') {
        for (const run of ids(r.fields.get('discarded'))) {
          runs.delete(run);
        }
        for (const call of ids(r.fields.get('abandoned'))) {
          pending.delete(call);
        }
        for (const d of ids(r.fields.get('dropped'))) {
          deliveries.delete(d);
        }
      }
    }
    offset = host.trace.length;
  };
  const resolve = (a: Action): string | undefined => {
    switch (a.kind) {
      case 'input':
        return a.line;
      case 'answer':
      case 'fail': {
        const id = choose([...pending], a.nth);
        if (!id) {
          return;
        }
        pending.delete(id);
        scheduled.add(id);
        return a.kind === 'answer'
          ? `> answer ${id} value=${a.value}`
          : `> fail ${id} error=${a.value}`;
      }
      case 'cancel-run': {
        const id = choose(
          [...runs].filter(id => id.startsWith(`${a.script}/r`)),
          a.nth,
        );
        return id ? `> cancel-run ${id}` : undefined;
      }
      case 'cancel-delivery': {
        const id = choose([...deliveries], a.nth);
        return id ? `> cancel-delivery ${id}` : undefined;
      }
      case 'restore': {
        const id = choose(host.saveIds.slice().reverse(), a.nth);
        return id
          ? `> restore from=${id}${a.variablesOnly ? ' mismatch=variables-only' : ''}`
          : undefined;
      }
      case 'settle': {
        const id = choose([...settlements], a.nth);
        if (!id) {
          return;
        }
        settlements.delete(id);
        if (a.how === 'adopt' || a.how === 'reissue') {
          pending.add(id);
        }
        return `> settle ${id} how=${a.how}${a.how === 'answer' ? ` value=${a.value ?? '0'}` : a.how === 'fail' ? ` error=${a.value ?? '{code: "fuzz failure"}'}` : ''}`;
      }
    }
  };
  for (const a of c.inputs) {
    const line = resolve(a);
    if (!line) {
      counts.noops++;
      continue;
    }
    const before = hex(host.group.fingerprint());
    host.apply(line);
    counts.applied++;
    const action = parseRecord(line).name;
    counts.actions[action] = (counts.actions[action] ?? 0) + 1;
    fingerprints.push({ action, before, after: hex(host.group.fingerprint()) });
    update();
    if (action === 'save' && host.saveIds.length) {
      savedRefs.set(host.saveIds.at(-1)!, {
        runs: [...runs],
        deliveries: [...deliveries],
      });
    }
  }
  return { trace: host.trace, counts, fingerprints };
};
