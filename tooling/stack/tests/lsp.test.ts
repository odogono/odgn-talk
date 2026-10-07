import { describe, expect, test } from 'bun:test';
import {
  createLanguageServer,
  type RpcMessage,
  type LspDiagnostic,
  type Location,
  type TextEdit,
  type Position,
} from '../src/lsp';

type Results = {
  'textDocument/codeAction': {
    edit: { changes: Record<string, TextEdit[]> };
  }[];
  'textDocument/completion': { label: string }[];
  'textDocument/definition': Location;
  'textDocument/formatting': TextEdit[];
  'textDocument/hover': { contents: { value: string } };
  'textDocument/inlayHint': { position: Position }[];
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
const setup = (source: string, withManifest = true) => {
  const sent: RpcMessage[] = [];
  const server = createLanguageServer(message => sent.push(message));
  server.configure({ manifest: withManifest ? manifest : null });
  server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { initializationOptions: { northtalk: { profile: 'beginner' } } },
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

describe('language server', () => {
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
    expect(request('textDocument/hover', at(4, 14)).contents.value).toContain(
      'suspending',
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
      'suspending',
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
