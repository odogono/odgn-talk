import { describe, expect, test } from 'bun:test';
import { SessionHost } from '@northtalk/ts/session';
import { readManifest } from '../src/lsp/manifest';
import {
  createLanguageServer,
  type RpcMessage,
  type LspDiagnostic,
  type Location,
  type TextEdit,
  type Position,
} from '../src/lsp';

type Results = {
  'northtalk/dictionary': string;
  'textDocument/codeAction': {
    edit: { changes: Record<string, TextEdit[]> };
  }[];
  'textDocument/completion': {
    detail?: string;
    documentation?: string | { kind: string; value: string };
    insertText?: string;
    insertTextFormat?: number;
    label: string;
  }[];
  'textDocument/definition': Location;
  'textDocument/formatting': TextEdit[];
  'textDocument/hover': { contents: { kind: string; value: string } };
  'textDocument/implementation': Location[];
  'textDocument/inlayHint': { position: Position }[];
  'textDocument/prepareCallHierarchy': { name: string }[];
  'textDocument/references': Location[];
  'textDocument/rename': { changes: Record<string, TextEdit[]> };
};
type Published = { diagnostics: LspDiagnostic[] };
const uri = 'file:///workspace/main.talk';
const manifest = {
  kind: 'demo',
  version: '1',
  language: '1.0-rc.3',
  grants: [
    {
      name: 'http',
      capability: 'http',
      operations: [
        {
          name: 'fetch',
          mode: 'suspending',
          args: ['text'],
          cost: { fuel: 1, alloc: 0 },
          errors: [{ code: 'offline', fields: [] }],
        },
      ],
    },
  ],
  libraries: [
    {
      name: 'maths',
      version: '1',
      source:
        'constant answer = 6 * 7\nfunction twice x\n return x * 2\nend twice\n',
      needs: [],
    },
  ],
  messages: [{ name: 'demo', args: [], receivers: [] }],
  objectKinds: [],
  objects: [],
};

test('LSP publishes binding advice separately from load errors and updates manifest-only advice', () => {
  const { server, sent } = setup(
    'constant min = 1\non other\nput missing into x\nend other',
  );
  const diagnostics = (sent.at(-1)!.params as Published).diagnostics;
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'unknown name',
        source: 'northtalk',
        severity: 1,
      }),
      expect.objectContaining({
        code: 'shadows-builtin',
        source: 'northtalk lint',
        severity: 2,
      }),
      expect.objectContaining({
        code: 'unknown-message',
        source: 'northtalk lint',
        severity: 4,
      }),
    ]),
  );
  server.configure({ manifest: null });
  const without = (sent.at(-1)!.params as Published).diagnostics;
  expect(without.map(d => d.code)).toEqual(['shadows-builtin']);
});
const setup = (
  source: string,
  withManifest: boolean | object = true,
  capabilities: object = {},
) => {
  const sent: RpcMessage[] = [];
  const server = createLanguageServer(message => sent.push(message));
  server.configure({
    manifest: withManifest === true ? manifest : withManifest || null,
  });
  server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      capabilities,
      initializationOptions: { northtalk: { profile: 'beginner' } },
    },
  });
  server.handle({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri, languageId: 'northtalk', version: 1, text: source },
    },
  });
  const request = <M extends keyof Results>(
    method: M,
    params: object = {},
  ): Results[M] => {
    server.handle({
      jsonrpc: '2.0',
      id: 2,
      method,
      params: { textDocument: { uri }, ...params },
    });
    return sent.at(-1)!.result as Results[M];
  };
  return { sent, server, request };
};
const at = (line: number, character: number) => ({
  position: { line, character },
});

describe('Manifest Object Collections', () => {
  const elements = {
    shape: { oneOf: [{ object: 'lamp' }, { object: 'switch' }] },
    countCost: { fuel: 1 },
    atCost: { fuel: 2, alloc: 3 },
    findCost: { fuel: 4 },
  };
  const host = {
    ...manifest,
    objectKinds: [
      { name: 'panel', elements },
      { name: 'lamp', props: [{ name: 'brightness', shape: 'number' }] },
      { name: 'switch', props: [{ name: 'enabled', shape: 'boolean' }] },
    ],
    objects: [{ name: 'thisPanel', kind: 'panel' }],
  };
  test('reads collection Shapes and all three costs', () => {
    expect(readManifest(host).objectKinds.get('panel')).toMatchObject({
      elements: {
        shape: {
          k: 'oneOf',
          of: [
            { k: 'object', kind: 'lamp' },
            { k: 'object', kind: 'switch' },
          ],
        },
        countCost: { fuel: 1, alloc: 0 },
        atCost: { fuel: 2, alloc: 3 },
        findCost: { fuel: 4, alloc: 0 },
      },
    });
    expect(
      readManifest(host).objectKinds.get('lamp')?.elements,
    ).toBeUndefined();
  });
  test('rejects malformed collection metadata', () => {
    for (const bad of [
      null,
      { ...elements, shape: undefined },
      { ...elements, shape: 'object' },
      { ...elements, shape: { optional: { object: 'lamp' } } },
      { ...elements, shape: { oneOf: [] } },
      { ...elements, shape: { oneOf: [{ object: 'lamp' }, 'text'] } },
      {
        ...elements,
        shape: { oneOf: [{ object: 'lamp' }, { object: 'lamp' }] },
      },
      { ...elements, countCost: undefined },
      { ...elements, atCost: { fuel: -1 } },
      { ...elements, findCost: { fuel: 1.5 } },
      {
        ...elements,
        findCost: { fuel: 1, alloc: Number.MAX_SAFE_INTEGER + 1 },
      },
    ]) {
      expect(() =>
        readManifest({
          ...host,
          objectKinds: [{ name: 'panel', elements: bad }],
        }),
      ).toThrow();
    }
  });
  test('hovers element references and counts with the collection Shape', () => {
    for (const expression of [
      'element "desk" of thisPanel',
      'elements ("de" & "sk") of (thisPanel)',
      'the first element of thisPanel',
      'the last element of thisPanel',
      'the number of elements of thisPanel',
    ]) {
      const { sent, request } = setup(
        `on demo\n return ${expression}\nend demo`,
        host,
      );
      expect((sent.at(-1)!.params as Published).diagnostics).toEqual([]);
      const hover = request('textDocument/hover', at(1, 9));
      expect(hover?.contents.value).toContain('lamp object or switch object');
      expect(hover?.contents.value).toContain('panel');
      expect(hover?.contents.value).toContain(
        expression.includes('number') ? 'Result: number' : 'Result: optional',
      );
    }
  });
  test('offers possible member properties without inferring a definite member kind', () => {
    const source =
      'on demo\n return the  of element "desk" of thisPanel\nend demo';
    const { request } = setup(source, host);
    const completion = request('textDocument/completion', at(1, 12));
    expect(completion.map(c => c.label)).toEqual(['brightness', 'enabled']);
    expect(completion.find(c => c.label === 'brightness')?.detail).toContain(
      'lamp',
    );
    expect(completion.find(c => c.label === 'enabled')?.detail).toContain(
      'switch',
    );
  });
  test('completes partial properties, computed selectors and ordinal receivers', () => {
    for (const [property, receiver, labels] of [
      ['br', 'element (name & "desk") of (thisPanel)', ['brightness']],
      ['', '(the first element of thisPanel)', ['brightness', 'enabled']],
      ['', 'the last element of thisPanel', ['brightness', 'enabled']],
      ['', 'elements 1 of thisPanel', ['brightness', 'enabled']],
    ] as const) {
      const line = ` return the ${property} of ${receiver}`;
      const { request } = setup(`on demo name\n${line}\nend demo`, host);
      expect(
        request('textDocument/completion', at(1, 12 + property.length)).map(
          c => c.label,
        ),
      ).toEqual([...labels]);
    }
  });
  test('supports homogeneous collections and keeps ordinary property completion', () => {
    const homogeneous = {
      ...host,
      objectKinds: [
        { name: 'panel', elements: { ...elements, shape: { object: 'lamp' } } },
        {
          name: 'lamp',
          props: [{ name: 'brightness', shape: 'number', readOnly: true }],
        },
      ],
      objects: [...host.objects, { name: 'deskLamp', kind: 'lamp' }],
    };
    for (const receiver of [
      'element "desk" of thisPanel',
      'deskLamp',
      '(deskLamp)',
    ]) {
      const { request } = setup(
        `on demo\n return the br of ${receiver}\nend demo`,
        homogeneous,
      );
      expect(request('textDocument/completion', at(1, 14))).toEqual([
        expect.objectContaining({
          label: 'brightness',
          detail: expect.stringContaining('read-only'),
        }),
      ]);
    }
    const { request } = setup(
      'on demo\n return element 1 of thisPanel\nend demo',
      homogeneous,
    );
    expect(request('textDocument/hover', at(1, 9))?.contents.value).toContain(
      'Result: optional lamp object',
    );
  });
  test('does not invent kinds for unknown, shadowed or computed receivers', () => {
    for (const [head, receiver] of [
      ['on demo thisPanel', 'thisPanel'],
      ['on demo receiver', 'receiver'],
      ['on demo', 'me'],
      ['on demo', 'it'],
      ['on demo', 'the target'],
      ['on demo\n put thisPanel into alias', 'alias'],
      ['on demo\n put element 1 of thisPanel into member', 'member'],
      ['on demo', 'element 1 of thisPanel'],
      ['use answer from maths as thisPanel\non demo', 'thisPanel'],
    ]) {
      const source = `${head}\n return element 1 of ${receiver}\nend demo`;
      const line = head!.split('\n').length;
      const { request } = setup(source, host);
      expect(request('textDocument/hover', at(line, 9))).toBeNull();
      const completion = setup(
        `${head}\n return the  of ${receiver}\nend demo`,
        host,
      ).request('textDocument/completion', at(line, 12));
      // A direct element reference can offer possible member properties.
      if (receiver !== 'element 1 of thisPanel') {
        expect(
          completion.some(c => ['brightness', 'enabled'].includes(c.label)),
        ).toBe(false);
      }
    }
    for (const withManifest of [false, manifest]) {
      const { request } = setup(
        'on demo\n return element 1 of thisPanel\nend demo',
        withManifest,
      );
      expect(request('textDocument/hover', at(1, 9))).toBeNull();
    }
  });
  test('shares completion properties across possible kinds and refreshes Manifest changes', () => {
    const line = ' return the  of element 1 of thisPanel';
    const { request, server } = setup(`on demo\n${line}\nend demo`, host);
    server.configure({
      manifest: {
        ...host,
        objectKinds: host.objectKinds.map(kind => ({
          ...kind,
          props: [{ name: 'label', shape: 'text' }],
        })),
      },
    });
    const completion = request('textDocument/completion', at(1, 12));
    expect(completion).toEqual([
      expect.objectContaining({
        label: 'label',
        detail: expect.stringContaining('lamp'),
      }),
    ]);
    expect(completion[0]?.detail).toContain('switch');
    server.configure({ manifest: null });
    expect(
      request('textDocument/completion', at(1, 12)).some(
        c => c.label === 'label',
      ),
    ).toBe(false);
  });
});

describe('Kind of the target', () => {
  const kinds = [
    {
      name: 'door',
      props: [
        { name: 'portal', shape: 'text' },
        { name: 'locked', shape: 'boolean', readOnly: true },
      ],
    },
    {
      name: 'window',
      props: [{ name: 'locked', shape: 'boolean' }],
    },
    { name: 'room', props: [{ name: 'size', shape: 'number' }] },
  ];
  const host = {
    ...manifest,
    objectKinds: kinds,
    ownerKind: 'room',
    messages: [
      { name: 'demo', args: [], receivers: [] },
      { name: 'open', args: [], receivers: ['door'] },
      { name: 'shut', args: [], receivers: ['door', 'window'] },
    ],
  };
  const properties = ['portal', 'locked', 'size'];
  const completions = (message: string, withHost: object = host) =>
    setup(`on ${message}\n return the  of the target\nend ${message}`, withHost)
      .request('textDocument/completion', at(1, 12))
      .map(c => [c.label, c.detail]);
  test("reads the target's kinds from its message's receivers", () => {
    expect(completions('open')).toEqual([
      ['portal', 'door property'],
      ['locked', 'door property (read-only)'],
    ]);
    expect(completions('shut')).toEqual([
      ['portal', 'door property (possible member)'],
      [
        'locked',
        'door property (read-only) (possible member); window property (possible member)',
      ],
    ]);
  });
  test('a Script-addressed message has the Owner Kind as its target', () => {
    expect(completions('demo')).toEqual([['size', 'room property']]);
    expect(
      completions('demo', { ...host, ownerKind: undefined }).filter(([l]) =>
        properties.includes(l!),
      ),
    ).toEqual([]);
  });
  test('leaves the target unknown for undeclared messages and Fallback Handlers', () => {
    expect(
      completions('other').filter(([l]) => properties.includes(l!)),
    ).toEqual([]);
    const { request } = setup(
      'on any message m\n return the portal of the target\nend',
      host,
    );
    expect(request('textDocument/hover', at(1, 13))).toBeNull();
  });
  test('hovers each possible kind of the target', () => {
    const { request } = setup(
      'on shut\n return the locked of the target\nend shut',
      host,
    );
    expect(request('textDocument/hover', at(1, 13))?.contents.value).toBe(
      'door property locked (read-only) (possible member)\nShape: boolean\n\nwindow property locked (possible member)\nShape: boolean',
    );
  });
  test('Lints the target, flagging read-only only when every kind agrees', () => {
    const { sent } = setup(
      [
        'on open',
        ' set the locked of the target to true',
        'end open',
        'on shut',
        ' set the locked of the target to true',
        ' put the colour of the target into c',
        'end shut',
      ].join('\n'),
      host,
    );
    const diagnostics = (sent.at(-1)!.params as Published).diagnostics;
    expect(diagnostics.map(d => [d.code, d.range.start.line])).toEqual([
      ['read-only-property', 1],
      ['unknown-property', 5],
    ]);
  });
});

describe('Owner Kind', () => {
  const door = {
    name: 'door',
    props: [
      { name: 'portal', shape: 'text' },
      { name: 'locked', shape: 'boolean', readOnly: true },
    ],
  };
  const owned = { ...manifest, objectKinds: [door], ownerKind: 'door' };
  test('reads the Owner Kind, which must be a declared Object Kind', () => {
    expect(readManifest(owned).ownerKind).toBe('door');
    expect(readManifest(manifest).ownerKind).toBeUndefined();
    expect(() => readManifest({ ...owned, objectKinds: [] })).toThrow(
      'Owner Kind door is not a declared Object Kind',
    );
    expect(() => readManifest({ ...owned, ownerKind: 1 })).toThrow();
  });
  test('completes and hovers the properties of me', () => {
    const { request } = setup('on demo\n return the  of me\nend demo', owned);
    expect(
      request('textDocument/completion', at(1, 12)).map(c => [
        c.label,
        c.detail,
      ]),
    ).toEqual([
      ['portal', 'door property'],
      ['locked', 'door property (read-only)'],
    ]);
    const hovered = setup('on demo\n return the portal of me\nend demo', owned);
    expect(
      hovered.request('textDocument/hover', at(1, 13))?.contents.value,
    ).toBe('door property portal\nShape: text');
  });
  test('leaves me unknown without an Owner Kind', () => {
    const { request } = setup('on demo\n return the portal of me\nend demo', {
      ...owned,
      ownerKind: undefined,
    });
    expect(request('textDocument/hover', at(1, 13))).toBeNull();
  });
  test('publishes unknown and read-only properties of me as Lints', () => {
    const { sent } = setup(
      'on demo\n set the locked of me to true\n set the portal of me to the colour of me\nend demo',
      owned,
    );
    const diagnostics = (sent.at(-1)!.params as Published).diagnostics;
    expect(diagnostics.map(d => [d.code, d.range.start])).toEqual([
      ['read-only-property', { line: 1, character: 9 }],
      ['unknown-property', { line: 2, character: 29 }],
    ]);
  });
});

test('hover uses Core documentation for declarations and ordered Handler Clauses', () => {
  const source = [
    '  --| Adds one.',
    '\t--|',
    '--|  preserve spaces  ',
    'function inc n',
    ' return n + 1',
    'end inc',
    '--| constant docs',
    'constant k = 1',
    '--| variable docs',
    'script variable v = 2',
    '--| first clause',
    'on go x where x = 1',
    'end go',
    '--| second clause',
    'on go x',
    ' say inc(k)',
    ' say v',
    'end go',
    '',
  ].join('\n');
  const host = new SessionHost({ now: () => 0n });
  const { request } = setup(source);
  const entries = [
    source.slice(0, source.indexOf('--| constant docs')),
    '--| constant docs\nconstant k = 1',
    '--| variable docs\nscript variable v = 2',
    '--| first clause\non go x where x = 1\nend go',
    '--| second clause\non go x\n say inc(k)\n say v\nend go',
  ];
  for (const entry of entries) {
    expect(host.input(entry)).toEqual([]);
  }
  for (const [name, line, col] of [
    ['inc', 15, 6],
    ['k', 15, 9],
    ['v', 16, 5],
    ['go', 14, 4],
  ] as const) {
    const value = request('textDocument/hover', at(line, col)).contents.value;
    const docs = host.documentation(name);
    for (const doc of docs) {
      expect(value).toContain(doc.doc);
    }
    if (name === 'go') {
      expect(value).toContain(
        'Clause 1:\nfirst clause\n\nClause 2:\nsecond clause',
      );
    }
  }
});

test('hover resolves aliases and remote Import names to updated Library documentation', () => {
  const { server, request } = setup(
    'use twice from maths as double\non go\n say double(2)\nend go',
  );
  const configure = (doc: string) =>
    server.configure({
      manifest: {
        ...manifest,
        libraries: [
          {
            ...manifest.libraries[0]!,
            source: `${doc}\nfunction twice n\n return n * 2\nend twice\n`,
          },
        ],
      },
    });
  configure('--| original');
  for (const [line, col] of [
    [0, 5],
    [0, 25],
    [2, 6],
  ]) {
    expect(
      request('textDocument/hover', at(line!, col!)).contents.value,
    ).toContain('original');
  }
  configure('--| replacement');
  const replaced = request('textDocument/hover', at(2, 6)).contents.value;
  expect(replaced).toContain('replacement');
  expect(replaced).not.toContain('original');
  configure('-- ordinary comment');
  expect(request('textDocument/hover', at(2, 6)).contents.value).not.toContain(
    'replacement',
  );
});

test('hover honors detached blocks, lexical shadowing and Built-in catalogue documentation', () => {
  const host = new SessionHost({ now: () => 0n });
  const { request } = setup(
    '--| detached\n\nconstant k = 1\n--| interrupted\n-- ordinary\nconstant c = 2\n--| authored min\nconstant min = 3\non go min\n say min\n say k\n say c\n say lower("A")\nend go',
  );
  expect(request('textDocument/hover', at(9, 6))).toBeNull();
  expect(request('textDocument/hover', at(10, 5)).contents.value).not.toContain(
    'detached',
  );
  expect(request('textDocument/hover', at(11, 5)).contents.value).not.toContain(
    'interrupted',
  );
  expect(request('textDocument/hover', at(7, 11)).contents.value).toContain(
    'authored min',
  );
  expect(request('textDocument/hover', at(12, 7)).contents.value).toContain(
    host.documentation('lower')[0]!.doc,
  );
});

// The whole of one line, which every Lint on it overlaps.
const lineRange = (line: number) => ({
  range: {
    start: { line, character: 0 },
    end: { line, character: 40 },
  },
  context: { diagnostics: [] },
});

describe('language server', () => {
  test('offers the idiom rewrites as quick fixes', () => {
    const { request } = setup(
      'on demo c\nput c * 2 into c\nif c = 1 or c = 2 or c = 3 then say c\nend demo',
    );
    expect(request('textDocument/codeAction', lineRange(1))).toMatchObject([
      {
        title: 'Rewrite as a command',
        edit: { changes: { [uri]: [{ newText: 'multiply c by 2' }] } },
      },
    ]);
    expect(request('textDocument/codeAction', lineRange(2))).toMatchObject([
      {
        title: 'Rewrite as is in',
        edit: { changes: { [uri]: [{ newText: 'c is in [1, 2, 3]' }] } },
      },
    ]);
  });
  test('offers the suggest-match rewrite as a quick fix', () => {
    const { request } = setup(
      'on demo c\nif c = 1 then\nsay 1\nelse if c = 2 then\nsay 2\nelse if c = 3 then\nsay 3\nend if\nend demo',
    );
    const fixes = request('textDocument/codeAction', {
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 2 },
      },
      context: { diagnostics: [] },
    });
    expect(fixes).toMatchObject([
      {
        title: 'Rewrite as match',
        kind: 'quickfix',
        diagnostics: [{ code: 'suggest-match' }],
        edit: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: 1, character: 0 },
                  end: { line: 7, character: 6 },
                },
                newText:
                  'match c\n  when 1 then\n  say 1\n  when 2 then\n  say 2\n  when 3 then\n  say 3\nend match',
              },
            ],
          },
        },
      },
    ]);
  });
  test('publishes list-splice hints in beginner without an automatic rewrite', () => {
    const { sent, server, request } = setup(
      'on demo\nput [] into acc\nput [1, 2] after acc\nend demo',
    );
    expect((sent.at(-1)!.params as Published).diagnostics).toMatchObject([
      {
        code: 'suggest-list-splice',
        severity: 4,
        range: { start: { line: 2, character: 0 } },
      },
    ]);
    expect(
      request('textDocument/codeAction', {
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 3 },
        },
        context: { diagnostics: [] },
      }),
    ).toEqual([]);
    server.configure({ profile: 'standard' });
    expect((sent.at(-1)!.params as Published).diagnostics).toEqual([]);
  });
  test('publishes the first syntax error, retained load diagnostics and configured Lints', () => {
    const { sent } = setup('on demo\n put + into x\n put absent into y\nend\n');
    const diagnostics = (sent.at(-1)!.params as Published).diagnostics;
    expect(
      diagnostics.filter(d => d.source === 'northtalk syntax'),
    ).toHaveLength(1);
    expect(diagnostics.map(d => d.code)).toContain('unknown name');
    expect(diagnostics.map(d => d.code)).toContain('prefer-explicit-end');
  });
  test('completes Operations, error patterns, imports, messages, Units and chunks in context', () => {
    for (const [source, line, character, label] of [
      ['on demo\n ask http to \nend demo', 1, 13, 'fetch'],
      ['on demo\n try\n catch \n end try\nend demo', 2, 7, '{code: "offline"}'],
      ['use  from maths\n', 0, 4, 'twice'],
      ['on \nend', 0, 3, 'demo'],
      ['on demo\n wait 2\nend demo', 1, 7, 'ms'],
      ['on demo\n put the first \nend demo', 1, 15, 'word'],
    ] as const) {
      const { request } = setup(source);
      expect(
        request('textDocument/completion', at(line, character)).map(
          c => c.label,
        ),
      ).toContain(label);
    }
    const { request } = setup('on demo\n put "2" into x\nend demo');
    expect(request('textDocument/completion', at(1, 7))).toEqual([]);
  });
  test('treats a computed message name as an expression, with no message completion or definition', () => {
    const { sent, request } = setup(
      'on ping\nend ping\non demo next\n send ("ping") with 1 to me\n send (next) to me\nend demo\n',
    );
    const diagnostics = (sent.at(-1)!.params as Published).diagnostics;
    expect(diagnostics.filter(d => d.severity === 1)).toEqual([]);
    const names = request('textDocument/completion', at(3, 7)) as {
      kind: number;
      label: string;
    }[];
    expect(names.map(c => c.label)).toContain('next');
    expect(names.filter(c => c.kind === 3)).toEqual([]);
    expect(request('textDocument/completion', at(3, 9))).toEqual([]);
    expect(request('textDocument/definition', at(3, 9))).toBeNull();
    expect(request('textDocument/definition', at(4, 8)).range.start).toEqual({
      line: 2,
      character: 8,
    });
  });
  test('hovers evaluated Constants, Function Home Scripts and Operation Declarations', () => {
    const { request } = setup(
      'use answer, twice from maths\non demo\n put answer into x\n put twice into f\n ask http to fetch "url" and wait\nend demo\n',
    );
    expect(request('textDocument/hover', at(2, 7)).contents.value).toContain(
      '42',
    );
    expect(request('textDocument/hover', at(3, 7)).contents.value).toContain(
      'Home Script',
    );
    expect(request('textDocument/hover', at(4, 14)).contents.value).toBe(
      "ask http to fetch ‹text› and wait\n  Suspending: a Suspension Point that waits at most the Script's MaxWait\n  Cost per call: 1 Fuel\n  Errors: offline",
    );
  });
  test("completes, hovers and marks a tell block's lines as their receiver's Operations", () => {
    const { request } = setup(
      'on demo\n tell http\n   fetch "url" and wait\n   \n end tell\nend demo\n',
    );
    expect(
      request('textDocument/completion', at(3, 3)).map(c => c.label),
    ).toContain('fetch');
    expect(request('textDocument/hover', at(2, 4)).contents.value).toContain(
      'Suspending',
    );
    const hints = request('textDocument/inlayHint', {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 6, character: 0 },
      },
    });
    expect(hints.map(hint => hint.position)).toContainEqual({
      line: 2,
      character: 3,
    });
  });
  test("marks a Timeout Block's waits, and reports its load errors", () => {
    const { sent, request } = setup(
      'on demo\n with timeout of 5 s\n   wait 1 s\n   send ping to me and wait\n end timeout\nend demo\n',
    );
    expect((sent.at(-1)!.params as Published).diagnostics).toEqual([]);
    const hints = request('textDocument/inlayHint', {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 6, character: 0 },
      },
    });
    // The Handler, which may suspend, then each wait in the block.
    expect(hints.map(hint => hint.position)).toEqual([
      { line: 0, character: 0 },
      { line: 2, character: 3 },
      { line: 3, character: 3 },
    ]);
    const bad = setup(
      'on blink\n wait 1 s\nend blink\non demo\n with timeout of 5 s\n   blink and wait\n end timeout\nend demo\n',
    );
    expect(
      (bad.sent.at(-1)!.params as Published).diagnostics
        .filter(d => d.severity === 1)
        .map(d => [d.code, d.range.start]),
    ).toEqual([
      ['empty timeout', { line: 4, character: 1 }],
      ['not in a timeout', { line: 5, character: 3 }],
    ]);
  });
  const shop = {
    ...manifest,
    grants: [
      {
        name: 'ledger',
        capability: 'books',
        operations: [
          {
            name: 'begin',
            mode: 'immediate',
            args: [],
            result: { object: 'transaction' },
            cost: { fuel: 2, alloc: 0 },
            scope: { opens: 'transaction', abandon: 'rollback' },
          },
          {
            name: 'charge',
            mode: 'suspending',
            args: [
              { quantity: 'GBP' },
              { optional: { map: [{ key: 'note', shape: 'text' }] } },
            ],
            result: { oneOf: ['text', 'nothing'] },
            cost: { fuel: 5, alloc: 64 },
            maxPending: 3000,
            errors: [
              { code: 'declined', fields: [{ key: 'reason', shape: 'text' }] },
            ],
          },
          {
            name: 'note',
            mode: 'fire-and-forget',
            args: ['text'],
            cost: { fuel: 1, alloc: 0 },
            errors: [],
          },
          {
            name: 'poll',
            mode: 'suspending',
            args: [],
            cost: { fuel: 1, alloc: 0 },
          },
          {
            name: 'post',
            mode: 'immediate',
            args: [{ list: 'number' }],
            cost: { fuel: 1, alloc: 0 },
            segmentBound: true,
          },
        ],
      },
    ],
  };
  const snippets = {
    textDocument: {
      completion: { completionItem: { snippetSupport: true } },
      hover: { contentFormat: ['markdown', 'plaintext'] },
    },
  };
  const items = (source: string, line: number, character: number, caps = {}) =>
    Object.fromEntries(
      setup(source, shop, caps)
        .request('textDocument/completion', at(line, character))
        .map(c => [c.label, c]),
    );
  const labels = (source: string, line: number, character: number) =>
    Object.keys(items(source, line, character));
  test("completes only the Operations a call's verb allows, adding `and wait` exactly when the mode needs it", () => {
    expect(labels('on demo\n tell ledger to \nend demo', 1, 17)).toEqual([
      'note',
    ]);
    expect(labels('on demo\n ask ledger to \nend demo', 1, 16)).toEqual([
      'begin',
      'charge',
      'poll',
      'post',
    ]);
    expect(
      labels('on demo\n tell ledger\n   \n end tell\nend demo', 2, 3),
    ).toEqual(['begin', 'charge', 'note', 'poll', 'post']);

    const ask = items('on demo\n ask ledger to \nend demo', 1, 16, snippets);
    expect(ask.charge).toMatchObject({
      detail:
        'ask ledger to charge ‹quantity in GBP›, [‹{note: text}›] and wait',
      insertText: 'charge ${1} and wait',
      insertTextFormat: 2,
      documentation: { kind: 'markdown' },
    });
    expect(ask.poll).toMatchObject({ insertText: 'poll and wait' });
    expect(ask.poll!.insertTextFormat).toBeUndefined();
    expect(ask.begin).toMatchObject({ insertText: 'begin' });
    // Without snippets, a suspending Operation with arguments inserts its name.
    const plain = items('on demo\n ask ledger to \nend demo', 1, 16);
    expect(plain.charge!.insertText).toBeUndefined();
    expect(typeof plain.charge!.documentation).toBe('string');
    // A line that already waits keeps its single `and wait`.
    const editing = items(
      'on demo\n ask ledger to ch 5 GBP and wait\nend demo',
      1,
      17,
      snippets,
    );
    expect(editing.charge).toMatchObject({ insertText: 'charge' });
    const block = items(
      'on demo\n tell ledger\n   \n end tell\nend demo',
      2,
      3,
      snippets,
    );
    expect(block.charge!.insertText).toBe('charge ${1} and wait');
    expect(block.note!.insertText).toBe('note');
  });
  test('Operation documentation reaches hover, completion and dictionary', () => {
    const documented = {
      ...shop,
      grants: shop.grants.map(grant => ({
        ...grant,
        operations: grant.operations.map(op => ({
          ...op,
          description: 'Plain *text* <tag>',
          examples: [
            'ask ledger to post [1]',
            '-- ```\nask ledger to post [2]',
          ],
        })),
      })),
    };
    const source = 'on demo\n ask ledger to post [1]\nend demo\n';
    for (const caps of [{}, snippets]) {
      const { request } = setup(source, documented, caps);
      const hover = request('textDocument/hover', at(1, 16)).contents;
      expect(hover.value).toContain('ask ledger to post [1]');
      expect(hover.value).toContain('Examples:');
      expect(hover.value).toContain(
        hover.kind === 'markdown'
          ? String.raw`Plain \*text\* \<tag\>`
          : 'Plain *text* <tag>',
      );
      if (hover.kind === 'markdown') {
        expect(hover.value).toContain('````northtalk\n-- ```');
      }
      const completion = setup(
        'on demo\n ask ledger to \nend demo',
        documented,
        caps,
      )
        .request('textDocument/completion', at(1, 16))
        .find(item => item.label === 'post')!;
      expect(JSON.stringify(completion.documentation)).toContain('Examples:');
      expect(request('northtalk/dictionary')).toContain(
        'ask ledger to post [2]',
      );
    }
  });
  test('hovers an Operation with its dictionary entry, in markdown when the client shows it', () => {
    const source =
      'on demo\n ask ledger to post [1]\n ask ledger to begin\nend demo\n';
    const { request } = setup(source, shop, snippets);
    expect(request('textDocument/hover', at(1, 16)).contents).toEqual({
      kind: 'markdown',
      value:
        '```northtalk\nask ledger to post ‹list of number›\n```\n\n- Immediate: answers at the call\n- Cost per call: 1 Fuel\n- Segment-bound: commits or rolls back with the Segment',
    });
    expect(
      setup(source, shop).request('textDocument/hover', at(2, 16)).contents,
    ).toEqual({
      kind: 'plaintext',
      value:
        'ask ledger to begin\n  Immediate: answers at the call\n  Result: transaction object\n  Cost per call: 2 Fuel\n  Scope: opens transaction, abandoned by rollback',
    });
  });
  test("hovers a Grant's name with its dictionary section", () => {
    const source =
      'on demo\n ask ledger to post [1]\n tell ledger\n  post [1]\n end tell\nend demo\n';
    const { request } = setup(source, shop, snippets);
    for (const line of [1, 2]) {
      const contents = request('textDocument/hover', at(line, 7)).contents;
      expect(contents.kind).toBe('markdown');
      expect(contents.value).toContain('## ledger (books)');
      expect(contents.value).toContain('### post');
      expect(contents.value).toContain(
        'ask ledger to charge ‹quantity in GBP›, [‹{note: text}›] and wait',
      );
    }
    const plain = setup(source, shop).request(
      'textDocument/hover',
      at(1, 7),
    ).contents;
    expect(plain).toMatchObject({ kind: 'plaintext' });
    expect(plain.value).toContain('ledger (books)');
  });
  test('explains a Grant or Operation the loaded Host Manifest cannot describe', () => {
    const source = 'on demo\n ask ledger to post [1]\nend demo\n';
    const none = setup(source, false);
    for (const col of [7, 16]) {
      expect(
        none.request('textDocument/hover', at(1, col)).contents.value,
      ).toContain('No Host Manifest is loaded');
    }
    const unknown = setup(
      'on demo\n ask mystery to post [1]\n ask ledger to vanish\nend demo\n',
      shop,
    );
    expect(
      unknown.request('textDocument/hover', at(1, 7)).contents.value,
    ).toContain('has no Grant named mystery');
    expect(
      unknown.request('textDocument/hover', at(2, 17)).contents.value,
    ).toContain('has no Operation named vanish');
  });
  test('does not treat a variable receiver as a Grant', () => {
    // Only a bare name after `ask` is a Grant name; `(box)` reads the variable.
    const { request } = setup(
      'on demo box\n ask (box) to post [1]\nend demo\n',
      shop,
    );
    expect(request('textDocument/hover', at(1, 7))).toBeNull();
  });
  test('answers northtalk/dictionary with every Grant and its Operations', () => {
    const text = setup('', shop).request('northtalk/dictionary');
    expect(text).toStartWith(
      '# Dictionary\n\n## ledger (books)\n\n### begin\n',
    );
    expect(text).toContain(
      '### charge\n\n```northtalk\nask ledger to charge ‹quantity in GBP›, [‹{note: text}›] and wait\n```\n\n- Suspending: a Suspension Point that waits at most 3000 ms (maxPending)\n- Result: text or nothing\n- Cost per call: 5 Fuel, 64 allocation\n- Errors: declined (reason)\n',
    );
    expect(text).toContain(
      '- Fire-and-forget: runs at the call, and its result is dropped\n- Cost per call: 1 Fuel\n- Errors: none declared\n',
    );
    expect(
      setup('', false).request('northtalk/dictionary', { format: 'plaintext' }),
    ).toBe('No Host Manifest, so no Grants to show.\n');
  });
  test("explains a Whose Clause's names, and reports its load errors", () => {
    const { sent, request } = setup(
      'on demo xs\n put 1 into amount\n return every item of xs whose amount > amount and it is not empty\nend demo\n',
    );
    expect((sent.at(-1)!.params as Published).diagnostics).toEqual([]);
    expect(request('textDocument/hover', at(2, 31)).contents.value).toBe(
      'Whose Key: the key `amount` of the chunk being tested, as `the amount of it`',
    );
    expect(request('textDocument/hover', at(2, 51)).contents.value).toBe(
      'it: the chunk this Whose Clause is testing',
    );
    // Renaming the local leaves the Whose Key, which isn't a name.
    const rename = request('textDocument/rename', {
      ...at(1, 13),
      newName: 'limit',
    });
    expect(rename.changes[uri]!.map(edit => edit.range.start)).toEqual([
      { line: 1, character: 12 },
      { line: 2, character: 40 },
    ]);
    const bad = setup(
      'function f x\n return x\nend f\non demo xs\n return every item of xs whose f(it) and region is "EU"\nend demo\n',
    );
    expect(
      (bad.sent.at(-1)!.params as Published).diagnostics
        .filter(d => d.severity === 1)
        .map(d => [d.code, d.range.start, d.message]),
    ).toEqual([
      ['not in a whose', { line: 4, character: 31 }, 'not in a whose: f'],
      [
        'unknown name',
        { line: 4, character: 41 },
        "unknown name: region; a key of the chunk is `it's region`",
      ],
    ]);
  });
  test('navigates and renames through imports while preserving aliases and lexical scopes', () => {
    const { request } = setup(
      'use twice from maths as double\non demo x\n put double(x) into y\nend demo\n',
    );
    const definition = request('textDocument/definition', at(2, 7));
    expect(definition.uri).toContain('maths.talk');
    expect(definition.range.start).toEqual({ line: 1, character: 9 });
    expect(
      request('textDocument/references', {
        ...at(2, 7),
        context: { includeDeclaration: true },
      }),
    ).toHaveLength(5);
    const rename = request('textDocument/rename', {
      ...at(0, 6),
      newName: 'doubler',
    });
    expect(rename.changes[uri]!).toHaveLength(1);
    const alias = request('textDocument/rename', {
      ...at(2, 7),
      newName: 'doubled',
    });
    expect(alias.changes[uri]!).toHaveLength(2);
  });
  test('marks Join heads, indirect suspending Handlers and Lambdas without leaking nested bodies', () => {
    const { request } = setup(
      'on inner\n wait 1ms\nend inner\non demo\n inner and wait\n put given x\n   wait 1ms\n end given into f\n wait for all\n   send inner to me and wait\n end wait\nend demo\n',
    );
    const hints = request('textDocument/inlayHint', {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      },
    });
    expect(hints.map(hint => hint.position.line)).toEqual([
      0, 1, 3, 4, 5, 6, 8, 9,
    ]);
  });
  test('formats and supplies an applicable explicit-end quick fix', () => {
    const { request } = setup('on demo\nput 1 into x\nend\n');
    expect(request('textDocument/formatting')[0]!.newText).toBe(
      'on demo\n  put 1 into x\nend\n',
    );
    const fixes = request('textDocument/codeAction', {
      range: {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 3 },
      },
      context: { diagnostics: [] },
    });
    expect(fixes[0]!.edit.changes[uri]![0]!.newText).toBe(' demo');
  });
  test('uses UTF-16 positions and ignores stale incremental edit versions', () => {
    const { server, request, sent } = setup(
      'on demo\r\n put "😀" & absent into x\r\nend demo\r\n',
    );
    expect(
      (sent.at(-1)!.params as Published).diagnostics.find(
        d => d.code === 'unknown name',
      )!.range.start,
    ).toEqual({ line: 1, character: 12 });
    server.handle({
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            range: {
              start: { line: 1, character: 12 },
              end: { line: 1, character: 18 },
            },
            text: '"ok"',
          },
        ],
      },
    });
    expect((sent.at(-1)!.params as Published).diagnostics).toEqual([]);
    server.handle({
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 1 },
        contentChanges: [{ text: 'bad' }],
      },
    });
    expect(request('textDocument/formatting')[0]!.newText).toContain('"ok"');
  });
  test('missing manifest permits grammar features without manifest diagnostics', () => {
    const { sent, request } = setup(
      'on demo\n ask unknown to fetch "x" and wait\nend demo\n',
      false,
    );
    expect((sent.at(-1)!.params as Published).diagnostics).toEqual([]);
    expect(request('textDocument/completion', at(1, 21))).toEqual([]);
  });
  test('supports protocol lifecycle and reports unsupported requests', () => {
    const sent: RpcMessage[] = [];
    const server = createLanguageServer(message => sent.push(message));
    server.handle({ id: 1, method: 'textDocument/hover', params: {} });
    expect(sent.at(-1)!.error?.code).toBe(-32_002);
    server.handle({ id: 2, method: 'initialize', params: {} });
    server.handle({ id: 3, method: 'unknown' });
    expect(sent.at(-1)!.error?.code).toBe(-32_601);
    server.handle({ id: 4, method: 'shutdown' });
    expect(sent.at(-1)!.result).toBeNull();
    server.handle({ method: 'exit' });
    expect(server.exitCode).toBe(0);
  });
});

test('Library dependencies contribute transitive Grant diagnostics at the Import', () => {
  const { server, sent } = setup(
    'use run from outer\non demo\n run and wait\nend demo',
  );
  server.configure({
    manifest: {
      ...manifest,
      grants: [],
      libraries: [
        {
          name: 'outer',
          source: 'use fetch from inner\non run\n fetch and wait\nend run',
          version: '1',
          needs: [],
        },
        {
          name: 'inner',
          source: 'on fetch\n ask http to fetch "url" and wait\nend fetch',
          version: '1',
          needs: [],
        },
      ],
    },
  });
  expect(
    (sent.at(-1)!.params as Published).diagnostics.map(d => d.code),
  ).toContain('missing grant');
});
test('initializer failures and unknown imported exports are load diagnostics', () => {
  const { sent } = setup(
    'use absent from maths\nconstant broken = 1 / 0\non demo\nend demo',
  );
  expect(
    (sent.at(-1)!.params as Published).diagnostics.map(d => d.code),
  ).toContain('unknown import');
  const initialized = setup('constant broken = 1 / 0\non demo\nend demo');
  expect(
    (initialized.sent.at(-1)!.params as Published).diagnostics.map(d => d.code),
  ).toContain('initialiser failed');
});
test('rename updates explicit endings and keeps unrelated local scopes intact', () => {
  const { request, server, sent } = setup(
    'function twice x\n return x * 2\nend twice\non demo x\n put twice(x) into y\nend demo',
  );
  expect(
    request('textDocument/rename', { ...at(0, 10), newName: 'doubler' })
      .changes[uri],
  ).toHaveLength(3);
  expect(
    request('textDocument/rename', { ...at(0, 15), newName: 'input' }).changes[
      uri
    ],
  ).toHaveLength(2);
  server.handle({
    id: 10,
    method: 'textDocument/rename',
    params: { textDocument: { uri }, ...at(0, 10), newName: 'if' },
  });
  expect(sent.at(-1)!.error?.code).toBe(-32_602);
});
test('close restores workspace Library source and refreshes importing documents', () => {
  const { server, request } = setup(
    'use answer from maths\non demo\n put answer into x\nend demo',
  );
  const library = 'file:///workspace/maths.talk';
  server.configure({
    sources: [
      { uri: library, library: 'maths', text: 'constant answer = 42\n' },
    ],
  });
  server.handle({
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: library,
        text: 'constant answer = 100\n',
        version: 1,
      },
    },
  });
  expect(request('textDocument/hover', at(2, 6)).contents.value).toBe('100');
  server.handle({
    method: 'textDocument/didClose',
    params: { textDocument: { uri: library } },
  });
  expect(request('textDocument/hover', at(2, 6)).contents.value).toBe('42');
});
test('malformed manifests report a diagnostic and retain grammar features', () => {
  const { server, sent, request } = setup('on demo\nwait 1ms\nend demo');
  server.configure({
    manifest: {
      ...manifest,
      grants: [
        {
          name: 'x',
          capability: 'x',
          operations: [{ name: 'bad', mode: 'invalid', args: [] }],
        },
      ],
    },
  });
  expect(
    (sent.at(-1)!.params as Published).diagnostics.map(d => d.code),
  ).toContain('host manifest');
  expect(request('textDocument/formatting')[0]!.newText).toContain('  wait');
});

test('alias rename rejects a different alias for the same exported binding', () => {
  const { server, sent } = setup(
    'use twice from maths as double\nuse twice from maths as other\non demo\n put double(1) into x\nend demo',
  );
  server.handle({
    id: 10,
    method: 'textDocument/rename',
    params: { textDocument: { uri }, ...at(0, 25), newName: 'other' },
  });
  expect(sent.at(-1)!.error?.code).toBe(-32_602);
});

test('Library import cycles are load diagnostics at the importing Script', () => {
  const { server, sent } = setup('use a from alpha\non demo\nend demo');
  server.configure({
    manifest: {
      ...manifest,
      libraries: [
        {
          name: 'alpha',
          source: 'use b from beta\nconstant a = 1\n',
          version: '1',
          needs: [],
        },
        {
          name: 'beta',
          source: 'use a from alpha\nconstant b = 2\n',
          version: '1',
          needs: [],
        },
      ],
    },
  });
  expect(
    (sent.at(-1)!.params as Published).diagnostics.map(d => d.code),
  ).toContain('import cycle');
});

test('rename allows a parameter name used in an unrelated Handler', () => {
  const { request } = setup(
    'on first x\n put x into a\nend first\non second y\n put y into b\nend second',
  );
  expect(
    request('textDocument/rename', { ...at(0, 9), newName: 'y' }).changes[uri],
  ).toHaveLength(2);
});
test('prepareRename supports the original name in an aliased Import', () => {
  const { server, sent } = setup(
    'use twice from maths as double\non demo\nend demo',
  );
  server.handle({
    id: 10,
    method: 'textDocument/prepareRename',
    params: { textDocument: { uri }, ...at(0, 6) },
  });
  expect(sent.at(-1)!.result).toEqual({
    range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
    placeholder: 'twice',
  });
});

test('global rename rejects a new name bound in any descendant scope', () => {
  const { server, sent } = setup(
    'constant answer = 42\non demo x\n put x into y\nend demo',
  );
  server.handle({
    id: 10,
    method: 'textDocument/rename',
    params: { textDocument: { uri }, ...at(0, 11), newName: 'x' },
  });
  expect(sent.at(-1)!.error?.code).toBe(-32_602);
});
test('prepareRename does not offer a Library name as a rename target', () => {
  const { server, sent } = setup('use twice from maths\non demo\nend demo');
  server.handle({
    id: 10,
    method: 'textDocument/prepareRename',
    params: { textDocument: { uri }, ...at(0, 16) },
  });
  expect(sent.at(-1)!.result).toBeNull();
});

test('export rename rejects a retained alias that would duplicate an unaliased Import', () => {
  const { server, sent } = setup(
    'use twice from maths\nuse twice from maths as double\non demo\n put twice(1) into x\nend demo',
  );
  server.handle({
    id: 10,
    method: 'textDocument/rename',
    params: { textDocument: { uri }, ...at(0, 6), newName: 'double' },
  });
  expect(sent.at(-1)!.error?.code).toBe(-32_602);
});
test('export rename permits the same spelling as a retained alias when no local binding is renamed', () => {
  const { request } = setup(
    'use twice from maths as double\non demo\n put double(1) into x\nend demo',
  );
  expect(
    request('textDocument/rename', { ...at(0, 6), newName: 'double' }).changes[
      uri
    ],
  ).toHaveLength(1);
});

test('LSP publishes recovery diagnostics and beginner advice without lexical offer lookup', () => {
  const source =
    'on demo\nchoose offer missing\ntry\noffer skip\noffer skip\ncatch e before unwind\nwait 1 s\nreturn 1\nchoose offer remote(1)\nend try\nend demo';
  const { sent } = setup(source);
  const diagnostics = (sent.at(-1)!.params as Published).diagnostics;
  expect(
    diagnostics.filter(d => d.source === 'northtalk').map(d => d.code),
  ).toEqual([
    'not in recovery',
    'duplicate offer',
    "can't suspend here",
    'leaves recovery catch',
  ]);
  expect(diagnostics.filter(d => d.code === 'advanced-construct')).toHaveLength(
    5,
  );
  expect(diagnostics.some(d => d.code === 'unknown name')).toBe(false);
});

const lines = (locations: Location[]) =>
  locations.map(
    l => `${l.uri === uri ? 'main' : 'other'}:${l.range.start.line}`,
  );

describe('senders and implementors of a message', () => {
  const other = 'file:///workspace/other.talk';
  const source = [
    'on review x', // 0
    '  send review with x to me', // 1
    '  send notify to it', // 2
    '  send (x) to it', // 3
    '  greet x at 2', // 4
    'end review', // 5
    'on greet name at t', // 6
    '  pass greet at', // 7
    'end greet', // 8
    'on any message m', // 9
    '  pass any message', // 10
    'end', // 11
    '',
  ].join('\n');
  const otherSource = [
    'on notify', // 0
    '  send review with 1 to it', // 1
    '  wait for review', // 2
    'end notify', // 3
    'on review y', // 4
    'end review', // 5
    '',
  ].join('\n');
  const workspace = () => {
    const { server, request, sent } = setup(source);
    server.configure({ sources: [{ uri: other, text: otherSource }] });
    const call = (method: string, params: object) => {
      server.handle({ jsonrpc: '2.0', id: 3, method, params });
      return sent.at(-1)!.result as {
        from?: { detail: string; name: string; uri: string };
        fromRanges: unknown[];
        to?: { detail: string; name: string };
      }[];
    };
    return { request, call };
  };

  test('references on a message name are its senders across Scripts, whatever the receiver', () => {
    const { request } = workspace();
    expect(
      lines(
        request('textDocument/references', {
          ...at(2, 8),
          context: { includeDeclaration: false },
        }),
      ),
    ).toEqual(['main:2']);
    expect(
      lines(
        request('textDocument/references', {
          ...at(1, 8),
          context: { includeDeclaration: false },
        }),
      ),
    ).toEqual(['main:1', 'other:1']);
    expect(
      lines(
        request('textDocument/references', {
          ...at(0, 4),
          context: { includeDeclaration: true },
        }),
      ),
    ).toEqual(['main:0', 'main:1', 'other:1', 'other:2', 'other:4']);
    expect(
      lines(
        request('textDocument/references', {
          ...at(6, 4),
          context: { includeDeclaration: false },
        }),
      ),
    ).toEqual(['main:4', 'main:7']);
  });
  test('implementation lists every Handler Clause and wait for event', () => {
    const { request } = workspace();
    const implementation = (position: ReturnType<typeof at>) =>
      lines(request('textDocument/implementation', position));
    expect(implementation(at(1, 8))).toEqual(['main:0', 'other:2', 'other:4']);
    expect(implementation(at(2, 8))).toEqual(['other:0']);
    expect(implementation(at(4, 3))).toEqual(['main:6']);
  });
  test('the call hierarchy follows a message from its senders, marking unknown names', () => {
    const { request, call } = workspace();
    const items = request('textDocument/prepareCallHierarchy', at(1, 8));
    expect(items.map(i => i.name)).toEqual(['review x', 'review y']);
    const incoming = call('callHierarchy/incomingCalls', { item: items[0] });
    expect(
      incoming.map(c => `${c.from!.name} (${c.from!.detail})`).sort(),
    ).toEqual([
      'any message m (unknown message name)',
      'notify (other.talk)',
      'review x (main.talk)',
      'review x (unknown message name)',
    ]);
    const outgoing = call('callHierarchy/outgoingCalls', { item: items[0] });
    expect(outgoing.map(c => `${c.to!.name} (${c.to!.detail})`)).toEqual([
      'review x (main.talk)',
      'notify (other.talk)',
      '(…) (unknown message name)',
      'greet name at t (main.talk)',
    ]);
  });
});

test('Session Store watch Operations are accepted and offered by LSP completion', () => {
  const host = new SessionHost({ now: () => 0n });
  host.input(':grant scores store');
  const source =
    'on go\n  ask scores to watch "board", "score/"\n  ask scores to unwatch "board"\nend go';
  const { sent, request } = setup(source, JSON.parse(host.exportManifest()));
  expect(
    (sent.at(-1)!.params as Published).diagnostics.filter(
      d => d.severity === 1,
    ),
  ).toEqual([]);
  const completion = request('textDocument/completion', at(1, 16));
  expect(completion.map(c => c.label)).toContain('watch');
  expect(completion.map(c => c.label)).toContain('unwatch');
});

test('completes optional key reads and Nothing defaults', () => {
  for (const [line, label] of [
    ['return the opt', 'optional'],
    ['return nothing other', 'otherwise'],
  ]) {
    const { request } = setup(`on go\n${line}\nend go`, false);
    expect(
      request('textDocument/completion', at(1, line!.length)).map(c => c.label),
    ).toContain(label!);
  }
  const { sent } = setup(
    'on go\nreturn the optional x of {} otherwise 4\nend go',
    false,
  );
  expect(
    (sent.at(-1)!.params as Published).diagnostics.filter(
      d => d.severity === 1,
    ),
  ).toEqual([]);
});

test('a message the Host answers is completed, documented and checked unless the Script answers it', () => {
  const host = {
    ...manifest,
    messages: [
      ...manifest.messages,
      {
        name: 'hide',
        args: [{ object: 'button' }],
        receivers: [],
        description: 'Hides an object.',
        examples: ['hide okButton'],
      },
    ],
  };
  const { sent, request } = setup('on demo\n  hi\n  hide\nend demo', host);
  const completion = request('textDocument/completion', at(1, 4));
  expect(completion).toContainEqual(
    expect.objectContaining({
      label: 'hide',
      documentation: expect.stringContaining('Hides an object.'),
    }),
  );
  const hover = request('textDocument/hover', at(2, 3)) as {
    contents: { value: string };
  };
  expect(hover.contents.value).toBe(
    'hide ‹button object›\nHides an object.\nExamples:\nhide okButton',
  );
  const published = sent
    .filter(m => m.method === 'textDocument/publishDiagnostics')
    .at(-1)!.params as Published;
  expect(published.diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'message-argument-count',
      severity: 2,
      message:
        'The Host Manifest declares hide with 1 argument, but this command gives 0 arguments.',
    }),
  );

  // The Script's own Handler takes precedence over the Host's message.
  const own = setup('on hide\nend hide\non demo\n  hide\nend demo', host);
  const ownHover = own.request('textDocument/hover', at(3, 3)) as {
    contents: { value: string };
  };
  expect(ownHover.contents.value).not.toContain('Hides an object.');
  expect(ownHover.contents.value).toContain('on hide');
  const ownDiagnostics = own.sent
    .filter(m => m.method === 'textDocument/publishDiagnostics')
    .at(-1)!.params as Published;
  expect(ownDiagnostics.diagnostics.map(d => d.code)).not.toContain(
    'message-argument-count',
  );
});

test('a Host Command is completed, documented, checked at load and Linted when shadowed', () => {
  const host = {
    ...manifest,
    grants: [
      ...manifest.grants,
      {
        name: 'folio',
        capability: 'folio',
        operations: [
          {
            name: 'hide',
            mode: 'fire-and-forget',
            args: ['text'],
            cost: { fuel: 0, alloc: 0 },
            command: true,
            description: 'Hides a part.',
          },
        ],
      },
    ],
  };
  const { sent, request } = setup(
    'on demo\n  hide "a"\n  hide\nend demo',
    host,
  );
  const hover = request('textDocument/hover', at(1, 3)) as {
    contents: { value: string };
  };
  expect(hover.contents.value).toContain('Hides a part.');
  expect(hover.contents.value).toContain('Host Command');
  const items = request('textDocument/completion', at(2, 3)) as {
    documentation?: unknown;
    label: string;
  }[];
  expect(JSON.stringify(items.find(i => i.label === 'hide'))).toContain(
    'Hides a part.',
  );
  const published = sent
    .filter(m => m.method === 'textDocument/publishDiagnostics')
    .at(-1)!.params as Published;
  expect(published.diagnostics.map(d => d.code)).toContain(
    'wrong argument count',
  );

  const own = setup('on hide x\nend hide\non demo\n  hide "a"\nend demo', host);
  const ownDiagnostics = own.sent
    .filter(m => m.method === 'textDocument/publishDiagnostics')
    .at(-1)!.params as Published;
  expect(ownDiagnostics.diagnostics.map(d => d.code)).toContain(
    'shadowed-host-command',
  );
  // The Script's own Handler is the one completed.
  const ownItems = own.request('textDocument/completion', at(3, 3)) as {
    documentation?: unknown;
    label: string;
  }[];
  expect(ownItems.filter(i => i.label === 'hide')).toHaveLength(1);
  expect(JSON.stringify(ownItems.find(i => i.label === 'hide'))).not.toContain(
    'Hides a part.',
  );
});

test('Result Targets define, reference and rename the same put binding across call forms', () => {
  const source =
    'on go\n sqrt(4) into answer\n tell http\n  fetch "a" into answer and wait\n end tell\n send echo to me into answer and wait\n return answer\nend go\n';
  const { request } = setup(source);
  const position = at(6, 9);
  const definition = request('textDocument/definition', position);
  expect(definition.range.start).toEqual({ line: 1, character: 14 });
  const rename = request('textDocument/rename', {
    ...position,
    newName: 'saved',
  });
  expect(rename.changes[uri]!.map(edit => edit.range.start)).toEqual([
    { line: 1, character: 14 },
    { line: 3, character: 17 },
    { line: 5, character: 22 },
    { line: 6, character: 8 },
  ]);
});

describe('Argument Labels on Operations (ADR 0115)', () => {
  const host = {
    ...manifest,
    grants: [
      ...manifest.grants,
      {
        name: 'world',
        capability: 'world',
        operations: [
          {
            name: 'move',
            mode: 'immediate',
            args: ['text', 'text'],
            labels: ['to'],
            cost: { fuel: 1, alloc: 0 },
            command: true,
            description: 'Moves a piece.',
          },
          {
            name: 'place',
            mode: 'fire-and-forget',
            args: ['text', 'text', { optional: 'number' }],
            labels: ['at', 'facing'],
            cost: { fuel: 1, alloc: 0 },
          },
          {
            name: 'swap',
            mode: 'immediate',
            args: ['text', 'text'],
            cost: { fuel: 1, alloc: 0 },
          },
        ],
      },
    ],
  };
  type Help = {
    activeParameter: number;
    activeSignature: number;
    signatures: {
      documentation?: string;
      label: string;
      parameters: { label: [number, number] }[];
    }[];
  } | null;
  // The signature at the end of the last line, with its parameters' text.
  const help = (source: string, line = source.split('\n').length - 1) => {
    const { request } = setup(source, host);
    const result = (request as (method: string, params: object) => unknown)(
      'textDocument/signatureHelp',
      at(line, source.split('\n')[line]!.length),
    ) as Help;
    return result
      ? {
          ...result,
          params: result.signatures.map(s =>
            s.parameters.map(p => s.label.slice(...p.label)),
          ),
        }
      : null;
  };
  const labels = (source: string, line = source.split('\n').length - 1) =>
    setup(source, host)
      .request(
        'textDocument/completion',
        at(line, source.split('\n')[line]!.length),
      )
      .map(i => i.label);
  const codes = (source: string) =>
    (
      setup(source, host)
        .sent.filter(m => m.method === 'textDocument/publishDiagnostics')
        .at(-1)!.params as Published
    ).diagnostics.map(d => d.code);

  test('the manifest reader keeps labels and the dictionary writes the labelled call', () => {
    const read = readManifest(host).grants.get('world')!;
    expect(read.get('move')!.labels).toEqual(['to']);
    expect(read.get('swap')!.labels).toBeUndefined();
    const { request } = setup('', host);
    const dictionary = request('northtalk/dictionary', {});
    expect(dictionary).toContain('ask world to move ‹text› to ‹text›');
    expect(dictionary).toContain(
      'tell world to place ‹text› at ‹text› [facing ‹number›]',
    );
    expect(dictionary).toContain('ask world to swap ‹text›, ‹text›');
    expect(dictionary).toContain(
      'Host Command: also callable as `move` alone, or as `move ‹text› to ‹text›`',
    );
  });

  test('completion offers the next declared label of an Operation call', () => {
    expect(labels('on demo\n  ask world to move "a" ')).toEqual(['to']);
    expect(labels('on demo\n  tell world to place "a" ')).toEqual(['at']);
    expect(labels('on demo\n  tell world to place "a" at "b" ')).toEqual([
      'facing',
    ]);
    expect(labels('on demo\n  tell world to place "a" at "b" fa')).toEqual([
      'facing',
    ]);
    expect(labels('on demo\n  tell world\n    place "a" ')).toEqual(['at']);
    // A wrong label so far, or an Operation without labels, offers none.
    expect(labels('on demo\n  tell world to place "a" on "b" ')).not.toContain(
      'facing',
    );
    expect(labels('on demo\n  ask world to swap "a" ')).not.toContain('to');
    // A labelled Host Command's labelled spelling is a Command Call.
    expect(labels('on demo\n  move "a" ')).toEqual(['to']);
  });

  test('hover shows the labelled call of an Operation and a labelled Host Command', () => {
    const source =
      'on demo\n  ask world to move "a" to "b"\n  move "a" to "b"\nend demo';
    const { request } = setup(source, host);
    expect(request('textDocument/hover', at(1, 16)).contents.value).toContain(
      'ask world to move ‹text› to ‹text›',
    );
    const command = request('textDocument/hover', at(2, 3)).contents.value;
    expect(command).toContain('Moves a piece.');
    expect(command).toContain('ask world to move ‹text› to ‹text›');
  });

  test('a wrong label is a load diagnostic and the positional call stays valid', () => {
    expect(
      codes('on demo\n  ask world to move "a" at "b"\nend demo'),
    ).toContain('wrong labels');
    expect(
      codes('on demo\n  ask world to swap "a" to "b"\nend demo'),
    ).toContain('wrong labels');
    expect(
      codes(
        'on demo\n  ask world to move "a", "b"\n  ask world to move "a" to "b"\n  tell world\n    place "a" at "b"\n  end tell\nend demo',
      ),
    ).not.toContain('wrong labels');
  });

  test('signature help shows the labelled call and the argument at the cursor', () => {
    expect(help('on demo\n  ask world to move ')).toMatchObject({
      signatures: [
        {
          label: 'ask world to move ‹text› to ‹text›',
          documentation: 'Moves a piece.',
        },
      ],
      params: [['‹text›', 'to ‹text›']],
      activeParameter: 0,
    });
    expect(help('on demo\n  ask world to move "a" to ')?.activeParameter).toBe(
      1,
    );
    expect(help('on demo\n  ask world to move "a", ')?.activeParameter).toBe(1);
    expect(
      help('on demo\n  tell world to place "a" at "b" facing '),
    ).toMatchObject({
      signatures: [
        { label: 'tell world to place ‹text› at ‹text› [facing ‹number›]' },
      ],
      params: [['‹text›', 'at ‹text›', '[facing ‹number›]']],
      activeParameter: 2,
    });
    expect(help('on demo\n  ask world to swap "a", ')).toMatchObject({
      signatures: [{ label: 'ask world to swap ‹text›, ‹text›' }],
      params: [['‹text›', '‹text›']],
      activeParameter: 1,
    });
    // A `tell` block's line is the call without its receiver.
    expect(help('on demo\n  tell world\n    place "a" at ')).toMatchObject({
      signatures: [{ label: 'place ‹text› at ‹text› [facing ‹number›]' }],
      activeParameter: 1,
    });
    // No signature while naming the Operation, past `into` or off the call.
    expect(help('on demo\n  ask world to move')).toBeNull();
    expect(help('on demo\n  ask world to move "a" to "b" into x')).toBeNull();
    expect(help('on demo\n  ask world to move "a" to "b"\n')).toBeNull();
    expect(help('on demo\n  ask world to fly "a"')).toBeNull();
  });

  test('signature help shows the Handler, Host Command or message a Command Call names', () => {
    expect(help('on demo\n  move "a" to ')).toMatchObject({
      signatures: [
        { label: 'move ‹text› to ‹text›', documentation: 'Moves a piece.' },
      ],
      params: [['‹text›', 'to ‹text›']],
      activeParameter: 1,
    });
    expect(help('on demo\n  move "a", ')).toMatchObject({
      signatures: [{ label: 'move ‹text›, ‹text›' }],
      activeParameter: 1,
    });
    // Both spellings fit until a comma or a label decides.
    expect(help('on demo\n  move ')?.signatures.map(s => s.label)).toEqual([
      'move ‹text›, ‹text›',
      'move ‹text› to ‹text›',
    ]);
    // A Script's own Handler takes the labelled spelling.
    const own = help(
      'on move piece to square\nend move\non demo\n  move "a" to ',
    );
    expect(own).toMatchObject({
      signatures: [{ label: 'move piece to square' }],
      params: [['piece', 'to square']],
      activeParameter: 1,
    });
    expect(help('on demo\n  demo ')?.signatures.map(s => s.label)).toEqual([
      'demo',
    ]);
  });

  test('a Handler shadowing either spelling of a labelled Host Command is Linted', () => {
    expect(
      codes(
        'on move piece to square\nend move\non demo\n  move "a" to "b"\nend demo',
      ),
    ).toContain('shadowed-host-command');
    expect(
      codes(
        'on move piece at square\nend move\non demo\n  move "a" at "b"\nend demo',
      ),
    ).not.toContain('shadowed-host-command');
  });

  test('the server advertises signature help', () => {
    const sent: RpcMessage[] = [];
    const server = createLanguageServer(message => sent.push(message));
    server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { capabilities: {} },
    });
    expect(
      (sent[0]!.result as { capabilities: Record<string, unknown> })
        .capabilities.signatureHelpProvider,
    ).toEqual({ triggerCharacters: [' ', ','] });
  });
});
test('hover on a Handler or function head shows its Fuel estimate (#1606)', () => {
  const { request } = setup(
    'use twice from maths\non demo\n repeat for each u in [1, 2]\n  ask http to fetch "x" and wait\n end repeat\n return twice(2)\nend demo\nfunction f n\n if n < 1 then return 0\n return f(n - 1)\nend f',
  );
  expect(request('textDocument/hover', at(1, 4))?.contents.value).toContain(
    [
      'Fuel estimate: 29, plus 4 per Handler Clause tried',
      '+ 17 per pass of the loop at line 3',
      // The Manifest declares fetch's 1 Fuel; only its result's size is open.
      '+ more with larger values: list (line 3), capability (line 4), arithmetic (maths line 3)',
    ].join('\n'),
  );
  expect(request('textDocument/hover', at(7, 9))?.contents.value).toContain(
    'Fuel estimate: 8..20\n+ more with larger values: compare (line 9), arithmetic (line 10)\n+ calls not counted: f (line 10)',
  );
  // A call site is not a head.
  expect(
    request('textDocument/hover', at(9, 8))?.contents.value ?? '',
  ).not.toContain('Fuel estimate');
});
test('northtalk.fuelCaps changes the hover’s Fuel Bound and refuses a bad cap (#1610)', () => {
  const { request, sent, server } = setup(
    'on demo\n repeat for each u in [1, 2]\n  put u into x\n end repeat\nend demo',
  );
  const bound = () =>
    /Fuel Bound: ([\d,]+)/.exec(
      request('textDocument/hover', at(0, 4))?.contents.value ?? '',
    )?.[1];
  const before = bound();
  server.handle({
    jsonrpc: '2.0',
    method: 'workspace/didChangeConfiguration',
    params: { settings: { northtalk: { fuelCaps: { collection: 10 } } } },
  });
  expect(Number(bound()!.replaceAll(',', ''))).toBeLessThan(
    Number(before!.replaceAll(',', '')),
  );
  expect(request('textDocument/hover', at(0, 4))?.contents.value).toContain(
    'collections ≤ 10 items',
  );
  server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'workspace/didChangeConfiguration',
    params: { settings: { northtalk: { fuelCaps: { text: -1 } } } },
  });
  expect(JSON.stringify(sent.at(-1))).toContain(
    'northtalk.fuelCaps.text must be a whole number',
  );
});
