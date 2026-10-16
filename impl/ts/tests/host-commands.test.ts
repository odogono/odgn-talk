// Host Commands: an Operation declared `command` called as a Command Call
// (ADR 0094; chapter 5, Calling a Handler by name).
import { describe, expect, test } from 'bun:test';
import {
  compileLibrary,
  defineCapability,
  dec,
  disassemble,
  exportManifest,
  HostError,
  LoadError,
  newGroup,
  parseInstant,
  ScriptError,
  shape,
  text,
  type Grant,
  type Operation,
} from '../src/index';
import { compileSource } from '../src/lowering';
import type { GrantDecls } from '../src/effects';

const now = parseInstant('2026-09-30T09:00:00Z');
const fired: string[] = [];
const folio = defineCapability('folio', {
  hide: {
    mode: 'fire-and-forget',
    command: true,
    args: [shape.text],
    cost: { fuel: 2 },
    fire: call => {
      fired.push(call.id);
    },
  },
  count: {
    mode: 'immediate',
    command: true,
    result: shape.number,
    cost: { fuel: 1 },
    do: () => dec('7'),
  },
  fetch: {
    mode: 'suspending',
    command: true,
    args: [shape.text],
    result: shape.text,
    cost: { fuel: 0 },
    start: call => call.answer(text('page')),
  },
  fail: {
    mode: 'immediate',
    command: true,
    cost: { fuel: 0 },
    do: () => {
      throw new ScriptError('no page', 'no such page');
    },
  },
  plain: {
    mode: 'immediate',
    result: shape.number,
    cost: { fuel: 0 },
    do: () => dec('1'),
  },
});
const all = () => ({ folio: folio.grant('all', undefined) });

const run = (
  source: string,
  grants: Record<string, Grant<unknown>> = all(),
) => {
  fired.length = 0;
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  group.load({ name: 's', source, grants }).deliver({ name: 'go' });
  for (let i = 0; i < 3; i++) {
    group.pump(now);
  }
  group.inspect();
  return lines;
};
const loadCodes = (
  source: string,
  grants: Record<string, Grant<unknown>> = all(),
) => {
  try {
    newGroup({ name: 'g' }).load({ name: 's', source, grants });
    return [];
  } catch (error) {
    return (error as LoadError).diagnostics.map(
      d => `${d.code} ${d.line}:${d.col}`,
    );
  }
};

describe('declaring', () => {
  const fire: Operation<void> = {
    mode: 'fire-and-forget',
    cost: { fuel: 0 },
    fire: () => {},
  };
  test('refuses `command` on a Reserved Word, and one that is not Boolean', () => {
    expect(() =>
      defineCapability('x', { put: { ...fire, command: true } }),
    ).toThrow(HostError);
    expect(() =>
      defineCapability('x', {
        hide: { ...fire, command: 'yes' as unknown as boolean },
      }),
    ).toThrow(HostError);
    // A Reserved Word may still name an ordinary Operation.
    expect(() =>
      defineCapability('x', { put: { ...fire, command: false } }),
    ).not.toThrow();
  });

  test('the manifest and Fingerprint carry the flag', () => {
    const plain = defineCapability('folio', { hide: fire });
    const flagged = defineCapability('folio', {
      hide: { ...fire, command: true },
    });
    const manifest = (def: typeof plain) =>
      exportManifest({
        kind: 'k',
        version: '1',
        grants: { folio: def.grant('all', undefined) },
      });
    expect(manifest(flagged)).toContain(
      '"cost":{"fuel":0,"alloc":0},"command":true',
    );
    expect(manifest(plain)).not.toContain('command');
    const fingerprint = (def: typeof plain) => {
      const g = newGroup({ name: 'g' });
      g.load({
        name: 's',
        source: 'on go\nend go',
        grants: { folio: def.grant('all', undefined) },
      });
      return g.fingerprint();
    };
    expect(fingerprint(flagged)).not.toEqual(fingerprint(plain));
    expect(
      fingerprint(
        defineCapability('folio', { hide: { ...fire, command: false } }),
      ),
    ).toEqual(fingerprint(plain));
  });
});

describe('lowering', () => {
  const grants: GrantDecls = {
    folio: {
      hide: { mode: 'fire-and-forget', args: [shape.text], command: true },
      count: { mode: 'immediate', args: [], command: true },
      fetch: { mode: 'suspending', args: [shape.text], command: true },
    },
  };
  const code = (body: string) => {
    const result = compileSource(`on go\n  ${body}\nend go`, {
      name: 's',
      unit: 'script',
      grants,
    });
    expect(result.diagnostics).toEqual([]);
    // Argument positions differ between the spellings; instructions don't.
    return disassemble(result.unit!).replaceAll(/ \d+:\d+ const/g, ' const');
  };
  test.each([
    ['hide "a"', 'tell folio to hide "a"'],
    ['count', 'ask folio to count'],
    ['fetch "a" and wait', 'ask folio to fetch "a" and wait'],
  ])('`%s` lowers as `%s`', (command, call) => {
    expect(code(command)).toBe(code(call));
  });
  test('a labelled Command Call is never a Host Command', () => {
    expect(code('hide "a" to "b"')).toContain('send-up');
  });
});

describe('calling', () => {
  test('immediate leaves its result in `it`, fire-and-forget leaves `it`', () => {
    const lines = run(
      'script variable a\nscript variable b\non go\n  count\n  put it into a\n  hide "x"\n  put it into b\nend go',
    );
    expect(lines.filter(l => l.startsWith('call '))).toEqual([
      'call s/r1.c1 op=folio.count args=[] result=7',
      'call s/r1.c2 op=folio.hide args=["x"]',
    ]);
    expect(fired).toEqual(['s/r1.c2']);
    expect(lines.at(-1)).toBe('vars s a=7 b=7');
  });

  test('a suspending one is written `and wait`', () => {
    const lines = run(
      'script variable a\non go\n  fetch "p" and wait\n  put it into a\nend go',
    );
    expect(lines.at(-1)).toBe('vars s a="page"');
  });

  test('its error is raised at the calling line and stops the caller', () => {
    const lines = run(
      'script variable e\non go\n  try\n    fail\n  catch err\n    put the at of err into e\n  end try\nend go',
    );
    expect(lines.at(-1)).toBe(
      'vars s e={unit: "s", handler: "go", line: 4, column: 5}',
    );
  });

  test('a Handler of the Script shadows it', () => {
    const lines = run(
      'script variable a\non go\n  count\n  put it into a\nend go\non count\n  return 1\nend count',
    );
    expect(lines.some(l => l.startsWith('call '))).toBe(false);
    expect(lines.at(-1)).toBe('vars s a=1');
  });

  test('an Operation not declared `command` still climbs', () => {
    expect(run('on go\n  plain\nend go').some(l => l.startsWith('call '))).toBe(
      false,
    );
  });
});

describe('load checks', () => {
  test.each([
    ['count and wait', 'wrong mode 2:3'],
    ['fetch "p"', 'wrong mode 2:3'],
    ['hide "x" and wait', 'wrong mode 2:3'],
    ['hide 1', 'wrong argument 2:8'],
    ['hide', 'wrong argument count 2:3'],
  ])('%s', (line, diagnostic) => {
    expect(loadCodes(`on go\n  ${line}\nend go`)).toEqual([diagnostic]);
  });

  test('two Grants offering one command clash at the call', () => {
    expect(
      loadCodes('on go\n  count\nend go', {
        folio: folio.grant(['count'], undefined),
        other: folio.grant(['count'], undefined),
      }),
    ).toEqual(['name clash 2:3']);
    // A Handler of the Script takes the call, so nothing is ambiguous.
    expect(
      loadCodes('on go\n  count\nend go\non count\nend count', {
        folio: folio.grant(['count'], undefined),
        other: folio.grant(['count'], undefined),
      }),
    ).toEqual([]);
  });

  test('an Import named like a Host Command clashes at the use line', () => {
    const g = newGroup({ name: 'g' });
    g.addLibrary(
      compileLibrary({
        name: 'lib',
        version: '1',
        source: 'on count\n  return 1\nend count',
      }),
    );
    expect(() =>
      g.load({ name: 's', source: 'use count from lib', grants: all() }),
    ).toThrow(LoadError);
    try {
      g.load({ name: 's', source: 'use count from lib', grants: all() });
    } catch (error) {
      expect(
        (error as LoadError).diagnostics.map(d => [d.code, d.line, d.col]),
      ).toEqual([['name clash', 1, 5]]);
    }
  });

  test('an aliased Import clashes at its local name', () => {
    const g = newGroup({ name: 'g' });
    g.addLibrary(
      compileLibrary({
        name: 'lib',
        version: '1',
        source: 'on total\n  return 1\nend total',
      }),
    );
    try {
      g.load({
        name: 's',
        source: 'use total from lib as count',
        grants: all(),
      });
      throw new Error('loaded');
    } catch (error) {
      expect(
        (error as LoadError).diagnostics.map(d => [d.code, d.line, d.col]),
      ).toEqual([['name clash', 1, 23]]);
    }
  });

  test('Grants as used keep a Host Command', () => {
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'on go\n  count\nend go',
      grants: all(),
      grantsAsUsed: true,
    });
    expect(g.scriptGrants('s')).toEqual({ folio: ['count'] });
  });
});

describe('Libraries', () => {
  const declarations: GrantDecls = {
    folio: { count: { mode: 'immediate', args: [], command: true } },
  };
  test('a Host Command joins `needs`, and an importer needs the Grant', () => {
    const lib = compileLibrary(
      {
        name: 'lib',
        version: '1',
        source: 'on tally\n  count\n  return it\nend tally',
      },
      [],
      declarations,
    );
    expect(lib.needs).toEqual([{ capability: 'folio', operation: 'count' }]);
    const lines: string[] = [];
    const g = newGroup({ name: 'g', trace: line => lines.push(line) });
    g.addLibrary(lib);
    try {
      g.load({ name: 's', source: 'use tally from lib' });
      throw new Error('loaded');
    } catch (error) {
      expect(
        (error as LoadError).diagnostics.map(d => [d.code, d.line, d.col]),
      ).toEqual([['missing grant', 1, 1]]);
    }
    g.load({
      name: 't',
      source:
        'script variable a\nuse tally from lib\non go\n  tally\n  put it into a\nend go',
      grants: all(),
    }).deliver({ name: 'go' });
    g.pump(now);
    g.inspect();
    expect(lines.at(-1)).toBe('vars t a=7');
  });

  test("a Library's own Handler shadows the Host Command", () => {
    const lib = compileLibrary(
      {
        name: 'lib2',
        version: '1',
        source: 'on tally\n  count\nend tally\non count\n  return 1\nend count',
      },
      [],
      declarations,
    );
    expect(lib.needs).toEqual([]);
  });
});
