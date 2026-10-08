import { operationalReports } from './operational-reports';
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

for (const ending of ['end', 'end wait']) {
  for (const failure of ['reply', 'timeout']) {
    for (const context of ['Handler', 'local Handler', 'block Lambda']) {
      test(`${failure} in a ${context} Join is raised at ${ending}`, () => {
        const members = `wait for all\n   send ping to b and wait\n   send ping to c and wait\n  ${ending} -- close`;
        const body =
          context === 'Handler'
            ? members
            : context === 'local Handler'
              ? 'query and wait'
              : `put given\n  ${members}\n end given into f\n f() and wait`;
        const source = `on go\n try\n  ${body}\n catch e\n  return e\n end try\nend go${context === 'local Handler' ? `\non query\n  ${members}\nend query` : ''}`;
        const closingLine =
          source.split('\n').findIndex(line => line.includes('-- close')) + 1;
        const lines: string[] = [];
        const g = newGroup({ name: 'test', trace: line => lines.push(line) });
        const a = g.load({ name: 'a', source, limits: { maxWaitMs: 1000 } });
        g.load({
          name: 'b',
          source: 'on ping\n wait 2 s\n return 7\nend ping',
        });
        g.load({
          name: 'c',
          source:
            failure === 'reply'
              ? 'on ping\n throw "bad"\nend ping'
              : 'on ping\n wait 2 s\n return 9\nend ping',
        });
        a.deliver({ name: 'go' });
        let result = g.pump(clock);
        if (failure === 'timeout') {
          result = g.pump(clock + 1_000_000_000n);
        }
        const end = operationalReports(result.reports).find(
          r => r.kind === 'run end' && r.script === 'a',
        );
        if (!end || end.kind !== 'run end' || !end.result) {
          throw new Error('no sender result');
        }
        const error = end.result;
        expect(error.get('code').asText()).toBe(
          failure === 'reply' ? 'send failed' : 'timeout',
        );
        expect(error.get('index').toString()).toBe(
          failure === 'reply' ? '2' : '1',
        );
        expect(error.get('at').get('unit').asText()).toBe('a');
        expect(error.get('at').get('line').toString()).toBe(
          String(closingLine),
        );
        expect(error.get('at').get('column').toString()).toBe('3');
        expect(
          lines.some(
            line =>
              line.startsWith('raise a/r1 ') &&
              line.endsWith(`pos=${closingLine}:3`),
          ),
        ).toBe(true);
        if (failure === 'reply') {
          expect(error.get('reason').asText()).toBe('errored');
          expect(error.get('error').get('code').asText()).toBe('bad');
          expect(error.get('error').get('at').get('unit').asText()).toBe('c');
          expect(error.get('error').get('at').get('line').toString()).toBe('2');
          expect(error.get('error').get('at').get('column').toString()).toBe(
            '2',
          );
        } else {
          expect(error.get('after').toString()).toBe('1000 ms');
        }
      });
    }
  }
}
