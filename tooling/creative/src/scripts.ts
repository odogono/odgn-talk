// One Code Browser for the Project's Scripts and Libraries. Source selection
// never navigates the canvas; each source retains its own editor state.
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { diagnosticsSpec, northtalkEditor } from '@northtalk/editor/editor';
import { clickAdvice } from './click-advice';
import { readDictionary } from '@northtalk/tooling/dictionary';
import { libraryUri, operationAt, readManifest } from '@northtalk/tooling/lsp';
import {
  codeWindow,
  languageServer,
  showCodeWindow,
  type LanguageServer,
} from './code-window';
import {
  renderCodeOutline,
  sourceKey,
  type CodeSelection,
  type NamedSource,
  type TestRun,
} from './code-browser-panel';
import { showContextMenu } from './context-menu';
import { DictionaryWindow } from './dictionary-window';
import { h } from './dom';
import type { StackEditor } from './editing';
import { freshName } from './model';
import { closeRecipePicker, openRecipePicker } from './recipe-picker';
import {
  ownerById,
  ownerId,
  scriptManifest,
  scriptHandlers,
  scriptPage,
  testScriptManifest,
  type ScriptOwner,
} from './script-manifest';
import { runProjectTests } from './test-runner';
import { containingGroups } from './tree/rules';
import { bringWindowForward, setWindowOpener } from './windows';

// A new Test Script's source: one Test Handler to start from.
const NEW_TEST_SCRIPT = `use assert, assertEqual from test

on testSomething
  ask harness to frame 16 ms and wait
  assert(true, "describe what should be true")
end testSomething
`;

type SavedEditor = {
  scroll: ReturnType<EditorView['scrollSnapshot']>;
  state: EditorState;
};
type BrowserWindow = {
  addAction: HTMLButtonElement;
  node: HTMLElement;
  outline: HTMLElement;
  path: HTMLElement;
  problems: HTMLElement;
  recipes: HTMLElement;
  server: LanguageServer;
  sourceTitle: HTMLElement;
  view: EditorView;
};

export class CodeBrowser {
  #window: BrowserWindow | undefined;
  #generation: number;
  #selected: CodeSelection = { kind: 'script', id: 0 };
  #states = new Map<string, SavedEditor>();
  #editing = new Compartment();
  #syncing = false;
  #tests: TestRun;
  readonly dictionary = new DictionaryWindow();

  constructor(
    readonly editor: StackEditor,
    readonly redraw: () => void,
  ) {
    this.#generation = editor.generation;
    setWindowOpener('code-browser', () => this.#show(this.#selected));
  }

  #uri(source = this.#selected): string {
    return `creative:///${source.kind}-${source.id}.talk`;
  }
  #library() {
    return this.#selected.kind === 'library'
      ? this.editor.project.libraries.find(l => l.id === this.#selected.id)
      : undefined;
  }
  #testScript() {
    return this.#selected.kind === 'test'
      ? this.editor.project.testScripts.find(t => t.id === this.#selected.id)
      : undefined;
  }
  #named(): NamedSource | undefined {
    const library = this.#library();
    if (library) {
      return { kind: 'library', source: library };
    }
    const test = this.#testScript();
    return test ? { kind: 'test', source: test } : undefined;
  }
  #owner() {
    return this.#selected.kind === 'script'
      ? ownerById(this.editor.project, this.#selected.id)
      : undefined;
  }
  #text(): string {
    return this.#named()?.source.source ?? this.#owner()?.script ?? '';
  }

  // The selected source's Manifest, which completion and the Dictionary read.
  #manifest() {
    const project = this.editor.project;
    const named = this.#named();
    return named?.kind === 'library'
      ? { ...scriptManifest(project, project), objects: [], messages: [] }
      : named?.kind === 'test'
        ? testScriptManifest(project)
        : scriptManifest(project, this.#owner() ?? project);
  }
  #label(): string {
    const project = this.editor.project;
    const named = this.#named();
    const owner = this.#owner() ?? project;
    return named
      ? `${named.kind === 'library' ? 'Library' : 'Test Script'} “${named.source.name}”`
      : `Script of ${owner === project ? 'Project' : 'elements' in owner ? 'Page' : 'Element'} “${owner.name}”`;
  }

  // Right-clicking a Grant or Operation call offers its Dictionary entry;
  // anywhere else keeps the browser's own menu.
  #contextMenu(view: EditorView, event: MouseEvent): void {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) {
      return;
    }
    const target = operationAt(
      view.state.doc.toString(),
      pos,
      readManifest(this.#manifest()),
    );
    if (!target) {
      return;
    }
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, [
      {
        label: `Show ${target.operation ? `${target.grant} ${target.operation}` : target.grant} in Dictionary`,
        run: () => this.dictionary.open(target),
      },
    ]);
  }

  #state(server: LanguageServer): EditorState {
    return EditorState.create({
      doc: this.#text(),
      extensions: [
        lineNumbers(),
        this.#editing.of(EditorState.readOnly.of(this.editor.readOnly)),
        northtalkEditor(
          this.#uri(),
          server.lsp,
          {
            changed: text => {
              if (this.#syncing || this.editor.readOnly) {
                return;
              }
              const source = this.#selected;
              this.editor.edit(({ project, tree }) => {
                if (source.kind === 'library') {
                  tree.setLibrarySource(source.id, text);
                } else if (source.kind === 'test') {
                  tree.setTestScriptSource(source.id, text);
                } else {
                  const owner = ownerById(project, source.id);
                  if (owner) {
                    tree.setScript(owner, text);
                  }
                }
              });
              this.redraw();
              server.lsp.change(this.#uri(source), text);
            },
            goTo: (uri, line) => {
              const library = this.editor.project.libraries.find(
                l =>
                  uri === libraryUri(l.name) ||
                  uri === this.#uri({ kind: 'library', id: l.id! }),
              );
              if (library) {
                this.openLibrary(library.id!, line + 1);
              }
            },
            references: lines => {
              if (this.#window) {
                this.#window.problems.textContent = lines.join('\n');
              }
            },
          },
          [
            { key: 'Mod-z', run: () => this.#history() },
            { key: 'Mod-Shift-z', run: () => this.#history(true) },
            { key: 'Mod-y', run: () => this.#history(true) },
          ],
        ),
      ],
    });
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

  #mount(): BrowserWindow {
    const win = codeWindow({
      id: 'code-browser',
      className: 'script-window code-browser',
      closeLabel: 'Close Code Browser',
      label: 'Code Browser',
      left: 140,
      top: 140,
    });
    const outline = h('div', { class: 'code-browser-columns' });
    const body = h('div', { class: 'code-browser-body' });
    // The columns show which Script is open; the title is for screen readers.
    const sourceTitle = h('h2', { class: 'code-source-title visually-hidden' });
    const path = h('nav', {
      class: 'message-path',
      'aria-label': 'Message Path',
    });
    const recipes = h('div');
    const addAction = h(
      'button',
      { type: 'button', class: 'add-action' },
      'Add action…',
    );
    const showDictionary = h(
      'button',
      { type: 'button', class: 'show-dictionary' },
      'Dictionary',
    );
    showDictionary.addEventListener('click', () => this.dictionary.open());
    addAction.addEventListener('click', () => {
      const owner = this.#owner();
      if (owner) {
        this.addAction(owner);
      }
    });
    const problems = h(
      'div',
      { class: 'script-problems', role: 'status' },
      'Checking…',
    );
    const parent = h('div', { class: 'code-editor script-editor' });
    body.append(
      sourceTitle,
      h(
        'div',
        { class: 'code-toolbar' },
        path,
        h('span', { class: 'spacer' }),
        addAction,
        showDictionary,
      ),
      recipes,
      parent,
      problems,
    );
    win.node.append(h('div', { class: 'code-browser-content' }, outline, body));
    parent.addEventListener('contextmenu', event =>
      this.#contextMenu(view, event),
    );
    const server = languageServer();
    const view = new EditorView({ parent, state: this.#state(server) });
    const browser = {
      ...win,
      outline,
      sourceTitle,
      path,
      addAction,
      recipes,
      problems,
      server,
      view,
    };
    this.#window = browser;
    server.lsp.onDiagnostics = (uri, found) => {
      if (uri !== this.#uri()) {
        return;
      }
      const diagnostics = [...found, ...clickAdvice(view.state.doc.toString())];
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
    win.close.addEventListener('click', () => {
      closeRecipePicker(recipes);
      win.node.hidden = true;
    });
    showCodeWindow(win);
    this.sync();
    server.lsp.open(this.#uri(), this.#text());
    return browser;
  }

  open(owner: ScriptOwner, line?: number): void {
    this.#show({ kind: 'script', id: ownerId(owner) }, line);
  }
  openLibrary(id: number, line?: number): void {
    this.#show({ kind: 'library', id }, line);
  }
  openTestScript(id: number, line?: number): void {
    this.#show({ kind: 'test', id }, line);
  }

  // Runs every Test Script against the Project as it is now.
  async #runTests(): Promise<void> {
    if (this.#tests === 'running') {
      return;
    }
    this.#tests = 'running';
    this.sync();
    try {
      this.#tests = { results: await runProjectTests(this.editor.project) };
    } finally {
      if (this.#tests === 'running') {
        this.#tests = undefined;
      }
      this.sync();
    }
  }

  #show(source: CodeSelection, line?: number): void {
    this.sync();
    if (
      source.kind === 'script'
        ? !ownerById(this.editor.project, source.id)
        : !(
            source.kind === 'library'
              ? this.editor.project.libraries
              : this.editor.project.testScripts
          ).some(l => l.id === source.id)
    ) {
      return;
    }
    const existing = this.#window;
    if (!existing) {
      this.#selected = source;
    }
    const win = existing ?? this.#mount();
    if (sourceKey(source) !== sourceKey(this.#selected)) {
      closeRecipePicker(win.recipes);
      this.#states.set(sourceKey(this.#selected), {
        state: win.view.state,
        scroll: win.view.scrollSnapshot(),
      });
      win.server.lsp.close(this.#uri());
      this.#selected = source;
      const saved = this.#states.get(sourceKey(source));
      win.view.setState(saved?.state ?? this.#state(win.server));
      if (saved && line === undefined) {
        win.view.dispatch({ effects: saved.scroll });
      }
      this.sync();
      win.server.lsp.open(this.#uri(), this.#text());
    }
    win.node.hidden = false;
    bringWindowForward(win.node);
    if (line !== undefined) {
      const pos = win.view.state.doc.line(
        Math.max(1, Math.min(line, win.view.state.doc.lines)),
      ).from;
      win.view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos),
      });
    }
    win.view.focus();
  }

  addAction(owner: ScriptOwner): void {
    if (this.editor.readOnly) {
      return;
    }
    this.open(owner);
    const win = this.#window!;
    openRecipePicker(
      win.recipes,
      win.view,
      this.editor.project,
      this.#owner()!,
      () => this.editor.readOnly,
    );
  }

  sync(): void {
    if (this.#generation !== this.editor.generation) {
      const win = this.#window;
      if (win) {
        closeRecipePicker(win.recipes);
        win.server.dispose();
        win.view.destroy();
        win.node.remove();
      }
      this.#window = undefined;
      this.#states.clear();
      this.#selected = { kind: 'script', id: 0 };
      this.#tests = undefined;
      this.#generation = this.editor.generation;
    }
    if (!this.#syncing) {
      this.dictionary.update(readDictionary(this.#manifest()), this.#label());
    }
    const win = this.#window;
    if (!win || this.#syncing) {
      return;
    }
    if (!this.#owner() && !this.#named()) {
      win.server.lsp.close(this.#uri());
      closeRecipePicker(win.recipes);
      this.#selected = { kind: 'script', id: 0 };
      win.view.setState(this.#state(win.server));
      win.server.lsp.open(this.#uri(), this.#text());
    }
    this.#syncing = true;
    try {
      const project = this.editor.project;
      const owner = this.#owner();
      const named = this.#named();
      win.server.configure(
        this.#manifest(),
        project.libraries.map(l => ({
          uri: this.#uri({ kind: 'library', id: l.id! }),
          text: l.source,
          library: l.name,
        })),
      );
      renderCodeOutline(win.outline, {
        project,
        handlers: scriptHandlers(this.#text()),
        onOpenLine: line => this.#show(this.#selected, line),
        ...(named ? { named } : {}),
        selected: this.#selected,
        readOnly: this.editor.readOnly,
        tests: this.#tests,
        onSelect: source => this.#show(source),
        onRunTests: () => void this.#runTests(),
        onOpenResult: result =>
          this.openTestScript(result.script.id!, result.at.line),
        onNew: kind => {
          let id = 0;
          this.editor.edit(({ tree }) => {
            id =
              kind === 'library'
                ? tree.addLibrary(
                    freshName(
                      'library1',
                      new Set(project.libraries.map(l => l.name)),
                    ),
                  ).id!
                : tree.addTestScript(
                    `${freshName(
                      'tests1',
                      new Set(
                        project.testScripts.map(t => t.name.slice(0, -5)),
                      ),
                    )}.test`,
                    NEW_TEST_SCRIPT,
                  ).id!;
          });
          this.redraw();
          this.#show({ kind: kind === 'library' ? 'library' : 'test', id });
        },
        onRename: name => {
          if (!named || this.editor.readOnly) {
            return undefined;
          }
          try {
            this.editor.edit(({ tree }) =>
              named.kind === 'library'
                ? tree.renameLibrary(named.source.id!, name)
                : tree.renameTestScript(named.source.id!, name),
            );
            this.redraw();
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
        onDelete: () => {
          if (named && !this.editor.readOnly) {
            this.editor.edit(({ tree }) =>
              named.kind === 'library'
                ? tree.removeLibrary(named.source.id!)
                : tree.removeTestScript(named.source.id!),
            );
            this.redraw();
          }
        },
      });
      win.sourceTitle.textContent = this.#label();
      win.addAction.hidden = !owner;
      win.addAction.disabled = this.editor.readOnly;
      win.path.hidden = !owner;
      win.path.replaceChildren();
      if (owner) {
        const page = scriptPage(project, owner);
        const path =
          owner === project
            ? [project]
            : owner === page
              ? [page!, project]
              : [
                  owner,
                  ...containingGroups(page!.elements, owner.name),
                  page!,
                  project,
                ];
        path.forEach((step, index) => {
          if (index) {
            win.path.append(h('span', { 'aria-hidden': 'true' }, '→'));
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
        });
      }
      if (this.editor.readOnly || !owner) {
        closeRecipePicker(win.recipes);
      }
      if (win.view.state.readOnly !== this.editor.readOnly) {
        win.view.dispatch({
          effects: this.#editing.reconfigure(
            EditorState.readOnly.of(this.editor.readOnly),
          ),
        });
      }
      const text = this.#text();
      if (text !== win.view.state.doc.toString()) {
        win.view.dispatch({
          changes: { from: 0, to: win.view.state.doc.length, insert: text },
        });
        win.server.lsp.change(this.#uri(), text);
      }
    } finally {
      this.#syncing = false;
    }
  }
}
