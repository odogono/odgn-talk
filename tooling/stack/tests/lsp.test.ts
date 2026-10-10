import { describe, expect, test } from 'bun:test';
import { SessionHost } from '@odgn/northtalk/session';
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
  language: '1.0-rc.2',
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

describe('language server', () => {
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
