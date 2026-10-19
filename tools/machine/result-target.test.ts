// Result Targets (ADRs 0112/0114, #1340/#1350). New forms stay outside
// shared fixtures until every Core supports them; see the #1350 handoff.
import { expect, test } from 'bun:test';
import { newStats, parse } from '../grammar/parser';
import { CompileError, compileSource, type Options } from './compile';

const ops = (src: string, opts: Options = {}) => {
  const unit = compileSource('s', 'script', src, opts);
  const b = unit.bodies.find(b => b.name === 't')!;
  return unit.code.slice(b.start, b.end).map(i => [i.op, ...i.args].join(' '));
};

test('a local target is moved from it', () => {
  const code = ops(
    'on t item\n  ask world to carries item into carried\n  return carried\nend t\n',
  );
  const i = code.findIndex(c => c.startsWith('ask world carries'));
  expect(code.slice(i, i + 3)).toEqual([
    'ask world carries 1',
    'store 0',
    expect.stringMatching(/^move 0 \d+$/),
  ]);
});

test('a suspending ask takes its target before and wait', () => {
  const code = ops(
    'on t key\n  ask storage to load key into saved and wait\n  return saved\nend t\n',
  );
  const i = code.findIndex(c => c.startsWith('ask-wait'));
  expect(code[i + 1]).toBe('store 0');
  expect(code[i + 2]).toMatch(/^move 0 \d+$/);
});

test('a Script Variable target is stored from it', () => {
  const code = ops(
    'script variable last\non t\n  ask clock to now into last\nend t\n',
  );
  const i = code.findIndex(c => c.startsWith('ask clock'));
  expect(code.slice(i + 1, i + 4)).toEqual([
    'store 0',
    'load 0',
    expect.stringMatching(/^store-var \d+$/),
  ]);
});

test('no target lowers as before', () => {
  const code = ops('on t\n  ask clock to now\nend t\n');
  const i = code.findIndex(c => c.startsWith('ask clock'));
  expect(code[i + 1]).toBe('store 0');
  expect(code[i + 2]?.startsWith('move')).toBe(false);
});

test.each([
  ['  ask g to op x into item 1 of xs', 2, 27],
  ['  ask g to op x and wait into y', 2, 26],
  ['  ask g to op into it', 2, 20],
  ['  tell g to op x into y', 2, 18],
])('reject %s', (line, l, c) => {
  const { error } = parse(`on t x\n${line}\nend t\n`);
  expect(error).toBeTruthy();
  expect([error!.tok.line, error!.tok.col]).toEqual([l, c]);
});

test('a Join Member registers its target without an immediate write', () => {
  const code = ops(
    'on t\n  wait for all\n    ask g to op into y and wait\n  end wait\nend t\n',
  );
  const i = code.findIndex(c => c.startsWith('join-ask'));
  expect(code[i]).toBe('join-ask g op 0 local 1');
  expect(code[i + 1]).toBe('join-end');
  expect(code[i + 2]).toBe('store 0');
  expect(code.some(c => c.startsWith('move'))).toBe(false);
});

test.each([
  ['tell g\n    op into x\n  end tell', 'ask g op 0'],
  ['tell g\n    op 1, 2 into x and wait\n  end tell', 'ask-wait g op 2'],
  ['h 1 into x', 'call-handler h 1'],
  ['move 1 to 2 into x', 'call-handler move:to: 2'],
  ['h 1 into x and wait', 'call-handler-wait h 1'],
  ['sqrt(4) into x', 'call-builtin sqrt 1'],
  ['f(4) into x and wait', 'call-value-wait 1'],
  ['send m with 1 to me into x and wait', 'send-wait m 1'],
  ['send to me: move 1 to 2 into x and wait', 'send-wait move:to: 2'],
  ['send ("m") with 1 to me into x and wait', 'send-named-wait 1'],
  ['send m with ...[1] to me into x and wait', 'send-spread-wait'],
  ['unknown 1 into x and wait', 'send-up-wait unknown 1'],
])('%s keeps the answer directly after store 0', (line, instruction) => {
  const stats = newStats();
  expect(parse(`on t\n ${line}\nend t\n`, stats).error).toBeNull();
  expect(stats.relexes).toEqual([]);
  const code = ops(
    `on h n\n  return n\nend h\non move n to p\n  return p\nend move\non t\n  put given n: n into f\n  ${line}\n  return x\nend t\n`,
  );
  const i = code.indexOf(instruction);
  expect(i).toBeGreaterThan(-1);
  expect(code.slice(i + 1, i + 3)).toEqual([
    'store 0',
    expect.stringMatching(/^move 0 \d+$/),
  ]);
});

test.each([
  'tell g\n    op into x\n  end tell',
  'h into x',
  'sqrt(4) into x',
  'send m to me into x and wait',
])('a Script Variable target uses its Name for both stores: %s', line => {
  const unit = compileSource(
    's',
    'script',
    `script variable x\non h\n return 1\nend h\non t\n  ${line}\nend t\n`,
  );
  const body = unit.bodies.find(b => b.name === 't')!;
  const instructions = unit.code.slice(body.start, body.end);
  const i = instructions.findIndex(
    ins => ins.op === 'store' && ins.args[0] === 0,
  );
  const writes = instructions.slice(i + 1, i + 3);
  expect(writes.map(ins => [ins.op, ...ins.args])).toEqual([
    ['load', 0],
    ['store-var', 0],
  ]);
  expect(writes.map(ins => [ins.line, ins.col])).toEqual(
    line.includes('\n')
      ? [
          [7, 13],
          [7, 13],
        ]
      : [
          [6, line.indexOf('into x') + 8],
          [6, line.indexOf('into x') + 8],
        ],
  );
});

test('a parameter target reuses its slot and new targets keep source binding order', () => {
  const unit = compileSource(
    's',
    'script',
    'on t p\n  sqrt(4) into p\n  tell g\n    op into x\n  end tell\n  put 1 into y\nend t\n',
  );
  const body = unit.bodies.find(b => b.name === 't')!;
  expect(body.locals).toEqual(['it', 'p', 'x', 'y']);
  expect(
    unit.code
      .slice(body.start, body.end)
      .filter(ins => ins.op === 'move')
      .map(ins => ins.args),
  ).toEqual([
    [0, 1],
    [0, 2],
  ]);
});

const grants: NonNullable<Options['grants']> = {
  g: {
    price: { mode: 'immediate', command: true },
    fetch: { mode: 'suspending', command: true },
    note: { mode: 'fire-and-forget', command: true },
  },
};

test.each([
  ['price into x', 'ask g price 0'],
  ['fetch into x and wait', 'ask-wait g fetch 0'],
])('Host Command %s resolves to an Operation', (line, instruction) => {
  const code = ops(`on t\n  ${line}\nend t\n`, { grants });
  expect(code.slice(0, 3)).toEqual([instruction, 'store 0', 'move 0 1']);
});

test('a local Handler still shadows a Host Command with a target', () => {
  expect(
    ops('on price\n return 2\nend price\non t\n price into x\nend t\n', {
      grants,
    })[0],
  ).toBe('call-handler price 0');
});

test('an imported Handler can have a Script Variable target', () => {
  const library = parse('on h\n return 3\nend h\n').ast!;
  const code = ops(
    'use h from lib\nscript variable x\non t\n h into x\nend t\n',
    { libraries: new Map([['lib', library]]) },
  );
  expect(code.slice(0, 4)).toEqual([
    'call-handler lib:h 0',
    'store 0',
    'load 0',
    'store-var 0',
  ]);
});

test.each([
  'unknown into x',
  'send m to me into x',
  'send to me: m into x',
  'say 1 into x',
  'note into x',
  'tell g\n    note into x\n  end tell',
  'tell g\n    fetch into x\n  end tell',
  'tell g\n    price into x and wait\n  end tell',
])('reject a Result Target without an answer: %s', line => {
  expect(() => ops(`on t\n  ${line}\nend t\n`, { grants })).toThrow(
    CompileError,
  );
});

test.each([
  'tell g\n    price into item 1 of xs\n  end tell',
  'h into it',
  'h into me',
  'h into x and wait into y',
  'f(1) and wait into x',
  'send m to me and wait into x',
  'send to me: m into x and wait into y',
  'h into the key of xs',
  'f(1 into x)',
  'put f(1) into x and wait',
])('reject misplaced or non-Name target: %s', line => {
  expect(parse(`on t\n  ${line}\nend t\n`).error).toBeTruthy();
});

test.each([
  ['ask g to op into x and wait', 'join-ask g op 0 local 1'],
  ['tell g\n      op into x and wait\n    end tell', 'join-ask g op 0 local 1'],
  ['send m to me into x and wait', 'join-send m 0 local 1'],
  ['send to me: m into x and wait', 'join-send m 0 local 1'],
  ['send ("m") to me into x and wait', 'join-send-named 0 local 1'],
  ['send m with ...[] to me into x and wait', 'join-send-spread local 1'],
])('register the reached destination: %s', (line, instruction) => {
  const code = ops(
    `on t\n  wait for all\n    ${line}\n  end wait\n  return x\nend t\n`,
  );
  expect(code).toContain(instruction);
  expect(code.filter(c => c.startsWith('store 0'))).toEqual(['store 0']);
  expect(code.some(c => c.startsWith('move'))).toBe(false);
});

test('a member destination can be a Script Variable, and old members keep their operands', () => {
  const code = ops(
    'script variable x\non t\n  wait for all\n    ask g to op into x and wait\n    send m to me and wait\n  end wait\nend t\n',
  );
  expect(code).toContain('join-ask g op 0 variable 0');
  expect(code).toContain('join-send m 0');
  expect(code.some(c => c.startsWith('store-var'))).toBe(false);
});

test('loops and branches keep destination registration at the member start', () => {
  const code = ops(
    'on t\n  wait for all\n    repeat 3 times\n      if true then\n        ask g to op into x and wait\n      end if\n    end repeat\n    ask g to op into x and wait\n  end wait\nend t\n',
  );
  expect(code.filter(c => c.startsWith('join-ask'))).toEqual([
    'join-ask g op 0 local 1',
    'join-ask g op 0 local 1',
  ]);
  expect(code.some(c => c.startsWith('move'))).toBe(false);
});

test.each(['ask g to op into k and wait', 'send m to me into k and wait'])(
  'a member cannot write a Constant: %s',
  line => {
    expect(() =>
      ops(`constant k = 1\non t\n wait for all\n  ${line}\n end wait\nend t\n`),
    ).toThrow("`k` can't be put into");
  },
);
