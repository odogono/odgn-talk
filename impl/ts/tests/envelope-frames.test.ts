import { expect, test } from 'bun:test';
import frames from '../../testdata/envelope-frames.json';
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
} from '../src/request-pump-binary';
import { readOrderedJSON, type Json } from '../src/readers';
import { decodeJsonView, encodeJsonMessage } from '../src/wasm/envelope-json';
import { plain, type Frame } from '../src/wasm/wire';

// JSON-only vectors, without `hex`, are checked by `envelope:check`.
for (const frame of frames.flatMap(f =>
  'hex' in f && f.hex ? [{ ...f, hex: f.hex }] : [],
)) {
  test(`shared fields envelope: ${frame.name}`, () => {
    const bytes = Uint8Array.from(Buffer.from(frame.hex, 'hex'));
    expect(
      Buffer.from(encodeBinaryFrame(readOrderedJSON(frame.tree))).toString(
        'hex',
      ),
    ).toBe(frame.hex);
    expect(plain(decodeBinaryFrame(bytes.buffer))).toEqual(
      plain(readOrderedJSON(frame.tree)),
    );
    expect(
      Buffer.from(encodeBinaryFrame(decodeBinaryFrame(bytes.buffer))).toString(
        'hex',
      ),
    ).toBe(frame.hex);
  });
}

test('settle-pump rejects malformed settlement records', () => {
  // ref=1, group=g, absent Pump options, one settlement. These literals
  // exercise the reader without producing the malformed input with its writer.
  const prefix = '4e544201010a060603011201670000000601';
  for (const settlement of [
    '06051201631206616e73776572000000', // Five fields instead of six.
    '0700', // A map instead of a positional list.
    '0606001206616e7377657200000000', // No call.
    '0606120163120362616400000000', // Unknown outcome.
    '06061201631206616e73776572001201660000', // Text fuel.
    '0606120163030100000000', // Integer outcome.
  ]) {
    const bytes = Uint8Array.from(Buffer.from(prefix + settlement, 'hex'));
    expect(() => decodeBinaryFrame(bytes.buffer)).toThrow();
  }
  const valid = frames.find(v => v.name === 'settle-pump')!;
  const bytes = Uint8Array.from(Buffer.from(valid.hex + '00', 'hex'));
  expect(() => decodeBinaryFrame(bytes.buffer)).toThrow();
});

/** A decoded record as plain data: its opaque nodes through `plain`. */
const plainDeep = (x: unknown): unknown =>
  x === null || typeof x !== 'object'
    ? x
    : Array.isArray(x)
      ? x.map(plainDeep)
      : 'kind' in x
        ? plain(x as Json)
        : Object.fromEntries(
            Object.entries(x).map(([k, v]) => [k, plainDeep(v)]),
          );

test('the JSON layout decodes the inspection vector to every field', () => {
  const frame = frames.find(v => v.name === 'inspection')!;
  const tree = readOrderedJSON(frame.tree);
  const view = decodeJsonView('inspection', tree);
  expect(plainDeep(view)).toEqual(plain(tree));
  const [s] = view.scripts;
  expect(s!.disabledGrants).toEqual(['api']);
  expect(s!.runs[0]!.until).toBe('2026-10-19T12:00:00.25Z');
  expect(s!.mailbox[0]!.from).toBe('t');
});

test('the JSON layout refuses an inspection without a required field', () => {
  expect(() =>
    decodeJsonView('inspection', readOrderedJSON('{"scripts":[{"name":"s"}]}')),
  ).toThrow('lacks vars');
});

test('the JSON layout encodes each Load vector but the exchange fields', () => {
  for (const frame of frames.filter(v => v.name.startsWith('load'))) {
    const tree = readOrderedJSON(frame.tree);
    const fields = Object.fromEntries(
      (tree as unknown as { pairs: [string, Json][] }).pairs.filter(
        ([k]) => !['m', 'ref', 'group'].includes(k),
      ),
    ) as unknown as Parameters<typeof encodeJsonMessage<'load'>>[1];
    const encoded = encodeJsonMessage('load', fields);
    expect(plainDeep(encoded)).toEqual(
      plainDeep(fields as Record<string, Frame>),
    );
  }
});
