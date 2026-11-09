// Browse's clock (ADR 0174, from Perform's toolbar #2002).
import { expect, test } from 'bun:test';
import { clockText } from '../src/transport-controls';

test('the clock counts the bar on from the worker’s anchor by the tempo', () => {
  expect(clockText(undefined, 0)).toBe('');
  expect(clockText({ at: 0, beatsPerBar: 4, tempo: 120 }, 5000)).toBe(
    '120 BPM',
  );
  const anchor = { at: 1000, beatsPerBar: 4, count: 5.5, tempo: 120 };
  expect(clockText(anchor, 1000)).toBe('120 BPM · bar 2.2');
  // Two beats a second at 120 BPM.
  expect(clockText(anchor, 2000)).toBe('120 BPM · bar 2.4');
  expect(clockText(anchor, 2500)).toBe('120 BPM · bar 3.1');
  // After a time-signature change the count is from its bar line (ADR 0166).
  const threeFour = { at: 0, bar: 2, beatsPerBar: 3, count: 4, tempo: 120 };
  expect(clockText(threeFour, 0)).toBe('120 BPM · bar 4.2');
});
