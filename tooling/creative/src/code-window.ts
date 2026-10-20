// What every NorthTalk editing window shares: a floating, resizable window,
// a language-server worker configured with the Host Manifest, and the shared
// editor. The Code Browser and Message Box are both built from these.
import { type Extension } from '@codemirror/state';
import { EditorView, type KeyBinding } from '@codemirror/view';
import { northtalkEditor, type LanguageHooks } from '@northtalk/editor/editor';
import { LspClient } from '@northtalk/editor/lsp-client';
import { floatingWindow, type FloatingWindow } from './windows';
import { type scriptManifest } from './script-manifest';
import type { WorkspaceConfiguration } from '@northtalk/tooling/lsp';

type HostManifest = ReturnType<typeof scriptManifest>;

/** A floating window with the shared title bar and a resize corner. */
export type CodeWindow = FloatingWindow;

export const codeWindow = (o: {
  className: string;
  closeLabel: string;
  id: string;
  label: string;
  left: number;
  top: number;
}): CodeWindow =>
  floatingWindow({ ...o, className: `resizable code-window ${o.className}` });

/** Shows a window built by `codeWindow`, registering it to float. */
export const showCodeWindow = (win: CodeWindow): void => {
  document.body.append(win.node);
  win.node.dispatchEvent(new Event('script-window-opened', { bubbles: true }));
};

/** A language-server worker for one editor. */
export type LanguageServer = {
  configure(
    manifest: HostManifest,
    sources?: WorkspaceConfiguration['sources'],
  ): void;
  dispose(): void;
  lsp: LspClient;
};

export const languageServer = (): LanguageServer => {
  const worker = new Worker('./lsp.worker.js', { type: 'module' });
  const lsp = new LspClient(worker);
  let configured = '';
  return {
    lsp,
    configure(manifest, sources) {
      const configuration = { manifest, sources };
      const key = JSON.stringify(configuration);
      if (key !== configured) {
        configured = key;
        lsp.configure(configuration);
      }
    },
    dispose() {
      worker.terminate();
    },
  };
};

/** The shared NorthTalk editor in `parent`, talking to `lsp` about `uri`. */
export const codeEditor = (o: {
  bindings?: readonly KeyBinding[];
  doc: string;
  extensions?: Extension[];
  hooks: LanguageHooks;
  lsp: LspClient;
  parent: HTMLElement;
  uri: string;
}): EditorView =>
  new EditorView({
    parent: o.parent,
    doc: o.doc,
    extensions: [
      ...(o.extensions ?? []),
      ...northtalkEditor(o.uri, o.lsp, o.hooks, o.bindings),
    ],
  });
