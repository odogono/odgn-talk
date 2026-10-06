import grammar from '../../../spec/data/grammar.toml';
import diagnostics from '../../../spec/data/diagnostics.toml';
import { text } from '@odgn/northtalk';
import {
  features,
  type Action,
  type Feature,
  type FuzzCase,
  type HandlerChoice,
  type Mutation,
  type ScriptChoice,
} from './model';

// Harness PRNG, independent of either Core. Seed parsing is explicit and portable.
export const random = (seed: string) => {
  if (!/^\d+$/.test(seed)) {
    throw new Error('Seed must be an unsigned decimal integer');
  }
  let state = Number(BigInt(seed) & 0xff_ff_ff_ffn) || 0x9e_37_79_b9;
  return (bound: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % bound;
  };
};
// The instant display form has the shortest fraction, unlike toISOString.
const clock = (milliseconds = 0) =>
  new Date(Date.UTC(2026, 9, 2) + milliseconds)
    .toISOString()
    .replace(/\.(\d*?)0*Z$/, (_, digits: string) =>
      digits ? `.${digits}Z` : 'Z',
    );
export const pump = (milliseconds = 0, slice = 0) =>
  `> pump clock=${clock(milliseconds)}${slice ? ` fuel-slice=${slice}` : ''}`;
const names: Record<Feature, string> = {
  compute: 'bump',
  dispatch: 'pick',
  suspend: 'fetch',
  join: 'gather',
  decision: 'permit',
  error: 'recover',
  scope: 'resource',
  effect: 'write',
  loop: 'spin',
  send: 'forward',
  timer: 'later',
};
const diagnostic: Record<Mutation, string> = {
  'wrong-mode': 'wrong mode',
  'after-suspension': 'after a suspension',
  'bad-suffixes': 'bad suffixes',
  'missing-grant': 'unknown operation',
  'impure-guard': 'not in a guard',
};
const body = (h: HandlerChoice): string => {
  const head = `on ${h.name}${['suspend', 'timer'].includes(h.kind) && h.policy ? `, ${h.policy}` : ''}`;
  const add = `add ${h.value} to count`;
  const interpolated = [
    '`value ${count}`',
    '`\n  value ${count}\n  `',
    '`value ${count +\n-- hole continuation\n0}`',
    '`value ${`${count}`}`',
    '`v\\u{61}lue ${count}`',
  ][h.value - 1]!;
  const fence = '"'.repeat(3 + (h.repetitions % 3));
  const margin = h.repetitions % 2 ? '\t ' : '  ';
  const raw = `${fence}\n${margin}raw \${count}  \n\n${margin}${'"'.repeat(fence.length - 1)}\n${margin}${fence}`;
  const fenced = `put ${interpolated} into rendered\nput ${raw} into template`;
  switch (h.kind) {
    case 'compute':
      return `${head}\n${fenced}\nrepeat ${h.repetitions} times\nif count >= 0 then\n${add}\nelse\nput 0 into count\nend if\nend repeat\nreturn count\nend ${h.name}`;
    case 'dispatch':
      return `on ${h.name} n where n > ${h.value}\nput n into count\nend ${h.name}\non ${h.name} n\nput ${h.value} into count\nend ${h.name}`;
    case 'suspend':
      return `${head}\nask remote to get and wait\nput it into count\nend ${h.name}`;
    case 'join':
      return `${head}\nwait for all\nask remote to get and wait\nask remote to get and wait\nend wait\nput it into count\nend ${h.name}`;
    case 'decision':
      return `on ${h.name} n, deciding\nif n > ${h.value} then\nveto "too large"\nend if\nend ${h.name}`;
    case 'error':
      return `${head}\ntry\nthrow {code: "fuzz error"}\ncatch err\n${add}\nfinally\nadd 1 to count\nend try\nend ${h.name}`;
    case 'scope':
      return `${head}\nask resource to open\nrepeat ${h.repetitions + 20} times\n${add}\nend repeat\nask resource to close\nend ${h.name}`;
    case 'effect':
      return `${head}\nask store to write ${h.value}\nrepeat ${h.repetitions + 20} times\n${add}\nend repeat\nend ${h.name}`;
    case 'loop':
      return `${head}\nrepeat forever\n${add}\nend repeat\nend ${h.name}`;
    case 'send':
      return `${head}\nsend bump to b\nend ${h.name}`;
    case 'timer':
      return `${head}\nwait ${h.value} ms\n${add}\nend ${h.name}`;
  }
};
export const sources = (scripts: ScriptChoice[]) =>
  scripts.map(s => ({
    name: s.name,
    source: `${s.name}.talk`,
    text: `script variable count = 0\nscript variable rendered = ""\nscript variable template = ""\n${s.handlers.map(body).join('\n')}`,
  }));
export const regenerate = (c: FuzzCase): FuzzCase => {
  const updated = structuredClone(c);
  for (const s of sources(updated.choices.scripts)) {
    const target = updated.setup.scripts!.find(x => x.name === s.name);
    if (target) {
      target.text = s.text;
    }
  }
  updated.inputs = structuredClone(updated.choices.inputs);
  return updated;
};
const setupOf = (scripts: ScriptChoice[]): FuzzCase['setup'] => ({
  operations: [
    {
      capability: 'remote',
      name: 'get',
      mode: 'suspending',
      args: [],
      result: 'number',
      maxPending: 1000,
      cost: { fuel: 1 },
    },
    {
      capability: 'resource',
      name: 'open',
      mode: 'immediate',
      args: [],
      result: 'nothing',
      scope: { opens: 'file', abandon: 'close' },
      cost: { fuel: 1 },
    },
    {
      capability: 'resource',
      name: 'close',
      mode: 'immediate',
      args: [],
      result: 'nothing',
      scope: { closes: 'file' },
      cost: { fuel: 1 },
    },
    {
      capability: 'store',
      name: 'write',
      mode: 'immediate',
      args: ['number'],
      result: 'nothing',
      segmentBound: true,
      cost: { fuel: 1 },
    },
  ],
  objectKinds: [{ name: 'node' }],
  objects: [
    { id: 'root', kind: 'node' },
    { id: 'child', kind: 'node' },
  ],
  scripts: sources(scripts).map(s => ({
    ...s,
    grants: {
      remote: { ops: 'all' as const },
      resource: { ops: 'all' as const },
      store: { ops: 'all' as const },
    },
    limits: { fuelPerRun: 2000 },
    ...(s.name === 'a' ? { owner: { id: 'root', kind: 'node' } } : {}),
  })),
});
const input = (line: string): Action => ({ kind: 'input', line });
const schedule = (
  scripts: ScriptChoice[],
  next: (n: number) => number,
  witness: boolean,
): Action[] => {
  const actions: Action[] = scripts.map(s => input(`> load ${s.name}`));
  actions.push(
    input(
      '> set-parent object=<object node "child"> parent=<object node "root">',
    ),
  );
  let time = 0;
  for (const s of scripts) {
    for (const h of s.handlers) {
      if (h.kind === 'scope') {
        actions.push(
          input('> stub resource.open value=nothing'),
          input('> stub resource.close value=nothing'),
        );
      }
      if (h.kind === 'effect') {
        actions.push(
          input('> stub store.write value=nothing'),
          ...(['begin', 'commit', 'rollback'] as const).map(phase =>
            input(
              `> stub-effect ${s.name}.store phase=${phase} status=${phase === 'commit' ? h.status : 'ok'}`,
            ),
          ),
        );
      }
      actions.push(
        input('> vars'),
        input(
          `> ${h.kind === 'decision' ? 'decide' : 'deliver'} to=${s.name} message=${h.name}${['decision', 'dispatch'].includes(h.kind) ? ` args=[${witness && h.kind === 'dispatch' ? 0 : next(8)}]` : ''}`,
        ),
      );
      if (['suspend', 'timer'].includes(h.kind) && h.policy) {
        actions.push(input(`> deliver to=${s.name} message=${h.name}`));
      }
      actions.push(
        input(
          pump(
            time,
            ['scope', 'effect'].includes(h.kind)
              ? 20
              : witness
                ? 0
                : [0, 1, 7, 30][next(4)]!,
          ),
        ),
        // Hold snapshots at preemption, suspension and ordinary boundaries, then settle independently.
        input('> save'),
        { kind: 'restore', nth: 0 },
      );
      for (let i = 0; i < 3; i++) {
        actions.push({ kind: 'settle', nth: i, how: 'adopt' });
      }
      if (h.kind === 'join' || h.kind === 'suspend') {
        for (let i = 0; i < 3; i++) {
          actions.push({
            kind: 'answer',
            nth: next(3),
            value: String(next(10)),
          });
        }
      }
      time += h.value + 1;
      actions.push(input(pump(time)), input('> vars'));
      if (!witness && next(3) === 0) {
        actions.push(
          { kind: 'cancel-run', script: s.name, nth: next(3) },
          input(pump(time)),
        );
      }
    }
  }
  if (!witness) {
    actions.push(
      input(
        `> reload a carry=yes source=${String(text(sources(scripts)[0]!.text))}`,
      ),
      input(
        `> extend a source=${String(text('on extra\nreturn 1\nend extra'))}`,
      ),
      input('> deliver to=a message=extra'),
      input(pump(time)),
      input('> dispose object=<object node "child">'),
    );
  }
  actions.push(input('> vars'));
  return actions;
};
export const generate = (
  seed: string,
  options: {
    commit?: string;
    features?: readonly Feature[];
    mutation?: Mutation;
    witness?: boolean;
  } = {},
): FuzzCase => {
  const next = random(seed);
  const profile = [...(options.features ?? features)];
  if (!profile.length || profile.some(f => !features.includes(f))) {
    throw new Error('Unsupported feature profile');
  }
  // Spec vocabulary only, never a Core parser/checker used to filter generated source.
  for (const f of profile) {
    if ((grammar.reserved as string[]).includes(names[f])) {
      throw new Error('Generator uses a Reserved Word');
    }
  }
  const selected = options.features ?? profile.filter(() => next(3) !== 0);
  const kinds = selected.length ? selected : [profile[0]!];
  const scripts: ScriptChoice[] = ['a', 'b'].map(name => ({
    name,
    handlers: kinds.map(kind => ({
      name: names[kind],
      kind,
      value: next(5) + 1,
      repetitions: next(5) + 1,
      policy: ['', 'queued', 'dropping', 'replacing'][
        next(4)
      ] as HandlerChoice['policy'],
      status: options.witness
        ? 'ok'
        : (['ok', 'failed', 'unknown'][next(3)] as HandlerChoice['status']),
    })),
  }));
  // Cross-Script sends always have a target Handler, independently of the feature swarm.
  if (kinds.includes('send') && !kinds.includes('compute')) {
    scripts[1]!.handlers.push({
      name: 'bump',
      kind: 'compute',
      value: 1,
      repetitions: 1,
      policy: '',
      status: 'ok',
    });
  }
  const inputs = schedule(scripts, next, options.witness ?? false);
  const c: FuzzCase = {
    version: 1,
    generator: 'scheduler-1',
    seed,
    commit: options.commit ?? 'uncommitted',
    profile,
    choices: { scripts, inputs: structuredClone(inputs) },
    setup: setupOf(scripts),
    inputs,
  };
  if (options.mutation) {
    const code = diagnostic[options.mutation];
    if (
      !(diagnostics.diagnostic as { code: string }[]).some(d => d.code === code)
    ) {
      throw new Error(`Unknown mutation diagnostic ${code}`);
    }
    const invalid: Record<Mutation, string> = {
      'wrong-mode': 'on go\nask remote to get\nend go',
      'after-suspension': 'on go, deciding\nwait 1 ms\nveto "no"\nend go',
      'bad-suffixes': 'on go, queued, deciding\nend go',
      'missing-grant': 'on go\nask absent to get and wait\nend go',
      'impure-guard':
        'function check\nreturn true\nend check\non go where check()\nend go',
    };
    c.setup.scripts = [
      { ...c.setup.scripts![0]!, text: invalid[options.mutation] },
    ];
    c.inputs = [input('> load a')];
    c.choices.inputs = structuredClone(c.inputs);
    c.expectedDiagnostic = code;
    c.mutation = options.mutation;
  }
  return c;
};
export const witnesses = () =>
  features.map(feature =>
    generate('1', { features: [feature], witness: true }),
  );
