import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createCore,
  num,
  type PumpedRequest,
  type Requested,
} from '../src/index';
import { createCore as createWasmCore } from '../src/wasm/index';

const artifact = resolve(
  import.meta.dir,
  process.env.NORTHTALK_WASM ?? '../../../.cache/zig-wasi/bin/talk.wasm',
);
const module = existsSync(artifact)
  ? await WebAssembly.compile(readFileSync(artifact))
  : undefined;
const admitted = (outcome: PumpedRequest): Requested => {
  expect(outcome.admitted).toBe(true);
  if (!outcome.admitted) {
    throw outcome.error;
  }
  return outcome.requested;
};
const pumped = (outcome: PumpedRequest) => {
  admitted(outcome);
  if (!outcome.admitted) {
    throw outcome.error;
  }
  expect(outcome.pump.ok).toBe(true);
  if (!outcome.pump.ok) {
    throw outcome.pump.error;
  }
  return outcome.pump.result;
};

for (const backend of ['ts', 'wasm', 'wasm JSON callbacks'] as const) {
  const core = async () =>
    backend === 'ts'
      ? createCore()
      : createWasmCore({ wasm: module!, binaryCallbacks: backend === 'wasm' });
  describe.skipIf(backend !== 'ts' && !module)(
    `${backend} combined operations`,
    () => {
      test('admits once, retains ordering, uses ordinary Trace and omits initial readiness', async () => {
        const c = await core();
        const trace: string[] = [];
        let ready = 0;
        const g = c.newGroup({
          name: 'g',
          onReady: () => {
            ready++;
          },
          trace: line => trace.push(line),
        });
        const s = g.load({
          name: 's',
          source: 'on echo n\n return n\nend echo',
        });
        const first = s.request({ name: 'echo', args: [num(1)] });
        ready = 0;
        const out = s.requestPump({ name: 'echo', args: [num(2)] }, 100n);
        const pump = pumped(out);
        expect(ready).toBe(0);
        expect(admitted(out).id).toBe('d2');
        expect((await first.result).toString()).toBe('1');
        expect((await admitted(out).result).toString()).toBe('2');
        expect(
          pump.reports.filter(r => r.kind === 'run end').map(r => r.delivery),
        ).toEqual(['d1', 'd2']);
        expect(trace.filter(l => l.startsWith('> request '))).toHaveLength(2);
        expect(trace.filter(l => l.startsWith('> pump '))).toHaveLength(1);
        expect(trace.some(l => l.includes('request-pump'))).toBe(false);
      });

      test('admission refusal has no handle or Pump, and consumes no delivery identity', async () => {
        const c = await core();
        const trace: string[] = [];
        const g = c.newGroup({ name: 'g', trace: line => trace.push(line) });
        const s = g.load({
          name: 's',
          source: 'on echo n\n return n\nend echo',
          limits: { mailboxDepth: 1, fuelPerRun: 100 },
        });
        const bad = s.requestPump(
          { name: 'echo', args: [num(1)], limits: { fuelPerRun: 101 } },
          10n,
        );
        expect(bad).toMatchObject({
          admitted: false,
          error: { code: 'invalid value' },
        });
        expect('requested' in bad).toBe(false);
        const first = s.request({ name: 'echo', args: [num(1)] });
        expect(first.id).toBe('d1');
        const full = s.requestPump({ name: 'echo', args: [num(2)] }, 10n);
        expect(full).toMatchObject({
          admitted: false,
          error: { name: 'MailboxFull' },
        });
        expect(trace.some(l => l.startsWith('> pump '))).toBe(false);
        g.pump(10n);
        await first.result;
      });

      test('a Pump refusal returns the Request, notifies readiness and leaves it queued', async () => {
        const c = await core();
        let ready = 0;
        const g = c.newGroup({
          name: 'g',
          onReady: () => {
            ready++;
          },
        });
        const s = g.load({
          name: 's',
          source: 'on echo n\n return n\nend echo',
        });
        g.pump(100n);
        ready = 0;
        const out = s.requestPump({ name: 'echo', args: [num(42)] }, 99n);
        expect(out).toMatchObject({
          admitted: true,
          pump: { ok: false, error: { code: 'clock backwards' } },
        });
        const requested = admitted(out);
        await Promise.resolve();
        expect(ready).toBe(1);
        g.pump(101n);
        expect((await requested.result).toString()).toBe('42');
      });

      test('a fuel cap leaves the combined Request pending without replaying admission', async () => {
        const c = await core();
        const g = c.newGroup({ name: 'g' });
        const s = g.load({
          name: 's',
          source: 'on echo n\n return n\nend echo',
        });
        s.deliver({ name: 'echo', args: [num(1)] });
        const out = s.requestPump({ name: 'echo', args: [num(9)] }, 10n, {
          fuelCap: 1,
          fuelSlice: 1,
        });
        expect(pumped(out).state).toBe('sliced');
        expect(admitted(out).id).toBe('d2');
        g.pump(11n);
        expect((await admitted(out).result).toString()).toBe('9');
      });

      test('Function lifecycle, arity at execution and ordinary Call limits', async () => {
        const c = await core();
        const g = c.newGroup({ name: 'g' });
        const source = 'on make\n return given x: x + 1\nend make';
        const s = g.load({ name: 's', source });
        const fn = await admitted(s.requestPump({ name: 'make' }, 10n)).result;
        const call = g.callPump(fn, [num(41)], 11n, {
          limits: { fuelPerRun: 1000 },
        });
        pumped(call);
        expect((await admitted(call).result).toString()).toBe('42');
        const arity = g.callPump(fn, [], 12n);
        expect(
          pumped(arity).reports.some(
            r => r.kind === 'run end' && r.outcome === 'errored',
          ),
        ).toBe(true);
        await expect(admitted(arity).result).rejects.toMatchObject({
          code: 'send failed',
        });
        s.reload(source, 'reset variables');
        const stale = g.callPump(fn, [num(1)], 13n);
        pumped(stale);
        await expect(admitted(stale).result).rejects.toMatchObject({
          code: 'send failed',
        });
        expect(g.callPump(num(1), [], 14n)).toMatchObject({
          admitted: false,
          error: { code: 'invalid value' },
        });
      });

      test('Object targets keep routing and wrong-Group checks', async () => {
        const c = await core();
        const kind = c.defineObjectKind({ name: 'thing', props: {} });
        const g = c.newGroup({ name: 'g' });
        const other = c.newGroup({ name: 'other' });
        const obj = g.object(kind, 'one', null);
        const foreign = other.object(kind, 'one', null);
        g.load({
          name: 's',
          source: 'on echo n\n return n\nend echo',
          owner: obj,
        });
        const out = g.requestPump(obj, { name: 'echo', args: [num(42)] }, 10n);
        pumped(out);
        expect((await admitted(out).result).toString()).toBe('42');
        expect(g.requestPump(foreign, { name: 'echo' }, 11n)).toMatchObject({
          admitted: false,
          error: { code: 'wrong group' },
        });
      });

      test('cancellation during a callback cancels the provisional Request; competing workers admit nothing', async () => {
        const c = await core();
        const abort = new AbortController();
        let competing: PumpedRequest | undefined;
        let workerCode = '';
        const trace: string[] = [];
        const cap = c.defineCapability('cap', {
          poke: {
            mode: 'immediate',
            cost: { fuel: 1 },
            do: () => {
              competing = s.requestPump({ name: 'later' }, 10n);
              try {
                g.pump(10n);
              } catch (error) {
                workerCode = (error as { code: string }).code;
              }
              abort.abort();
              return num(1);
            },
          },
        });
        const g = c.newGroup({ name: 'g', trace: line => trace.push(line) });
        const s = g.load({
          name: 's',
          source:
            'on go\n ask cap to poke\n wait 1 ms\nend go\non later\n return 42\nend later',
          grants: { cap: cap.grant('all', undefined) },
        });
        const out = s.requestPump({ name: 'go' }, 10n, {
          signal: abort.signal,
        });
        pumped(out);
        expect(competing).toMatchObject({
          admitted: false,
          error: { code: 'reentrant call' },
        });
        expect(workerCode).toBe('reentrant call');
        g.pump(11n);
        await expect(admitted(out).result).rejects.toMatchObject({
          code: 'send failed',
        });
        expect(trace.filter(l => l === '> cancel-delivery d1')).toHaveLength(1);
        const next = s.requestPump({ name: 'later' }, 12n);
        expect(admitted(next).id).toBe('d2');
        expect((await admitted(next).result).toString()).toBe('42');
      });

      test('an already-aborted signal cancels before execution', async () => {
        const c = await core();
        const trace: string[] = [];
        const g = c.newGroup({ name: 'g', trace: line => trace.push(line) });
        const s = g.load({ name: 's', source: 'on go\n return 42\nend go' });
        const abort = new AbortController();
        abort.abort();
        const out = s.requestPump({ name: 'go' }, 10n, {
          signal: abort.signal,
        });
        pumped(out);
        await expect(admitted(out).result).rejects.toMatchObject({
          code: 'send failed',
        });
        expect(trace.filter(l => l === '> cancel-delivery d1')).toHaveLength(1);
        expect(pumped(s.requestPump({ name: 'go' }, 11n)).state).toBe('idle');
      });

      test('cancellation after the final reply uses the admitted id after a refused Pump', async () => {
        const c = await core();
        const abort = new AbortController();
        const trace: string[] = [];
        const g = c.newGroup({ name: 'g', trace: line => trace.push(line) });
        const s = g.load({ name: 's', source: 'on go\n return 1\nend go' });
        g.pump(10n);
        const out = s.requestPump({ name: 'go' }, 9n, { signal: abort.signal });
        admitted(out);
        abort.abort();
        g.pump(11n);
        await expect(admitted(out).result).rejects.toMatchObject({
          code: 'send failed',
        });
        expect(trace.filter(l => l === '> cancel-delivery d1')).toHaveLength(1);
      });
    },
  );
}
