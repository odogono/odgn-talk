// A small LSP client over the LSP worker's `postMessage`.
import type {
  LspDiagnostic,
  RpcMessage,
  WorkspaceConfiguration,
} from '@odgn/northtalk-tooling/lsp';
import type { FromLsp, ToLsp } from './protocol';

export class LspClient {
  private next = 1;
  private readonly pending = new Map<
    number,
    { reject(error: Error): void; resolve(value: unknown): void }
  >();
  private readonly versions = new Map<string, number>();
  onDiagnostics: (uri: string, diagnostics: LspDiagnostic[]) => void = () => {};

  constructor(private readonly worker: Worker) {
    worker.onmessage = ({ data: { message } }: MessageEvent<FromLsp>) =>
      this.receive(message);
    void this.request('initialize', {
      processId: null,
      rootUri: null,
      // Hover stays plaintext: the editor shows it as text, not markdown.
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
        },
      },
    }).then(() => this.notify('initialized', {}));
  }

  private post(message: ToLsp) {
    this.worker.postMessage(message);
  }

  private receive(message: RpcMessage) {
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as {
        diagnostics: LspDiagnostic[];
        uri: string;
      };
      this.onDiagnostics(params.uri, params.diagnostics);
      return;
    }
    if (typeof message.id === 'number' && !message.method) {
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        waiting?.reject(new Error(message.error.message));
      } else {
        waiting?.resolve(message.result);
      }
    }
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.next++;
    this.post({ t: 'rpc', message: { jsonrpc: '2.0', id, method, params } });
    return new Promise<T>((resolve, reject) =>
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
      }),
    );
  }

  notify(method: string, params: unknown) {
    this.post({ t: 'rpc', message: { jsonrpc: '2.0', method, params } });
  }

  configure(configuration: WorkspaceConfiguration) {
    this.post({ t: 'configure', configuration });
  }

  open(uri: string, text: string) {
    this.versions.set(uri, 1);
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'northtalk', version: 1, text },
    });
  }

  change(uri: string, text: string) {
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  close(uri: string) {
    this.versions.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }
}
