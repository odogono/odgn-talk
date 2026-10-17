// @northtalk/ts/wasm: the embedding API over the Zig reactor (#1121).
// Each test runs the same Host code on the TS Core and on the facade, and
// expects the same result. Skipped when talk.wasm hasn't been built:
// `cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi`.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// eslint-disable-next-line import-x/no-namespace -- each test takes a whole package.
import * as ts from '../src/index';
// eslint-disable-next-line import-x/no-namespace -- each test takes a whole package.
import * as wasm from '../src/wasm/index';

const artifact = resolve(
  import.meta.dir,
  process.env.NORTHTALK_WASM ?? '../../../.cache/zig-wasi/bin/talk.wasm',
);
const built = existsSync(artifact);
const module = built
  ? await WebAssembly.compile(readFileSync(artifact))
  : undefined;

type NT = typeof wasm;
type Core = wasm.Core;
const cores: [string, () => Promise<Core>, NT][] = [
  ['ts', async () => ts.createCore() as unknown as Core, ts as unknown as NT],
  [
    'wasm',
    () => wasm.createCore({ wasm: module!, diagnostics: () => {} }),
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
    expect(results[1]).toEqual(results[0]);
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
          do: (_c, s) => nt.num(s!.asText()!.length),
        },
        note: {
          mode: 'fire-and-forget',
          args: [nt.shape.text],
          cost: { fuel: 1 },
          fire: (c, s) => {
            fired.push(`${c.scriptName} ${c.grantName} ${s!.asText()}`);
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
            (c.group as unknown as wasm.Group).pump(5n * second);
          } catch (error) {
            code = (error as wasm.HostError).code;
          }
          // Queued calls are fine.
          (c.group as unknown as wasm.Group)
            .script(c.scriptName)!
            .deliver({ name: 'later' });
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
