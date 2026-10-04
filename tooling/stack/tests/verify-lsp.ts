import { createLanguageServer, type RpcMessage } from '../src/lsp';

/** Run unchanged in a worker-like VM, Node, and the actual browser smoke page. */
export const verifyLspFeatures = (): number => {
  const messages: RpcMessage[] = [];
  const server = createLanguageServer(message => messages.push(message));
  server.configure({
    manifest: {
      kind: 'demo',
      version: '1',
      language: '1.0-rc.2',
      grants: [],
      libraries: [],
      messages: [],
      objects: [],
    },
  });
  server.handle({ method: 'initialize', id: 1, params: {} });
  const uri = 'file:///demo.talk';
  server.handle({
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri,
        languageId: 'northtalk',
        version: 1,
        text: 'constant answer = 6 * 7\non demo\nput answer into x\nwait 1ms\nend demo\n',
      },
    },
  });
  const diagnostics = messages.at(-1)!.params as { diagnostics: unknown[] };
  if (diagnostics.diagnostics.length) {
    throw new Error('Unexpected LSP diagnostics');
  }
  server.handle({
    method: 'textDocument/hover',
    id: 2,
    params: { textDocument: { uri }, position: { line: 2, character: 6 } },
  });
  const hover = messages.at(-1)!.result as { contents: { value: string } };
  if (hover.contents.value !== '42') {
    throw new Error('Constant hover failed');
  }
  server.handle({
    method: 'textDocument/inlayHint',
    id: 3,
    params: {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 5, character: 0 },
      },
    },
  });
  const hints = messages.at(-1)!.result as unknown[];
  if (hints.length !== 2) {
    throw new Error('Suspension marks failed');
  }
  server.handle({
    method: 'textDocument/definition',
    id: 4,
    params: { textDocument: { uri }, position: { line: 2, character: 6 } },
  });
  const definition = messages.at(-1)!.result as {
    range: { start: { line: number } };
  };
  if (definition.range.start.line !== 0) {
    throw new Error('Definition failed');
  }
  return 4;
};
