import { expect, test } from 'bun:test';
import {
  defineCapability,
  newGroup,
  nothing,
  parseInstant,
} from '../src/index';

test('an immediate Operation checks declared allocation together with call Fuel', () => {
  let effects = 0;
  const service = defineCapability('service', {
    inspect: {
      mode: 'immediate',
      cost: { fuel: 7, alloc: 100 },
      do: () => {
        effects++;
        return nothing;
      },
    },
  });
  const lines: string[] = [];
  const group = newGroup({ name: 'test', trace: line => lines.push(line) });
  group
    .load({
      name: 's',
      source: 'on go\n ask service to inspect\nend go',
      grants: { service: service.grant('all', undefined) },
      limits: { allocPerRun: 20 },
    })
    .deliver({ name: 'go' });
  const result = group.pump(parseInstant('2026-10-04T12:00:00Z'));

  expect(effects).toBe(0);
  expect(lines.some(line => line.startsWith('call s/r1.'))).toBe(false);
  // Chapter 8: instruction Fuel/allocation, including the first clause charge,
  // are checked together. An unpaid instruction consumes neither budget.
  expect(result.reports).toMatchObject([
    {
      kind: 'run end',
      outcome: 'limit fault',
      limit: 'alloc',
      at: { unit: 's', handler: 'go', line: 2, col: 2, pc: 2 },
      fuel: 0,
      alloc: 0,
    },
  ]);
  expect(result.fuelUsed).toBe(0);
});
