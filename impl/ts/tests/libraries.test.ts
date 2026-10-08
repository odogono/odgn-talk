import { describe, expect, test } from 'bun:test';
import {
  codeIdentity,
  compileLibrary,
  HostError,
  LoadError,
  newGroup,
  parseInstant,
  type Library,
} from '../src/index';

const lib = (name: string, source: string, imports: Library[] = []) =>
  compileLibrary({ name, version: '1', source }, imports);
const hex = (l: Library) => Buffer.from(l.identity).toString('hex');

// Load a Script into a Group holding `libraries`, deliver `go`, and give the
// Trace lines and the Script Variables.
const run = (source: string, libraries: Library[]) => {
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  for (const l of libraries) {
    group.addLibrary(l);
  }
  group.load({ name: 's', source }).deliver({ name: 'go' });
  group.pump(parseInstant('2026-09-30T09:00:00Z'));
  group.inspect();
  return { lines, vars: lines.at(-1)! };
};
// The load diagnostics' codes for a Library's source, or none.
const codes = (source: string, imports: Library[] = []) => {
  try {
    lib('x', source, imports);
    return [];
  } catch (error) {
    return (error as LoadError).diagnostics.map(d => d.code);
  }
};
const fuelOf = (lines: string[]) =>
  lines.find(line => line.startsWith('run '))!.match(/ fuel=(\d+)/)![1];

const helpers = `
constant base = 100

function plus a, b = base
  return a + b
end plus

on pick a
  return "one"
end pick

on pick a, b
  return "two"
end pick
`;

describe('calls into a Library', () => {
  test('cost the same as calls to the Script’s own code', () => {
    const body =
      'script variable n\non go\n  put [plus(1), plus(1, 2), pick(1), pick(1, 2)] into n\nend go';
    const local = run(`${helpers}\n${body}`, []);
    const imported = run(`use plus, pick from h\n${body}`, [lib('h', helpers)]);
    expect(local.vars).toBe('vars s n=[101, 3, "one", "two"]');
    expect(imported.vars).toBe(local.vars);
    expect(fuelOf(imported.lines)).toBe(fuelOf(local.lines));
  });

  test('take the Library’s defaults and Constants', () => {
    const r = run(
      'use plus, base from h\nscript variable n\non go\n  put [plus(5), base] into n\nend go',
      [lib('h', helpers)],
    );
    expect(r.vars).toBe('vars s n=[105, 100]');
  });

  test('keep the Run’s clause the entry Handler’s', () => {
    const r = run('use pick from h\non go\n  pick 1, 2\nend go', [
      lib('h', helpers),
    ]);
    expect(r.lines.find(line => line.startsWith('seg '))).toContain('clause=1');
  });

  test('raise with `at` in the Library, and unwind back to the caller', () => {
    const h = lib('h', 'function boom\n  throw {code: "x"}\nend boom');
    const r = run(
      'use boom from h\nscript variable e\non go\n  try\n    boom()\n  catch err\n    put err into e\n  end try\nend go',
      [h],
    );
    expect(r.lines).toContain('raise s/r1 code="x" at=h:4 pos=2:3');
    expect(r.vars).toBe(
      'vars s e={code: "x", at: {unit: "h", handler: "boom", line: 2, column: 3}}',
    );
  });

  test('raise with `at` at the call, when the Host asks it to', () => {
    const source = 'function boom\n  throw {code: "x"}\nend boom';
    const h = compileLibrary(
      { name: 'h', version: '1', source },
      [],
      {},
      {
        atCaller: true,
      },
    );
    const r = run(
      'use boom from h\nscript variable e\non go\n  try\n    boom()\n  catch err\n    put err into e\n  end try\nend go',
      [h],
    );
    expect(r.lines).toContain('raise s/r1 code="x" at=h:4 pos=2:3');
    expect(r.vars).toBe(
      'vars s e={code: "x", at: {unit: "s", handler: "go", line: 5, column: 5}}',
    );
    // The same source compiled as usual still names its own position.
    const plain = run(
      'use boom from h\nscript variable e\non go\n  try\n    boom()\n  catch err\n    put err into e\n  end try\nend go',
      [lib('h', source)],
    );
    expect(plain.vars).toContain('at: {unit: "h"');
  });

  test('make Function Values whose Home Script is the caller', () => {
    const h = lib(
      'h',
      'function scale k\n  return given x: x * k\nend scale\nfunction id x\n  return x\nend id',
    );
    const r = run(
      'use scale, id from h\nscript variable n\non go\n  put scale(2) into f\n  put [f, id, f(4), id = id] into n\nend go',
      [h],
    );
    expect(r.vars).toBe(
      'vars s n=[<function s:h:2:10 {k: 2}>, <function s:h:id>, 8, true]',
    );
  });
});

describe('compiling and adding Libraries', () => {
  test('a code identity covers the identities of the direct imports', () => {
    const a = lib('a', 'function one\n  return 1\nend one');
    const b = lib(
      'b',
      'use one from a\nfunction two\n  return one() + 1\nend two',
      [a],
    );
    const source = 'use two from b\non go\n  return two()\nend go';
    expect(a.identity).toHaveLength(32);
    expect(hex(b)).toBe(
      codeIdentity(
        'library',
        'b',
        'use one from a\nfunction two\n  return one() + 1\nend two',
        [hex(a)],
      ),
    );
    const r = run(source, [a, b]);
    expect(r.lines).toContain(
      `> load s identity=${codeIdentity('script', 's', source, [hex(b)])}`,
    );
    const a2 = lib('a', 'function one\n  return 2\nend one');
    const b2 = lib(
      'b',
      'use one from a\nfunction two\n  return one() + 1\nend two',
      [a2],
    );
    expect(hex(b2)).not.toBe(hex(b));
    expect(lib('a', 'function one\n  return 1\nend one').identity).toEqual(
      a.identity,
    );
  });

  test('a Library that breaks a Library rule doesn’t compile', () => {
    expect(codes('script variable n')).toEqual(['not in a library']);
    expect(
      codes(
        'function f\n  put me into x\n  send ping to x\n  wait for ping\n  return the target\nend f\non h\n  pass h\nend h',
      ),
    ).toEqual([
      'not in a library',
      'not in a library',
      "can't suspend here",
      'not in a library',
      'not in a library',
      'not in a library',
    ]);
    expect(codes('use one from nowhere')).toEqual(['unknown import']);
  });

  test('the Group refuses a reused name, a stdlib name and missing imports', () => {
    const a = lib('a', 'function one\n  return 1\nend one');
    const b = lib(
      'b',
      'use one from a\nfunction two\n  return one()\nend two',
      [a],
    );
    const group = newGroup({ name: 'g' });
    const refusal = (l: Library) => {
      try {
        group.addLibrary(l);
        return null;
      } catch (error) {
        return (error as HostError).code;
      }
    };
    expect(refusal(b)).toBe('library mismatch');
    expect(refusal(a)).toBeNull();
    expect(refusal(a)).toBe('name reused');
    expect(refusal(lib('list', 'function f\n  return 1\nend f'))).toBe(
      'reserved name',
    );
    expect(
      refusal(
        lib('b', 'use one from a\nfunction two\n  return one()\nend two', [
          lib('a', 'function one\n  return 9\nend one'),
        ]),
      ),
    ).toBe('library mismatch');
    expect(refusal(b)).toBeNull();
  });

  test('a Script importing a name its Library doesn’t export doesn’t load', () => {
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    group.addLibrary(lib('a', 'function one\n  return 1\nend one'));
    expect(() =>
      group.load({ name: 's', source: 'use one, two from a\non go\nend go' }),
    ).toThrow(LoadError);
    expect(lines.at(-1)).toBe('diag s code="unknown import" pos=1:10');
  });

  test('a user Library may import a stdlib Library, which needs no adding', () => {
    const shout = lib(
      'shout',
      'use repeated from text\nfunction shout t\n  return t & repeated("!", 3)\nend shout',
    );
    const r = run(
      'use shout from shout\nscript variable n\non go\n  put shout("hi") into n\nend go',
      [shout],
    );
    expect(r.vars).toBe('vars s n="hi!!!"');
  });
});
