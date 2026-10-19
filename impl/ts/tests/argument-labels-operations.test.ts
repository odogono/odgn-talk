// Argument Labels on Operation Declarations (ADR 0115; chapter 4,
// Capabilities; chapter 5, Labelled Host Commands; chapter 9, Argument Labels).
import { describe, expect, test } from 'bun:test';
import {
  compileLibrary,
  defineCapability,
  disassemble,
  exportManifest,
  HostError,
  LoadError,
  newGroup,
  parseInstant,
  parseSource,
  restore,
  shape,
  text,
  type Grant,
  type Operation,
  type SyntaxNode,
} from '../src/index';
import { compileSource } from '../src/lowering';
import type { GrantDecls } from '../src/effects';

const now = parseInstant('2026-09-30T09:00:00Z');
const world = defineCapability('world', {
  move: {
    mode: 'immediate',
    args: [shape.text, shape.text],
    labels: ['to'],
    result: shape.text,
    cost: { fuel: 1 },
    do: (_call, _a, b) => b!,
  },
  mark: {
    mode: 'fire-and-forget',
    args: [shape.text, shape.optional(shape.text), shape.optional(shape.text)],
    labels: ['at', 'by'],
    cost: { fuel: 1 },
    fire: () => {},
  },
  fetch: {
    mode: 'suspending',
    args: [shape.text, shape.text],
    labels: ['toward'],
    result: shape.text,
    cost: { fuel: 1 },
    start: call => call.answer(text('fetched')),
  },
  swap: {
    mode: 'immediate',
    args: [shape.text, shape.text],
    result: shape.text,
    cost: { fuel: 1 },
    do: (_call, a) => a!,
  },
});
const all = () => ({ world: world.grant('all', undefined) });

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
const run = (
  source: string,
  grants: Record<string, Grant<unknown>> = all(),
) => {
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  group.load({ name: 's', source, grants }).deliver({ name: 'go' });
  group.pump(now);
  group.inspect();
  return lines;
};
const find = (node: SyntaxNode, rule: string): SyntaxNode | undefined => {
  if (node.rule === rule) {
    return node;
  }
  for (const child of node.children) {
    const found = child.kind === 'node' ? find(child, rule) : undefined;
    if (found) {
      return found;
    }
  }
  return undefined;
};

const fire: Operation<void> = {
  mode: 'fire-and-forget',
  args: [shape.text, shape.text],
  cost: { fuel: 0 },
  fire: () => {},
};
const declared = (labels: string[]) =>
  defineCapability('world', { op: { ...fire, labels } });
const declarations = (labels: string[]): GrantDecls => ({
  world: {
    move: { mode: 'immediate', args: [shape.text, shape.text], labels },
  },
});
const manifest = (labels?: string[]) =>
  exportManifest({
    kind: 'k',
    version: '1',
    grants: { world: declared(labels ?? []).grant('all', undefined) },
  });
const fingerprint = (labels?: string[]) => {
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: 'on go\nend go',
    grants: {
      world: (labels
        ? declared(labels)
        : defineCapability('world', { op: fire })
      ).grant('all', undefined),
    },
  });
  return g.fingerprint();
};

describe('declaring', () => {
  test.each([
    ['a word that is not a label', ['from']],
    ['an excluded word', ['with']],
    ['a Reserved Word other than `to`', ['into']],
    ['a non-word', ['to:']],
    ['too many', ['to', 'by']],
    ['a non-text entry', [1 as unknown as string]],
  ])('refuses %s', (_name, labels) => {
    expect(() => defineCapability('x', { op: { ...fire, labels } })).toThrow(
      HostError,
    );
  });
  test('takes `to`, any Name, and an empty list', () => {
    for (const labels of [['to'], ['toward'], []]) {
      expect(() =>
        defineCapability('x', { op: { ...fire, labels } }),
      ).not.toThrow();
    }
    expect(() =>
      defineCapability('x', { op: { ...fire, args: [], labels: [] } }),
    ).not.toThrow();
  });

  test('the manifest and Fingerprint carry labels after `args`', () => {
    expect(manifest(['to'])).toContain(
      '"args":["text","text"],"labels":["to"],',
    );
    expect(manifest([])).not.toContain('labels');
    expect(fingerprint(['to'])).not.toEqual(fingerprint());
    expect(fingerprint(['to'])).not.toEqual(fingerprint(['toward']));
    expect(fingerprint([])).toEqual(fingerprint());
  });

  test('restore treats changed labels as a declaration mismatch', () => {
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'on go\n  tell world to op "a", "b"\nend go',
      grants: { world: declared(['to']).grant('all', undefined) },
    });
    const saved = g.save();
    const options = (labels: string[]) => ({
      name: 'resumed',
      libraries: [],
      grants: () => declared(labels).grant('all', undefined),
      resolve: () => undefined,
      onMismatch: 'reject' as const,
    });
    expect(() => restore(saved, options(['toward']))).toThrow('save mismatch');
    expect(() => restore(saved, options(['to']))).not.toThrow();
  });
});

describe('parsing', () => {
  test('a labelled `ask` keeps its labels in its argument list', () => {
    const source =
      'on t a, b\n  ask world to move a to b into spot and wait\nend t';
    const tree = parseSource(source).tree!;
    const ask = find(tree, 'AskTell')!;
    expect(
      ask.children.flatMap(c => (c.kind === 'node' ? [c.rule] : [])),
    ).toEqual(['Expression', 'ExpressionList', 'ResultTarget', 'AndWait']);
    const list = find(ask, 'ExpressionList')!;
    expect(
      list.children.flatMap(c => (c.kind === 'node' ? [c.rule] : [])),
    ).toEqual(['Expression', 'Label', 'Expression']);
  });

  test('a `tell` block line takes labels, `to` included', () => {
    const { error } = parseSource(
      'on t\n  tell log\n    write "x" to "y"\n    mark "a" at "b" by "c"\n  end tell\nend t',
    );
    expect(error).toBeNull();
  });

  test.each([
    ['  ask g to op a to b, c', 2, 21],
    ['  ask g to op a, b to c', 2, 20],
    ['  tell g to op a from b', 2, 18],
  ])('rejects mixing or a non-label: %s', (line, l, c) => {
    const { error } = parseSource(`on t a, b, c\n${line}\nend t\n`);
    expect(error).not.toBeNull();
    expect([error!.tok.line, error!.tok.col]).toEqual([l, c]);
  });
});

describe('load checks', () => {
  test.each([
    ['ask world to move "a" to "b"', []],
    ['ask world to move "a", "b"', []],
    ['tell world to mark "a"', []],
    ['tell world to mark "a" at "b"', []],
    ['tell world to mark "a" at "b" by "c"', []],
    ['ask world to move "a" at "b"', ['wrong labels 2:25']],
    ['ask world to swap "a" to "b"', ['wrong labels 2:25']],
    ['tell world to mark "a" by "b"', ['wrong labels 2:26']],
    ['tell world to mark "a" at "b" at "c"', ['wrong labels 2:33']],
    ['ask world to move "a" to "b" to "c"', ['wrong argument count 2:16']],
    ['ask world to move "a" to "b" and wait', ['wrong mode 2:3']],
    ['tell world\n    mark "a" toward "b"\n  end tell', ['wrong labels 3:14']],
    [
      'wait for all\n    ask world to fetch "a" to "b" and wait\n  end wait',
      ['wrong labels 3:28'],
    ],
  ])('%s', (line, diagnostics) => {
    expect(loadCodes(`on go\n  ${line}\nend go`)).toEqual(diagnostics);
  });
});

describe('lowering and calls', () => {
  const grants: GrantDecls = {
    world: {
      move: {
        mode: 'immediate',
        args: [shape.text, shape.text],
        labels: ['to'],
      },
    },
  };
  const code = (body: string) => {
    const result = compileSource(`on go a, b\n  ${body}\nend go`, {
      name: 's',
      unit: 'script',
      grants,
    });
    expect(result.diagnostics).toEqual([]);
    return disassemble(result.unit!).replaceAll(/ \d+:\d+ /g, ' ');
  };
  test('a labelled call lowers as the positional one', () => {
    expect(code('ask world to move a to b into x')).toBe(
      code('ask world to move a, b into x'),
    );
  });
  test('the Host function sees only positional arguments', () => {
    const lines = run(
      'script variable x\non go\n  ask world to move "a" to "b" into x\nend go',
    );
    expect(lines.filter(l => l.startsWith('call '))).toEqual([
      'call s/r1.c1 op=world.move args=["a", "b"] result="b"',
    ]);
  });
});

describe('Host Commands', () => {
  const board = defineCapability('board', {
    move: {
      mode: 'immediate',
      command: true,
      args: [shape.text, shape.text],
      labels: ['to'],
      result: shape.text,
      cost: { fuel: 1 },
      do: () => text('moved'),
    },
    mark: {
      mode: 'immediate',
      command: true,
      args: [shape.text, shape.optional(shape.text), shape.text],
      labels: ['at', 'by'],
      result: shape.text,
      cost: { fuel: 1 },
      do: () => text('marked'),
    },
  });
  const grants = () => ({ board: board.grant('all', undefined) });

  test('both spellings call the Operation', () => {
    const lines = run(
      'script variable seen = []\non go\n  move "a" to "b"\n  put it after seen\n  move "a", "b"\n  put it after seen\nend go',
      grants(),
    );
    expect(lines.filter(l => l.startsWith('call ')).length).toBe(2);
    expect(lines.at(-1)).toBe('vars s seen=["moved", "moved"]');
  });

  test('a Handler shadows only the spelling with its Selector', () => {
    const lines = run(
      'script variable seen = []\non move p to q\n  return "handled"\nend move\non go\n  move "a" to "b"\n  put it after seen\n  move "a", "b"\n  put it after seen\n  move "a" at "b"\nend go',
      grants(),
    );
    expect(lines.filter(l => l.startsWith('call ')).length).toBe(1);
    expect(lines).toContain('unhandled message=move:at: args=["a", "b"]');
    expect(lines.at(-1)).toBe('vars s seen=["handled", "moved"]');
  });

  test('a labelled spelling exists only for the argument counts it accepts', () => {
    // `mark` takes 3 arguments, or 2 dropping none (its Optional isn't last),
    // so `mark:at:` isn't a spelling and climbs.
    const lines = run(
      'on go\n  mark "a" at "b" by "c"\n  mark "a" at "b"\nend go',
      grants(),
    );
    expect(lines.filter(l => l.startsWith('call ')).length).toBe(1);
    expect(lines).toContain('unhandled message=mark:at: args=["a", "b"]');
  });

  test('two Grants offering one labelled spelling clash at the call', () => {
    expect(
      loadCodes('on go\n  move "a" to "b"\nend go', {
        board: board.grant(['move'], undefined),
        other: board.grant(['move'], undefined),
      }),
    ).toEqual(['name clash 2:3']);
  });

  test('a Library makes the labelled call as a Host Command', () => {
    const lib = compileLibrary(
      {
        name: 'lib',
        version: '1',
        source: 'on go2\n  move "a" to "b"\n  return it\nend go2',
      },
      [],
      {
        board: {
          move: {
            mode: 'immediate',
            args: [shape.text, shape.text],
            labels: ['to'],
            command: true,
          },
        },
      },
    );
    expect(lib.needs).toEqual([{ capability: 'board', operation: 'move' }]);
  });
});

describe('Libraries', () => {
  const source =
    'on route a, b\n  ask world to move a to b\n  return it\nend route';

  test('a labelled call is checked against the compilation declarations', () => {
    expect(() =>
      compileLibrary(
        { name: 'router', version: '1', source },
        [],
        declarations(['toward']),
      ),
    ).toThrow(LoadError);
  });

  test("an importer's declarations are rechecked at its `use` line", () => {
    const g = newGroup({ name: 'g' });
    g.addLibrary(
      compileLibrary(
        { name: 'router', version: '1', source },
        [],
        declarations(['to']),
      ),
    );
    expect(() =>
      g.load({ name: 's', source: 'use route from router', grants: all() }),
    ).not.toThrow();
    const drift = defineCapability('drift', {
      move: {
        mode: 'immediate',
        args: [shape.text, shape.text],
        labels: ['toward'],
        result: shape.text,
        cost: { fuel: 1 },
        do: (_call, a) => a!,
      },
    });
    try {
      g.load({
        name: 't',
        source: '\nuse route from router',
        grants: { world: drift.grant('all', undefined) },
      });
      throw new Error('loaded');
    } catch (error) {
      expect(
        (error as LoadError).diagnostics.map(d => [d.code, d.line, d.col]),
      ).toEqual([['wrong labels', 2, 1]]);
    }
  });
});
