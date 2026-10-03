// The only LSP file, process and byte-framing concerns live in this adapter.
import {
  readdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { stdlibSources } from '@odgn/northtalk';
import { manifestSourceEdits } from './lsp-manifest';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createLanguageServer,
  offsetAt,
  type TextEdit,
  type RpcMessage,
  type WorkspaceSource,
} from '@odgn/northtalk-tooling/lsp';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const configuration = (value: unknown) => {
  const data = object(value);
  return object(data.northtalk ?? data);
};
const workspace = (
  roots: readonly string[],
  configuredPath: unknown,
  materialize: (
    name: string,
    text: string,
    manifestPath?: string,
  ) => WorkspaceSource,
) => {
  const manifests: string[] = [];
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.talk-manifest.json')) {
          manifests.push(join(root, entry.name));
        }
      }
    } catch {
      /* A client may initialize before its workspace exists. */
    }
  }
  const path =
    typeof configuredPath === 'string' && configuredPath
      ? resolve(roots[0] ?? process.cwd(), configuredPath)
      : manifests.length === 1
        ? manifests[0]
        : undefined;
  let manifest: unknown = null;
  let manifestError: string | null = null;
  if (path) {
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      manifestError = `Cannot read Host Manifest ${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (manifests.length > 1) {
    manifestError =
      'Several Host Manifests found; configure northtalk.manifest to select one.';
  }
  const libraries = object(manifest).libraries;
  const libraryNames = new Set(
    Array.isArray(libraries) ? libraries.map(lib => object(lib).name) : [],
  );
  const sources: WorkspaceSource[] = Object.entries(stdlibSources).map(
    ([name, source]) => materialize(name, source),
  );
  for (const value of Array.isArray(libraries) ? libraries : []) {
    const library = object(value);
    if (
      typeof library.name === 'string' &&
      typeof library.source === 'string'
    ) {
      sources.push(materialize(library.name, library.source, path));
    }
  }
  const work = [...roots];
  while (work.length) {
    const directory = work.pop()!;
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist'
        ) {
          continue;
        }
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          work.push(path);
        } else if (entry.isFile() && entry.name.endsWith('.talk')) {
          const name = basename(entry.name, '.talk');
          sources.push({
            uri: pathToFileURL(path).href,
            text: readFileSync(path, 'utf8'),
            ...(libraryNames.has(name) ? { library: name } : {}),
          });
        }
      }
    } catch {
      /* Deleted or unreadable files simply leave the workspace index. */
    }
  }
  return { manifest, sources, ...(manifestError ? { manifestError } : {}) };
};

const encodeFrame = (message: RpcMessage): Buffer => {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
};

/** Standard Content-Length framing over bytes, under both Node and Bun. */
export const lsp = async (): Promise<number> => {
  const directory = mkdtempSync(join(tmpdir(), 'northtalk-libraries-'));
  const copies = new Map<
    string,
    { manifestPath?: string; name: string; text: string }
  >();
  const materialize = (
    name: string,
    text: string,
    manifestPath?: string,
  ): WorkspaceSource => {
    const path = join(directory, `${encodeURIComponent(name)}.talk`);
    const uri = pathToFileURL(path).href;
    if (copies.get(uri)?.text !== text) {
      writeFileSync(path, text);
    }
    copies.set(uri, { name, text, manifestPath });
    return { uri, text, library: name };
  };
  let renaming = false;
  const send = (message: RpcMessage) => {
    if (renaming && message.result) {
      const changes = object(object(message.result).changes) as Record<
        string,
        TextEdit[]
      >;
      const manifests = new Map<
        string,
        {
          replacements: Map<string, { after: string; before: string }>;
          text: string;
        }
      >();
      for (const [uri, edits] of Object.entries(changes)) {
        const copy = copies.get(uri);
        if (!copy) {
          continue;
        }
        if (!copy.manifestPath) {
          process.stdout.write(
            encodeFrame({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32_602,
                message: 'Standard Library exports cannot be renamed',
              },
            }),
          );
          return;
        }
        let manifest = manifests.get(copy.manifestPath);
        if (!manifest) {
          const text = readFileSync(copy.manifestPath, 'utf8');
          manifest = { text, replacements: new Map() };
          manifests.set(copy.manifestPath, manifest);
        }
        let text = server.documentSource(uri) ?? copy.text;
        const ordered = [...edits].sort(
          (a, b) =>
            offsetAt(text, b.range.start) - offsetAt(text, a.range.start),
        );
        for (const edit of ordered) {
          text =
            text.slice(0, offsetAt(text, edit.range.start)) +
            edit.newText +
            text.slice(offsetAt(text, edit.range.end));
        }
        manifest.replacements.set(copy.name, {
          before: copy.text,
          after: text,
        });
      }
      for (const [path, manifest] of manifests) {
        changes[pathToFileURL(path).href] = manifestSourceEdits(
          manifest.text,
          manifest.replacements,
        );
      }
    }
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
  };
  const server = createLanguageServer(send);
  let roots: string[] = [];
  let settings: Record<string, unknown> = {};
  let clientCapabilities: Record<string, unknown> = {};
  const reload = () => {
    const profile = settings.profile;
    if (
      profile !== undefined &&
      profile !== 'beginner' &&
      profile !== 'standard'
    ) {
      throw new Error('northtalk.profile must be beginner or standard');
    }
    server.configure({
      ...workspace(roots, settings.manifest, materialize),
      ...(profile ? { profile } : {}),
    });
  };
  const handle = (message: RpcMessage) => {
    const params = object(message.params);
    if (message.method === 'initialize') {
      const folders = params.workspaceFolders;
      const uris = Array.isArray(folders)
        ? folders.map(folder => object(folder).uri)
        : [params.rootUri];
      roots = uris
        .filter(
          (uri): uri is string =>
            typeof uri === 'string' && uri.startsWith('file:'),
        )
        .map(uri => fileURLToPath(uri));
      if (!roots.length && typeof params.rootPath === 'string') {
        roots = [params.rootPath];
      }
      settings = configuration(params.initializationOptions);
      clientCapabilities = object(params.capabilities);
      reload();
    } else if (message.method === 'workspace/didChangeConfiguration') {
      settings = { ...settings, ...configuration(params.settings) };
      reload();
      return;
    } else if (
      message.method === 'workspace/didChangeWatchedFiles' ||
      message.method === 'textDocument/didSave'
    ) {
      reload();
      return;
    } else if (
      message.id === 'northtalk-configuration' &&
      Array.isArray(message.result)
    ) {
      settings = configuration(message.result[0]);
      reload();
      return;
    }
    renaming = message.method === 'textDocument/rename';
    try {
      server.handle(message);
    } finally {
      renaming = false;
    }
    if (message.method === 'initialized') {
      const workspace = object(clientCapabilities.workspace);
      if (workspace.configuration === true) {
        send({
          jsonrpc: '2.0',
          id: 'northtalk-configuration',
          method: 'workspace/configuration',
          params: { items: [{ section: 'northtalk' }] },
        });
      }
      if (
        object(workspace.didChangeWatchedFiles).dynamicRegistration === true
      ) {
        send({
          jsonrpc: '2.0',
          id: 'northtalk-watch',
          method: 'client/registerCapability',
          params: {
            registrations: [
              {
                id: 'northtalk-workspace',
                method: 'workspace/didChangeWatchedFiles',
                registerOptions: {
                  watchers: [
                    { globPattern: '**/*.talk' },
                    { globPattern: '**/*.talk-manifest.json' },
                  ],
                },
              },
            ],
          },
        });
      }
    }
  };
  let buffer = Buffer.alloc(0);
  let length: number | undefined;
  const maximumBytes = 16 * 1024 * 1024;
  try {
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([
        buffer,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      for (;;) {
        if (length === undefined) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (buffer.length > 8192) {
              throw new Error('LSP header too large');
            }
            break;
          }
          if (end > 8192) {
            throw new Error('LSP header too large');
          }
          const header = buffer.subarray(0, end).toString('ascii');
          const lengths = [
            ...header.matchAll(/^content-length:\s*(\d+)\s*$/gim),
          ];
          if (lengths.length !== 1) {
            throw new Error('Expected one LSP Content-Length header');
          }
          length = Number(lengths[0]![1]);
          if (!Number.isSafeInteger(length) || length > maximumBytes) {
            throw new Error('LSP message too large');
          }
          buffer = buffer.subarray(end + 4);
        }
        if (buffer.length < length) {
          break;
        }
        const body = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        length = undefined;
        let data: Record<string, unknown>;
        try {
          data = object(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
          );
        } catch {
          send({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32_700, message: 'Invalid JSON or UTF-8' },
          });
          continue;
        }
        if (
          data.jsonrpc !== '2.0' ||
          (data.id !== undefined &&
            data.id !== null &&
            typeof data.id !== 'string' &&
            typeof data.id !== 'number') ||
          (typeof data.method !== 'string' &&
            !('result' in data) &&
            !('error' in data))
        ) {
          send({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32_600, message: 'Invalid JSON-RPC message' },
          });
        } else {
          try {
            handle(data as RpcMessage);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (data.id !== undefined && data.method) {
              send({
                jsonrpc: '2.0',
                id: data.id as RpcMessage['id'],
                error: { code: -32_602, message },
              });
            } else {
              send({
                jsonrpc: '2.0',
                method: 'window/logMessage',
                params: { type: 1, message },
              });
            }
          }
        }
        if (server.exitCode !== undefined) {
          return server.exitCode;
        }
      }
    }
    if (buffer.length || length !== undefined) {
      throw new Error('Truncated LSP frame');
    }
    return server.exitCode ?? 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
