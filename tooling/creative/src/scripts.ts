// One floating editor and LSP workspace per authored Script. Each workspace
// has its owner's Host Manifest, so unrelated Pages never leak names.
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { diagnosticsSpec } from '@northtalk/editor/editor';
import {
  codeEditor,
  codeWindow,
  languageServer,
  showCodeWindow,
  type LanguageServer,
} from './code-window';
import { h } from './dom';
import { bringWindowForward } from './windows';
import { closeRecipePicker, openRecipePicker } from './recipe-picker';
import type { StackEditor } from './editing';
import {
  ownerById,
  ownerId,
  scriptManifest,
  scriptOwners,
  scriptPage,
  type ScriptOwner,
} from './script-manifest';

type OpenScript = {
  addAction: HTMLButtonElement;
  editing: Compartment;
  manifest: string;
  node: HTMLElement;
  owner: ScriptOwner;
  path: HTMLElement;
  recipes: HTMLElement;
  server: LanguageServer;
  title: HTMLElement;
  uri: string;
  view: EditorView;
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
    return new Map(
      scriptOwners(this.editor.project).map(owner => [ownerId(owner), owner]),
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
    closeRecipePicker(win.recipes);
    win.server.lsp.close(win.uri);
    win.server.dispose();
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
    const id = ownerId(owner);
    const current = this.#owners().get(id);
    if (!current) {
      return;
    }
    owner = current;
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
    const server = languageServer();
    const { lsp } = server;
    const { node, title, close } = codeWindow({
      id: `script-window-${id}`,
      className: 'script-window',
      closeLabel: 'Close Script',
      label: 'Script',
      left: 140 + this.#windows.size * 24,
      top: 140 + this.#windows.size * 24,
    });
    const path = h('nav', {
      class: 'message-path',
      'aria-label': 'Message Path',
    });
    const parent = h('div', { class: 'code-editor script-editor' });
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
    node.append(path, addAction, recipes, parent, problems);
    const editing = new Compartment();
    const view = codeEditor({
      parent,
      doc: owner.script ?? '',
      uri,
      lsp,
      extensions: [
        lineNumbers(),
        editing.of(EditorState.readOnly.of(this.editor.readOnly)),
      ],
      hooks: {
        changed: text => {
          if (this.#syncing || this.editor.readOnly) {
            return;
          }
          const current = this.#owners().get(id);
          if (!current) {
            return;
          }
          this.editor.edit(({ project }) => {
            const owner = ownerById(project, id);
            if (owner) {
              owner.script = text;
            }
          });
          // Redraw first: it sends the Manifest with any new Handlers, so
          // the diagnostics for this text already know them.
          this.redraw();
          lsp.change(uri, text);
        },
        goTo() {},
        references(lines) {
          problems.textContent = lines.join('\n');
        },
      },
      bindings: [
        { key: 'Mod-z', run: () => this.#history() },
        { key: 'Mod-Shift-z', run: () => this.#history(true) },
        { key: 'Mod-y', run: () => this.#history(true) },
      ],
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
      manifest: '',
      owner,
      recipes,
      addAction,
      editing,
      server,
      node,
      path,
      title,
      uri,
      view,
    });
    close.addEventListener('click', () => this.close(id));
    showCodeWindow({ node, title, close });
    this.sync();
    lsp.open(uri, owner.script ?? '');
    this.#goTo(view, line ?? 1);
  }

  addAction(owner: ScriptOwner): void {
    if (this.editor.readOnly) {
      return;
    }
    this.open(owner);
    const win = this.#windows.get(ownerId(owner))!;
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
        if (owner.name !== win.owner.name) {
          closeRecipePicker(win.recipes);
        }
        win.owner = owner;
        win.addAction.disabled = this.editor.readOnly;
        if (this.editor.readOnly) {
          closeRecipePicker(win.recipes);
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
        if (configure !== win.manifest) {
          closeRecipePicker(win.recipes);
          win.manifest = configure;
          win.server.configure(manifest);
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
          win.server.lsp.change(win.uri, text);
        }
      }
    } finally {
      this.#syncing = false;
    }
  }
}
