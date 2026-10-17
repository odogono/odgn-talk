// The LSP worker: the tooling stack's language server, with its formatter and
// Lints, over `postMessage` in place of stdio.
import { createLanguageServer } from '@northtalk/tooling/lsp';
import type { FromLsp, ToLsp } from './lsp-protocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ToLsp>) => void) | null;
  postMessage(message: FromLsp): void;
};

const server = createLanguageServer(message => scope.postMessage({ message }));

scope.onmessage = ({ data }) => {
  if (data.t === 'configure') {
    server.configure(data.configuration);
  } else {
    server.handle(data.message);
  }
};
