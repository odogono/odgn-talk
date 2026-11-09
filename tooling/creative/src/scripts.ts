// One Code Browser for the Project's Scripts and Libraries. Source selection
// never navigates the canvas; each source retains its own editor state.
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import {
  breakpointGutter,
  breakpointLines,
  markVerified,
  pausedAt,
} from '@northtalk/editor/breakpoints';
import { diagnosticsSpec, northtalkEditor } from '@northtalk/editor/editor';
import { clickAdvice } from './click-advice';
import {
  patternDiagnostics,
  patternTexts,
  projectPatternNames,
} from './pattern-checks';
import { musicSoundIn } from './sounds';
import { readDictionary } from '@northtalk/tooling/dictionary';
import {
  libraryUri,
  operationAt,
  readManifest,
  type LspDiagnostic,
} from '@northtalk/tooling/lsp';
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
import { LiteralEditorWindows } from './literal-editor-windows';
import { literalAt, literalEditorsFor } from './literal-editors';
import { literalGutter } from './literal-gutter';
import {
  highlightOn,
  lightFor,
  patternRanges,
  playingHighlight,
  setHighlightOn,
  unlightAll,
} from './playing-highlight';

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
/** A Script's or Library's Breakpoints, with the text they are set in. */
export type SourceBreakpoints = {
  lines: number[];
  source: CodeSelection;
  text: string;
};
/** Each Script's or Library's source as the Play Session loaded it. */
export type LoadedSource = (source: CodeSelection) => string | undefined;

// The selection a `sourceKey` was made from.
const selectionOf = (key: string): CodeSelection => {
  const [kind, id] = key.split(':');
  return { kind: kind as CodeSelection['kind'], id: Number(id) };
};

// Marks a source's Breakpoints as placed, unless it was edited since the
// session loaded it; with no session, all are.
const verifiedLines = (
  loaded: LoadedSource | undefined,
  source: CodeSelection,
  state: EditorState,
) =>
  markVerified(
    !loaded || loaded(source) === state.doc.toString()
      ? breakpointLines(state)
      : [],
  );

type BrowserWindow = {
  addAction: HTMLButtonElement;
  node: HTMLElement;
  outline: HTMLElement;
  path: HTMLElement;
  problems: HTMLElement;
  punchNote: HTMLElement;
  recipes: HTMLElement;
  server: LanguageServer;
  sourceTitle: HTMLElement;
  stoppedNote: HTMLElement;
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
  // Breakpoints (ADR 0147): the session's loaded sources while browsing,
  // and who to tell when a Breakpoint is toggled.
  #loaded: LoadedSource | undefined;
  #stopped: { line: number; source: CodeSelection } | undefined;
  #breakpointsChanged = () => {};
  // Punch In (ADR 0157): who loads the shown source into a browsing
  // session; it answers false when no session is browsing.
  #punchIn: (source: CodeSelection, text: string) => boolean = () => false;
  // Who copies a Music sound into the Project, for the missing-sound quick
  // fix (#1963), and the shown source's last language-server diagnostics.
  #addMusicSound: (key: string) => Promise<void> = async () => {};
  #soundsShown = '';
  #found: { diagnostics: readonly LspDiagnostic[]; uri: string } | undefined;
  readonly dictionary = new DictionaryWindow();
  // Literal Editor windows (ADR 0175), each pinned to one literal.
  readonly literals = new LiteralEditorWindows({
    read: source => this.#textOf(source),
    write: (source, text) => this.#write(source, text),
  });

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
  #textOf(source: CodeSelection): string | undefined {
    const project = this.editor.project;
    return source.kind === 'library'
      ? project.libraries.find(l => l.id === source.id)?.source
      : source.kind === 'test'
        ? project.testScripts.find(t => t.id === source.id)?.source
        : ownerById(project, source.id)?.script;
  }

  // A Literal Editor's edit: through the shown editor when it shows the
  // source, so undo and the language server see it, else to the Project.
  #write(source: CodeSelection, text: string): void {
    const view = this.#window?.view;
    const shown = this.#selected;
    if (this.editor.readOnly) {
      return;
    }
    if (view && shown.kind === source.kind && shown.id === source.id) {
      const doc = view.state.doc.toString();
      let from = 0;
      while (from < doc.length && doc[from] === text[from]) {
        from++;
      }
      let end = 0;
      while (
        end < doc.length - from &&
        end < text.length - from &&
        doc[doc.length - 1 - end] === text[text.length - 1 - end]
      ) {
        end++;
      }
      view.dispatch({
        changes: {
          from,
          to: doc.length - end,
          insert: text.slice(from, text.length - end),
        },
      });
      return;
    }
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
  }

  // The Literal Editor this Project lists for Mini-Notation, if any.
  #literalEditor() {
    return literalEditorsFor(this.editor.project.addOns, 'mini-notation')[0];
  }

  #openLiteral(view: EditorView, at: number): void {
    const editor = this.#literalEditor();
    if (!editor) {
      return;
    }
    const line = view.state.doc.lineAt(at).number;
    this.literals.open(
      editor,
      this.#selected,
      at,
      `${this.#label()}, line ${line}`,
    );
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
    const doc = view.state.doc.toString();
    const target = operationAt(doc, pos, readManifest(this.#manifest()));
    const editor = this.#literalEditor();
    const literal = editor ? literalAt(doc, pos) : undefined;
    if (!target && !literal) {
      return;
    }
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, [
      ...(editor && literal
        ? [
            {
              label: `Open in ${editor.label}`,
              run: () => this.#openLiteral(view, literal.offset),
            },
          ]
        : []),
      ...(target
        ? [
            {
              label: `Show ${target.operation ? `${target.grant} ${target.operation}` : target.grant} in Dictionary`,
              run: () => this.dictionary.open(target),
            },
          ]
        : []),
    ]);
  }

  #state(server: LanguageServer): EditorState {
    const source = this.#selected;
    return EditorState.create({
      doc: this.#text(),
      extensions: [
        source.kind === 'test'
          ? []
          : breakpointGutter(() => {
              this.#markBreakpoints();
              this.#breakpointsChanged();
            }, 'Breakpoint in source changed since Play began: it applies from the next Play'),
        lineNumbers(),
        literalGutter(
          () => this.#literalEditor()?.label,
          (view, at) => this.#openLiteral(view, at),
        ),
        playingHighlight(),
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
              // After this update: an edit fades its source's Breakpoints.
              queueMicrotask(() => this.#markBreakpoints());
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
            { key: 'Mod-Enter', run: () => this.punchIn() },
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
    // The Playing Highlight (#2176) is on unless this browser turned it off.
    const highlightBox = h('input', {
      type: 'checkbox',
      'data-playing-highlight': '',
    });
    highlightBox.checked = highlightOn();
    highlightBox.addEventListener('change', () => {
      setHighlightOn(highlightBox.checked);
      if (!highlightBox.checked) {
        this.unlight();
      }
    });
    const highlightToggle = h(
      'label',
      {
        class: 'highlight-toggle',
        title: 'Light up each pattern step as it sounds while browsing',
      },
      highlightBox,
      'Highlight',
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
    const stoppedNote = h('div', {
      class: 'stopped-note',
      role: 'status',
      hidden: true,
    });
    const punchNote = h('div', {
      class: 'punch-note',
      role: 'status',
      hidden: true,
    });
    body.append(
      sourceTitle,
      h(
        'div',
        { class: 'code-toolbar' },
        path,
        h('span', { class: 'spacer' }),
        addAction,
        highlightToggle,
        showDictionary,
      ),
      recipes,
      stoppedNote,
      punchNote,
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
      punchNote,
      stoppedNote,
      view,
    };
    this.#window = browser;
    server.lsp.onDiagnostics = (uri, found) => {
      if (uri !== this.#uri()) {
        return;
      }
      this.#found = { diagnostics: found, uri };
      this.#showDiagnostics();
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

  onAddMusicSound(add: (key: string) => Promise<void>): void {
    this.#addMusicSound = add;
  }

  // Shows the language server's diagnostics with Folio's own checks, which
  // follow the Project's sounds.
  #showDiagnostics(): void {
    const win = this.#window;
    if (!win) {
      return;
    }
    const { problems, view } = win;
    const found =
      this.#found?.uri === this.#uri() ? this.#found.diagnostics : [];
    const text = view.state.doc.toString();
    this.#soundsShown = this.#sounds();
    const diagnostics = [
      ...found,
      ...clickAdvice(text),
      ...patternDiagnostics(text, projectPatternNames(this.editor.project)),
    ];
    view.dispatch(
      diagnosticsSpec(view.state, diagnostics, d => this.#fixes(d)),
    );
    problems.classList.toggle(
      'bad',
      diagnostics.some(d => d.severity === 1),
    );
    problems.textContent = diagnostics.length
      ? diagnostics
          .map(d => `Line ${d.range.start.line + 1}: ${d.message}`)
          .join('\n')
      : '✓ No problems';
  }

  #sounds(): string {
    return [...projectPatternNames(this.editor.project).sounds].join('\n');
  }

  // A missing Music sound's quick fix copies it in as one undoable edit.
  #fixes(diagnostic: LspDiagnostic) {
    const key =
      diagnostic.code === 'mini-notation' && !this.editor.readOnly
        ? musicSoundIn(diagnostic.message)
        : undefined;
    return key === undefined
      ? []
      : [
          {
            name: `Add “${key}” from Music`,
            apply: () => void this.#addMusicSound(key),
          },
        ];
  }

  /** Every Script's and Library's Breakpoints, in shown or saved editors. */
  breakpoints(): SourceBreakpoints[] {
    const states = new Map(
      [...this.#states].map(([key, saved]) => [key, saved.state]),
    );
    if (this.#window) {
      states.set(sourceKey(this.#selected), this.#window.view.state);
    }
    return [...states].flatMap(([key, state]) => {
      const source = selectionOf(key);
      const lines = breakpointLines(state);
      return lines.length && source.kind !== 'test'
        ? [{ source, lines, text: state.doc.toString() }]
        : [];
    });
  }
  onBreakpointsChanged(listener: () => void): void {
    this.#breakpointsChanged = listener;
  }

  /**
   * While browsing, `loaded` gives each source as the session loaded it:
   * Breakpoints in a source edited since then fade, and don't trigger.
   */
  setLoaded(loaded: LoadedSource | undefined): void {
    this.#loaded = loaded;
    this.#markBreakpoints();
  }

  /**
   * Shows where a Run is stopped, opening its source, or clears it. A
   * source edited since Play began gets a note instead of a paused line.
   */
  showStopped(at: { line: number; source: CodeSelection } | undefined): void {
    const before = this.#stopped;
    this.#stopped = at;
    if (at && sourceKey(at.source) !== sourceKey(this.#selected)) {
      this.#show(at.source, at.line);
    } else if (at && before?.line !== at.line) {
      this.#show(at.source, at.line);
    }
    this.#drawStopped();
  }

  #drawStopped(): void {
    const win = this.#window;
    if (!win) {
      return;
    }
    const at = this.#stopped;
    const here =
      at && sourceKey(at.source) === sourceKey(this.#selected) ? at : undefined;
    const changed =
      here !== undefined &&
      this.#loaded?.(here.source) !== win.view.state.doc.toString();
    win.view.dispatch({
      effects: pausedAt(here && !changed ? here.line : null),
    });
    win.stoppedNote.hidden = !changed;
    win.stoppedNote.textContent = here
      ? `Stopped at line ${here.line} of this source as Play loaded it; it has changed since.`
      : '';
  }

  /**
   * Lights a Pattern Event's characters for `ms` (#2176), if the browser
   * shows the Script with id `scriptId` or, when that Script's source
   * `script` writes no such pattern, a Library that does.
   */
  light(
    scriptId: number,
    script: string,
    event: { from: number; text: string; to: number },
    ms: number,
  ): void {
    if (highlightOn()) {
      this.#hearLiterals(scriptId, script, event, ms);
    }
    const win = this.#window;
    const shown = this.#selected;
    if (!win || win.node.hidden || !highlightOn()) {
      return;
    }
    const inScript = shown.kind === 'script' && shown.id === scriptId;
    const inLibrary =
      shown.kind === 'library' &&
      !patternTexts(script).some(found => found.text === event.text);
    if (inScript || inLibrary) {
      lightFor(
        win.view,
        patternRanges(
          win.view.state.doc.toString(),
          event.text,
          event.from,
          event.to,
        ),
        ms,
      );
    }
  }

  // Literal Editor windows show the Playing Highlight too: those on the
  // Script, or on a Library when the Script writes no such pattern.
  #hearLiterals(
    scriptId: number,
    script: string,
    event: { from: number; text: string; to: number },
    ms: number,
  ): void {
    this.literals.heard(
      { kind: 'script', id: scriptId },
      event.text,
      event,
      ms,
    );
    if (!patternTexts(script).some(found => found.text === event.text)) {
      for (const library of this.editor.project.libraries) {
        this.literals.heard(
          { kind: 'library', id: library.id! },
          event.text,
          event,
          ms,
        );
      }
    }
  }

  /** Puts out the Playing Highlight, as Pause, Hush and Stop do. */
  unlight(): void {
    if (this.#window) {
      unlightAll(this.#window.view);
    }
  }

  onPunchIn(listener: (source: CodeSelection, text: string) => boolean): void {
    this.#punchIn = listener;
  }

  /**
   * Punches In the shown Script or Library, as ⌘↩ and Edit → Punch In do,
   * or starts Play when nothing is playing; false leaves the key to the
   * editor.
   */
  punchIn(): boolean {
    const win = this.#window;
    if (!win || this.#selected.kind === 'test' || this.editor.readOnly) {
      return false;
    }
    return this.#punchIn(this.#selected, win.view.state.doc.toString());
  }

  /** What the last Punch In did, or nothing to clear it. */
  showPunch(message: string | undefined): void {
    const win = this.#window;
    if (win) {
      win.punchNote.hidden = !message;
      win.punchNote.textContent = message ?? '';
    }
  }

  // Fades each Breakpoint set in source edited since the session loaded it.
  #markBreakpoints(): void {
    for (const [key, saved] of this.#states) {
      saved.state = saved.state.update({
        effects: verifiedLines(this.#loaded, selectionOf(key), saved.state),
      }).state;
    }
    this.#window?.view.dispatch({
      effects: verifiedLines(
        this.#loaded,
        this.#selected,
        this.#window.view.state,
      ),
    });
    this.#drawStopped();
  }

  /** The source the browser shows. */
  get selected(): CodeSelection {
    return this.#selected;
  }

  /**
   * Replaces the shown source's text, as an edit like any other, so undo
   * takes it back; Revert (#2002, ADR 0174) puts back what Play loaded.
   */
  replace(text: string): void {
    const view = this.#window?.view;
    if (view && view.state.doc.toString() !== text && !this.editor.readOnly) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    }
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
      this.showPunch(undefined);
      const saved = this.#states.get(sourceKey(source));
      win.view.setState(saved?.state ?? this.#state(win.server));
      if (saved && line === undefined) {
        win.view.dispatch({ effects: saved.scroll });
      }
      this.sync();
      win.server.lsp.open(this.#uri(), this.#text());
      this.#markBreakpoints();
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
      this.literals.clear();
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
      this.literals.refresh();
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
      } else if (this.#soundsShown !== this.#sounds()) {
        // Adding or removing a sound changes the pattern checks (#1963).
        this.#showDiagnostics();
      }
    } finally {
      this.#syncing = false;
    }
  }
}
