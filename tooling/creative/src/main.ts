// The creative tool's page (#154): the Stack editor shell (#749) on the
// last Project used, autosaved in the browser with its Project list and
// earlier versions (#752), and a sample Script window on the shared
// NorthTalk editor, with the language server's diagnostics, completion and
// hover. Script windows for the Project's own Scripts come with stage 2.
import { coreVersions } from '@odgn/northtalk';
import {
  diagnosticsSpec,
  northtalkEditor,
  refreshHints,
} from '@odgn/northtalk-editor/editor';
import { LspClient } from '@odgn/northtalk-editor/lsp-client';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { browserChannel, browserLocks, EditLock } from './edit-lock';
import {
  mountProjects,
  openInitialProject,
  type InitialProject,
  type LockDelegate,
} from './projects';
import { mountStack } from './stack';
import { openProjectStorage, type ProjectStorage } from './storage';

// A sample Script in the Host interface settled in #735.
export const SAMPLE = `-- Script of button climbButton
on click
  set the label of me to "Climbing…"
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

// Opens storage and the last Project used, asks for its edit lock (another
// tab may hold it), then mounts the shell and the Project windows. When
// the browser won't keep data, editing still works in memory.
const boot = async (): Promise<void> => {
  let storage: ProjectStorage | undefined;
  let storageError: unknown;
  let initial: InitialProject;
  try {
    storage = await openProjectStorage(indexedDB);
    initial = await openInitialProject(storage);
  } catch (error) {
    storageError = error;
    storage = undefined;
    initial = await openInitialProject(undefined);
  }
  const channel = browserChannel();
  // Filled in by mountProjects once autosave exists; the lock needs its
  // hooks before the first takeover can arrive.
  const lockDelegate: LockDelegate = {
    flush: () => Promise.resolve(),
    onEditing: () => {},
  };
  const lock = new EditLock(browserLocks(), channel, {
    flush: () => lockDelegate.flush(),
    onEditing: editing => lockDelegate.onEditing(editing),
  });
  const editing = await lock.acquire(initial.id);
  const shell = mountStack(initial.project, { readOnly: !editing });
  mountProjects({
    channel,
    initial,
    lock,
    lockDelegate,
    shell,
    storage,
    storageError,
  });
};
void boot();

element('script-title').textContent = 'Sample Script of button “climbButton”';
const scriptWindow = element('script-window');
element('show-script').addEventListener('click', () => {
  scriptWindow.hidden = false;
  view.requestMeasure();
});
element('close-script').addEventListener('click', () => {
  scriptWindow.hidden = true;
});

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
