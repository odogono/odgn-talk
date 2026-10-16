// The Message Box: one line of NorthTalk, run at once (HyperCard's
// Message Box). While browsing it talks to the running Play Session;
// in Edit it changes the authored Project as one undoable edit.
//
// It is a code window like a Script's, with the same editor and language
// server. The editor holds the whole Script the command runs as, with the
// lines around the command hidden and protected, so completion, hover and
// diagnostics see exactly what runs.
import {
  Annotation,
  EditorState,
  Prec,
  StateField,
  type Text,
} from '@codemirror/state';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import { diagnosticsSpec } from '@odgn/northtalk-editor/editor';
import {
  codeEditor,
  codeWindow,
  languageServer,
  showCodeWindow,
} from './code-window';
import { h } from './dom';
import { MESSAGE_FIRST_LINE, messageParts } from './message-script';
import { runInEdit, type MessageReply } from './message';
import { type PlaySession } from './play';
import { scriptManifest } from './script-manifest';
import { bringWindowForward, setWindowOpener } from './windows';
import { type StackShell } from './stack';

export type MessageTarget = {
  /** Lets the session run the command it was just given. */
  ran(): void;
  /** The browsing session, if any; commands run there when it is. */
  session(): PlaySession | undefined;
};

const HISTORY = 50;
const URI = 'creative:///message-box.talk';

/** The command's span: the lines between the hidden prefix and suffix. */
const commandRange = (doc: Text) =>
  doc.lines > MESSAGE_FIRST_LINE
    ? {
        from: doc.line(MESSAGE_FIRST_LINE).from,
        to: doc.line(doc.lines).from - 1,
      }
    : { from: 0, to: doc.length };

// Marks the Message Box's own rewrites of the hidden lines.
const rewrite = Annotation.define<true>();

const hide = (doc: Text) => {
  const { from, to } = commandRange(doc);
  const hidden = Decoration.replace({});
  return Decoration.set([
    ...(from > 0 ? [hidden.range(0, from)] : []),
    ...(to < doc.length ? [hidden.range(to, doc.length)] : []),
  ]);
};

const hiddenWrapper = StateField.define({
  create: state => hide(state.doc),
  update: (value, tr) => (tr.docChanged ? hide(tr.state.doc) : value),
  provide: field => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of(view => view.state.field(field)),
  ],
});

// Typing can change only the command.
const protectWrapper = EditorState.changeFilter.of(tr => {
  if (tr.annotation(rewrite) || tr.startState.doc.lines <= MESSAGE_FIRST_LINE) {
    return true;
  }
  const { from, to } = commandRange(tr.startState.doc);
  return [0, from, to, tr.startState.doc.length];
});

export const mountMessageWindow = (
  shell: StackShell,
  target: MessageTarget,
): void => {
  const win = codeWindow({
    id: 'message-window',
    className: 'message-window',
    closeLabel: 'Close Message Box',
    label: 'Message Box',
    left: 160,
    top: 560,
  });
  win.node.hidden = true;
  const log = h('ol', { class: 'message-log', 'aria-live': 'polite' });
  const parent = h('div', { class: 'code-editor' });
  win.node.append(log, parent);
  const server = languageServer();
  const { lsp } = server;
  const history: string[] = [];
  let recalled = 0;

  const print = (className: string, text: string) => {
    log.append(h('li', { class: className }, text));
    while (log.children.length > HISTORY * 2) {
      log.firstElementChild!.remove();
    }
    log.scrollTop = log.scrollHeight;
  };

  const command = () => {
    const { from, to } = commandRange(view.state.doc);
    return view.state.sliceDoc(from, to);
  };
  const setCommand = (text: string) => {
    const { from, to } = commandRange(view.state.doc);
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
  };

  /** The Page commands run on: the session's while browsing, else Edit's. */
  const page = () => {
    const project = shell.editor.project;
    const name = target.session()?.page.name;
    return project.pages.find(p => p.name === name) ?? shell.editor.page;
  };
  /** Refreshes the names and Host Manifest for the current Page. */
  const sync = () => {
    const project = shell.editor.project;
    const showing = page();
    server.configure(scriptManifest(project, showing));
    const { prefix, suffix } = messageParts();
    const doc = view.state.doc.toString();
    const text = command();
    if (doc !== prefix + text + suffix) {
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: prefix + text + suffix },
        selection: { anchor: prefix.length + text.length },
        annotations: rewrite.of(true),
      });
    }
    // Keep the cursor in the command, never in the hidden lines.
    const { from, to } = commandRange(view.state.doc);
    const { head } = view.state.selection.main;
    if (head < from || head > to) {
      view.dispatch({ selection: { anchor: to } });
    }
  };

  const run = async (text: string): Promise<MessageReply> => {
    const play = target.session();
    if (!play) {
      const reply = await runInEdit(shell.editor, text);
      shell.redraw();
      return reply;
    }
    const started = play.runMessage(text);
    if (!started.ok) {
      return { error: started.error };
    }
    target.ran();
    return started.result.then(
      value => ({
        text:
          value.kind === 'nothing'
            ? undefined
            : (value.asText() ?? String(value)),
      }),
      (error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const submit = () => {
    const text = command().trim();
    if (!text) {
      return true;
    }
    setCommand('');
    if (history.at(-1) !== text) {
      history.push(text);
      history.splice(0, history.length - HISTORY);
    }
    recalled = history.length;
    print('command', text);
    sync();
    void run(text).then(reply => {
      if (reply.error) {
        print('error', reply.error);
      } else if (reply.text !== undefined) {
        print('result', reply.text);
      }
      sync();
    });
    return true;
  };
  // Up and Down recall earlier commands while the command is one line.
  const recall = (step: number) => () => {
    if (command().includes('\n') || !history.length) {
      return false;
    }
    recalled = Math.max(0, Math.min(history.length, recalled + step));
    setCommand(history[recalled] ?? '');
    return true;
  };

  const view = codeEditor({
    parent,
    doc: (({ prefix, suffix }) => prefix + suffix)(messageParts()),
    uri: URI,
    lsp,
    extensions: [
      hiddenWrapper,
      protectWrapper,
      // Below completion, whose Enter and arrows win while it is open.
      Prec.high(
        keymap.of([
          { key: 'Enter', run: submit },
          { key: 'ArrowUp', run: recall(-1) },
          { key: 'ArrowDown', run: recall(1) },
        ]),
      ),
      EditorView.contentAttributes.of({
        'aria-label': 'NorthTalk command',
      }),
    ],
    hooks: {
      changed: text => lsp.change(URI, text),
      goTo() {},
      references(lines) {
        print('result', lines.join('\n'));
      },
    },
  });
  lsp.onDiagnostics = (uri, diagnostics) => {
    if (uri !== URI) {
      return;
    }
    // Only the command's own lines; the hidden Handler isn't the author's.
    const first = MESSAGE_FIRST_LINE - 1;
    const last = view.state.doc.lines - 2;
    view.dispatch(
      diagnosticsSpec(
        view.state,
        diagnostics.filter(
          d => d.range.start.line >= first && d.range.end.line <= last,
        ),
      ),
    );
  };

  let shown = false;
  setWindowOpener('message-window', () => {
    if (!shown) {
      shown = true;
      showCodeWindow(win);
      sync();
      lsp.open(URI, view.state.doc.toString());
    }
    win.node.hidden = false;
    sync();
    bringWindowForward(win.node);
    view.focus();
  });
  win.close.addEventListener('click', () => {
    win.node.hidden = true;
  });
  view.contentDOM.addEventListener('focus', sync);
  shell.onRedraw(() => {
    if (shown && !win.node.hidden) {
      sync();
    }
  });
};
