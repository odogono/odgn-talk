import { expect, test } from 'bun:test';
import frames from '../../testdata/envelope-frames.json';
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
} from '../src/request-pump-binary';
import { readOrderedJSON } from '../src/readers';

for (const frame of frames) {
  test(`shared fields envelope: ${frame.name}`, () => {
    const bytes = Uint8Array.from(Buffer.from(frame.hex, 'hex'));
    expect(
      Buffer.from(encodeBinaryFrame(readOrderedJSON(frame.tree))).toString(
        'hex',
      ),
    ).toBe(frame.hex);
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
