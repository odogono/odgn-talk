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
    request(method: string, line: number, character: number) {
      server.handle({
        jsonrpc: '2.0',
        id: 2,
        method,
        params: {
          textDocument: { uri },
          position: { line, character },
          context: { includeDeclaration: true },
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
