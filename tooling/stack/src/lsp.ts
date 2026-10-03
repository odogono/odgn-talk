/** Transport-agnostic LSP 3.17 server. Send and workspace data are supplied by
 * a stdio Host or a browser worker; this module has no file/process imports. */
import {
  analyzeWorkspace,
  type Document,
  type WorkspaceSource,
} from './lsp/workspace';
import { readManifest, type HostManifest } from './lsp/manifest';
import {
  codeActions,
  completion,
  definition,
  formatting,
  hover,
  nameAt,
  references,
  rename,
  suspensionHints,
} from './lsp/features';
import {
  offsetAt,
  range,
  rangeAt,
  record,
  string,
  position,
  RpcError,
  type RpcMessage,
} from './lsp/protocol';
import type { LintProfile } from './lint';
export type {
  RpcMessage,
  Position,
  Range,
  Location,
  TextEdit,
  LspDiagnostic,
} from './lsp/protocol';
export { libraryUri, type WorkspaceSource } from './lsp/workspace';
export type WorkspaceConfiguration = {
  manifest?: unknown;
  manifestError?: string | null;
  profile?: LintProfile;
  sources?: readonly WorkspaceSource[];
};
export const createLanguageServer = (send: (message: RpcMessage) => void) => {
  let initialized = false;
  let shutdown = false;
  let exitCode: number | undefined;
  let manifest: HostManifest | null = null;
  let manifestError: string | null = null;
  let profile: LintProfile = 'standard';
  let sources: readonly WorkspaceSource[] = [];
  const open = new Map<string, Document>();
  let analyses = new Map<
    string,
    ReturnType<typeof analyzeWorkspace> extends Map<string, infer A> ? A : never
  >();
  const refresh = () => {
    const documents = new Map(sources.map(source => [source.uri, source]));
    for (const [uri, doc] of open) {
      documents.set(uri, { ...documents.get(uri), ...doc });
    }
    analyses = analyzeWorkspace([...documents.values()], manifest, profile);
    for (const [uri, doc] of open) {
      const diagnostics = [...(analyses.get(uri)?.diagnostics ?? [])];
      if (manifestError) {
        diagnostics.push({
          range: rangeAt(doc.text, 0, 0),
          code: 'host manifest',
          source: 'northtalk',
          severity: 2,
          message: manifestError,
        });
      }
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri, version: doc.version, diagnostics },
      });
    }
  };
  const configure = (configuration: WorkspaceConfiguration) => {
    if ('manifest' in configuration) {
      manifestError = null;
      try {
        manifest =
          configuration.manifest == null
            ? null
            : readManifest(configuration.manifest);
      } catch (error) {
        manifest = null;
        manifestError = `Invalid Host Manifest: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (configuration.sources) {
      sources = configuration.sources;
    }
    if ('manifestError' in configuration) {
      manifestError = configuration.manifestError ?? null;
    }
    if (configuration.profile) {
      profile = configuration.profile;
    }
    if (open.size) {
      refresh();
    }
  };
  const settings = (value: unknown) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    const data = record(value);
    const config = data.northtalk ? record(data.northtalk) : data;
    if (config.profile !== undefined) {
      if (config.profile !== 'beginner' && config.profile !== 'standard') {
        throw new RpcError(
          -32_602,
          'northtalk.profile must be beginner or standard',
        );
      }
      profile = config.profile;
    }
  };
  const dispatch = (method: string, raw: unknown): unknown => {
    const params = raw == null ? {} : record(raw);
    if (method === 'exit') {
      exitCode = shutdown ? 0 : 1;
      return null;
    }
    if (method === 'initialize') {
      if (initialized) {
        throw new RpcError(-32_600, 'Already initialized');
      }
      settings(params.initializationOptions);
      initialized = true;
      return {
        capabilities: {
          positionEncoding: 'utf-16',
          textDocumentSync: {
            openClose: true,
            change: 2,
            save: { includeText: true },
          },
          completionProvider: { triggerCharacters: [' ', '.'] },
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          renameProvider: { prepareProvider: true },
          inlayHintProvider: true,
          documentFormattingProvider: true,
          codeActionProvider: { codeActionKinds: ['quickfix'] },
        },
        serverInfo: { name: 'northtalk', version: '0.1.0' },
      };
    }
    if (!initialized) {
      throw new RpcError(-32_002, 'Server not initialized');
    }
    if (method === 'shutdown') {
      shutdown = true;
      return null;
    }
    if (shutdown) {
      throw new RpcError(-32_600, 'Server has shut down');
    }
    if (
      method === 'initialized' ||
      method === '$/cancelRequest' ||
      method === '$/setTrace'
    ) {
      return null;
    }
    if (method === 'workspace/didChangeConfiguration') {
      settings(params.settings);
      refresh();
      return null;
    }
    if (method === 'northtalk/librarySource') {
      if (!analyses.size) {
        refresh();
      }
      return analyses.get(string(params.uri))?.document.text ?? null;
    }
    if (method === 'textDocument/didOpen') {
      const doc = record(params.textDocument);
      if (!Number.isInteger(doc.version)) {
        throw new RpcError(-32_602, 'Expected an integer document version');
      }
      open.set(string(doc.uri), {
        uri: string(doc.uri),
        text: string(doc.text),
        version: Number(doc.version),
      });
      refresh();
      return null;
    }
    if (method === 'textDocument/didChange') {
      const doc = record(params.textDocument);
      const current = open.get(string(doc.uri));
      if (!current || !Number.isInteger(doc.version)) {
        throw new RpcError(
          -32_602,
          'Expected an open document and integer version',
        );
      }
      if (Number(doc.version) <= current.version!) {
        return null;
      }
      if (!Array.isArray(params.contentChanges)) {
        throw new RpcError(-32_602, 'Expected contentChanges');
      }
      let text = current.text;
      for (const value of params.contentChanges) {
        const change = record(value);
        if (change.range) {
          const r = range(change.range);
          const start = offsetAt(text, r.start);
          const end = offsetAt(text, r.end);
          if (end < start) {
            throw new RpcError(-32_602, 'Reversed edit range');
          }
          text = text.slice(0, start) + string(change.text) + text.slice(end);
        } else {
          text = string(change.text);
        }
      }
      open.set(current.uri, { ...current, text, version: Number(doc.version) });
      refresh();
      return null;
    }
    if (method === 'textDocument/didClose') {
      const uri = string(record(params.textDocument).uri);
      open.delete(uri);
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri, diagnostics: [] },
      });
      refresh();
      return null;
    }
    if (method === 'textDocument/didSave') {
      return null;
    }
    const supported = [
      'textDocument/completion',
      'textDocument/hover',
      'textDocument/definition',
      'textDocument/references',
      'textDocument/rename',
      'textDocument/prepareRename',
      'textDocument/inlayHint',
      'textDocument/formatting',
      'textDocument/codeAction',
    ];
    if (!supported.includes(method)) {
      throw new RpcError(-32_601, `Unsupported method: ${method}`);
    }
    const uri = string(record(params.textDocument).uri);
    const analysis = analyses.get(uri);
    if (!analysis) {
      throw new RpcError(-32_602, `Unknown document: ${uri}`);
    }
    if (method === 'textDocument/formatting') {
      return formatting(analysis);
    }
    if (method === 'textDocument/codeAction') {
      return codeActions(analysis, range(params.range));
    }
    if (method === 'textDocument/inlayHint') {
      return suspensionHints(analysis, range(params.range));
    }
    const offset = offsetAt(analysis.document.text, position(params.position));
    switch (method) {
      case 'textDocument/completion':
        return completion(analysis, offset, manifest, analyses);
      case 'textDocument/hover':
        return hover(analyses, analysis, offset, manifest);
      case 'textDocument/definition':
        return definition(analyses, analysis, offset);
      case 'textDocument/references':
        return references(
          analyses,
          analysis,
          offset,
          record(params.context).includeDeclaration === true,
        );
      case 'textDocument/rename':
        return rename(analyses, analysis, offset, string(params.newName));
      case 'textDocument/prepareRename': {
        const name = nameAt(analysis, offset);
        return name &&
          name.role !== 'library' &&
          definition(analyses, analysis, offset)
          ? {
              range: rangeAt(
                analysis.document.text,
                name.span.start,
                name.span.end,
              ),
              placeholder: name.text,
            }
          : null;
      }
    }
    return null;
  };
  return {
    configure,
    documentSource: (uri: string): string | undefined =>
      analyses.get(uri)?.document.text,
    get exitCode() {
      return exitCode;
    },
    handle(message: RpcMessage): void {
      // Responses to optional client requests are not incoming server requests.
      if (!message.method) {
        return;
      }
      try {
        const result = dispatch(message.method, message.params);
        if (message.id !== undefined) {
          send({ jsonrpc: '2.0', id: message.id, result });
        }
      } catch (error) {
        if (message.id !== undefined) {
          send({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: error instanceof RpcError ? error.code : -32_603,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        } else {
          send({
            jsonrpc: '2.0',
            method: 'window/logMessage',
            params: {
              type: 1,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    },
  };
};

export { offsetAt, rangeAt } from './lsp/protocol';
