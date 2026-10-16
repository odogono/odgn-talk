// What every NorthTalk editing window shares: a floating, resizable window,
// a language-server worker that knows the `folio` Library, and the shared
// editor. Script windows and the Message Box are both built from these.
import { type Extension } from '@codemirror/state';
import { EditorView, type KeyBinding } from '@codemirror/view';
import {
  northtalkEditor,
  type LanguageHooks,
} from '@odgn/northtalk-editor/editor';
import { LspClient } from '@odgn/northtalk-editor/lsp-client';
import { h } from './dom';
import { FOLIO_LIBRARY_NAME, FOLIO_LIBRARY_SOURCE } from './folio-library';
import { type scriptManifest } from './script-manifest';

type HostManifest = ReturnType<typeof scriptManifest>;

/** A floating window with a title bar, a close box and a resize corner. */
export type CodeWindow = {
  close: HTMLButtonElement;
  node: HTMLElement;
  title: HTMLElement;
};

export const codeWindow = (o: {
  className: string;
  closeLabel: string;
  id: string;
  label: string;
  left: number;
  top: number;
}): CodeWindow => {
  const title = h('span', {}, o.label);
  const close = h('button', {
    type: 'button',
    class: 'close',
    'aria-label': o.closeLabel,
  });
  const node = h(
    'section',
    {
      id: o.id,
      class: `window code-window ${o.className}`,
      'aria-label': o.label,
      'data-left': o.left,
      'data-top': o.top,
    },
    h('div', { class: 'bar' }, close, title),
  );
  return { close, node, title };
};

/** Shows a window built by `codeWindow`, registering it to float. */
export const showCodeWindow = (win: CodeWindow): void => {
  document.body.append(win.node);
  win.node.dispatchEvent(new Event('script-window-opened', { bubbles: true }));
};

/** A language-server worker for one editor, which knows `folio`. */
export type LanguageServer = {
  configure(manifest: HostManifest): void;
  dispose(): void;
  lsp: LspClient;
};

// The tooling's URI for a Library's source.
const FOLIO_LIBRARY_URI = `northtalk-library:///${FOLIO_LIBRARY_NAME}.talk`;

export const languageServer = (): LanguageServer => {
  const worker = new Worker('./lsp.worker.js', { type: 'module' });
  const lsp = new LspClient(worker);
  let configured = '';
  return {
    lsp,
    configure(manifest) {
      const key = JSON.stringify(manifest);
      if (key !== configured) {
        configured = key;
        lsp.configure({
          manifest,
          sources: [
            {
              library: FOLIO_LIBRARY_NAME,
              uri: FOLIO_LIBRARY_URI,
              text: FOLIO_LIBRARY_SOURCE,
            },
          ],
        });
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
