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
import { diagnosticsSpec } from '@northtalk/editor/editor';
import {
  codeEditor,
  codeWindow,
  languageServer,
  showCodeWindow,
} from './code-window';
import { copySource } from './copy-source';
import { h } from './dom';
import {
  MESSAGE_FIRST_LINE,
  messageParts,
  messageHandler,
  type LoadedMessageTarget,
} from './message-script';
import { runInEdit, sessionCommand, type MessageReply } from './message';
import { sourceOf, type VariableValue } from './variables';
import { renderValueRows } from './variables-window';
import {
  ownerId,
  scriptManifest,
  scriptOwners,
  scriptPage,
} from './script-manifest';
import { bringWindowForward, setWindowOpener } from './windows';
import { type StackShell } from './stack';

export type MessageTarget = {
  /**
   * Hears an `:inspect` result; `select` selects an Element it names, which
   * `session` places (undefined for Edit).
   */
  inspected(
    text: string,
    value: VariableValue,
    context: string,
    session: number | undefined,
  ): (owner: number) => void;
  /** The playing session's Page name, if any; commands run there when it is. */
  pageName(): string | undefined;
  run(text: string, session: number, target?: number): Promise<MessageReply>;
  scripts(): LoadedMessageTarget[];
  /** Runs a command in the playing session, which may take a while to answer. */
  session(): number | undefined;
};

const HISTORY = 50;
const URI = 'creative:///message-box.talk';

/** The command's span: the lines between the hidden prefix and suffix. */
const commandRange = (doc: Text, first = MESSAGE_FIRST_LINE) =>
  doc.lines > first
    ? {
        from: doc.line(first).from,
        to: doc.line(doc.lines).from - 1,
      }
    : { from: 0, to: doc.length };

// Marks the Message Box's own rewrites of the hidden lines.
const rewrite = Annotation.define<number>();
const firstLine = StateField.define<number>({
  create: () => MESSAGE_FIRST_LINE,
  update: (value, tr) => tr.annotation(rewrite) ?? value,
});

const hide = (state: EditorState) => {
  const doc = state.doc;
  const { from, to } = commandRange(doc, state.field(firstLine));
  const hidden = Decoration.replace({});
  return Decoration.set([
    ...(from > 0 ? [hidden.range(0, from)] : []),
    ...(to < doc.length ? [hidden.range(to, doc.length)] : []),
  ]);
};

const hiddenWrapper = StateField.define({
  create: state => hide(state),
  update: (value, tr) => (tr.docChanged ? hide(tr.state) : value),
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
  const { from, to } = commandRange(
    tr.startState.doc,
    tr.startState.field(firstLine),
  );
  return [0, from, to, tr.startState.doc.length];
});

export const mountMessageWindow = (
  shell: StackShell,
  target: MessageTarget,
): (() => void) => {
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
  const selector = h('select', { 'aria-label': 'Message Box context' });
  const submitButton = h('button', { type: 'button' }, 'Run');
  const status = h('span', { role: 'status' });
  win.node.append(
    h('div', { class: 'message-context' }, selector, submitButton, status),
    log,
    parent,
  );
  const server = languageServer();
  const { lsp } = server;
  type Context = { id?: number; label: string; session: number | undefined };
  const history: { context: Context; text: string }[] = [];
  let selected: Context | undefined;
  let generation = shell.editor.generation;
  let recalled = 0;
  let choicesKey = '';
  let availableScripts: LoadedMessageTarget[] = [];

  const print = (className: string, text: string) => {
    log.append(h('li', { class: className }, text));
    while (log.children.length > HISTORY * 2) {
      log.firstElementChild!.remove();
    }
    log.scrollTop = log.scrollHeight;
    return log.lastElementChild!;
  };

  const command = () => {
    const { from, to } = commandRange(
      view.state.doc,
      view.state.field(firstLine),
    );
    return view.state.sliceDoc(from, to);
  };
  const setCommand = (text: string) => {
    const { from, to } = commandRange(
      view.state.doc,
      view.state.field(firstLine),
    );
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
  };

  /** The Page commands run on: the session's while browsing, else Edit's. */
  const page = () => {
    const project = shell.editor.project;
    const name = target.pageName();
    return project.pages.find(p => p.name === name) ?? shell.editor.page;
  };
  /** Refreshes the names and Host Manifest for the current Page. */
  const sync = () => {
    if (generation !== shell.editor.generation) {
      generation = shell.editor.generation;
      history.length = 0;
      recalled = 0;
      selected = undefined;
      log.replaceChildren();
      setCommand('');
    }
    const project = shell.editor.project;
    const showing = page();
    const session = target.session();
    const scripts =
      session === undefined
        ? scriptOwners(project)
            .filter(
              owner =>
                owner.script?.trim() &&
                (owner === project || scriptPage(project, owner) === showing),
            )
            .map(owner => ({
              id: ownerId(owner),
              label:
                owner === project
                  ? 'project'
                  : owner === showing
                    ? `page:${showing.name}`
                    : `element:${showing.name}/${owner.name}`,
              source: owner.script!,
              manifest: scriptManifest(project, owner),
            }))
        : target.scripts();
    availableScripts = scripts;
    const loaded =
      selected?.session === session && selected?.id !== undefined
        ? scripts.find(script => script.id === selected!.id)
        : undefined;
    const available =
      !selected ||
      (selected.session === session &&
        (selected.id === undefined || loaded !== undefined));
    const nextChoicesKey = JSON.stringify([
      session,
      scripts.map(script => [script.id, script.label]),
      selected,
      available,
    ]);
    if (nextChoicesKey !== choicesKey) {
      choicesKey = nextChoicesKey;
      selector.replaceChildren(
        h('option', { value: 'default' }, 'Default context'),
      );
      for (const script of scripts) {
        selector.append(
          h('option', { value: String(script.id) }, script.label),
        );
      }
      if (selected && !available) {
        selector.append(
          h(
            'option',
            { value: 'unavailable' },
            `${selected.label} (unavailable)`,
          ),
        );
      }
    }
    selector.value = !available
      ? 'unavailable'
      : selected?.id === undefined
        ? 'default'
        : String(selected.id);
    submitButton.disabled = !available;
    view.contentDOM.setAttribute('aria-disabled', String(!available));
    status.textContent = available ? '' : 'Choose a context to run.';
    server.configure(loaded?.manifest ?? scriptManifest(project, showing));
    const handler = loaded
      ? messageHandler(loaded.source + JSON.stringify(loaded.manifest.objects))
      : undefined;
    const { prefix, suffix } = loaded
      ? {
          prefix: `${loaded.source}\non ${handler}\n`,
          suffix: `\nend ${handler}`,
        }
      : messageParts();
    const doc = view.state.doc.toString();
    const text = command();
    if (doc !== prefix + text + suffix) {
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: prefix + text + suffix },
        selection: { anchor: prefix.length + text.length },
        annotations: rewrite.of(prefix.split('\n').length),
      });
    }
    // Keep the cursor in the command, never in the hidden lines.
    const { from, to } = commandRange(
      view.state.doc,
      view.state.field(firstLine),
    );
    const { head } = view.state.selection.main;
    if (head < from || head > to) {
      view.dispatch({ selection: { anchor: to } });
    }
  };

  const run = async (text: string, context: Context): Promise<MessageReply> => {
    const named = sessionCommand(
      text,
      availableScripts.find(script => script.id === context.id)?.source ?? '',
      shell.editor.project.libraries,
    );
    if (named) {
      return named;
    }
    if (context.session === undefined) {
      const reply = await runInEdit(shell.editor, text, context.id);
      shell.redraw();
      return reply;
    }
    return target.run(text, context.session, context.id);
  };

  const submit = () => {
    sync();
    const text = command().trim();
    if (!text || submitButton.disabled) {
      return true;
    }
    const context = selected ?? {
      session: target.session(),
      label: 'Default context',
    };
    setCommand('');
    const last = history.at(-1);
    if (
      !last ||
      last.text !== text ||
      last.context.session !== context.session ||
      last.context.id !== context.id
    ) {
      history.push({ text, context });
      history.splice(0, Math.max(0, history.length - HISTORY));
    }
    recalled = history.length;
    const where = `${context.label} · ${context.session === undefined ? 'Edit' : `Play ${context.session}`}`;
    const row = print('entry', '');
    row.append(
      h('div', { class: 'context' }, where),
      h('div', { class: 'command' }, text),
    );
    void run(text, context)
      .catch((error: unknown): MessageReply => ({
        error: error instanceof Error ? error.message : String(error),
      }))
      .then(reply => {
        if (reply.error) {
          row.append(h('div', { class: 'error' }, reply.error));
        } else if (reply.value !== undefined) {
          const expression = text.replace(/^:inspect\s*/u, '');
          const select = target.inspected(
            expression,
            reply.value,
            where,
            context.session,
          );
          const rows = h('div', { class: 'result variables-script' });
          row.append(rows);
          renderValueRows(rows, expression, reply.value, select);
        } else if (reply.text !== undefined) {
          row.append(h('div', { class: 'result' }, reply.text));
        }
        if (!reply.error && (reply.value ?? reply.text) !== undefined) {
          const source =
            reply.value === undefined ? reply.source : sourceOf(reply.value);
          // Only the last result copies as source.
          for (const old of log.querySelectorAll('.copy')) {
            old.remove();
          }
          const copy = h(
            'button',
            {
              'aria-label': 'Copy the result as source',
              class: 'copy',
              title: 'Copy as source',
              type: 'button',
            },
            '⧉',
          );
          copy.addEventListener('click', () => {
            void copySource(source).then(said => {
              copy.title = said;
              copy.textContent = source === undefined ? 'no source form' : '✓';
              setTimeout(() => {
                copy.title = 'Copy as source';
                copy.textContent = '⧉';
              }, 2000);
            });
          });
          row.prepend(copy);
        }
        sync();
      });
    return true;
  };
  submitButton.addEventListener('click', submit);
  selector.addEventListener('change', () => {
    if (selector.value === 'unavailable') {
      return;
    }
    const script = availableScripts.find(
      script => String(script.id) === selector.value,
    );
    selected = script
      ? { session: target.session(), id: script.id, label: script.label }
      : undefined;
    sync();
    view.focus();
  });
  // Up and Down recall earlier commands while the command is one line.
  const recall = (step: number) => () => {
    if (command().includes('\n') || !history.length) {
      return false;
    }
    recalled = Math.max(0, Math.min(history.length, recalled + step));
    const entry = history[recalled];
    if (entry) {
      selected = entry.context;
    }
    sync();
    setCommand(entry?.text ?? '');
    return true;
  };

  const view = codeEditor({
    parent,
    doc: (({ prefix, suffix }) => prefix + suffix)(messageParts()),
    uri: URI,
    lsp,
    extensions: [
      firstLine,
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
    // A Session Command isn't NorthTalk, so it has no diagnostics.
    if (/^:(?:describe|apropos)\b/u.test(command().trimStart())) {
      diagnostics = [];
    }
    // Only the command's own lines; the hidden Handler isn't the author's.
    const first = view.state.field(firstLine) - 1;
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
    sync();
  });
  return sync;
};
