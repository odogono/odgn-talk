import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { replay, runTraceCase, type Setup } from '../tools/trace-case';

const root = resolve(import.meta.dir, '../../../corpus/capabilities');
const cases = readdirSync(root).filter(name => /^(scope|effect)-/.test(name));

test.each(cases)(
  '%s meets the TS gate in normal, save/restore and recorded-result replay',
  name => {
    const dir = resolve(root, name);
    const setup = Bun.TOML.parse(
      readFileSync(resolve(dir, 'case.toml'), 'utf8'),
    ) as Setup;
    expect(runTraceCase(dir, setup).divergence).toBeUndefined();
    const recorded = readFileSync(resolve(dir, 'case.trace'), 'utf8')
      .split('\n')
      .filter(
        line => line && !line.startsWith('#') && !line.startsWith('> stub'),
      );
    expect(replay(dir, setup, recorded)).toEqual(recorded);
  },
);
