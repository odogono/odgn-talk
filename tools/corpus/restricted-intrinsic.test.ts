import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileSource } from '../machine/compile';

test('reference lowering grants the private intrinsic only to trusted stdlib', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../spec/stdlib/map.talk'),
    'utf8',
  );
  const ordinary = compileSource('map', 'library', source);
  const trusted = compileSource('map', 'library', source, {
    trustedStdlib: true,
  });
  expect(ordinary.code.some(i => i.op === 'call-restricted')).toBe(false);
  const calls = trusted.code.filter(i => i.op === 'call-restricted');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toEqual([]);
  const body = trusted.bodies.find(b => b.name === 'restrictedCall')!;
  expect(trusted.code.slice(body.start, body.end).map(i => i.op)).toEqual([
    'load',
    'load',
    'call-restricted',
    'return',
    'const',
    'return',
  ]);
});
