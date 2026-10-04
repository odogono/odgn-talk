import { expect, test } from 'bun:test';
import { newGroup, parseInstant } from '../src/index';

test('a paid Script send counts its pending reply before suspending', async () => {
  const lines: string[] = [];
  const g = newGroup({ name: 'test', trace: line => lines.push(line) });
  const a = g.load({
    limits: { persistentState: 223 },
    name: 'a',
    source: 'on go\n send ping with 7 to b and wait\nend go',
  });
  g.load({ name: 'b', source: 'on ping n\n return n\nend ping' });
  a.deliver({ name: 'go' });
  await g.pump(parseInstant('2026-10-04T12:00:00Z'));

  // Its 176-byte frame and 48-byte call cross the limit. The receiver still runs.
  expect(
    lines.some(line => line.startsWith('fault a/r1 limit=persistent')),
  ).toBe(true);
  expect(lines).toContain('abandon a/r1.c1');
  expect(lines).toContain(
    'run b/r1 outcome=completed handler=ping value=7 fuel=7 alloc=0',
  );
});
