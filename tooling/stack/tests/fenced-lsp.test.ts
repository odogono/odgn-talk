import { expect, test } from 'bun:test';
import {
  createLanguageServer,
  type RpcMessage,
  type Location,
  type LspDiagnostic,
} from '../src/lsp';

const uri = 'file:///workspace/fenced.talk';
const setup = (source: string) => {
  const sent: RpcMessage[] = [];
  const server = createLanguageServer(message => sent.push(message));
  server.configure({
    manifest: {
      kind: 'test',
      version: '1',
      language: '1.0-rc.2',
      grants: [],
      libraries: [],
      messages: [],
      objectKinds: [],
      objects: [],
    },
  });
  server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  server.handle({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri, languageId: 'northtalk', version: 1, text: source },
    },
  });
  return {
    sent,
    request(
      method: string,
      line: number,
      character: number,
      extra: Record<string, unknown> = {},
    ) {
      server.handle({
        jsonrpc: '2.0',
        id: 2,
        method,
        params: {
          textDocument: { uri },
          position: { line, character },
          context: { includeDeclaration: true },
          ...extra,
        },
      });
      return sent.at(-1)!.result;
    },
  };
};

test('LSP reports unknown names inside interpolation at UTF-16 positions', () => {
  const { sent } = setup('on go\n say `😀 ${missing}`\nend go');
  const publication = [...sent]
    .reverse()
    .find(message => message.method === 'textDocument/publishDiagnostics');
  const { diagnostics } = publication!.params as {
    diagnostics: LspDiagnostic[];
  };
  expect(diagnostics.find(d => d.code === 'unknown name')?.range.start).toEqual(
    { line: 1, character: 11 },
  );
});

test('LSP finds interpolation references without treating literal placeholder text as code', () => {
  const { request } = setup(
    'on go name\n say `hello ${name}`\n say """${name}"""\nend go',
  );
  const locations = request('textDocument/references', 1, 15) as Location[];
  expect(locations.map(location => location.range.start)).toEqual([
    { line: 0, character: 6 },
    { line: 1, character: 14 },
  ]);
  const definition = request('textDocument/definition', 1, 15) as Location;
  expect(definition.range.start).toEqual({ line: 0, character: 6 });
});

test('LSP offers local names inside holes but suppresses completion in literal text', () => {
  const { request } = setup('on go name\n say `hello ${name}`\nend go');
  const completions = request('textDocument/completion', 1, 16) as {
    label: string;
  }[];
  expect(completions.map(item => item.label)).toContain('name');
  expect(request('textDocument/completion', 1, 9)).toEqual([]);
});

test.each(['`hello na', '"""hello na', '`outer ${`nested na'])(
  'LSP suppresses completion in unfinished literal %s',
  expression => {
    const source = 'on go name\n say ' + expression;
    const { request } = setup(source);
    expect(
      request('textDocument/completion', 1, source.split('\n')[1]!.length),
    ).toEqual([]);
  },
);

test('LSP offers names in an unfinished hole after a completed nested literal', () => {
  const source = 'on go name\n say `outer ${"""raw""" & na';
  const { request } = setup(source);
  expect(
    (
      request('textDocument/completion', 1, source.split('\n')[1]!.length) as {
        label: string;
      }[]
    ).map(item => item.label),
  ).toContain('name');
});

test('LSP still completes inside a hole when the outer literal has no final closer', () => {
  const { request } = setup('on go name\n say `hello ${name} tail');
  expect(
    (request('textDocument/completion', 1, 16) as { label: string }[]).map(
      item => item.label,
    ),
  ).toContain('name');
  expect(request('textDocument/completion', 1, 24)).toEqual([]);
});

test('LSP renames nested hole references while preserving raw and escaped placeholders', () => {
  const { request } = setup(
    'on go name\n say `😀 ${`inner ${name}`} \\${name}`\n say """${name}"""\nend go',
  );
  const result = request('textDocument/rename', 1, 22, {
    newName: 'guest',
  }) as {
    changes: Record<
      string,
      {
        newText: string;
        range: { start: { character: number; line: number } };
      }[]
    >;
  };
  expect(
    result.changes[uri]!.map(edit => [edit.range.start, edit.newText]),
  ).toEqual([
    [{ line: 0, character: 6 }, 'guest'],
    [{ line: 1, character: 20 }, 'guest'],
  ]);
});

test('LSP formatting coordinates fenced margins and formats hole code', () => {
  const { request } = setup(
    'on go\nsay `\n    value ${1+2}  \n\n    `\nend go',
  );
  const edits = request('textDocument/formatting', 0, 0) as {
    newText: string;
  }[];
  expect(edits[0]!.newText).toBe(
    'on go\n  say `\n  value ${1 + 2}  \n\n  `\nend go',
  );
});

test('an earlier line-local quoted-text error does not suppress hole completion', () => {
  const { request } = setup(
    'on go name\n say "unfinished\n say `value ${name}`\nend go',
  );
  expect(
    (request('textDocument/completion', 2, 16) as { label: string }[]).map(
      item => item.label,
    ),
  ).toContain('name');
});

test.each(['`bad \\xZ`', '`bad \\u12`', '`bad \\1`', '""""x"""""'])(
  'an earlier closed literal error in %s does not suppress code completion',
  literal => {
    const { request } = setup(
      'on go name\n say ' + literal + '\n say na\nend go',
    );
    expect(
      (request('textDocument/completion', 2, 7) as { label: string }[]).map(
        item => item.label,
      ),
    ).toContain('name');
  },
);

test('an invalid escape before a hole does not suppress completion within that hole', () => {
  const { request } = setup('on go name\n say `bad \\xZ ${na}`\nend go');
  expect(
    (request('textDocument/completion', 1, 18) as { label: string }[]).map(
      item => item.label,
    ),
  ).toContain('name');
});
