import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blessCase, type Step } from './bless';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'northtalk-bless-'));
  const dir = join(root, 'case');
  mkdirSync(dir);
  writeFileSync(join(dir, 'case.toml'), 'kind = "trace"\n');
  writeFileSync(join(dir, 'case.trace'), 'old\n');
  return { dir, root };
};

// Each step is a shell command; the case name arrives as $0.
const write = (root: string): Step => ({
  command: [
    'sh',
    '-c',
    `echo new > "${root}/$0/case.trace"; printf x > "${root}/$0/extra"`,
  ],
  name: 'write',
});
const pass: Step = { command: ['sh', '-c', 'exit 0'], name: 'first' };
const diverge: Step = {
  command: ['sh', '-c', 'echo "FAIL $0 line 1"; exit 1'],
  name: 'second',
};

test('bless keeps the written expectations when every Core agrees', () => {
  const { dir, root } = fixture();
  try {
    expect(blessCase(root, 'case', write(root), [pass, pass])).toEqual({
      blessed: true,
      name: 'case',
    });
    expect(readFileSync(join(dir, 'case.trace'), 'utf8')).toBe('new\n');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('bless restores the case and reports the first divergence when a Core disagrees', () => {
  const { dir, root } = fixture();
  try {
    expect(blessCase(root, 'case', write(root), [pass, diverge])).toEqual({
      blessed: false,
      name: 'case',
      output: 'FAIL case line 1\n',
      step: 'second',
    });
    expect(readFileSync(join(dir, 'case.trace'), 'utf8')).toBe('old\n');
    expect(existsSync(join(dir, 'extra'))).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('bless refuses a name that is not a case', () => {
  const { root } = fixture();
  try {
    expect(() => blessCase(root, 'missing', write(root), [])).toThrow(
      'unknown case missing',
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
