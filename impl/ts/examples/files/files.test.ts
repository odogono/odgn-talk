import { operationalReports } from '../../tests/operational-reports';
import { afterEach, expect, test } from 'bun:test';
import {
  fstatSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  newGroup,
  parseInstant,
  type Group,
  type Limits,
} from '../../src/index';
import { createFileHost, type FileHostOptions } from './host';

const now = parseInstant('2026-10-03T09:00:00Z');
const hosts: ReturnType<typeof createFileHost>[] = [];
const groups: Group[] = [];
afterEach(() => {
  try {
    for (const group of groups.splice(0)) {
      group.script('writer')!.stop('test cleanup');
      group.pump(now + 1_000_000n);
    }
  } finally {
    for (const host of hosts.splice(0)) {
      host.dispose();
    }
  }
});
const start = (
  mode: 'immediate' | 'staged',
  body: string,
  options: FileHostOptions = {},
  limits: Partial<Limits> = {},
) => {
  const host = createFileHost(mode, options);
  hosts.push(host);
  const group = newGroup({ name: 'files' });
  groups.push(group);
  const script = group.load({
    name: 'writer',
    source: `on export\n${body}\nend export`,
    grants: { output: host.grant },
    limits,
  });
  script.deliver({ name: 'export' });
  return { group, script, host, path: join(host.directory, 'report.txt') };
};
const opened =
  'ask output to open "report.txt"\nask output to write "new bytes"';
const closed = `${opened}\nask output to close`;
const fault = '\nrepeat forever\nend repeat';
const preempt = (group: Group) => {
  expect(
    operationalReports(group.pump(now, { fuelSlice: 50, fuelCap: 50 }).reports),
  ).toEqual([]);
};

test('ordinary write followed by a Limit Fault closes the actual handle and keeps bytes', () => {
  const { group, host, path } = start(
    'immediate',
    opened + fault,
    {},
    { fuelPerRun: 150 },
  );
  preempt(group);
  const [fd] = host.openHandles();
  expect(fd).toBeDefined();
  expect(fstatSync(fd!).isFile()).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe('new bytes');
  expect(group.pump(now).reports).toContainEqual(
    expect.objectContaining({ outcome: 'limit fault' }),
  );
  expect(host.openHandles()).toEqual([]);
  expect(() => fstatSync(fd!)).toThrow();
  expect(readFileSync(path, 'utf8')).toBe('new bytes');
});

test('staged close stays invisible across preemption and publishes once on successful completion', () => {
  let publications = 0;
  const { group, host, path } = start(
    'staged',
    closed + '\nrepeat 50 times\nend repeat',
    {
      publish: (source, destination) => {
        publications++;
        renameSync(source, destination);
        return { status: 'ok' };
      },
    },
  );
  writeFileSync(path, 'old bytes');
  preempt(group);
  expect(host.openHandles()).toEqual([]);
  expect(readFileSync(path, 'utf8')).toBe('old bytes');
  expect(readdirSync(host.directory)).toHaveLength(2);
  expect(publications).toBe(0);
  expect(() => group.save()).toThrow('effects pending');
  expect(group.pump(now).reports).toContainEqual(
    expect.objectContaining({ outcome: 'completed' }),
  );
  expect(readFileSync(path, 'utf8')).toBe('new bytes');
  expect(readdirSync(host.directory)).toEqual(['report.txt']);
  expect(publications).toBe(1);
});

test('a fault after staged close preserves the destination and removes staging', () => {
  const { group, host, path } = start(
    'staged',
    closed + fault,
    {},
    { fuelPerRun: 150 },
  );
  writeFileSync(path, 'old bytes');
  expect(group.pump(now).reports).toContainEqual(
    expect.objectContaining({ outcome: 'limit fault' }),
  );
  expect(readFileSync(path, 'utf8')).toBe('old bytes');
  expect(readdirSync(host.directory)).toEqual(['report.txt']);
  expect(host.openHandles()).toEqual([]);
});

test.each(['', '\nthrow {code: "ordinary"}'])(
  'unfinished staging is discarded at Run end %s',
  boundary => {
    const { group, host, path } = start('staged', opened + boundary);
    writeFileSync(path, 'old bytes');
    group.pump(now);
    expect(readFileSync(path, 'utf8')).toBe('old bytes');
    expect(readdirSync(host.directory)).toEqual(['report.txt']);
    expect(host.openHandles()).toEqual([]);
  },
);

test('ordinary error after explicit staged close still commits', () => {
  const { group, host, path } = start(
    'staged',
    closed + '\nthrow {code: "ordinary"}',
  );
  expect(group.pump(now).reports).toContainEqual(
    expect.objectContaining({ outcome: 'errored' }),
  );
  expect(readFileSync(path, 'utf8')).toBe('new bytes');
  expect(readdirSync(host.directory)).toEqual(['report.txt']);
});

test('a second staged destination is rejected before touching it, while the first commits', () => {
  const { group, host, path } = start(
    'staged',
    closed + '\nask output to open "other.txt"',
  );
  const other = join(host.directory, 'other.txt');
  writeFileSync(other, 'untouched');
  expect(group.pump(now).reports).toContainEqual(
    expect.objectContaining({
      outcome: 'errored',
      error: expect.objectContaining({ code: 'destination conflict' }),
    }),
  );
  expect(readFileSync(path, 'utf8')).toBe('new bytes');
  expect(readFileSync(other, 'utf8')).toBe('untouched');
  expect(readdirSync(host.directory).sort()).toEqual([
    'other.txt',
    'report.txt',
  ]);
});

test('the same staged destination may be reopened in its Run scope slot', () => {
  const { group, host, path } = start(
    'staged',
    closed +
      '\nask output to open "report.txt"\nask output to write "replacement"\nask output to close',
  );
  expect(group.pump(now).reports).toContainEqual(
    expect.objectContaining({ outcome: 'completed' }),
  );
  expect(readFileSync(path, 'utf8')).toBe('replacement');
  expect(readdirSync(host.directory)).toEqual(['report.txt']);
});

test.each(['parent path', 'absolute path', 'staging name', 'nested path'])(
  'Script destination with %s cannot escape the private directory',
  kind => {
    // Even a broken confinement check can reach only another disposable fixture.
    const outside = createFileHost('immediate');
    hosts.push(outside);
    const target = join(outside.directory, 'keep.txt');
    writeFileSync(target, 'untouched');
    const names: Record<string, string> = {
      'parent path': join('..', basename(outside.directory), 'keep.txt'),
      'absolute path': target,
      'staging name': '.stage-forged',
      'nested path': 'nested/report.txt',
    };
    const { group, host } = start(
      'immediate',
      `ask output to open "${names[kind]}"`,
    );
    expect(group.pump(now).reports).toContainEqual(
      expect.objectContaining({
        outcome: 'errored',
        error: expect.objectContaining({ code: 'invalid destination' }),
      }),
    );
    expect(readdirSync(host.directory)).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  },
);

test('a real rename rejection is definite non-publication and rolls back staging', () => {
  const { group, host, path } = start('staged', closed);
  mkdirSync(path);
  writeFileSync(join(path, 'keep.txt'), 'old bytes');
  expect(group.pump(now).reports).toContainEqual(
    expect.objectContaining({
      outcome: 'effect failed',
      effect: expect.objectContaining({ phase: 'commit', status: 'failed' }),
    }),
  );
  expect(readFileSync(join(path, 'keep.txt'), 'utf8')).toBe('old bytes');
  expect(readdirSync(host.directory)).toEqual(['report.txt']);
  expect(host.openHandles()).toEqual([]);
});

test.each(['returned unknown', 'exception after publication'])(
  'uncertain publication %s stops the Group without retrying',
  failure => {
    let attempts = 0;
    const { group, host, path } = start('staged', closed, {
      publish: (source, destination) => {
        attempts++;
        if (failure === 'exception after publication') {
          renameSync(source, destination);
          throw new Error('publication acknowledgement lost');
        }
        return { status: 'unknown', detail: 'storage outcome unavailable' };
      },
    });
    writeFileSync(path, 'old bytes');
    const result = group.pump(now);
    expect(result.state).toBe('stopped');
    expect(result.reports).toContainEqual(
      expect.objectContaining({
        kind: 'effect failure',
        phase: 'commit',
        status: 'unknown',
      }),
    );
    expect(readFileSync(path, 'utf8')).toBe(
      failure === 'returned unknown' ? 'old bytes' : 'new bytes',
    );
    expect(readdirSync(host.directory)).toEqual(['report.txt']);
    expect(host.openHandles()).toEqual([]);
    group.pump(now);
    expect(attempts).toBe(1);
  },
);

test('same-named Groups sharing a Grant retain distinct handles and reject a busy destination', () => {
  const { group, host } = start('staged', opened + fault);
  preempt(group);
  const [firstFd] = host.openHandles();
  const other = newGroup({ name: 'files' });
  groups.push(other);
  const script = other.load({
    name: 'writer',
    source: `on export\n${opened}\nend export`,
    grants: { output: host.grant },
  });
  script.deliver({ name: 'export' });
  expect(other.pump(now).reports).toContainEqual(
    expect.objectContaining({
      outcome: 'errored',
      error: expect.objectContaining({ code: 'destination busy' }),
    }),
  );
  expect(host.openHandles()).toEqual([firstFd!]);
  group.script('writer')!.stop('done');
  group.pump(now);
  expect(host.openHandles()).toEqual([]);
  expect(readdirSync(host.directory)).toEqual([]);
});

test.each(['stop', 'cancel'])(
  'unfinished staged output is discarded on %s after preemption',
  action => {
    const { group, script, host, path } = start('staged', opened + fault);
    writeFileSync(path, 'old bytes');
    preempt(group);
    const [fd] = host.openHandles();
    expect(fstatSync(fd!).isFile()).toBe(true);
    if (action === 'stop') {
      script.stop('Host stop');
    } else {
      script.cancelRun('writer/r1');
    }
    group.pump(now);
    expect(host.openHandles()).toEqual([]);
    expect(() => fstatSync(fd!)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('old bytes');
    expect(readdirSync(host.directory)).toEqual(['report.txt']);
  },
);

test('same-named Groups can stage different destinations without sharing handles', () => {
  const { group, script, host, path } = start('staged', opened + fault);
  preempt(group);
  const [firstFd] = host.openHandles();
  const other = newGroup({ name: 'files' });
  groups.push(other);
  const otherScript = other.load({
    name: 'writer',
    source: `on export\nask output to open "other.txt"\nask output to write "other bytes"${fault}\nend export`,
    grants: { output: host.grant },
  });
  otherScript.deliver({ name: 'export' });
  preempt(other);
  const [secondFd] = host.openHandles().filter(fd => fd !== firstFd);
  expect(secondFd).toBeDefined();
  script.stop('first Group stops');
  group.pump(now);
  expect(host.openHandles()).toEqual([secondFd!]);
  expect(fstatSync(secondFd!).isFile()).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(host.directory, 'other.txt'))).toBe(false);
  otherScript.stop('second Group stops');
  other.pump(now);
  expect(host.openHandles()).toEqual([]);
  expect(readdirSync(host.directory)).toEqual([]);
});

test('a new Segment may stage a new destination after publication', () => {
  const { group, host, path } = start(
    'staged',
    `${closed}\nwait 1 ms\nask output to open "other.txt"\nask output to write "other bytes"\nask output to close`,
  );
  group.pump(now);
  expect(readFileSync(path, 'utf8')).toBe('new bytes');
  expect(existsSync(join(host.directory, 'other.txt'))).toBe(false);
  expect(group.pump(now + 1_000_000n).reports).toContainEqual(
    expect.objectContaining({ outcome: 'completed' }),
  );
  expect(readFileSync(join(host.directory, 'other.txt'), 'utf8')).toBe(
    'other bytes',
  );
  expect(readdirSync(host.directory).sort()).toEqual([
    'other.txt',
    'report.txt',
  ]);
});

test('the runnable Scripts demonstrate all four outcomes and remove their temporary directories', () => {
  const result = Bun.spawnSync([
    process.execPath,
    new URL('./main.ts', import.meta.url).pathname,
  ]);
  const output = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  expect(output.match(/Run outcome: (.+)/g)).toEqual([
    'Run outcome: limit fault',
    'Run outcome: completed',
    'Run outcome: limit fault',
    'Run outcome: errored',
  ]);
  expect(output).toContain('After first Pump: old bytes; open handles: 0');
  expect(output.match(/After Run: .+/g)).toEqual([
    'After Run: new bytes; open handles: 0',
    'After Run: new bytes; open handles: 0',
    'After Run: old bytes; open handles: 0',
    'After Run: old bytes; open handles: 0',
  ]);
  const directories = [...output.matchAll(/Host directory: (.+)/g)].map(
    match => match[1]!,
  );
  expect(directories).toHaveLength(4);
  expect(directories.every(directory => !existsSync(directory))).toBe(true);
});
