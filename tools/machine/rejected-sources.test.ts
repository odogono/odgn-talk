import { expect, test } from 'bun:test';
import { isRejectedSource, rejectedUnits } from './rejected-sources';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('only diagnostic output of the source load rejects it for lowering', () => {
  expect(
    rejectedUnits(
      `> load bad identity=abcd\ndiag bad code="outside a loop" pos=2:1\n> load good\n> reload good source="bad source"\ndiag good code="unknown name" pos=1:1\n> add-library lib\ndiag lib code="name clash" pos=1:1\n`,
    ),
  ).toEqual(new Set(['bad', 'lib']));
  expect(rejectedUnits('> load good\n> vars\n')).toEqual(new Set());
  expect(
    rejectedUnits(
      '> load retry\ndiag retry code="unknown import" pos=1:1\n> load retry\n> vars\n',
    ),
  ).toEqual(new Set());
});

test('a shared source keeps its checks when another unit accepts it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-rejected-'));
  try {
    writeFileSync(
      join(dir, 'case.toml'),
      'kind = "trace"\n[[scripts]]\nname = "missing"\nsource = "shared.talk"\n[[scripts]]\nname = "fine"\nsource = "shared.talk"\n',
    );
    writeFileSync(
      join(dir, 'case.trace'),
      '> load missing\ndiag missing code="missing grant" pos=1:1\n> load fine\n> vars\n',
    );
    expect(isRejectedSource(join(dir, 'shared.talk'))).toBe(false);
    writeFileSync(
      join(dir, 'case.trace'),
      '> load missing\ndiag missing code="missing grant" pos=1:1\n> load fine\ndiag fine code="missing grant" pos=1:1\n> vars\n',
    );
    expect(isRejectedSource(join(dir, 'shared.talk'))).toBe(true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
