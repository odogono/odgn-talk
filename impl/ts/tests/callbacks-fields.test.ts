import { expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { BinaryWriter, integerItem } from '../src/binary-value';
import {
  callbacksFeature,
  decodeBinaryFrame,
  decodeNeed,
  encodeBinaryFrame,
  encodeResult,
  isRequestPumpBinary,
  requestPumpFeature,
} from '../src/request-pump-binary';
import { num } from '../src/values';
import { binaryValues, decode, encode } from '../src/wasm/codec';
import {
  answerFields,
  field,
  frameJSON,
  frameTree,
  listOf,
  plain,
  type Frame,
} from '../src/wasm/wire';
import { Reactor } from '../src/wasm/reactor';
import { callbackScenario } from '../tools/wasm-callbacks';
import { artifact } from './reactor-artifact';

const roundTrip = (frame: Frame) =>
  plain(decodeBinaryFrame(encodeBinaryFrame(frameTree(frame))));

test('all callback needs preserve Values, protocol text and notices', () => {
  for (const need of [
    {
      m: 'op',
      call: 'c',
      script: 's',
      run: 'r',
      segment: 'seg',
      grant: 'g',
      capability: 'api',
      operation: 'echo',
      mode: 'immediate',
      now: '2026-01-01T00:00:00Z',
      args: [null, { $dec: '0.00' }, { $map: [['$x', { $bytes: 'AP8=' }]] }],
      scope: 'transaction',
      automatic: true,
      fuelLeft: 10,
    },
    {
      m: 'prop',
      object: { $object: ['thing', 'e\u0301'] },
      prop: 'value',
      value: null,
    },
    {
      m: 'prop',
      object: { $object: ['thing', 'id'] },
      prop: 'elements',
      op: 'at',
      selector: { $quantity: ['1.00', 'm'] },
    },
    {
      m: 'effect',
      script: 's',
      run: 'r',
      segment: 'seg',
      grant: 'g',
      grants: ['g', 'g2'],
      coordinator: 'co',
      phase: 'rollback',
      now: '2026-01-01T00:00:00Z',
    },
    {
      m: 'release',
      script: 's',
      grant: 'g',
      reason: 'stop',
      now: '2026-01-01T00:00:00Z',
    },
  ]) {
    const packet: Frame = {
      ref: 7,
      need,
      abandoned: ['c1'],
      settled: ['c2'],
      trace: ['e\u0301'],
    };
    expect(roundTrip(packet)).toEqual(packet);
  }
});

test('callback result outcomes retain Nothing, decimal scale, failures and charges', () => {
  for (const m of ['op-result', 'prop-result']) {
    const outcomes =
      m === 'op-result'
        ? [
            { result: null },
            { result: { $dec: '0.00' } },
            { started: true },
            { done: true },
            { limit: true },
          ]
        : [{ value: null }, { value: { $bytes: 'AP8=' } }, { ok: true }];
    for (const outcome of [
      ...outcomes,
      {
        fail: {
          code: 'oops',
          message: 'e\u0301',
          data: { $map: [['$x', true]] },
        },
      },
    ]) {
      const packet = { m, ref: -1, group: 'g', charged: 5, ...outcome };
      expect(roundTrip(packet)).toEqual(packet);
    }
    expect(
      roundTrip({ m, ref: 1, group: 'g', hostError: 'Host-only detail' }),
    ).toEqual({ m, ref: 1, group: 'g', hostError: '' });
  }
  for (const packet of [
    { m: 'effect-result', ref: 1, group: 'g', status: 'unknown' },
    { m: 'release-result', ref: 1, group: 'g' },
  ]) {
    expect(roundTrip(packet)).toEqual(packet);
  }
});

test('direct results match the frame encoder byte for byte', () => {
  const codec = { identity: {}, object: () => undefined };
  for (const [need, answer] of [
    ['op', { result: encode(codec, num(42)), charged: 3 }],
    ['op', { fail: { code: 'oops', message: 'm', data: undefined } }],
    ['prop', { ok: true }],
    ['effect', { status: 'unknown' }],
    ['release', {}],
  ] as const) {
    const frame = { ...answer, m: `${need}-result`, ref: 4, group: 'g' };
    expect(
      new Uint8Array(encodeResult(need, 4, 'g', answerFields(answer))!),
    ).toEqual(new Uint8Array(encodeBinaryFrame(frameTree(frame))));
  }
  expect(encodeResult('resolve', 4, 'g', {})).toBeUndefined();
});

test('a direct need holds its Values, and an unknown Object fails only its use', () => {
  const codec = { identity: {}, object: () => undefined };
  const bytes = encodeBinaryFrame(
    frameTree({
      ref: 2,
      need: {
        m: 'op',
        call: 'c',
        script: 's',
        run: 'r',
        segment: 'seg',
        grant: 'g',
        capability: 'api',
        operation: 'echo',
        mode: 'immediate',
        now: '2026-01-01T00:00:00Z',
        args: [{ $dec: '1.50' }, { $object: ['thing', 'gone'] }],
      },
    }),
  );
  const need = field(decodeNeed(bytes, binaryValues(codec)), 'need');
  const [first, second] = listOf(field(need, 'args'));
  expect(decode(codec, first).toString()).toBe('1.50');
  expect(() => decode(codec, second)).toThrow('No Host Object thing gone');
  expect(() =>
    decodeNeed(
      encodeBinaryFrame(frameTree({ m: 'release-result', ref: 1, group: 'g' })),
      {},
    ),
  ).toThrow();
});

const raw = (tag: number, count: number) => {
  const w = new BinaryWriter();
  w.output.push(0x4e, 0x54, 0x42, 1, 1, tag, 6, count);
  return w;
};

test('malformed callback fields and unknown outcomes are refused before dispatch', () => {
  const unknown = raw(6, 7);
  unknown.item(integerItem(1n));
  unknown.item({ tag: 18, data: 'g' });
  unknown.item({ tag: 18, data: 'invalid' });
  for (let i = 0; i < 4; i++) {
    unknown.item({ tag: 0 });
  }
  const wrongObject = raw(0x84, 10);
  wrongObject.item(integerItem(1n));
  wrongObject.item({ tag: 6, data: [{ tag: 18, data: 'kind' }] });
  for (let i = 0; i < 8; i++) {
    wrongObject.item({ tag: 0 });
  }
  const getterWithValue = raw(0x84, 10);
  getterWithValue.item(integerItem(1n));
  getterWithValue.item({
    tag: 6,
    data: [
      { tag: 18, data: 'kind' },
      { tag: 18, data: 'id' },
    ],
  });
  getterWithValue.item({ tag: 18, data: 'value' });
  getterWithValue.item({ tag: 1 });
  getterWithValue.item(integerItem(1n));
  for (let i = 0; i < 5; i++) {
    getterWithValue.item({ tag: 0 });
  }
  const missingFields = raw(0x83, 17);
  missingFields.item(integerItem(1n));
  for (let i = 0; i < 16; i++) {
    missingFields.item({ tag: 0 });
  }
  const good = encodeBinaryFrame(
    frameTree({ m: 'release-result', ref: 1, group: 'g' }),
  );
  for (const bad of [
    unknown.buffer(),
    wrongObject.buffer(),
    getterWithValue.buffer(),
    missingFields.buffer(),
    good.slice(0, -1),
    Uint8Array.from([...new Uint8Array(good), 0]).buffer,
  ]) {
    expect(() => decodeBinaryFrame(bad)).toThrow();
  }
  expect(() =>
    roundTrip({ m: 'op-result', ref: 1, group: 'g', result: 1, done: true }),
  ).toThrow();
  expect(() =>
    roundTrip({
      m: 'op-result',
      ref: 1,
      group: 'g',
      result: null,
      charged: -1,
    }),
  ).toThrow();
});

test.skipIf(!existsSync(artifact))(
  'a binary need accepts JSON answers and rejects a wrong ref without consuming the need',
  async () => {
    const original = Reactor.prototype.frameBytes;
    let checked = false;
    const spy = spyOn(Reactor.prototype, 'frameBytes').mockImplementation(
      function (this: Reactor, bytes) {
        if (isRequestPumpBinary(bytes) && bytes[5]! >= 6 && bytes[5]! <= 9) {
          const frame = plain(
            decodeBinaryFrame(bytes.slice().buffer),
          ) as Record<string, Frame>;
          if (!checked) {
            const bad = encodeBinaryFrame(frameTree({ ...frame, ref: -123 }));
            const refused = JSON.parse(
              new TextDecoder().decode(
                original.call(this, new Uint8Array(bad)),
              ),
            );
            expect(refused.err.kind).toBe('protocol error');
            checked = true;
          }
          bytes = new TextEncoder().encode(frameJSON(frame));
        }
        return original.call(this, bytes);
      },
    );
    try {
      const result = await callbackScenario(readFileSync(artifact), true);
      expect(checked).toBe(true);
      expect(result.setterNothing).toBe(true);
      expect(result.events).toContain('release:stop');
    } finally {
      spy.mockRestore();
    }
  },
);
for (const binaryCallbacks of [true, false]) {
  for (const binaryPump of [true, false]) {
    test.skipIf(!existsSync(artifact))(
      `real callback wire: callbacks=${binaryCallbacks}, Pump=${binaryPump}`,
      async () => {
        const inputs: (number | string)[] = [];
        const outputs: number[] = [];
        const original = Reactor.prototype.frameBytes;
        const spy = spyOn(Reactor.prototype, 'frameBytes').mockImplementation(
          function (this: Reactor, bytes) {
            if (!isRequestPumpBinary(bytes)) {
              const frame = JSON.parse(new TextDecoder().decode(bytes));
              inputs.push(frame.m);
              if (frame.m === 'hello') {
                expect(frame.features.includes(callbacksFeature)).toBe(
                  binaryCallbacks,
                );
              }
              if (frame.m === 'hello' && !binaryPump) {
                frame.features = frame.features.filter(
                  (f: string) => f !== requestPumpFeature,
                );
                bytes = new TextEncoder().encode(JSON.stringify(frame));
              }
            } else {
              inputs.push(bytes[5]!);
            }
            let reply = original.call(this, bytes);
            if (isRequestPumpBinary(new Uint8Array(reply))) {
              outputs.push(new Uint8Array(reply)[5]!);
            }
            if (!binaryPump && inputs.at(-1) === 'hello') {
              const frame = JSON.parse(new TextDecoder().decode(reply));
              frame.ok.features = frame.ok.features.filter(
                (f: string) => f !== requestPumpFeature,
              );
              reply = new TextEncoder().encode(JSON.stringify(frame)).buffer;
            }
            return reply;
          },
        );
        try {
          // Combined calls require Pump negotiation, so the unsupported-Pump case
          // uses ordinary admission and Pump through a directly negotiated Session below.
          if (!binaryPump) {
            const { Session } = await import('../src/wasm/session');
            const session = new Session(
              await WebAssembly.compile(readFileSync(artifact)),
              () => {},
              { handleOf: () => 'api', kinds: [] },
              binaryCallbacks,
            );
            session.exchange('new-group', { group: 'g', name: 'g' });
            session.exchange('define-capability', {
              name: 'api',
              handle: 'api',
              ops: [
                {
                  name: 'echo',
                  mode: 'immediate',
                  args: [],
                  result: 'value',
                  cost: { fuel: 1, alloc: 0 },
                },
              ],
            });
            const grant = plain(
              session.exchange('grant', { capability: 'api', ops: ['echo'] }),
            ) as { grant: number };
            session.exchange('load', {
              group: 'g',
              name: 's',
              source: 'on go\n ask api to echo\n return it\nend go',
              grants: { api: grant.grant },
            });
            session.exchange('request', {
              group: 'g',
              to: { script: 's' },
              message: { name: 'go', args: [] },
            });
            session.exchange(
              'pump',
              { group: 'g', now: '2026-01-01T00:00:00Z' },
              () => ({ result: null, charged: 0 }),
            );
            expect(inputs).toContain(binaryCallbacks ? 6 : 'op-result');
            expect(outputs.includes(0x83)).toBe(binaryCallbacks);
          } else {
            const result = await callbackScenario(
              readFileSync(artifact),
              binaryCallbacks,
            );
            expect(result.setterNothing).toBe(true);
            expect(result.failure).toBe('"refused"');
            expect(result.events).toEqual([
              'set:nothing',
              'get',
              'begin',
              'echo',
              'commit',
              'release:stop',
            ]);
            for (const tag of [6, 7, 8, 9]) {
              expect(inputs.includes(tag)).toBe(binaryCallbacks);
            }
            for (const tag of [0x83, 0x84, 0x85, 0x86]) {
              expect(outputs.includes(tag)).toBe(binaryCallbacks);
            }
            if (!binaryCallbacks) {
              for (const m of [
                'op-result',
                'prop-result',
                'effect-result',
                'release-result',
              ]) {
                expect(inputs).toContain(m);
              }
            }
          }
        } finally {
          spy.mockRestore();
        }
      },
    );
  }
}
