// Starts `northtalk lsp` for `northtalk` documents. Highlighting comes from the
// TextMate grammar alone; everything else is the language server's.
import { join } from 'node:path';
import { commands, window, workspace, type ExtensionContext } from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

const settings = () => {
  const config = workspace.getConfiguration('northtalk');
  return {
    profile: config.get<string>('profile') || undefined,
    manifest: config.get<string>('manifest') || undefined,
  };
};

const serverOptions = (context: ExtensionContext): ServerOptions => {
  const config = workspace.getConfiguration('northtalk.server');
  const runtime = config.get<string>('runtime');
  const script =
    config.get<string>('path') ||
    join(context.extensionPath, 'dist', 'server.mjs');
  // Without a runtime, the editor's own Electron binary runs the bundled
  // server as plain Node.
  const executable = runtime
    ? { command: runtime, args: [script, 'lsp'] }
    : {
        command: process.execPath,
        args: [script, 'lsp'],
        options: { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      };
  return { run: executable, debug: executable };
};

const start = async (context: ExtensionContext) => {
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'northtalk' }],
    initializationOptions: { northtalk: settings() },
    synchronize: {
      configurationSection: 'northtalk',
    },
  };
  client = new LanguageClient(
    'northtalk',
    'NorthTalk',
    serverOptions(context),
    clientOptions,
  );
  await client.start();
};

const stop = async () => {
  const current = client;
  client = undefined;
  await current?.stop();
};

export const activate = async (context: ExtensionContext) => {
  context.subscriptions.push(
    commands.registerCommand('northtalk.restartServer', async () => {
      await stop();
      await start(context);
    }),
    workspace.onDidChangeConfiguration(async event => {
      // Profile and manifest reach the running server as configuration; a
      // different server process needs a restart.
      if (event.affectsConfiguration('northtalk.server')) {
        await stop();
        await start(context);
      }
    }),
  );
  try {
    await start(context);
  } catch (error) {
    window.showErrorMessage(
      `NorthTalk language server failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const deactivate = () => stop();
