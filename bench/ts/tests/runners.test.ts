import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { selectRunners, coreRunners, peerRunners } from '../src/runners';

test('the default and peers selections retain every existing runner', () => {
  expect(selectRunners()).toEqual([...coreRunners, ...peerRunners]);
  expect(selectRunners('peers')).toEqual(peerRunners);
  expect(selectRunners('zig')).toEqual(['zig']);
});

test('a focused comparison selects exactly the named runners', () => {
  expect(selectRunners('zig,ts,applescript,gopher-lua')).toEqual([
    'zig',
    'ts',
    'applescript',
    'gopher-lua',
  ]);
  expect(selectRunners(' ts,ts,peers,gopher-lua ')).toEqual([
    'ts',
    ...peerRunners,
  ]);
});

test('unknown and empty selections fail before starting measurements', () => {
  for (const only of ['', 'zig,', 'lua', 'ts,unknown']) {
    expect(() => selectRunners(only)).toThrow(
      '--only takes comma-separated runner names',
    );
  }
});

test('the CLI measures only the selected Core and Go peer', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, '../src/main.ts'),
      '--only',
      'ts,gopher-lua',
      '--filter',
      'core/loop',
      '--smoke',
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  expect(result.exitCode).toBe(0);
  const report = result.stdout.toString();
  const rows = report
    .split('\n')
    .filter(line => line.startsWith('| core/loop |'));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain('| ts |');
  expect(rows[1]).toContain('| gopher-lua |');
  expect(report).toContain('runners ts,gopher-lua');
  for (const excluded of [
    'wasmoon',
    'quickjs',
    'cpython',
    'starlark',
    'AppleScript',
  ]) {
    expect(report).not.toContain(excluded);
    expect(result.stderr.toString()).not.toContain(excluded);
  }
}, 30_000);
