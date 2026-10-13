// The creative tool's page (#154). For now it opens one Script window on the
// shared NorthTalk editor, with the language server's diagnostics,
// completion and hover. The Project model and editor come with stage 1.
import { coreVersions } from '@odgn/northtalk';
import {
  diagnosticsSpec,
  northtalkEditor,
  refreshHints,
} from '@odgn/northtalk-editor/editor';
import { LspClient } from '@odgn/northtalk-editor/lsp-client';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';

// A sample Script in the Host interface settled in #735.
export const SAMPLE = `-- Script of button climbButton
on click
  set the label of climbButton to "Climbing…"
  tell pages to show lampRoom
end click
`;
const URI = 'creative:///climbButton.talk';

const element = (id: string) => {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`The page has no #${id}`);
  }
  return found;
};

element('core').textContent = `Core ${coreVersions.core}`;
element('script-title').textContent = 'Script of button “climbButton”';

const lsp = new LspClient(new Worker('./lsp.worker.js', { type: 'module' }));
const problems = element('problems');
let refresh: ReturnType<typeof setTimeout> | null = null;

const view = new EditorView({
  parent: element('editor'),
  state: EditorState.create({
    doc: SAMPLE,
    extensions: [
      lineNumbers(),
      ...northtalkEditor(URI, lsp, {
        changed(text) {
          lsp.change(URI, text);
          if (refresh) {
            clearTimeout(refresh);
          }
          refresh = setTimeout(() => void refreshHints(view, URI, lsp), 300);
        },
        goTo() {},
        references() {},
      }),
    ],
  }),
});

lsp.onDiagnostics = (uri, diagnostics) => {
  if (uri !== URI) {
    return;
  }
  view.dispatch(diagnosticsSpec(view.state, diagnostics));
  const errors = diagnostics.filter(d => d.severity === 1).length;
  problems.className = errors ? 'bad' : '';
  problems.textContent = diagnostics.length
    ? `${diagnostics.length} problem${diagnostics.length === 1 ? '' : 's'}`
    : '✓ No problems';
};
lsp.open(URI, SAMPLE);
void refreshHints(view, URI, lsp);
