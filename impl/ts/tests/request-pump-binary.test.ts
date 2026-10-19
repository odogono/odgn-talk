import { expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  binaryReports,
  decodeBinaryFrame,
  encodeBinaryFrame,
  requestPumpFeature,
} from '../src/request-pump-binary';
import { JsonNumber, readOrderedJSON } from '../src/readers';
import { encodeAll } from '../src/wasm/codec';
import { frameJSON, frameTree, plain, type Frame } from '../src/wasm/wire';
import { encodeBinaryValue } from '../src/binary-value';
import { bytes, list, map, text } from '../src/values';
import { fromJson } from '../src/readers';
import { Reactor } from '../src/wasm/reactor';
import { createCore } from '../src/wasm/index';

const frame = (data: Frame) => readOrderedJSON(frameJSON(data));
test('a frame holding Values encodes as its Value Encoding would', () => {
  const codec = { identity: {}, object: () => undefined };
  const args = encodeAll(codec, [
    text('é'),
    list(map([['k', bytes(new Uint8Array([0, 255]))]])),
    fromJson(readOrderedJSON('{"$dec":"1.50"}')),
  ]);
  const data: Frame = {
    m: 'call-pump',
    ref: 1,
    group: 'g',
    token: 2,
    fn: { $object: ['K', 'id'] },
    args,
    now: '2026-01-01T00:00:00Z',
    fuelSlice: 10,
  };
  expect(new Uint8Array(encodeBinaryFrame(frameTree(data)))).toEqual(
    new Uint8Array(encodeBinaryFrame(frame(data))),
  );
});
test('every specialized Report and nested Value survives the fields envelope', () => {
  const reports = binaryReports.map(([kind]) => ({ kind }));
  const full = [
    {
      kind: 'run end',
      script: 's',
      run: 'r1',
      outcome: 'errored',
      result: { $dec: '0.00' },
      error: { code: 'oops', data: { $bytes: 'AP8=' } },
      effect: { status: 'failed', phase: 'commit' },
      cleanupFailed: true,
      at: { line: 1, col: 2 },
    },
    {
      kind: 'run started',
      args: [
        {
          $map: [
            ['$x', { $dec: '1.00' }],
            ['2', true],
          ],
        },
      ],
      fn: { $function: ['s', '<function s:go>', 'f1'] },
    },
    {
      kind: 'unhandled',
      message: { name: 'écho', args: [{ $range: [1, 3] }] },
      target: { $object: ['thing', 'one'] },
    },
    {
      kind: 'decided',
      vetoes: [{ script: 's', run: 'r1', reason: { $bytes: 'AQID' } }],
      undecided: [{ script: 's', outcome: 'unhandled' }],
    },
    {
      kind: 'call failed',
      operation: { capability: 'api', operation: 'read' },
      detail: 'e\u0301',
    },
  ];
  const original = frame({
    ref: 1,
    delivery: 'd1',
    token: 1,
    ok: {
      state: 'idle',
      nextDeadline: '2026-10-18T12:00:00Z',
      fuelUsed: 2,
      reports: [...reports, ...full],
      gone: ['d2'],
    },
    abandoned: ['c1'],
    settled: ['c2'],
    trace: ['e\u0301'],
  });
  const buffer = encodeBinaryFrame(original);
  expect(plain(decodeBinaryFrame(buffer))).toEqual(plain(original));
  expect(new Uint8Array(encodeBinaryFrame(decodeBinaryFrame(buffer)))).toEqual(
    new Uint8Array(buffer),
  );
});

test('negotiated Core-error markers survive a frame decode and re-encode', () => {
  const packet = frame({
    ref: 1,
    ok: {
      state: 'idle',
      fuelUsed: 1,
      reports: [
        {
          kind: 'run end',
          outcome: 'errored',
          error: { message: 'bad', code: 'oops' },
        },
      ],
    },
  });
  const buffer = encodeBinaryFrame(packet);
  const item = encodeBinaryValue(
    map([
      ['message', text('bad')],
      ['code', text('oops')],
    ]),
  );
  const offset = Buffer.from(buffer).indexOf(Buffer.from(item));
  expect(offset).toBeGreaterThan(0);
  new Uint8Array(buffer)[offset] = 17;
  expect(() => decodeBinaryFrame(buffer)).toThrow();
  const decoded = decodeBinaryFrame(buffer, { coreErrors: true });
  expect(
    new Uint8Array(encodeBinaryFrame(decoded, { coreErrors: true })),
  ).toEqual(new Uint8Array(buffer));
});

test('all five inputs preserve targets, options and large correlation integers', () => {
  const inputs = [
    {
      m: 'request',
      to: { script: 's' },
      message: { name: 'go', args: [{ $dec: '0.00' }] },
    },
    {
      m: 'call',
      fn: { $function: ['s', 'display', 'token'] },
      args: [null],
      limits: { maxJoin: 1 },
    },
    { m: 'pump', now: '1970-01-01T00:00:00Z', fuelSlice: 1, fuelCap: 2 },
    {
      m: 'request-pump',
      token: new JsonNumber('18446744073709551615'),
      to: { object: { $object: ['thing', 'one'] } },
      message: { name: 'go', args: [] },
      now: '1970-01-01T00:00:00Z',
    },
    {
      m: 'call-pump',
      token: 2,
      fn: { $function: ['s', 'display', 'token'] },
      args: [],
      now: '1970-01-01T00:00:00Z',
      limits: { maxWaitMs: 5 },
    },
  ];
  for (const data of inputs) {
    const token =
      typeof data.token === 'object' && data.token?.kind === 'number'
        ? data.token
        : undefined;
    const original = frame({
      ...data,
      token: token ? undefined : data.token,
      ref: 1,
      group: 'e\u0301',
    } as Frame);
    if (
      token &&
      typeof original === 'object' &&
      original !== null &&
      !Array.isArray(original) &&
      original.kind === 'object'
    ) {
      original.pairs.push(['token', token]);
    }
    const decoded = decodeBinaryFrame(encodeBinaryFrame(original));
    expect(plain(decoded)).toEqual(plain(original));
    if (token) {
      expect(JSON.stringify(decoded)).toContain(token.source);
    }
  }
});

test('truncated records, unknown tags/layouts, extra fields and trailing bytes are refused', () => {
  const buffer = encodeBinaryFrame(
    frame({ m: 'pump', ref: 1, group: 'g', now: '1970-01-01T00:00:00Z' }),
  );
  for (let i = 0; i < buffer.byteLength; i++) {
    expect(() => decodeBinaryFrame(buffer.slice(0, i))).toThrow();
  }
  for (const [at, byte] of [
    [3, 2],
    [4, 0],
    [5, 255],
    [7, 0],
  ]) {
    const b = new Uint8Array(buffer.slice(0));
    b[at!] = byte!;
    expect(() => decodeBinaryFrame(b.buffer)).toThrow();
  }
  expect(() =>
    decodeBinaryFrame(Uint8Array.from([...new Uint8Array(buffer), 0]).buffer),
  ).toThrow();
  expect(() =>
    encodeBinaryFrame(frame({ m: 'pump', ref: 1, extra: true })),
  ).toThrow();
  expect(() => encodeBinaryFrame(frame({ m: 'unknown', ref: 1 }))).toThrow();
  expect(() =>
    decodeBinaryFrame(
      encodeBinaryFrame(frame({ m: 'load', ref: 1, group: 'g' })),
    ),
  ).toThrow();
});

const artifact = resolve(
  import.meta.dir,
  process.env.NORTHTALK_WASM ?? '../../../.cache/zig-wasi/bin/talk.wasm',
);
test.skipIf(!existsSync(artifact))(
  'a real guest recovers from malformed binary and rejects stale tokens',
  async () => {
    const reactor = new Reactor(
      await WebAssembly.compile(readFileSync(artifact)),
      () => {},
    );
    const send = (f: Frame) => JSON.parse(reactor.frame(frameJSON(f)));
    expect(
      send({ m: 'hello', ref: 1, protocol: 1, features: [requestPumpFeature] })
        .ok.features,
    ).toContain(requestPumpFeature);
    send({ m: 'new-group', ref: 2, group: 'g', name: 'g' });
    send({
      m: 'load',
      ref: 3,
      group: 'g',
      name: 's',
      source: 'on go\n return 42\nend go',
    });
    const good = encodeBinaryFrame(
      frame({
        m: 'request-pump',
        ref: 4,
        group: 'g',
        token: 1,
        to: { script: 's' },
        message: { name: 'go', args: [] },
        now: '1970-01-01T00:00:00Z',
      }),
    );
    for (const bad of [
      good.slice(0, -1),
      Uint8Array.from([...new Uint8Array(good), 0]).buffer,
    ]) {
      expect(
        JSON.parse(
          new TextDecoder().decode(reactor.frameBytes(new Uint8Array(bad))),
        ).err.kind,
      ).toBe('protocol error');
    }
    const reply = plain(
      decodeBinaryFrame(reactor.frameBytes(new Uint8Array(good))),
    );
    expect(reply).toMatchObject({
      delivery: 'd1',
      token: 1,
      ok: { state: 'idle' },
    });
    expect(
      send({ m: 'cancel-correlated', ref: 5, group: 'g', token: 1 }).err.kind,
    ).toBe('protocol error');
    // Other messages and an ordinary JSON Pump remain JSON after negotiation.
    expect(
      send({ m: 'pump', ref: 6, group: 'g', now: '1970-01-01T00:00:00Z' }).ok
        .state,
    ).toBe('idle');
  },
);

test.skipIf(!existsSync(artifact))(
  'an unsupported guest retains ordinary APIs and refuses combined calls before admission',
  async () => {
    const original = Reactor.prototype.frameBytes;
    const spy = spyOn(Reactor.prototype, 'frameBytes').mockImplementation(
      function (this: Reactor, bytes) {
        if (bytes[0] === 123) {
          const f = JSON.parse(new TextDecoder().decode(bytes));
          if (f.m === 'hello') {
            f.features = f.features.filter(
              (x: string) => x !== requestPumpFeature,
            );
            bytes = new TextEncoder().encode(JSON.stringify(f));
          }
        }
        const reply = original.call(this, bytes);
        if (
          bytes[0] === 123 &&
          JSON.parse(new TextDecoder().decode(bytes)).m === 'hello'
        ) {
          const packet = JSON.parse(new TextDecoder().decode(reply));
          packet.ok.features = packet.ok.features.filter(
            (x: string) => x !== requestPumpFeature,
          );
          return new TextEncoder().encode(JSON.stringify(packet)).buffer;
        }
        return reply;
      },
    );
    try {
      const c = await createCore({ wasm: readFileSync(artifact) });
      const g = c.newGroup({ name: 'g' });
      const s = g.load({ name: 's', source: 'on go\n return 1\nend go' });
      expect(s.requestPump({ name: 'go' }, 0n)).toMatchObject({
        admitted: false,
      });
      const request = s.request({ name: 'go' });
      expect(request.id).toBe('d1');
      g.pump(0n);
      expect((await request.result).toString()).toBe('1');
    } finally {
      spy.mockRestore();
    }
  },
);
