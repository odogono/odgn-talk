import { expect, test } from 'bun:test';
import { newGroup, parseInstant } from '../src/index';

const clock = parseInstant('2026-10-04T12:00:00Z');

test('a Script-only Join counts pending members at its closing end', () => {
  const lines: string[] = [];
  const g = newGroup({ name: 'test', trace: line => lines.push(line) });
  const a = g.load({
    name: 'a',
    limits: { persistentState: 223 },
    source:
      'on go\n wait for all\n  send ping with 7 to b and wait\n end wait\nend go',
  });
  g.load({ name: 'b', source: 'on ping n\n return n\nend ping' });
  a.deliver({ name: 'go' });
  g.pump(clock);
  expect(
    lines.some(line => line.startsWith('fault a/r1 limit=persistent')),
  ).toBe(true);
  expect(lines).toContain('abandon a/r1.c1');
  expect(lines).toContain(
    'run b/r1 outcome=completed handler=ping value=7 fuel=7 alloc=0',
  );
});

test('a Script reply arriving before a preempted Join closes is retained', () => {
  const lines: string[] = [];
  const g = newGroup({ name: 'test', trace: line => lines.push(line) });
  const a = g.load({
    name: 'a',
    source:
      'on go\n wait for all\n  send ping with 7 to b and wait\n end wait\n return it\nend go',
  });
  g.load({ name: 'b', source: 'on ping n\n return n\nend ping' });
  a.deliver({ name: 'go' });
  g.pump(clock, { fuelSlice: 38 });
  g.pump(clock);
  expect(
    lines.some(
      line =>
        line.startsWith('run a/r1 outcome=completed ') &&
        line.includes('value=[7]'),
    ),
  ).toBe(true);
});
