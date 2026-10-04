import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  cpSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  firstDivergence,
  firstLineDivergence,
  runDisassemblyCase,
  runEncodingCase,
} from '../tools/corpus';
import {
  DeferredCaseError,
  parseRecord,
  replay,
  runTraceCase,
} from '../tools/trace-case';

test('the NFC encoding seed case executes every line through the public values', () => {
  const dir = resolve(
    import.meta.dir,
    '../../../corpus/text-model/host-text-normalised-to-nfc',
  );
  const result = runEncodingCase(dir);
  expect(result.count).toBe(5);
  expect(result.divergence).toBeUndefined();
});

test('the runner reads object Shapes from the shared declaration data model', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'northtalk-object-shapes-'));
  try {
    writeFileSync(
      resolve(dir, 'script.talk'),
      'on go x\n  ask api to read x\n  return it\nend',
    );
    const setup = {
      operations: [
        {
          capability: 'api',
          name: 'read',
          mode: 'immediate',
          args: [{ object: 'door' }],
          result: { object: 'door' },
          cost: { fuel: 0 },
        },
      ],
      objectKinds: [{ name: 'door' }],
      objects: [{ kind: 'door', id: 'a' }],
      scripts: [
        { name: 's', source: 'script.talk', grants: { api: { ops: 'all' } } },
      ],
    };
    const lines = replay(dir, setup as never, [
      '> load s source=script.talk',
      '> request d1 to=s message=go args=[<object door "a">]',
      '> stub api.read value=<object door "a">',
      '> pump clock=2026-10-02T00:00:00Z',
    ]);
    expect(lines).toContain(
      'call s/r1.c1 op=api.read args=[<object door "a">] result=<object door "a">',
    );
    expect(
      lines.some(
        line =>
          line.startsWith('run s/r1 outcome=completed') &&
          line.includes('value=<object door "a">'),
      ),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('divergence output identifies the first byte and retains both outputs', () => {
  expect(firstDivergence('"é"', '"e"')).toEqual({
    byte: 2,
    expected: '"é"',
    actual: '"e"',
  });
  expect(firstDivergence('a', 'ab')).toEqual({
    byte: 2,
    expected: 'a',
    actual: 'ab',
  });
  expect(firstDivergence('same', 'same')).toBeUndefined();
});

test('encoding selection reports the first differing source line', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'northtalk-encoding-'));
  try {
    writeFileSync(
      resolve(dir, 'case.toml'),
      'kind = "encoding"\n[versions]\nlanguage = "1.0-rc.2"\ncostModel = "0"\n',
    );
    writeFileSync(
      resolve(dir, 'case.encoding'),
      '# test case\n" => " => " => "\n"é" => "wrong"\n"x" => "also wrong"\n',
    );
    expect(runEncodingCase(dir)).toEqual({
      count: 1,
      divergence: {
        line: 3,
        byte: 2,
        source: '"é"',
        expected: '"wrong"',
        actual: '"é"',
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selecting a Trace Case with a deferred input exits with a clear failure', () => {
  const runner = resolve(import.meta.dir, '../tools/corpus.ts');
  const dir = mkdtempSync(resolve(tmpdir(), 'northtalk-deferred-'));
  try {
    writeFileSync(
      resolve(dir, 'case.toml'),
      'kind = "trace"\n[versions]\nlanguage = "1.0-rc.2"\ncostModel = "0"\n',
    );
    writeFileSync(resolve(dir, 'case.trace'), '> unsupported-input\n');
    const result = Bun.spawnSync([process.execPath, runner, dir]);
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'deferred, since it uses',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unblessed Trace Case runs when named, and reports its first divergence', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'northtalk-unblessed-'));
  try {
    cpSync(
      resolve(import.meta.dir, '../../../corpus/limits/fuel-alloc-minimums'),
      dir,
      {
        recursive: true,
      },
    );
    const trace = resolve(dir, 'case.trace');
    // Keep divergence coverage independent of the real case's blessing.
    writeFileSync(
      trace,
      '# Unblessed: deliberate test fixture.\n' +
        readFileSync(trace, 'utf8').replace(
          'state=48 end=return',
          'state=16 end=return',
        ),
    );
    const setup = Bun.TOML.parse(
      readFileSync(resolve(dir, 'case.toml'), 'utf8'),
    );
    const result = runTraceCase(dir, setup as never);
    expect(result.lines).toBe(8);
    expect(result.divergence?.expected).toEndWith('state=16 end=return');
    expect(result.divergence?.actual).toEndWith('state=48 end=return');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the blessed text-model Trace Cases reproduce exactly', () => {
  const root = resolve(import.meta.dir, '../../../corpus/text-model');
  for (const name of readdirSync(root)) {
    const dir = resolve(root, name);
    const setup = Bun.TOML.parse(
      readFileSync(resolve(dir, 'case.toml'), 'utf8'),
    ) as {
      kind: string;
    };
    if (setup.kind === 'trace') {
      expect([name, runTraceCase(dir, setup as never).divergence]).toEqual([
        name,
        undefined,
      ]);
    }
  }
});

test.each([
  'load-diagnostics/invalid-raw-text-closing-margin',
  'load-diagnostics/invalid-text-closing-margin',
  'limits/fenced-text-concat',
])('the fenced-text regression %s reproduces on both replay paths', name => {
  const dir = resolve(import.meta.dir, '../../../corpus', name);
  const setup = Bun.TOML.parse(readFileSync(resolve(dir, 'case.toml'), 'utf8'));
  const result = runTraceCase(dir, setup as never);
  expect(result.divergence).toBeUndefined();
});

test('blessing a Trace Case keeps its comments before the inputs they preceded', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'northtalk-trace-'));
  try {
    writeFileSync(
      resolve(dir, 'case.toml'),
      'kind = "trace"\n[versions]\nlanguage = "1.0-rc.2"\ncostModel = "0"\n[[scripts]]\nname = "a"\nsource = "a.talk"\n',
    );
    writeFileSync(resolve(dir, 'a.talk'), 'on go\n  return 1\nend go\n');
    writeFileSync(
      resolve(dir, 'case.trace'),
      '# a case\n> load a\n\n# deliver it\n> deliver d1 to=a message=go\n> pump clock=2026-09-30T09:00:00Z\nwrong line\n# the end\n',
    );
    const setup = Bun.TOML.parse(
      readFileSync(resolve(dir, 'case.toml'), 'utf8'),
    );
    expect(runTraceCase(dir, setup as never).divergence?.expected).toBe(
      'wrong line',
    );
    runTraceCase(dir, setup as never, { bless: true });
    const blessed = readFileSync(resolve(dir, 'case.trace'), 'utf8');
    expect(blessed.replace(/ identity=[\da-f]+/, '')).toBe(
      [
        '# a case',
        '> load a',
        '',
        '# deliver it',
        '> deliver d1 to=a message=go',
        '> pump clock=2026-09-30T09:00:00Z',
        'seg a/r1 start delivery=d1 handler=go clause=1 fuel=7 alloc=0 state=0 end=return',
        'run a/r1 outcome=completed delivery=d1 handler=go value=1 fuel=7 alloc=0',
        'pumped state=idle fuel=7',
        '# the end',
        '',
      ].join('\n'),
    );
    expect(runTraceCase(dir, setup as never).divergence).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every Disassembly Case reproduces its expected text byte for byte', () => {
  for (const name of [
    'expressions',
    'containers',
    'destructuring',
    'errors-and-loops',
    'calls-and-lambdas',
    'messages-and-waiting',
  ]) {
    const result = runDisassemblyCase(
      resolve(import.meta.dir, '../../../corpus/disassembly', name),
    );
    expect(result.divergence).toBeUndefined();
    expect(result.count).toBeGreaterThan(0);
  }
});

test('a Disassembly divergence names the first differing line and byte', () => {
  expect(
    firstLineDivergence('a.dis', 'unit a\n  0 1\n', 'unit a\n  0 2\n'),
  ).toEqual({
    file: 'a.dis',
    line: 2,
    byte: 5,
    expected: '  0 1',
    actual: '  0 2',
  });
  const dir = mkdtempSync(resolve(tmpdir(), 'northtalk-disassembly-'));
  try {
    cpSync(
      resolve(import.meta.dir, '../../../corpus/disassembly/containers'),
      dir,
      {
        recursive: true,
      },
    );
    const expected = resolve(dir, 'writes.dis');
    const blessed = readFileSync(expected, 'utf8');
    writeFileSync(
      expected,
      blessed.replace('chunk-set item', 'chunk-set word'),
    );
    const result = runDisassemblyCase(dir);
    expect(result.divergence?.file).toBe('writes.dis');
    expect(result.divergence?.actual).toContain('chunk-set item');
    expect(result.divergence?.expected).toContain('chunk-set word');
    // Blessing writes the Core's text back.
    expect(runDisassemblyCase(dir, { bless: true }).count).toBe(1);
    expect(readFileSync(expected, 'utf8')).toBe(blessed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blessing refuses case kinds this Core does not bless', () => {
  const runner = resolve(import.meta.dir, '../tools/corpus.ts');
  const result = Bun.spawnSync([
    process.execPath,
    runner,
    '--bless',
    'text-model/host-text-normalised-to-nfc',
  ]);
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain(
    '--bless writes Disassembly, Trace and Transcript Cases only',
  );
});

test("every record the Core writes has corpus.toml's ids and keys, in its order", async () => {
  const corpus = (await import('../../../spec/data/corpus.toml')).default as {
    record: {
      ids?: string[];
      input: boolean;
      key?: { key: string; optional?: boolean }[];
      name: string;
    }[];
  };
  const specs = new Map(corpus.record.map(r => [`${r.input}:${r.name}`, r]));
  const lines: string[] = [];
  for (const area of [
    'text-model',
    'limits',
    'text-patterns',
    'capabilities',
  ]) {
    const root = resolve(import.meta.dir, '../../../corpus', area);
    for (const name of readdirSync(root)) {
      const dir = resolve(root, name);
      if (!statSync(dir).isDirectory()) {
        continue;
      }
      const setup = Bun.TOML.parse(
        readFileSync(resolve(dir, 'case.toml'), 'utf8'),
      ) as {
        kind: string;
      };
      if (setup.kind !== 'trace') {
        continue;
      }
      try {
        lines.push(
          ...replay(
            dir,
            setup as never,
            readFileSync(resolve(dir, 'case.trace'), 'utf8').split('\n'),
          ),
        );
      } catch (error) {
        if (!(error instanceof DeferredCaseError)) {
          throw error;
        }
      }
    }
  }
  expect(lines.length).toBeGreaterThan(100);
  for (const line of lines) {
    const record = parseRecord(line);
    const spec = specs.get(`${record.input}:${record.name}`)!;
    expect(spec).toBeDefined();
    const keys = (spec.key ?? []).map(k => k.key);
    const written = [...record.fields.keys()];
    expect(written).toEqual(keys.filter(k => written.includes(k)));
    for (const k of spec.key ?? []) {
      if (!k.optional && !(record.input && 'filled' in k)) {
        expect([line, written.includes(k.key)]).toEqual([line, true]);
      }
    }
    const required = (spec.ids ?? []).filter(id => !id.endsWith('?')).length;
    expect(record.ids.length).toBeGreaterThanOrEqual(
      record.input ? 0 : required,
    );
  }
}, 60_000);

test('corpus selectors accept corpus-relative and absolute paths from any working directory', () => {
  const runner = resolve(import.meta.dir, '../tools/corpus.ts');
  const name = 'text-model/host-text-normalised-to-nfc';
  for (const selector of [
    name,
    resolve(import.meta.dir, '../../../corpus', name),
  ]) {
    const result = Bun.spawnSync([process.execPath, runner, selector], {
      cwd: tmpdir(),
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain(`PASS ${name}`);
  }
});

test('redundant corpus prefixes fail with a corrected selector instead of running it', () => {
  const runner = resolve(import.meta.dir, '../tools/corpus.ts');
  const name = 'text-model/host-text-normalised-to-nfc';
  for (const prefix of ['corpus/', './corpus/']) {
    const result = Bun.spawnSync([process.execPath, runner, prefix + name]);
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      `Case paths are relative to corpus/; use "${name}" instead of "${prefix + name}"`,
    );
    expect(new TextDecoder().decode(result.stdout)).toBe('');
  }
});

test('missing corpus selectors retain their filesystem error without a misleading suggestion', () => {
  const runner = resolve(import.meta.dir, '../tools/corpus.ts');
  for (const selector of ['no-such-retro-case', 'corpus/no-such-retro-case']) {
    const result = Bun.spawnSync([process.execPath, runner, selector]);
    const error = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(error).toContain('ENOENT');
    expect(error).toContain(selector);
    expect(error).not.toContain('instead of');
  }
});
