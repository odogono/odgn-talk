import { describe, expect, test } from 'bun:test';
import { compileSource, parseSource, syntaxText } from '../src';
import { parse } from '../../../tools/grammar/parser';

const explicitSources: readonly (readonly [string, string])[] = [
  ['Handler', 'on h\nend h'],
  ['function', 'function f x\n  return x\nend f'],
  ['Handler finally', 'on h\n  put 1 into x\nfinally\n  put 2 into x\nend h'],
  [
    'if branches',
    'on h\n  if true then\n    put 1 into x\n  else if false then\n    put 2 into x\n  else\n    put 3 into x\n  end if\nend h',
  ],
  ...[
    '3 times',
    'while true',
    'until false',
    'forever',
    'for each x in [1]',
  ].map(
    head =>
      [
        'repeat ' + head,
        `on h\n  repeat ${head}\n  end repeat\nend h`,
      ] as const,
  ),
  [
    'match branches',
    'on h\n  match 1\n    when 1 then\n      put 1 into x\n    else\n      put 2 into x\n  end match\nend h',
  ],
  [
    'try catch finally',
    'on h\n  try\n    put 1 into x\n  catch e\n    put 2 into x\n  finally\n    put 3 into x\n  end try\nend h',
  ],
  ['Join', 'on h\n  wait for all\n    put 1 into x\n  end wait\nend h'],
  [
    'tell block',
    'on h\n  tell canvas\n    fill "red"\n    rectangle 1, 2\n  end tell\nend h',
  ],
  [
    'tell block in a Join',
    'on h\n  wait for all\n    tell feed\n      fetch "a" and wait\n    end tell\n  end wait\nend h',
  ],
  [
    'Timeout Block',
    'on h\n  with timeout of 1 s\n    wait 1 s\n  end timeout\nend h',
  ],
  [
    'waiting branches',
    'on h\n  wait for\n    when done x then\n      put x into y\n    after 1 s then\n      put 0 into y\n  end wait\nend h',
  ],
  [
    'Lambda assignment',
    'on h\n  put given x\n    return x\n  end given into f\nend h',
  ],
  [
    'Lambda call argument',
    'on h\n  put apply(given x\n    return x\n  end given, 2) into y\nend h',
  ],
  [
    'Lambda call with trailing comment and newline',
    'on h\n  put apply(given x\n    return x\n  end given -- close\n  ) into y\nend h',
  ],
  [
    'Lambda list',
    'on h\n  put [given x\n    return x\n  end given] into ys\nend h',
  ],
  [
    'Lambda map',
    'on h\n  put {f: given x\n    return x\n  end given} into m\nend h',
  ],
  [
    'Lambda list with trailing comment and newline',
    'on h\n  put [given x\n    return x\n  end given -- close\n  ] into ys\nend h',
  ],
  [
    'Lambda map with trailing comment and newline',
    'on h\n  put {f: given x\n    return x\n  end given -- close\n  } into m\nend h',
  ],
  [
    'Lambda grouping and comparison',
    'on h\n  put (given x\n    return x\n  end given\n  ) = nothing into y\nend h',
  ],
  [
    'nested Lambdas and structural blocks',
    'on h\n  put given x\n    put given y\n      if true then\n        return y\n      end if\n    end given into f\n    return f(x)\n  end given into f\nend h',
  ],
] as const;

const bareEnds = (source: string) =>
  source.replaceAll(/^(\s*end) [a-z]+/gm, '$1');

// Mixed spellings: bare inner endings with an explicit outermost one, and the
// reverse.
const mixedEnds = (source: string) => {
  const lines = source.split('\n');
  const last = lines.map(line => /^\s*end [a-z]+/.test(line)).lastIndexOf(true);
  const keepLast = lines
    .map((line, i) => (i === last ? line : bareEnds(line)))
    .join('\n');
  const bareLast = lines
    .map((line, i) => (i === last ? bareEnds(line) : line))
    .join('\n');
  return [keepLast, bareLast];
};

describe('optional block endings', () => {
  for (const [label, explicit] of explicitSources) {
    test(`bare, explicit and mixed endings preserve ${label}`, () => {
      for (const source of [
        explicit,
        bareEnds(explicit),
        ...mixedEnds(explicit),
      ]) {
        const core = parseSource(source);
        expect(core.error).toBeNull();
        expect(syntaxText(core.tree!)).toBe(source);
        const tooling = parse(source);
        expect(tooling.error).toBeNull();
        expect(tooling.stats.relexes).toEqual([]);
      }
    });
  }

  test('mixed endings close one innermost block regardless of indentation', () => {
    const source =
      'on h\nrepeat 3 times\nif true then\n  put 1 into x\nend\nend repeat\nend';
    expect(parseSource(source).error).toBeNull();
    expect(parse(source).error).toBeNull();
  });

  for (const [label, source, line, col] of [
    ['wrong Handler name', 'on h\nend other', 2, 5],
    ['wrong function name', 'function f\nend other', 2, 5],
    ['closing through an inner block', 'on h\nrepeat 3 times\nend h', 3, 5],
    ['wrong block keyword', 'on h\nif true then\nend repeat\nend', 3, 5],
    ['wrong tell block keyword', 'on h\ntell canvas\nend repeat\nend', 3, 5],
    [
      'wrong Timeout Block keyword',
      'on h\nwith timeout of 1 s\nwait 1 s\nend wait\nend',
      4,
      5,
    ],
    [
      'wrong Lambda keyword',
      'on h\nput given x\nreturn x\nend repeat into f\nend',
      4,
      5,
    ],
    ['missing outer ending', 'on h\nrepeat 3 times\nend', 3, 4],
    ['extra ending', 'on h\nend\nend', 3, 1],
    ['same-line statements', 'on h\nif true then\nend put 1 into x\nend', 3, 5],
    [
      'suffix on next line',
      'on h\nput [given x\nreturn x\nend\ngiven: x] into fs\nend',
      5,
      1,
    ],
    [
      'ungrouped Lambda arithmetic',
      'on h\nput given x\nreturn x\nend + 1 into f\nend',
      4,
      5,
    ],
    [
      'ungrouped Lambda conversion',
      'on h\nput given x\nreturn x\nend as function into f\nend',
      4,
      5,
    ],
  ] as const) {
    test(`rejects ${label} at its first invalid token`, () => {
      for (const result of [parseSource(source), parse(source)]) {
        expect(result.error?.code).toBe('unexpected token');
        expect(result.error?.tok).toMatchObject({ line, col });
      }
    });
  }

  for (const [label, source, message] of [
    [
      'wrong block keyword',
      'on h\nif true then\nend repeat\nend',
      'expected end of line or `if` after `end` (closing line 2), found `repeat`',
    ],
    [
      'wrong Lambda keyword',
      'on h\nput given x\nreturn x\nend if into f\nend',
      'expected end of line or `given` after `end` (closing line 2), found `if`',
    ],
    [
      'wrong tell block keyword',
      'on h\ntell canvas\nend if\nend',
      'expected end of line or `tell` after `end` (closing line 2), found `if`',
    ],
    [
      'wrong Timeout Block keyword',
      'on h\nwith timeout of 1 s\nwait 1 s\nend if\nend',
      'expected end of line or `timeout` after `end` (closing line 2), found `if`',
    ],
    [
      'Lambda closed with end tell',
      'on h\nput given x\nreturn x\nend tell into f\nend',
      'expected end of line or `given` after `end` (closing line 2), found `tell`',
    ],
  ] as const) {
    test(`names the open block for ${label}`, () => {
      for (const result of [parseSource(source), parse(source)]) {
        expect(result.error?.message).toBe(message);
      }
    });
  }

  test('bare endings preserve lowering, suspension and cleanup', () => {
    const explicit =
      'function f x\n  return x + 1\nend f\non h\n  put given x\n    return f(x)\n  end given into g\n  repeat 3 times\n    if true then\n      put g(1) into x\n    end if\n  end repeat\n  match x\n    when 2 then put 3 into x\n  end match\n  try\n    wait for all\n      send finished to me and wait\n    end wait\n    wait for\n      after 1 s then put 5 into x\n    end wait\n  finally\n    put 6 into x\n  end try\nfinally\n  put 7 into x\nend h';
    const units = [explicit, bareEnds(explicit)].map(source => {
      const result = compileSource(source, { name: 'test' });
      expect(result.error).toBeNull();
      expect(result.diagnostics).toEqual([]);
      expect(result.unit).not.toBeNull();
      const unit = result.unit!;
      return {
        ...unit,
        code: unit.code.map(({ op, operands }) => ({ op, operands })),
      };
    });
    expect(units[1]).toEqual(units[0]);
  });
});
