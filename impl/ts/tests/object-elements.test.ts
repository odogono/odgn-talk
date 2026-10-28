import { describe, expect, test } from 'bun:test';
import { canonicalJSON, exportManifest } from '../src/manifest';
import {
  SessionHost,
  parseTranscript,
  replayTranscript,
  writeTranscript,
  type TranscriptItem,
} from '../src/session';
import {
  defineObjectKind,
  HostError,
  map,
  newGroup,
  nothing,
  num,
  parseInstant,
  ScriptError,
  shape,
  text,
  type HostObject,
  type ObjectElements,
  type Value,
} from '../src/index';

// Object Element References (#1143): the Host API and its result checks.
const now = parseInstant('2026-10-17T09:00:00Z');
const cell = defineObjectKind<null>({ name: 'elements-cell', props: {} });
const cost = { fuel: 1 };

const logOf = (group: ReturnType<typeof newGroup>): Value =>
  group
    .inspect()
    .scripts.find(s => s.name === 's')!
    .vars.find(([name]) => name === 'log')![1];

const collection = (
  answers: Partial<Pick<ObjectElements<null>, 'at' | 'count' | 'find'>>,
): ObjectElements<null> => ({
  shape: shape.object(cell),
  count: () => num(0),
  at: () => nothing,
  find: () => nothing,
  countCost: cost,
  atCost: cost,
  findCost: cost,
  ...answers,
});

// Runs `source`'s `go` on a page whose collection answers as given, and
// gives its Trace and Script Variables.
const run = (
  name: string,
  answers: (members: HostObject<null>[]) => Partial<ObjectElements<null>>,
  source: string,
) => {
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  const members: HostObject<null>[] = [];
  const page = defineObjectKind<null>({
    name,
    props: {},
    elements: { ...collection({}), ...answers(members) },
  });
  members.push(group.object(cell, 'c1', null), group.object(cell, 'c2', null));
  const script = group.load({
    name: 's',
    objects: { thisPage: group.object(page, 'main', null) },
    source: `script variable log = []\non go\n${source}\nend go`,
  });
  script.deliver({ name: 'go' });
  group.pump(now);
  return { group, lines, log: logOf(group) };
};

describe('Object Collection definitions', () => {
  test('missing callbacks, invalid costs and non-object Shapes are invalid values', () => {
    const define = (elements: unknown) => () =>
      defineObjectKind<null>({
        name: 'elements-invalid',
        props: {},
        elements: elements as ObjectElements<null>,
      });
    const { find: _, ...noFind } = collection({});
    expect(define(noFind)).toThrow(HostError);
    expect(define({ ...collection({}), atCost: { fuel: 1.5 } })).toThrow(
      HostError,
    );
    expect(define({ ...collection({}), countCost: { fuel: -1 } })).toThrow(
      HostError,
    );
    expect(define({ ...collection({}), findCost: undefined })).toThrow(
      HostError,
    );
    expect(define({ ...collection({}), shape: shape.text })).toThrow(HostError);
    expect(define({ ...collection({}), shape: shape.value })).toThrow(
      HostError,
    );
    expect(
      define({ ...collection({}), shape: shape.optional(shape.object(cell)) }),
    ).toThrow(HostError);
    expect(
      define({
        ...collection({}),
        shape: shape.oneOf(shape.object(cell), shape.object(cell)),
      }),
    ).toThrow(HostError);
    expect(define({ ...collection({}), shape: shape.oneOf() })).toThrow(
      HostError,
    );
    expect(
      define({
        ...collection({}),
        shape: shape.oneOf(
          shape.object(cell),
          shape.object(defineObjectKind({ name: 'elements-other', props: {} })),
        ),
      }),
    ).not.toThrow();
  });

  test('later changes to the definition do not change the declaration', () => {
    const elements = collection({ count: () => num(2) });
    const kind = defineObjectKind<null>({
      name: 'elements-copied',
      props: {},
      elements,
    });
    elements.count = () => num(9);
    elements.countCost = { fuel: 100 };
    expect(kind.elements!.countCost).toEqual({ fuel: 1 });
    expect(kind.elements!.count(null as never)).toEqual(num(2));
  });

  test('the Host Manifest writes a collection declaration, and omits none', () => {
    const kind = defineObjectKind<null>({
      name: 'elements-manifest',
      props: {},
      elements: { ...collection({}), findCost: { fuel: 2, alloc: 4 } },
    });
    const manifest = JSON.parse(
      exportManifest({
        kind: 'k',
        version: '1',
        grants: {},
        objectKinds: [kind, cell],
      }),
    );
    expect(canonicalJSON(manifest.objectKinds)).toBe(
      canonicalJSON([
        {
          name: 'elements-cell',
          props: [],
          parentKinds: [],
        },
        {
          name: 'elements-manifest',
          props: [],
          parentKinds: [],
          elements: {
            shape: { object: 'elements-cell' },
            countCost: { fuel: 1, alloc: 0 },
            atCost: { fuel: 1, alloc: 0 },
            findCost: { fuel: 2, alloc: 4 },
          },
        },
      ]),
    );
  });
});

describe('Object Collection results', () => {
  test('At gets the signed position and Find the exact name, once each', () => {
    const calls: string[] = [];
    const { log } = run(
      'elements-signed',
      members => ({
        at: (_, index) => {
          calls.push(`at ${index}`);
          return members[index > 0 ? index - 1 : members.length + index]!.value;
        },
        find: (_, name) => {
          calls.push(`find ${name}`);
          return nothing;
        },
        count: () => {
          calls.push('count');
          return num(2);
        },
      }),
      '  put [element -1 of thisPage, the first element of thisPage, element "Ä" of thisPage, element 0 of thisPage] into log',
    );
    expect(calls).toEqual(['at -1', 'at 1', 'find Ä']);
    expect(log.toString()).toBe(
      '[<object elements-cell "c2">, <object elements-cell "c1">, nothing, nothing]',
    );
  });

  test('a malformed answer is host error, recorded with an empty error', () => {
    const answers: [string, (members: HostObject<null>[]) => unknown][] = [
      ['a number', () => num(3)],
      ['a Promise', () => Promise.resolve(nothing)],
      ['another kind', () => text('x')],
    ];
    for (const [what, answer] of answers) {
      const { lines, log } = run(
        `elements-malformed-${what}`,
        members => ({ at: () => answer(members) as Value }),
        '  try\n    put element 1 of thisPage into log\n  catch e\n    put e into log\n  end try',
      );
      expect(log.toString(), what).toContain('code: "host error"');
      expect(log.toString(), what).toContain('operation: "elements.at"');
      expect(
        lines.find(line => line.startsWith('prop ')),
        what,
      ).toBe(
        `prop s/r1 object=<object elements-malformed-${what} "main"> name=elements op=at selector=1 error={}`,
      );
    }
  });

  test('a count must be an integer from 0 to 2^53 - 1', () => {
    for (const count of [num(-1), num(1.5), text('2'), num(2n ** 53n)]) {
      const { log } = run(
        `elements-count-${count.toString()}`,
        () => ({ count: () => count }),
        '  try\n    put the number of elements of thisPage into log\n  catch e\n    put the code of e into log\n  end try',
      );
      expect(log.toString(), count.toString()).toBe('"host error"');
    }
  });

  test('a disposed member and another Group’s member are host error', () => {
    const other = newGroup({ name: 'other' }).object(cell, 'x', null);
    const { log: foreign } = run(
      'elements-foreign',
      () => ({ find: () => other.value }),
      '  try\n    put element "x" of thisPage into log\n  catch e\n    put the code of e into log\n  end try',
    );
    expect(foreign.toString()).toBe('"host error"');
    const group = newGroup({ name: 'g' });
    const member = group.object(cell, 'gone', null);
    const page = defineObjectKind<null>({
      name: 'elements-disposed',
      props: {},
      elements: collection({ at: () => member.value }),
    });
    const script = group.load({
      name: 's',
      objects: { thisPage: group.object(page, 'main', null) },
      source:
        'script variable log = []\non go\n  try\n    put element 1 of thisPage into log\n  catch e\n    put the code of e into log\n  end try\nend go',
    });
    group.dispose(member);
    script.deliver({ name: 'go' });
    group.pump(now);
    expect(logOf(group).toString()).toBe('"host error"');
  });

  test('a Script error from a callback carries the kind and callback names', () => {
    const { log } = run(
      'elements-refusing',
      () => ({
        count: () => {
          throw new ScriptError(
            'page locked',
            'locked',
            map([['page', text('main')]]),
          );
        },
      }),
      '  try\n    put the number of elements of thisPage into log\n  catch e\n    put e into log\n  end try',
    );
    expect(log.toString()).toContain('code: "page locked"');
    expect(log.toString()).toContain('capability: "elements-refusing"');
    expect(log.toString()).toContain('operation: "elements.count"');
  });

  test('positions past 2^53 - 1 select nothing without a callback', () => {
    const calls: number[] = [];
    const { log } = run(
      'elements-huge',
      () => ({
        at: (_, index) => {
          calls.push(index);
          return nothing;
        },
      }),
      '  put [element 9007199254740992 of thisPage, element -9007199254740992 of thisPage, element 9007199254740991 of thisPage] into log',
    );
    expect(calls).toEqual([9_007_199_254_740_991]);
    expect(log.toString()).toBe('[nothing, nothing, nothing]');
  });
});

test('a Session Transcript records collection callbacks and replays them without the Host', () => {
  const items: TranscriptItem[] = [];
  const calls: string[] = [];
  const host = new SessionHost({
    now: () => 0n,
    record: i => items.push(i),
    objects: c => {
      const member = c.defineKind({ name: 'SessionCell', props: {} });
      const kind = c.defineKind<null>({
        name: 'SessionPage',
        props: {},
        elements: {
          ...collection({}),
          shape: shape.object(member),
          count: () => {
            calls.push('count');
            return num(1);
          },
          at: (_, index) => {
            calls.push(`at ${index}`);
            return cell1.value;
          },
          find: (_, name) => {
            calls.push(`find ${name}`);
            return nothing;
          },
        },
      });
      const cell1 = c.object(member, 'c1', {});
      return { page: c.object(kind, 'p', null) };
    },
  });
  expect(
    host.input(
      '[the number of elements of page, element -1 of page, element "x" of page]',
    ),
  ).toEqual(['[1, <object SessionCell "c1">, nothing]']);
  expect(calls).toEqual(['count', 'at -1', 'find x']);
  const live = writeTranscript(items);
  expect(live).toContain(
    '"operation":"at","property":"elements","selector":-1',
  );
  expect(live).toContain('"elements":{"atCost"');
  expect(writeTranscript(replayTranscript(parseTranscript(live)).items)).toBe(
    live,
  );
  expect(calls).toHaveLength(3);
});

const twoMembers = (calls: string[]) => (members: HostObject<null>[]) => ({
  count: () => {
    calls.push('count');
    return num(members.length);
  },
  at: (_: HostObject<null>, index: number) => {
    calls.push(`at ${index}`);
    return members[index - 1]!.value;
  },
});

// Walking an Object Collection (#1627): `the elements of o` reads it whole.
describe('Walking an Object Collection', () => {
  test('the elements of o calls Count, then At for each position, in order', () => {
    const calls: string[] = [];
    const { lines, log } = run(
      'elements-walk',
      twoMembers(calls),
      '  repeat for each thing in the elements of thisPage\n    put thing after log\n  end repeat',
    );
    expect(calls).toEqual(['count', 'at 1', 'at 2']);
    expect(log.toString()).toBe(
      '[<object elements-cell "c1">, <object elements-cell "c2">]',
    );
    expect(lines.filter(line => line.startsWith('prop '))).toEqual([
      'prop s/r1 object=<object elements-walk "main"> name=elements op=count value=2',
      'prop s/r1 object=<object elements-walk "main"> name=elements op=at selector=1 value=<object elements-cell "c1">',
      'prop s/r1 object=<object elements-walk "main"> name=elements op=at selector=2 value=<object elements-cell "c2">',
    ]);
  });

  test('Whose Clauses over element read every member before testing', () => {
    const calls: string[] = [];
    const { log } = run(
      'elements-whose',
      twoMembers(calls),
      '  put [every element of thisPage whose the id of it is "c2", the first element of thisPage whose true] into log',
    );
    expect(calls).toEqual(['count', 'at 1', 'at 2', 'count', 'at 1', 'at 2']);
    expect(log.toString()).toBe(
      '[[<object elements-cell "c2">], <object elements-cell "c1">]',
    );
  });

  test('an empty collection gives [] after only Count', () => {
    const calls: string[] = [];
    const { log } = run(
      'elements-empty',
      () => ({
        count: () => {
          calls.push('count');
          return num(0);
        },
      }),
      '  put the elements of thisPage into log',
    );
    expect(calls).toEqual(['count']);
    expect(log.toString()).toBe('[]');
  });

  test('At giving Nothing below the count is host error', () => {
    const { log } = run(
      'elements-short',
      () => ({ count: () => num(2) }),
      '  try\n    put the elements of thisPage into log\n  catch e\n    put the code of e into log\n  end try',
    );
    expect(log.toString()).toBe('"host error"');
  });

  test('a list receiver is wrong kind, expecting an object', () => {
    const { log } = run(
      'elements-list',
      () => ({}),
      '  try\n    put the elements of [1, 2] into log\n  catch e\n    put [the code of e, the expected of e] into log\n  end try',
    );
    expect(log.toString()).toBe('["wrong kind", "object"]');
  });

  test('a kind with no collection is out of domain for elements', () => {
    const { log } = run(
      'elements-none',
      members => ({ at: () => members[0]!.value }),
      '  try\n    put every element of (element 1 of thisPage) whose true into log\n  catch e\n    put [the code of e, the function of e] into log\n  end try',
    );
    expect(log.toString()).toBe('["out of domain", "elements"]');
  });
});
