import { describe, expect, test } from 'bun:test';
import {
  compileLibrary,
  defineCapability,
  LoadError,
  newGroup,
  num,
  restore,
  shape,
} from '../src/index';

const declarations = {
  io: {
    read: { mode: 'immediate' as const, args: [shape.text] },
    write: { mode: 'fire-and-forget' as const, args: [shape.text] },
    pause: { mode: 'suspending' as const, args: [] },
  },
};
const source =
  'function fetch key\n  ask io to read key\n  return it\nend fetch';
const build = (
  name: string,
  text: string,
  imports: ReturnType<typeof compileLibrary>[] = [],
) =>
  compileLibrary({ name, source: text, version: '1' }, imports, declarations);
const diagnostics = (work: () => unknown) => {
  try {
    work();
    return [];
  } catch (error) {
    if (!(error instanceof LoadError)) {
      throw error;
    }
    return error.diagnostics;
  }
};

describe('Library needs', () => {
  test('reports deduplicated sorted direct and transitive Operations, including private definitions', () => {
    const base = build(
      'base',
      `${source}\nprivate on note\n  tell io to write "x"\n  tell io to write "y"\nend note`,
    );
    const wrapper = build(
      'wrapper',
      'use fetch from base\non work\n  ask io to pause and wait\n  put fetch("key") into x\nend work',
      [base],
    );
    expect(base.needs).toEqual([
      { capability: 'io', operation: 'read' },
      { capability: 'io', operation: 'write' },
    ]);
    expect(wrapper.needs).toEqual([
      { capability: 'io', operation: 'pause' },
      { capability: 'io', operation: 'read' },
      { capability: 'io', operation: 'write' },
    ]);
  });

  test('compilation checks declarations even when the code identity is cached', () => {
    build('base', source);
    expect(
      diagnostics(() =>
        compileLibrary({ name: 'base', source, version: '1' }),
      ).map(d => d.code),
    ).toContain('unknown operation');
    const bad = {
      ...declarations,
      io: {
        ...declarations.io,
        read: { mode: 'fire-and-forget' as const, args: [shape.text] },
      },
    };
    expect(
      diagnostics(() =>
        compileLibrary({ name: 'base', source, version: '1' }, [], bad),
      ).map(d => d.code),
    ).toContain('wrong mode');
    expect(
      diagnostics(() =>
        build(
          'bad',
          'function fetch\n  ask io to read 1\n  return it\nend fetch',
        ),
      ).map(d => d.code),
    ).toContain('wrong argument');
    expect(
      diagnostics(() =>
        build(
          'bad',
          'function fetch\n  ask io to read\n  return it\nend fetch',
        ),
      ).map(d => d.code),
    ).toContain('wrong argument count');
  });

  test('a missing transitive Operation rejects at the outer use line and names the original call site', () => {
    const base = build('base', source);
    const wrapper = build(
      'wrapper',
      'use fetch from base\nfunction label key\n  return fetch(key)\nend label',
      [base],
    );
    const g = newGroup({ name: 'g' });
    g.addLibrary(base);
    g.addLibrary(wrapper);
    const d = diagnostics(() =>
      g.load({
        name: 's',
        source: 'use label from wrapper\non go\n  return label("key")\nend go',
      }),
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      code: 'missing grant',
      unit: 's',
      line: 1,
      col: 1,
    });
    expect(d[0]!.message).toContain('base:2:3');
    expect(d[0]!.message).toContain('io.read');
    expect(g.script('s')).toBeUndefined();
  });

  test('uses caller binding and validates imported calls against kept Operations and Shapes', () => {
    const cap = defineCapability<number>('store', {
      read: {
        mode: 'immediate',
        args: [shape.text],
        cost: { fuel: 7 },
        do: c => num(c.binding),
      },
      write: {
        mode: 'fire-and-forget',
        args: [shape.text],
        cost: { fuel: 1 },
        fire: () => {},
      },
    });
    const base = build('base', source);
    const g = newGroup({ name: 'g' });
    g.addLibrary(base);
    const script = 'use fetch from base\non go\n  return fetch("key")\nend go';
    expect(
      diagnostics(() =>
        g.load({
          name: 'missing',
          source: script,
          grants: { io: cap.grant(['write'], 3) },
        }),
      )[0]!.code,
    ).toBe('missing grant');
    for (const binding of [3, 8]) {
      g.load({
        name: `s${binding}`,
        source: script,
        grants: { io: cap.grant(['read'], binding) },
      }).deliver({ name: 'go' });
    }
    const reports = g.pump(0n).reports.filter(r => r.kind === 'run end');
    expect(reports.map(r => 'result' in r && r.result!.toString())).toEqual([
      '3',
      '8',
    ]);
    const changed = defineCapability('other', {
      read: {
        mode: 'immediate',
        args: [shape.number],
        cost: { fuel: 1 },
        do: () => num(0),
      },
    });
    const literal = build(
      'literal',
      'function fetch\n  ask io to read "key"\n  return it\nend fetch',
    );
    g.addLibrary(literal);
    expect(
      diagnostics(() =>
        g.load({
          name: 'bad',
          source: 'use fetch from literal',
          grants: { io: changed.grant('all', undefined) },
        }),
      )[0]!.code,
    ).toBe('wrong argument');
  });

  test('Reload and Extend enforce needs without changing the old Script', () => {
    const base = build('base', source);
    const g = newGroup({ name: 'g' });
    g.addLibrary(base);
    const s = g.load({ name: 's', source: 'script variable n = 9' });
    expect(
      diagnostics(() => s.reload('use fetch from base', 'carry variables'))[0]!
        .code,
    ).toBe('missing grant');
    expect(diagnostics(() => s.extend('use fetch from base'))[0]!.code).toBe(
      'missing grant',
    );
    expect(g.inspect().scripts[0]!.vars[0]![1].toString()).toBe('9');
  });
});

test('Library replacement rejects new transitive needs atomically', () => {
  const base = build('base', 'function fetch key\n  return key\nend fetch');
  const wrapper = build(
    'wrapper',
    'use fetch from base\nfunction label key\n  return fetch(key)\nend label',
    [base],
  );
  const g = newGroup({ name: 'g' });
  g.addLibrary(base);
  g.addLibrary(wrapper);
  g.load({
    name: 's',
    source: 'use label from wrapper\non go\n  return label("old")\nend go',
  });
  const fingerprint = g.fingerprint();
  expect(
    diagnostics(() =>
      g.replaceLibrary(build('base', source), 'carry variables'),
    )[0]!.code,
  ).toBe('missing grant');
  expect(g.fingerprint()).toEqual(fingerprint);
  g.script('s')!.deliver({ name: 'go' });
  const report = g.pump(0n).reports[0]!;
  expect('result' in report && report.result!.toString()).toBe('"old"');
});

test('suspending Library Handlers use the caller Call and settle in its Run', () => {
  const library = build(
    'helper',
    'on hold\n  ask io to pause and wait\n  return it\nend hold',
  );
  let answer: ((v: ReturnType<typeof num>) => void) | undefined;
  const capability = defineCapability('api', {
    pause: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel: 10 },
      start: c => {
        answer = c.answer;
        expect(c.scriptName).toBe('s');
      },
    },
  });
  const g = newGroup({ name: 'g' });
  g.addLibrary(library);
  expect(
    diagnostics(() =>
      g.load({
        name: 'bad',
        source: 'use hold from helper\non go\n  hold\nend go',
        grants: { io: capability.grant('all', undefined) },
      }),
    ).map(d => d.code),
  ).toContain('missing and wait');
  g.load({
    name: 's',
    source: 'use hold from helper\non go\n  hold and wait\n  return it\nend go',
    grants: { io: capability.grant('all', undefined) },
  }).deliver({ name: 'go' });
  expect(g.pump(0n).reports).toEqual([]);
  answer!(num(7));
  const report = g.pump(1n).reports[0]!;
  expect('result' in report && report.result!.toString()).toBe('7');
});

test('multiple imports report missing needs in source order once per Operation per use', () => {
  const library = build(
    'base',
    `${source}\nfunction other key\n  ask io to read key\n  return it\nend other`,
  );
  const g = newGroup({ name: 'g' });
  g.addLibrary(library);
  const d = diagnostics(() =>
    g.load({ name: 's', source: 'use fetch from base\nuse other from base' }),
  );
  expect(d.map(d => [d.code, d.line, d.col])).toEqual([
    ['missing grant', 1, 1],
    ['missing grant', 2, 1],
  ]);
});

test('a nested Lambda reports its own missing need once', () => {
  const library = compileLibrary(
    {
      name: 'nested',
      version: '1',
      source:
        'on make\n  tell io to write (given x\n    ask other to pause and wait\n    return it\n  end given)\nend make',
    },
    [],
    { ...declarations, other: { pause: { mode: 'suspending', args: [] } } },
  );
  const cap = defineCapability('log', {
    write: {
      mode: 'fire-and-forget',
      args: [shape.text],
      cost: { fuel: 1 },
      fire: () => {},
    },
  });
  const g = newGroup({ name: 'g' });
  g.addLibrary(library);
  expect(
    diagnostics(() =>
      g.load({
        name: 's',
        source: 'use make from nested',
        grants: { io: cap.grant('all', undefined) },
      }),
    ).map(d => d.code),
  ).toEqual(['missing grant']);
});

test('say records console.write and checks its mode, argument count and literal Shape', () => {
  const text = 'on logit\n  say "hello"\nend logit';
  const declarations = {
    console: { write: { mode: 'fire-and-forget' as const, args: [shape.any] } },
  };
  const library = compileLibrary(
    { name: 'logger', version: '1', source: text },
    [],
    declarations,
  );
  expect(library.needs).toEqual([
    { capability: 'console', operation: 'write' },
  ]);
  for (const [op, code] of [
    [{ mode: 'immediate' as const, args: [shape.text] }, 'wrong mode'],
    [{ mode: 'fire-and-forget' as const, args: [] }, 'wrong argument count'],
    [
      { mode: 'fire-and-forget' as const, args: [shape.number] },
      'wrong argument',
    ],
  ] as const) {
    expect(
      diagnostics(() =>
        compileLibrary({ name: 'logger', version: '1', source: text }, [], {
          console: { write: { ...op, args: [...op.args] } },
        }),
      ).map(d => d.code),
    ).toContain(code);
    const cap = defineCapability('console', {
      write:
        op.mode === 'immediate'
          ? {
              mode: 'immediate',
              args: [...op.args],
              cost: { fuel: 1 },
              do: () => num(0),
            }
          : {
              mode: 'fire-and-forget',
              args: [...op.args],
              cost: { fuel: 1 },
              fire: () => {},
            },
    });
    const g = newGroup({ name: 'g' });
    g.addLibrary(library);
    expect(
      diagnostics(() =>
        g.load({
          name: 's',
          source: 'use logit from logger',
          grants: { console: cap.grant('all', undefined) },
        }),
      ).map(d => d.code),
    ).toContain(code);
  }
});

test('dependent recompilation retains declarations for its own Capability calls', () => {
  const base = build('base', 'function value\n  return 1\nend value');
  const wrapper = build(
    'wrapper',
    'use value from base\non work\n  tell io to write "x"\n  return value()\nend work',
    [base],
  );
  const writes: string[] = [];
  const cap = defineCapability('log', {
    write: {
      mode: 'fire-and-forget',
      args: [shape.text],
      cost: { fuel: 1 },
      fire: (_c, value) => {
        writes.push(value.toString());
      },
    },
  });
  const g = newGroup({ name: 'g' });
  g.addLibrary(base);
  g.addLibrary(wrapper);
  g.load({
    name: 's',
    source: 'use work from wrapper\non go\n  work\n  return it\nend go',
    grants: { io: cap.grant('all', undefined) },
  });
  g.replaceLibrary(
    build('base', 'function value\n  return 2\nend value'),
    'carry variables',
  );
  g.script('s')!.deliver({ name: 'go' });
  const report = g.pump(0n).reports[0]!;
  expect('result' in report && report.result!.toString()).toBe('2');
  expect(writes).toEqual(['"x"']);
});

test('restore keeps a Library import valid when its saved Grant is rebound as revoked', () => {
  const library = build('base', source);
  const cap = defineCapability('store', {
    read: {
      mode: 'immediate',
      args: [shape.text],
      cost: { fuel: 1 },
      do: () => num(7),
    },
  });
  const g = newGroup({ name: 'g' });
  g.addLibrary(library);
  g.load({
    name: 's',
    source: 'use fetch from base\non go\n  return fetch("key")\nend go',
    grants: { io: cap.grant('all', undefined) },
  });
  const { group: copy, result } = restore(g.save(), {
    name: 'copy',
    libraries: [library],
    grants: () => undefined,
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  expect(result.variablesOnly).toBe(false);
  copy.script('s')!.deliver({ name: 'go' });
  const report = copy.pump(0n).reports[0]!;
  expect(report).toMatchObject({ outcome: 'errored' });
  expect('error' in report && report.error!.get('code').toString()).toBe(
    '"capability revoked"',
  );
});
