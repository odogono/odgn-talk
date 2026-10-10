import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  readFileSync,
  mkdtempSync,
  copyFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { RpcMessage } from '../../stack/src/lsp';

/** The same real stdio session runs under Bun and Node, with fragmented frames
 * and UTF-8 text, rather than substituting an in-process server for the CLI. */
export const verifyLspStdio = async (
  runtime: string,
  entry: string,
  fixture: string,
) => {
  const directory = mkdtempSync(join(tmpdir(), 'northtalk-lsp-'));
  const child = spawn(runtime, [entry, 'lsp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => {
    stderr += chunk;
  });
  let buffer = Buffer.alloc(0);
  const messages: RpcMessage[] = [];
  const waiters: {
    matches: (message: RpcMessage) => boolean;
    resolve: (message: RpcMessage) => void;
  }[] = [];
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        break;
      }
      const length = Number(
        /content-length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1],
      );
      if (buffer.length < end + 4 + length) {
        break;
      }
      const message = JSON.parse(
        buffer.subarray(end + 4, end + 4 + length).toString(),
      ) as RpcMessage;
      buffer = buffer.subarray(end + 4 + length);
      const index = waiters.findIndex(w => w.matches(message));
      if (index >= 0) {
        waiters.splice(index, 1)[0]!.resolve(message);
      } else {
        messages.push(message);
      }
    }
  });
  const receive = (
    matches: (message: RpcMessage) => boolean,
  ): Promise<RpcMessage> => {
    const index = messages.findIndex(matches);
    if (index >= 0) {
      return Promise.resolve(messages.splice(index, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`LSP response timeout: ${stderr}`)),
        15_000,
      );
      waiters.push({
        matches,
        resolve: message => {
          clearTimeout(timeout);
          resolve(message);
        },
      });
    });
  };
  let id = 0;
  const send = (message: RpcMessage) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
      body,
    ]);
    child.stdin.write(frame.subarray(0, 17));
    child.stdin.write(frame.subarray(17));
  };
  const request = async (method: string, params: object = {}) => {
    const requestId = ++id;
    send({ id: requestId, method, params });
    const response = await receive(m => m.id === requestId);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  };
  const notification = () =>
    receive(m => m.method === 'textDocument/publishDiagnostics');
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  try {
    copyFileSync(
      join(fixture, 'demo.talk-manifest.json'),
      join(directory, 'demo.talk-manifest.json'),
    );
    const text = readFileSync(join(fixture, 'main.talk'), 'utf8');
    const file = join(directory, 'main.talk');
    writeFileSync(file, text);
    const uri = pathToFileURL(file).href;
    const result = await request('initialize', {
      rootUri: pathToFileURL(directory).href,
      capabilities: {},
      initializationOptions: { northtalk: { profile: 'beginner' } },
    });
    assert.equal(
      (result as { capabilities: { hoverProvider: boolean } }).capabilities
        .hoverProvider,
      true,
    );
    send({ method: 'initialized', params: {} });
    send({
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, text, version: 1, languageId: 'northtalk' },
      },
    });
    const diagnostics = (await notification()).params as {
      diagnostics: { code: string }[];
    };
    assert.deepEqual(
      diagnostics.diagnostics.map(d => d.code),
      ['prefer-explicit-end'],
    );
    const hover = (await request('textDocument/hover', {
      textDocument: { uri },
      position: { line: 2, character: 5 },
    })) as { contents: { value: string } };
    assert.equal(hover.contents.value, '42');
    // The discovered manifest's Grants make the dictionary (#526).
    assert.match(
      String(await request('northtalk/dictionary', {})),
      /## http\n\n### fetch\n\n```northtalk\nask http to fetch ‹text› and wait\n```/u,
    );
    const definition = (await request('textDocument/definition', {
      textDocument: { uri },
      position: { line: 2, character: 5 },
    })) as { uri: string };
    assert(definition.uri.startsWith('file:'));
    assert.match(
      readFileSync(fileURLToPath(definition.uri), 'utf8'),
      /constant answer = 6 \* 7/,
    );
    const renamed = (await request('textDocument/rename', {
      textDocument: { uri },
      position: { line: 2, character: 5 },
      newName: 'reply',
    })) as { changes: Record<string, { newText: string }[]> };
    const manifestUri = pathToFileURL(
      join(directory, 'demo.talk-manifest.json'),
    ).href;
    assert.match(renamed.changes[manifestUri]![0]!.newText, /constant reply/);
    assert.equal(
      typeof JSON.parse(renamed.changes[manifestUri]![0]!.newText),
      'string',
    );

    const edits = (await request('textDocument/formatting', {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    })) as { newText: string }[];
    assert.match(edits[0]!.newText, /\n {2}put answer/);
    send({
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [
          { text: 'on demo\n put "😀" & absent into x\nend demo\n' },
        ],
      },
    });
    const changed = (await notification()).params as {
      diagnostics: { code: string; range: { start: { character: number } } }[];
      version: number;
    };
    assert.equal(changed.version, 2);
    assert.equal(
      changed.diagnostics.find(d => d.code === 'unknown name')!.range.start
        .character,
      12,
    );
    // Several matches degrade with a diagnostic; explicit client configuration
    // selects one and immediately republishes document diagnostics.
    copyFileSync(
      join(fixture, 'demo.talk-manifest.json'),
      join(directory, 'other.talk-manifest.json'),
    );
    send({
      method: 'workspace/didChangeWatchedFiles',
      params: {
        changes: [
          {
            uri: pathToFileURL(join(directory, 'other.talk-manifest.json'))
              .href,
            type: 1,
          },
        ],
      },
    });
    const ambiguous = (await notification()).params as {
      diagnostics: { code: string }[];
    };
    assert(ambiguous.diagnostics.some(d => d.code === 'host manifest'));
    send({
      method: 'workspace/didChangeConfiguration',
      params: {
        settings: {
          northtalk: {
            manifest: 'demo.talk-manifest.json',
            profile: 'standard',
          },
        },
      },
    });
    const configured = (await notification()).params as {
      diagnostics: { code: string }[];
    };
    assert(!configured.diagnostics.some(d => d.code === 'host manifest'));
    await request('shutdown');
    send({ method: 'exit' });
    assert.equal(await closed, 0, stderr);
    assert.equal(stderr, '');
  } finally {
    child.kill();
    rmSync(directory, { recursive: true, force: true });
  }
};

export const verifyLspInvalidConfiguration = async (
  runtime: string,
  entry: string,
) => {
  const { spawnSync } = await import('node:child_process');
  const frame = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value));
    return Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
      body,
    ]);
  };
  const child = spawnSync(runtime, [entry, 'lsp'], {
    input: Buffer.concat([
      frame({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { initializationOptions: { northtalk: { profile: 'typo' } } },
      }),
      frame({ jsonrpc: '2.0', method: 'exit' }),
    ]),
    timeout: 15_000,
  });
  const response = JSON.parse(
    child.stdout.toString().split('\r\n\r\n')[1]!,
  ) as RpcMessage;
  assert.equal(response.id, 1);
  assert.equal(response.error?.code, -32_602);
  assert.equal(child.status, 1);
};
