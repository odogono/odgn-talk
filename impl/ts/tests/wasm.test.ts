// @northtalk/ts/wasm: the embedding API over the Zig reactor (#1121).
// Each test runs the same Host code on the TS Core and on the facade, and
// expects the same result. Skipped when talk.wasm hasn't been built:
// `bun run wasm:build`.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
// eslint-disable-next-line import-x/no-namespace -- each test takes a whole package.
import * as ts from '../src/index';
// eslint-disable-next-line import-x/no-namespace -- each test takes a whole package.
import * as wasm from '../src/wasm/index';
import { autoDrive, newDrivenGroup } from '../src/driver';
import { artifact } from './reactor-artifact';

const built = existsSync(artifact);
const module = built
  ? await WebAssembly.compile(readFileSync(artifact))
  : undefined;

// The values both packages export, apart from their own createCore.
type NT = Omit<
  Pick<typeof wasm, keyof typeof ts & keyof typeof wasm>,
  'createCore'
>;
type Core = wasm.Core;
const cores: [string, () => Promise<Core>, NT][] = [
  ['ts', async () => ts.createCore(), ts],
  [
    'wasm',
    () => wasm.createCore({ wasm: module!, diagnostics: () => {} }),
    wasm,
  ],
  [
    'wasm JSON callbacks',
    () =>
      wasm.createCore({
        wasm: module!,
        diagnostics: () => {},
        binaryCallbacks: false,
      }),
    wasm,
  ],
];
const second = 1_000_000n;

/** Runs `f` on both Cores and expects the same result from each. */
const both = (name: string, f: (core: Core, nt: NT) => unknown) =>
  test(name, async () => {
    const results = [];
    for (const [, make, nt] of cores) {
      results.push(await f(await make(), nt));
    }
    for (const result of results.slice(1)) {
      expect(result).toEqual(results[0]);
    }
  });

const kinds = (reports: readonly wasm.Report[]) => reports.map(r => r.kind);
const ends = (reports: readonly wasm.Report[]) =>
  reports.flatMap(r =>
    r.kind === 'run end'
      ? [
          `${r.outcome}${r.result ? ` ${r.result}` : ''}${r.error ? ` ${r.error.code}` : ''}`,
        ]
      : [],
  );

describe.skipIf(!built)('@northtalk/ts/wasm', () => {
  test('hello reports the Zig Core', async () => {
    const core = await wasm.createCore({ wasm: module! });
    expect(core.versions.core).toStartWith('zig/');
    expect(core.versions.language).toBe(ts.coreVersions.language);
    expect(core.versions.unicode).toBe(ts.coreVersions.unicode);
  });

  test('the State Fingerprint ignores the save id and survives restore', async () => {
    const core = await wasm.createCore({
      wasm: module!,
      diagnostics: () => {},
    });
    const g = core.newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source: 'script variable n = 0\non bump\n  add 1 to n\nend bump',
    });
    const live = g.stateFingerprint();
    const a = g.save();
    const b = g.save();
    expect(a).not.toEqual(b);
    expect(core.stateFingerprint(a)).toEqual(live);
    expect(core.stateFingerprint(b)).toEqual(live);
    const { group: copy } = core.restore(a, {
      name: 'g',
      libraries: [],
      grants: () => undefined,
      resolve: () => undefined,
      onMismatch: 'reject',
    });
    expect(copy.stateFingerprint()).toEqual(live);
    s.deliver({ name: 'bump' });
    g.pump(second);
    expect(g.stateFingerprint()).not.toEqual(live);
    expect(() => core.stateFingerprint(new Uint8Array([1, 2, 3]))).toThrow(
      'invalid save',
    );
  });

  both(
    'Requests settle from the Pump that ends their Run',
    async (core, nt) => {
      const g = core.newGroup({ name: 'g' });
      const s = g.load({
        name: 's',
        source:
          'on double n\n  return n * 2\nend double\non boom\n  throw "nope"\nend boom',
      });
      const ok = s.request({ name: 'double', args: [nt.num(21)] });
      const bad = s.request({ name: 'boom' });
      const lost = s.request({ name: 'nobody' });
      const reports = g.pump(second).reports;
      return {
        reports: kinds(reports),
        ends: ends(reports),
        ok: (await ok.result).toString(),
        bad: await bad.result.catch((error: wasm.ScriptError) => [
          error.code,
          error.data.toString(),
        ]),
        lost: await lost.result.catch((error: wasm.ScriptError) => [
          error.code,
          error.data.toString(),
        ]),
      };
    },
  );

  both(
    'Operations: immediate, fire-and-forget, failures and charges',
    (core, nt) => {
      const fired: string[] = [];
      const cap = core.defineCapability('cap', {
        length: {
          mode: 'immediate',
          args: [nt.shape.text],
          result: nt.shape.number,
          cost: { fuel: 3 },
          do: (_c, s) => BigInt(s.length),
        },
        note: {
          mode: 'fire-and-forget',
          args: [nt.shape.text],
          cost: { fuel: 1 },
          fire: (c, s) => {
            fired.push(`${c.scriptName} ${c.grantName} ${s}`);
          },
        },
        refuse: {
          mode: 'immediate',
          cost: { fuel: 1 },
          errors: [{ code: 'refused' }],
          do: () => {
            throw new nt.ScriptError(
              'refused',
              'no',
              nt.record({ why: nt.text('policy') }),
            );
          },
        },
        crash: {
          mode: 'immediate',
          cost: { fuel: 1 },
          do: () => {
            throw new Error('host bug');
          },
        },
        greedy: {
          mode: 'immediate',
          cost: { fuel: 1 },
          do: c => {
            c.charge(10);
            c.charge(1_000_000_000);
            return nt.nothing;
          },
        },
      });
      const g = core.newGroup({ name: 'g' });
      const s = g.load({
        name: 's',
        source: [
          'on go',
          '  ask io to length "hello"',
          '  tell io to note "hi"',
          '  return it',
          'end go',
          'on refuse',
          '  try',
          '    ask io to refuse',
          '  catch e',
          '    return e',
          '  end try',
          'end refuse',
          'on crash',
          '  ask io to crash',
          'end crash',
          'on greedy',
          '  ask io to greedy',
          'end greedy',
        ].join('\n'),
        grants: { io: cap.grant('all', undefined) },
      });
      for (const name of ['go', 'refuse', 'crash', 'greedy']) {
        s.deliver({ name });
      }
      const reports = g.pump(second).reports;
      return {
        ends: ends(reports),
        failed: reports.flatMap(r =>
          r.kind === 'call failed' ? [r.detail] : [],
        ),
        fired,
      };
    },
  );

  both(
    'A primitive Host result fails its call and leaves later work runnable',
    async (core, nt) => {
      const cap = core.defineCapability('api', {
        bad: {
          mode: 'immediate',
          cost: { fuel: 1 },
          // @ts-expect-error A JavaScript Host can return a primitive despite the TS declaration.
          do: () => 42,
        },
      });
      const g = core.newGroup({ name: 'g' });
      const s = g.load({
        name: 's',
        source:
          'on bad\n ask api to bad\nend bad\non good\n return 1\nend good',
        grants: { api: cap.grant('all', undefined) },
      });
      s.deliver({ name: 'bad' });
      const good = s.request({ name: 'good' });
      const reports = g.pump(second).reports;
      expect(reports.filter(r => r.kind === 'call failed')).toHaveLength(1);
      return { ends: ends(reports), value: (await good.result).toString() };
    },
  );

  both('A suspending call answered later, and one abandoned', (core, nt) => {
    const calls: wasm.Call<unknown>[] = [];
    const cap = core.defineCapability('feed', {
      fetch: {
        mode: 'suspending',
        args: [nt.shape.number],
        result: nt.shape.number,
        maxPendingMs: 1000,
        cost: { fuel: 1 },
        start: c => {
          calls.push(c);
        },
      },
    });
    const g = core.newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source:
        'on get n\n  ask feed to fetch n and wait\n  return it + 1\nend get',
      grants: { feed: cap.grant('all', undefined) },
    });
    s.deliver({ name: 'get', args: [nt.num(1)] });
    s.deliver({ name: 'get', args: [nt.num(2)] });
    g.pump(second);
    calls[0]!.answer(nt.num(41));
    const first = ends(g.pump(2n * second).reports);
    const timedOut = ends(g.pump(4n * second).reports);
    return {
      first,
      timedOut,
      aborted: calls.map(c => c.signal.aborted),
      ids: calls.map(c => [c.id, c.runId, c.segmentId, c.now]),
    };
  });

  // ADR 0125: a call names the Host Delivery that started its Run, and a
  // Run a Script's send started has none.
  both('A call names the Host Delivery that started its Run', (core, nt) => {
    const seen: string[] = [];
    const api = core.defineCapability('api', {
      see: {
        mode: 'immediate',
        cost: { fuel: 1 },
        do: c => {
          seen.push(`${c.runId} ${c.delivery ?? '-'}`);
          return nt.nothing;
        },
      },
    });
    const g = core.newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source:
        'on go\n  ask api to see\n  send again to me\nend go\non again\n  ask api to see\nend again',
      grants: { api: api.grant('all', undefined) },
    });
    const id = s.deliver({ name: 'go' });
    g.pump(second);
    expect(seen).toEqual([`s/r1 ${id}`, 's/r2 -']);
    return seen;
  });

  both(
    'Host Objects: properties, Message Paths and wrong group',
    (core, nt) => {
      const door = core.defineObjectKind<{ open: boolean }>({
        name: 'door',
        props: {
          open: {
            shape: nt.shape.bool,
            get: o => nt.bool(o.native.open),
            set: (o, v) => {
              o.native.open = v.asBool()!;
            },
          },
        },
      });
      const g = core.newGroup({ name: 'g' });
      const other = core.newGroup({ name: 'other' });
      const front = g.object(door, 'front', { open: false });
      const stranger = other.object(door, 'front', { open: false });
      g.load({
        name: 'keeper',
        source:
          'on toggle\n  set the open of me to not the open of me\n  return the open of me\nend toggle',
        owner: front,
      });
      const asked = g.request(front, { name: 'toggle' });
      const reports = g.pump(second).reports;
      let refused = '';
      try {
        g.deliver(stranger, { name: 'toggle' });
      } catch (error) {
        refused = (error as wasm.HostError).code;
      }
      return {
        ends: ends(reports),
        native: front.native.open,
        same: g.objectById('door', 'front') === front,
        refused,
        result: asked.id,
      };
    },
  );

  both('Function Values go out and come back', async (core, nt) => {
    const g = core.newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source:
        'on adder n\n  return given x\n    return x + n\n  end given\nend adder',
    });
    const made = s.request({ name: 'adder', args: [nt.num(10)] });
    g.pump(second);
    const fn = await made.result;
    const called = g.call(fn, [nt.num(5)]);
    g.pump(2n * second);
    let refused = '';
    try {
      core.newGroup({ name: 'h' }).call(fn, []);
    } catch (error) {
      refused = (error as wasm.HostError).code;
    }
    return {
      kind: fn.kind,
      home: fn.homeScript(),
      display: fn.toString(),
      called: (await called.result).toString(),
      refused,
    };
  });

  both('Decisions settle when the Verdict seals', async (core, nt) => {
    const g = core.newGroup({ name: 'g' });
    const s = g.load({
      name: 'judge',
      source:
        'on allowed n, deciding\n  if n > 5 then veto "too many"\nend allowed',
    });
    const yes = s.decide({ name: 'allowed', args: [nt.num(1)] });
    const no = s.decide({ name: 'allowed', args: [nt.num(9)] });
    g.pump(second);
    const [a, b] = await Promise.all([yes.decided, no.decided]);
    return [a.verdict, b.verdict, b.vetoes.map(v => v.reason.toString())];
  });

  both('Worker calls from a callback are reentrant calls', (core, nt) => {
    let code = '';
    const cap = core.defineCapability('cap', {
      poke: {
        mode: 'immediate',
        cost: { fuel: 1 },
        do: c => {
          try {
            c.group.pump(5n * second);
          } catch (error) {
            code = (error as wasm.HostError).code;
          }
          // Queued calls are fine.
          c.group.script(c.scriptName)!.deliver({ name: 'later' });
          return nt.nothing;
        },
      },
    });
    const g = core.newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source:
        'script variable n = 0\non go\n  ask cap to poke\nend go\non later\n  put n + 1 into n\nend later',
      grants: { cap: cap.grant('all', undefined) },
    });
    s.deliver({ name: 'go' });
    const first = ends(g.pump(second).reports);
    const second_ = ends(g.pump(2n * second).reports);
    return { code, first, second: second_ };
  });

  both('Load errors, mailbox limits and unknown names', (core, nt) => {
    const g = core.newGroup({ name: 'g' });
    let load: unknown;
    try {
      g.load({ name: 'bad', source: 'on go\n  retrun 1\nend go' });
    } catch (error) {
      load = (error as wasm.LoadError).diagnostics.map(d => [d.code, d.line]);
    }
    const s = g.load({
      name: 's',
      source: 'on go\nend go',
      limits: { mailboxDepth: 1 },
    });
    s.deliver({ name: 'go' });
    let full = '';
    try {
      s.deliver({ name: 'go', args: [nt.num(1)] });
    } catch (error) {
      full = (error as Error).name;
    }
    return { load, full, names: g.scriptNames() };
  });

  both(
    'Libraries compile once and load where they are added',
    async (core, nt) => {
      const lib = core.compileLibrary({
        name: 'maths',
        version: '1',
        source: 'function triple n\n  return n * 3\nend triple',
      });
      const g = core.newGroup({ name: 'g' });
      g.addLibrary(lib);
      const s = g.load({
        name: 's',
        source: 'use triple from maths\non go n\n  return triple(n)\nend go',
      });
      const r = s.request({ name: 'go', args: [nt.num(4)] });
      g.pump(second);
      return {
        result: (await r.result).toString(),
        identity: lib.identity.length,
      };
    },
  );

  both('Host Command Result Targets survive restore rebinding', (core, nt) => {
    const grant = core
      .defineCapability('api', {
        price: {
          mode: 'immediate',
          command: true,
          cost: { fuel: 0 },
          result: nt.shape.number,
          do: () => nt.num(7),
        },
      })
      .grant('all', undefined);
    const group = core.newGroup({ name: 'original' });
    group
      .load({
        name: 's',
        grants: { api: grant },
        source:
          'script variable result\non go\n price into x\n wait 1 ms\n put [x, it] into result\nend go',
      })
      .deliver({ name: 'go' });
    group.pump(0n);
    const { group: copy } = core.restore(group.save(), {
      name: 'copy',
      libraries: [],
      grants: () => grant,
      resolve: () => undefined,
      onMismatch: 'reject',
    });
    copy.pump(second);
    return copy.inspect().scripts[0]!.vars.map(v => [v[0], v[1].toString()]);
  });

  both('Inspect, counters, grants and Reload', (core, nt) => {
    const cap = core.clockCapability({ now: { fuel: 1 } });
    const g = core.newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source:
        'script variable seen = 0\non tick\n  put seen + 1 into seen\n  ask clock to now\n  return it\nend tick',
      grants: { clock: cap.grant('all', undefined) },
    });
    s.deliver({ name: 'tick' });
    const before = ends(g.pump(3n * second).reports);
    const reloaded = s.reload(
      'script variable seen = 0\non tick\n  return seen\nend tick',
      'carry variables',
    );
    s.deliver({ name: 'tick' });
    const after = ends(g.pump(4n * second).reports);
    const view = g.inspect().scripts[0]!;
    return {
      before,
      after,
      reloaded: kinds(reloaded),
      vars: view.vars.map(([n, v]) => `${n}=${v}`),
      grants: s.grants(),
      runs: s.counters().runs,
      fingerprint: g.fingerprint().length,
      tag: nt.text('x').kind,
    };
  });

  both(
    'newDrivenGroup drives Requests and invoke to their answers',
    async (core, nt) => {
      const { group, drive } = newDrivenGroup(core, { name: 'g' });
      const s = group.load({
        name: 's',
        source: 'on double n\n  return n * 2\nend double',
      });
      const answers = await Promise.all([
        s.request({ name: 'double', args: [nt.num(2)] }).result,
        s.invoke('double', nt.num(21)),
      ]);
      await drive.close();
      return answers.map(String);
    },
  );

  both(
    'a driver closes only after an abandoned Host Promise settles',
    async (core, nt) => {
      const events: string[] = [];
      const cleanup = Promise.withResolvers<void>();
      const api = core.defineCapability('api', {
        fetch: {
          mode: 'suspending',
          args: [],
          result: nt.shape.nothing,
          cost: { fuel: 0 },
          run: async call => {
            await new Promise<void>(resolve =>
              call.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
            events.push('abort');
            await cleanup.promise;
            events.push('cleanup');
            return nt.nothing;
          },
        },
      });
      // onReady runs only once Inputs are queued, after drive exists.
      const group = core.newGroup({ name: 'g', onReady: () => drive.ready() });
      const drive = autoDrive(group);
      const reply = group
        .load({
          name: 's',
          source: 'on go\n  ask api to fetch and wait\nend go',
          grants: { api: api.grant('all', undefined) },
        })
        .request({ name: 'go', args: [] })
        .result.catch((error: wasm.ScriptError) => error.code);
      await drive.idle();
      const closing = drive.close().then(() => events.push('closed'));
      events.push(String(await reply));
      await drive.idle();
      expect(events).not.toContain('closed');
      cleanup.resolve();
      await closing;
      return events;
    },
  );

  test('a trap loses only its own Group', async () => {
    const core = await wasm.createCore({
      wasm: module!,
      diagnostics: () => {},
    });
    const g = core.newGroup({ name: 'g' });
    const h = core.newGroup({ name: 'h' });
    g.load({ name: 's', source: 'on go\nend go' });
    h.load({ name: 's', source: 'on go\nend go' });
    expect(g.memoryBytes()).toBeGreaterThan(0);
    expect(h.scriptNames()).toEqual(['s']);
  });
});
