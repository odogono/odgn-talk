// One floating editor and LSP workspace per authored Script. Each workspace
// has its owner's Host Manifest, so unrelated Pages never leak names.
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import {
  diagnosticsSpec,
  northtalkEditor,
} from '@odgn/northtalk-editor/editor';
import { LspClient } from '@odgn/northtalk-editor/lsp-client';
import { h } from './dom';
import { openRecipePicker } from './recipe-picker';
import type { StackEditor } from './editing';
import {
  scriptManifest,
  scriptPage,
  type ScriptOwner,
} from './script-manifest';

export const bringWindowForward = (window: HTMLElement): void => {
  document
    .querySelectorAll('.window')
    .forEach(other => other.classList.toggle('front', other === window));
};

type OpenScript = {
  addAction: HTMLButtonElement;
  configure: string;
  editing: Compartment;
  lsp: LspClient;
  node: HTMLElement;
  owner: ScriptOwner;
  path: HTMLElement;
  recipes: HTMLElement;
  title: HTMLElement;
  uri: string;
  view: EditorView;
  worker: Worker;
};

export class ScriptWindows {
  #windows = new Map<number, OpenScript>();
  #generation: number;
  #syncing = false;

  constructor(
    readonly editor: StackEditor,
    readonly redraw: () => void,
  ) {
    this.#generation = editor.generation;
  }

  #owners(): Map<number, ScriptOwner> {
    const project = this.editor.project;
    return new Map(
      [project, ...project.pages.flatMap(page => [page, ...page.elements])].map(
        owner => [this.editor.identity(owner), owner],
      ),
    );
  }

  /** Windows belong to one Project; a replaced Project closes them all. */
  #dropStale(): void {
    if (this.#generation !== this.editor.generation) {
      for (const id of this.#windows.keys()) {
        this.close(id);
      }
      this.#generation = this.editor.generation;
    }
  }

  close(id: number): void {
    const win = this.#windows.get(id);
    if (!win) {
      return;
    }
    this.#windows.delete(id);
    win.lsp.close(win.uri);
    win.worker.terminate();
    win.view.destroy();
    win.node.remove();
  }

  #history(redo = false): boolean {
    if (redo) {
      this.editor.redo();
    } else {
      this.editor.undo();
    }
    this.redraw();
    return true;
  }

  open(owner: ScriptOwner, line?: number): void {
    this.#dropStale();
    const id = this.editor.identity(owner);
    const existing = this.#windows.get(id);
    if (existing) {
      bringWindowForward(existing.node);
      if (line === undefined) {
        existing.view.focus();
      } else {
        this.#goTo(existing.view, line);
      }
      return;
    }
    const uri = `creative:///script-${id}.talk`;
    const worker = new Worker('./lsp.worker.js', { type: 'module' });
    const lsp = new LspClient(worker);
    const title = h('span');
    const close = h('button', {
      type: 'button',
      class: 'close',
      'aria-label': 'Close Script',
    });
    const path = h('nav', {
      class: 'message-path',
      'aria-label': 'Message Path',
    });
    const parent = h('div', { class: 'script-editor' });
    const recipes = h('div');
    const addAction = h(
      'button',
      { type: 'button', class: 'add-action' },
      'Add action…',
    );
    addAction.addEventListener('click', () => {
      const current = this.#owners().get(id);
      if (current) {
        this.addAction(current);
      }
    });
    const problems = h(
      'div',
      { class: 'script-problems', role: 'status' },
      'Checking…',
    );
    const node = h(
      'section',
      {
        id: `script-window-${id}`,
        class: 'window script-window',
        'aria-label': 'Script',
        'data-left': 140 + this.#windows.size * 24,
        'data-top': 140 + this.#windows.size * 24,
      },
      h('div', { class: 'bar' }, close, title),
      path,
      addAction,
      recipes,
      parent,
      problems,
    );
    document.body.append(node);
    const editing = new Compartment();
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: owner.script ?? '',
        extensions: [
          lineNumbers(),
          editing.of(EditorState.readOnly.of(this.editor.readOnly)),
          ...northtalkEditor(
            uri,
            lsp,
            {
              changed: text => {
                if (this.#syncing || this.editor.readOnly) {
                  return;
                }
                const current = this.#owners().get(id);
                if (!current) {
                  return;
                }
                this.editor.edit(() => {
                  current.script = text;
                });
                lsp.change(uri, text);
                this.redraw();
              },
              goTo() {},
              references(lines) {
                problems.textContent = lines.join('\n');
              },
            },
            [
              { key: 'Mod-z', run: () => this.#history() },
              { key: 'Mod-Shift-z', run: () => this.#history(true) },
              { key: 'Mod-y', run: () => this.#history(true) },
            ],
          ),
        ],
      }),
    });
    lsp.onDiagnostics = (target, diagnostics) => {
      if (target !== uri || !this.#windows.has(id)) {
        return;
      }
      view.dispatch(diagnosticsSpec(view.state, diagnostics));
      problems.classList.toggle(
        'bad',
        diagnostics.some(d => d.severity === 1),
      );
      problems.textContent = diagnostics.length
        ? diagnostics
            .map(d => `Line ${d.range.start.line + 1}: ${d.message}`)
            .join('\n')
        : '✓ No problems';
    };
    this.#windows.set(id, {
      configure: '',
      owner,
      recipes,
      addAction,
      editing,
      lsp,
      node,
      path,
      title,
      uri,
      view,
      worker,
    });
    close.addEventListener('click', () => this.close(id));
    this.sync();
    lsp.open(uri, owner.script ?? '');
    node.dispatchEvent(new Event('script-window-opened', { bubbles: true }));
    this.#goTo(view, line ?? 1);
  }

  addAction(owner: ScriptOwner): void {
    if (this.editor.readOnly) {
      return;
    }
    this.open(owner);
    const win = this.#windows.get(this.editor.identity(owner))!;
    openRecipePicker(
      win.recipes,
      win.view,
      this.editor.project,
      owner,
      () => this.editor.readOnly,
    );
  }

  #goTo(view: EditorView, line: number): void {
    const pos = view.state.doc.line(
      Math.max(1, Math.min(line, view.state.doc.lines)),
    ).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos),
    });
    view.focus();
  }

  /** Reconcile after edits, history, read-only changes and Project replacement. */
  sync(): void {
    this.#dropStale();
    const all = this.#owners();
    this.#syncing = true;
    try {
      for (const [id, win] of this.#windows) {
        const owner = all.get(id);
        if (!owner) {
          this.close(id);
          continue;
        }
        if (owner !== win.owner) {
          win.recipes.replaceChildren();
          win.owner = owner;
        }
        win.addAction.disabled = this.editor.readOnly;
        if (this.editor.readOnly) {
          win.recipes.replaceChildren();
        }
        const project = this.editor.project;
        const page = scriptPage(project, owner);
        const owners =
          owner === project
            ? [project]
            : owner === page
              ? [page!, project]
              : [owner, page!, project];
        const kind = ['Project', 'Page', 'Element'][owners.length - 1];
        const label = `Script of ${kind} “${owner.name}”`;
        win.title.textContent = label;
        win.node.setAttribute('aria-label', label);
        win.path.replaceChildren();
        for (const [index, step] of owners.entries()) {
          if (index) {
            win.path.append(' → ');
          }
          const button = h(
            'button',
            {
              type: 'button',
              'aria-current': step === owner ? 'true' : undefined,
            },
            step.name,
          );
          button.addEventListener('click', () => this.open(step));
          win.path.append(button);
        }
        const manifest = scriptManifest(project, owner);
        const configure = JSON.stringify(manifest);
        if (configure !== win.configure) {
          win.recipes.replaceChildren();
          win.configure = configure;
          win.lsp.configure({ manifest });
        }
        if (win.view.state.readOnly !== this.editor.readOnly) {
          win.view.dispatch({
            effects: win.editing.reconfigure(
              EditorState.readOnly.of(this.editor.readOnly),
            ),
          });
        }
        const text = owner.script ?? '';
        if (text !== win.view.state.doc.toString()) {
          win.view.dispatch({
            changes: { from: 0, to: win.view.state.doc.length, insert: text },
          });
          win.lsp.change(win.uri, text);
        }
      }
    } finally {
      this.#syncing = false;
    }
  }
}
