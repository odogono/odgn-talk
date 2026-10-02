import { expect, test } from 'bun:test';
import {
  localeCapability,
  newGroup,
  parseInstant,
  text,
  num,
  list,
  map,
  dec,
  HostError,
  ScriptError,
  type LocaleImpl,
  type Costs,
  LoadError,
  compileLibrary,
  restore,
} from '../src/index';

const now = parseInstant('2026-10-02T12:00:00Z');
const names = (count: number) =>
  list(...Array.from({ length: count }, (_, i) => text(String(i))));
const symbols = map([
  ['decimal', text('.')],
  ['group', text(',')],
  ['minus', text('-')],
  ['digits', names(10)],
  ['primaryGroup', num(3)],
  ['secondaryGroup', num(3)],
  ['minGrouping', num(1)],
]);
const impl: LocaleImpl = {
  compare: () => num(0),
  rank: () => map([]),
  upper: () => text('İ'),
  lower: () => text('ı'),
  numberSymbols: () => symbols,
  monthNames: () => names(12),
  dayNames: () => names(7),
  tag: call => text(call.binding),
};
const costs: Costs = Object.fromEntries(
  Object.keys(impl).map(name => [name, { fuel: 7 }]),
);
const run = (body: string, host = impl, binding = 'en-GB') => {
  const lines: string[] = [];
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  g.load({
    name: 's',
    source: `script variable seen = nothing\non go\n${body}\nput it into seen\nend`,
    grants: { loc: localeCapability(host, costs).grant('all', binding) },
  }).deliver({ name: 'go' });
  const report = g.pump(now).reports.find(r => r.kind === 'run end')!;
  return {
    g,
    lines,
    report,
    seen: new Map(g.inspect().scripts[0]!.vars).get('seen')!,
  };
};

test('Locale requires every Host method and cost, and copies declared costs', () => {
  for (const name of Object.keys(impl)) {
    expect(() =>
      localeCapability(
        { ...impl, [name]: undefined } as unknown as LocaleImpl,
        costs,
      ),
    ).toThrow(HostError);
    const missing = { ...costs };
    delete missing[name];
    expect(() => localeCapability(impl, missing)).toThrow(HostError);
    expect(() =>
      localeCapability(impl, { ...costs, [name]: { fuel: -1 } }),
    ).toThrow(HostError);
  }
  const given = { ...costs, upper: { fuel: 3 } };
  const cap = localeCapability(impl, given);
  given.upper.fuel = 99;
  expect(cap.operations.get('upper')!.cost.fuel).toBe(3);
});

test('Locale forwards all Operations, default options, binding and explicit tags', () => {
  const seen: unknown[] = [];
  const host: LocaleImpl = {
    compare(call, a, b, opts, tag) {
      seen.push([
        call.binding,
        call.now,
        a.asText(),
        b.asText(),
        opts.toString(),
        tag,
      ]);
      return num(-1);
    },
    rank(_call, texts, opts, tag) {
      seen.push([texts.toString(), opts.toString(), tag]);
      return map([['a', num(1)]]);
    },
    upper(_call, value, tag) {
      seen.push([value.asText(), tag]);
      return text('İ');
    },
    lower(_call, value, tag) {
      seen.push([value.asText(), tag]);
      return text('ı');
    },
    numberSymbols(_call, tag) {
      seen.push(tag);
      return symbols;
    },
    monthNames(_call, opts, tag) {
      seen.push([opts.toString(), tag]);
      return names(12);
    },
    dayNames(_call, opts, tag) {
      seen.push([opts.toString(), tag]);
      return names(7);
    },
    tag(call, tag) {
      return text(tag ?? call.binding);
    },
  };
  const result = run(
    'ask loc to compare "a", "b"\nask loc to rank ["a", "a"], {numeric: true}, "de"\nask loc to upper "i", "tr"\nask loc to lower "I", "tr"\nask loc to numberSymbols nothing\nask loc to monthNames {width: "short"}\nask loc to dayNames "fr"\nask loc to tag',
    host,
  );
  expect(result.report.outcome).toBe('completed');
  expect(result.seen.asText()).toBe('en-GB');
  expect(seen).toEqual([
    [
      'en-GB',
      now,
      'a',
      'b',
      '{sensitivity: "variant", numeric: false}',
      undefined,
    ],
    ['["a", "a"]', '{sensitivity: "variant", numeric: true}', 'de'],
    ['i', 'tr'],
    ['I', 'tr'],
    undefined,
    ['{width: "short", form: "format"}', undefined],
    ['{width: "long", form: "format"}', 'fr'],
  ]);
});

test('Locale optional arguments distinguish maps, tags and Nothing without changing the Trace', () => {
  for (const [suffix, tag] of [
    ['', undefined],
    [', nothing', undefined],
    [', "de"', 'de'],
    [', nothing, "de"', 'de'],
    [', {}, nothing', undefined],
  ] as const) {
    const received: unknown[] = [];
    const result = run(`ask loc to compare "a", "b"${suffix}`, {
      ...impl,
      compare: (_call, _a, _b, opts, t) => {
        received.push(opts.toString(), t);
        return num(0);
      },
    });
    expect(result.report.outcome).toBe('completed');
    expect(received).toEqual(['{sensitivity: "variant", numeric: false}', tag]);
    const args = result.lines.find(line => line.startsWith('call '))!;
    expect(args).not.toContain('sensitivity');
    if (suffix.includes('nothing')) {
      expect(args).toContain('nothing');
    }
  }
});

test('Locale accepts RFC 5646 syntax including private-use, grandfathered and unregistered tags', () => {
  for (const tag of [
    'und',
    'DE-ch',
    'zh-cmn-Hans-CN',
    'es-419',
    'de-1901',
    'en-a-abc-b-12-x-private',
    'x-a',
    'i-klingon',
    'sgn-BE-FR',
    'en-GB-oed',
    'qzz-QZ',
    'en-1901-1901',
    'en-a-abc-a-def',
  ]) {
    const result = run(`ask loc to tag "${tag}"`, {
      ...impl,
      tag: (_call, t) => text(t!),
    });
    expect(result.seen.asText()).toBe(tag);
  }
});

test('Locale rejects malformed explicit and default tags before Host execution or call costs', () => {
  for (const tag of [
    '',
    'en_US',
    'en--GB',
    'en-',
    'x',
    'i-madeup',
    'a-abc',
    'en-a',
    'en-x',
    'en-1234abcd9',
    'en-GB-Latn',
    'en-12',
    'é',
    'en\n',
  ]) {
    for (const explicit of [true, false]) {
      let called = false;
      const result = run(
        `ask loc to tag${explicit ? ' ' + (tag === 'en\n' ? '"en" & newline' : JSON.stringify(tag)) : ''}`,
        {
          ...impl,
          tag: () => {
            called = true;
            return text('und');
          },
        },
        tag,
      );
      expect(called).toBe(false);
      expect(result.report.error?.code).toBe('bad locale');
      expect(result.report.error?.data.get('locale').asText()).toBe(tag);
      expect(result.lines.some(line => line.startsWith('call '))).toBe(false);
    }
  }
  expect(
    run(
      'ask loc to tag "de"',
      { ...impl, tag: (_call, tag) => text(tag!) },
      'bad_tag',
    ).report.outcome,
  ).toBe('completed');
});

test('Locale checks option words and rejects two tag positions before reaching the Host', () => {
  for (const body of [
    'ask loc to compare "a", "b", {sensitivity: "wrong"}',
    'ask loc to monthNames {width: "wrong"}',
    'ask loc to dayNames {form: "wrong"}',
    'ask loc to compare "a", "b", "de", "fr"',
  ]) {
    const result = run(body);
    expect(result.report.error?.code).toBe('out of domain');
    expect(result.lines.some(line => line.startsWith('call '))).toBe(false);
  }
});

test('Locale rank accepts exactly the distinct texts with dense positive integer ranks', () => {
  const answers = [
    [
      map([
        ['b', num(2)],
        ['a', num(1)],
      ]),
      true,
    ],
    [
      map([
        ['a', num(1)],
        ['b', num(1)],
      ]),
      true,
    ],
    [
      map([
        ['a', num(1)],
        ['b', num(3)],
      ]),
      false,
    ],
    [
      map([
        ['a', num(0)],
        ['b', num(1)],
      ]),
      false,
    ],
    [
      map([
        ['a', num(1)],
        ['b', dec('1.000000000000000000000000000000001')],
      ]),
      false,
    ],
    [map([['a', num(1)]]), false],
    [
      map([
        ['a', num(1)],
        ['b', num(2)],
        ['c', num(3)],
      ]),
      false,
    ],
    [
      map([
        ['a', text('1')],
        ['b', num(2)],
      ]),
      false,
    ],
  ] as const;
  for (const [answer, valid] of answers) {
    const result = run('ask loc to rank ["a", "b", "a"]', {
      ...impl,
      rank: () => answer,
    });
    expect(result.report.outcome).toBe(valid ? 'completed' : 'errored');
    if (!valid) {
      expect(result.report.error?.code).toBe('host error');
    }
  }
  expect(run('ask loc to rank []').seen.toString()).toBe('{}');
});

test('Locale checks compare range, name counts, symbols and returned tag syntax', () => {
  for (const [op, args, answer] of [
    ['compare', ' "a", "b"', num(2)],
    ['compare', ' "a", "b"', dec('0.1')],
    ['monthNames', '', names(11)],
    ['dayNames', '', names(8)],
    [
      'numberSymbols',
      '',
      map(symbols.entries().filter(([key]) => key !== 'digits')),
    ],
    [
      'numberSymbols',
      '',
      map(
        symbols
          .entries()
          .map(([key, value]) => [key, key === 'minGrouping' ? num(0) : value]),
      ),
    ],
    ['tag', '', text('en_US')],
    ['upper', ' "i"', num(1)],
  ] as const) {
    expect(
      run(`ask loc to ${op}${args}`, { ...impl, [op]: () => answer }).report
        .error?.code,
    ).toBe('host error');
  }
  expect(
    run('ask loc to upper "e"', {
      ...impl,
      upper: () => text('e\u0301'),
    }).seen.asText(),
  ).toBe('é');
});

test('Locale Host failures cannot claim bad locale or other catalogue errors', () => {
  expect(
    run('ask loc to tag', {
      ...impl,
      tag: () => {
        throw new ScriptError(
          'bad locale',
          'host detail',
          map([['locale', text('en')]]),
        );
      },
    }).report.error?.code,
  ).toBe('host error');
});

test('Locale enforces Grants, modes, arities and option Shapes at load and runtime', () => {
  const g = newGroup({ name: 'g' });
  const loc = localeCapability(impl, costs);
  for (const body of [
    'tell loc to upper "x"',
    'ask loc to upper',
    'ask loc to compare "a"',
    'ask loc to upper "a", "en", "fr"',
  ]) {
    expect(() =>
      g.load({
        name: 's',
        source: `on go\n${body}\nend`,
        grants: { loc: loc.grant('all', 'en') },
      }),
    ).toThrow(LoadError);
  }
  expect(() =>
    g.load({ name: 's', source: 'on go\nask loc to tag\nend' }),
  ).toThrow(LoadError);
  for (const body of [
    'put [1] into bad\nask loc to rank bad',
    'put {unknown: "x"} into bad\nask loc to monthNames bad',
    'put {numeric: "yes"} into bad\nask loc to compare "a", "b", bad',
  ]) {
    expect(run(body).report.error?.code).toBe('wrong kind');
  }
  const result = run('put ["a", 1] into badTexts\nask loc to rank badTexts');
  expect(result.report.error?.code).toBe('wrong kind');
  expect(result.report.error?.data.get('path').toString()).toBe('[2]');
  expect(result.lines.some(line => line.startsWith('call '))).toBe(false);
});

test('Locale pays declared and Host costs, and rolls back on Fuel exhaustion', () => {
  let called = false;
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source:
      'script variable touched = 0\non go\nadd 1 to touched\nask loc to tag\nend',
    limits: { fuelPerRun: 40 },
    grants: {
      loc: localeCapability(
        {
          ...impl,
          tag: () => {
            called = true;
            return text('en');
          },
        },
        { ...costs, tag: { fuel: 100 } },
      ).grant('all', 'en'),
    },
  }).deliver({ name: 'go' });
  expect(g.pump(now).reports.find(r => r.kind === 'run end')!.outcome).toBe(
    'limit fault',
  );
  expect(called).toBe(false);
  expect(new Map(g.inspect().scripts[0]!.vars).get('touched')!.toString()).toBe(
    '0',
  );
  const result = run('ask loc to rank ["a"]', {
    ...impl,
    rank: call => {
      call.charge(5);
      return map([['a', num(1)]]);
    },
  });
  expect(result.lines.some(line => line.includes('charged=5'))).toBe(true);
});

test('Locale Library needs and result checks survive Restore', () => {
  const helper = compileLibrary(
    {
      name: 'helper',
      version: '1',
      source: 'function order texts\nask loc to rank texts\nreturn it\nend',
    },
    [],
    {
      loc: {
        rank: {
          mode: 'immediate',
          args: [
            ...localeCapability(impl, costs).operations.get('rank')!.args!,
          ],
        },
      },
    },
  );
  const g = newGroup({ name: 'g' });
  g.addLibrary(helper);
  const script = g.load({
    name: 's',
    source: 'use order from helper\non go\nput order(["a"]) into ranks\nend',
    grantsAsUsed: true,
    grants: { loc: localeCapability(impl, costs).grant('all', 'en') },
  });
  expect(script.grants()).toEqual({ loc: ['rank'] });
  const copy = restore(g.save(), {
    name: 'copy',
    libraries: [helper],
    grants: () => localeCapability(impl, costs).grant('all', 'en'),
    resolve: () => undefined,
    onMismatch: 'reject',
  }).group;
  expect(copy.fingerprint()).toEqual(g.fingerprint());
  copy.script('s')!.deliver({ name: 'go' });
  expect(
    copy.pump(now).reports.find(r => r.kind === 'run end')!.error?.code,
  ).toBe('host error');
});

test('Locale rank uses exact normalized keys including object-prototype names', () => {
  const answer = map([
    ['__proto__', num(1)],
    ['é', num(2)],
  ]);
  expect(
    run('ask loc to rank ["__proto__", "é", "é"]', {
      ...impl,
      rank: () => answer,
    }).seen.equals(answer),
  ).toBe(true);
  expect(
    run('ask loc to rank ["a"]', {
      ...impl,
      rank: () => map([['a', dec('1000000000000000000000000000000000')]]),
    }).report.error?.code,
  ).toBe('host error');
});
