// Chapter 12, The foreground: one more Pump for queued Host Inputs; and Store
// Notifications, The Session Host: Pumps at the same Clock reading for
// Notifications, until none is left queued.
import { expect, test } from 'bun:test';
import {
  SessionHost,
  parseTranscript,
  replayTranscript,
  writeTranscript,
  type TranscriptItem,
} from '../src/session';
import { dec } from '../src/values';

// A Session whose `bell` getter queues a `rang` Delivery each time it is read.
const bellSession = () => {
  const items: TranscriptItem[] = [];
  let reads = 0;
  let clock = 0n;
  const host = new SessionHost({
    now: () => (clock += 1_000_000n),
    record: i => items.push(i),
    objects: c => {
      const kind = c.defineKind({
        name: 'Bell',
        props: {
          ring: {
            get: () => {
              c.action({
                kind: 'deliver',
                to: { script: 'session' },
                message: { name: 'rang', args: [] },
              });
              return dec(String(++reads));
            },
          },
        },
      });
      return { bell: c.object(kind, 'bell', {}) };
    },
  });
  return { host, items };
};
const pumps = (items: readonly TranscriptItem[]) =>
  items.filter(i => i.k === 'clock').length;

test('a getter that queues a Delivery is followed by one more Pump, whose lines come after the command’s', () => {
  const { host, items } = bellSession();
  host.input('on rang\nsay "rang"\nend rang');
  const before = pumps(items);
  expect(host.input('say the ring of bell')).toEqual([
    '1',
    '[session/r2] rang',
  ]);
  // The Entry's Pump, then the Pump for the queued Delivery, with its own reading.
  expect(pumps(items) - before).toBe(2);
  const transcript = writeTranscript(items);
  expect(transcript).toMatch(/\n1\n@ \S+\n\[session\/r2\] rang\n$/u);
  expect(
    writeTranscript(replayTranscript(parseTranscript(transcript)).items),
  ).toBe(transcript);
});

test('a Handler that reads the getter again gets exactly one more Pump per Host call', () => {
  const { host, items } = bellSession();
  host.input('on rang\nsay "rang " & the ring of bell\nend rang');
  let before = pumps(items);
  expect(host.input('say the ring of bell')).toEqual([
    '1',
    '[session/r2] rang 2',
  ]);
  expect(pumps(items) - before).toBe(2);
  // What the extra Pump left queued waits for the next Host call, even one
  // that doesn't pump itself, and gets its one extra Pump there.
  before = pumps(items);
  expect(host.input(':runs')).toEqual(['[session/r3] rang 3']);
  expect(pumps(items) - before).toBe(1);
  const transcript = writeTranscript(items);
  expect(
    writeTranscript(replayTranscript(parseTranscript(transcript)).items),
  ).toBe(transcript);
});

test('Notifications pump again at the same Clock reading until a Pump leaves none', () => {
  const items: TranscriptItem[] = [];
  let clock = 0n;
  const host = new SessionHost({
    now: () => (clock += 1_000_000n),
    record: i => items.push(i),
  });
  host.input(':grant n store');
  host.input(
    'on counted change, queued\nask n to get "k"\nsay it\nif it < 3 then ask n to set "k", it + 1\nend counted',
  );
  host.input('ask n to watch "w", "k", "counted"');
  const before = pumps(items);
  expect(host.input('ask n to set "k", 1')).toEqual([
    '[session/r3] 1',
    '[session/r4] 2',
    '[session/r5] 3',
  ]);
  // One reading: the Notifications' Pumps take the Entry's.
  expect(pumps(items) - before).toBe(1);
  const transcript = writeTranscript(items);
  expect(
    writeTranscript(replayTranscript(parseTranscript(transcript)).items),
  ).toBe(transcript);
});
