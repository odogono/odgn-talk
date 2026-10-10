// The Playground's editor: CodeMirror 6 with NorthTalk highlighting, a
// breakpoint gutter, the paused line, suspension marks, and the language
// server's diagnostics, completion, hover and navigation.
import type { LspDiagnostic, Position } from '@odgn/northtalk-tooling/lsp';
import {
  autocompletion,
  type CompletionContext,
  snippet,
  type CompletionResult,
} from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import {
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  gutter,
  GutterMarker,
  highlightActiveLine,
  hoverTooltip,
  keymap,
  lineNumbers,
  WidgetType,
  type DecorationSet,
  type KeyBinding,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { LspClient } from './lsp-client';
import { northtalk } from './language';
import type { SelectionAction } from './session';

// ------------------------------------------------------------- language

const style = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--keyword)', fontWeight: '600' },
  { tag: tags.labelName, color: 'var(--keyword)', fontStyle: 'italic' },
  { tag: tags.string, color: 'var(--string)' },
  { tag: tags.number, color: 'var(--number)' },
  { tag: tags.comment, color: 'var(--comment)', fontStyle: 'italic' },
  { tag: tags.operator, color: 'var(--operator)' },
]);

// ------------------------------------------------------------- positions

export const offsetOf = (doc: Text, p: Position): number => {
  const line = doc.line(Math.min(doc.lines, p.line + 1));
  return Math.min(line.to, line.from + p.character);
};
export const positionOf = (doc: Text, offset: number): Position => {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
};

// ------------------------------------------------------------- breakpoints

class BreakpointMarker extends GutterMarker {
  constructor(private readonly verified: boolean) {
    super();
  }
  override eq(other: BreakpointMarker) {
    return other.verified === this.verified;
  }
  override toDOM() {
    const dot = document.createElement('span');
    dot.className = this.verified ? 'bp' : 'bp bp-unverified';
    dot.textContent = '●';
    dot.title = this.verified
      ? 'Breakpoint'
      : 'Breakpoint, not in loaded code: Apply or save the tab first';
    return dot;
  }
}

const toggleBreakpoint = StateEffect.define<number>();
const verifyBreakpoints = StateEffect.define<Set<number>>();

const breakpoints = StateField.define<{
  lines: RangeSet<GutterMarker>;
  verified: Set<number>;
}>({
  create: () => ({ lines: RangeSet.empty, verified: new Set() }),
  update(value, tr) {
    let { lines, verified } = value;
    lines = lines.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(toggleBreakpoint)) {
        let has = false;
        lines.between(e.value, e.value, () => {
          has = true;
        });
        lines = has
          ? lines.update({ filter: from => from !== e.value })
          : lines.update({ add: [new BreakpointMarker(false).range(e.value)] });
      }
      if (e.is(verifyBreakpoints)) {
        verified = e.value;
      }
    }
    if (tr.effects.some(e => e.is(verifyBreakpoints))) {
      const ranges: ReturnType<GutterMarker['range']>[] = [];
      const iter = lines.iter();
      while (iter.value) {
        const line = tr.state.doc.lineAt(iter.from).number;
        ranges.push(new BreakpointMarker(verified.has(line)).range(iter.from));
        iter.next();
      }
      lines = RangeSet.of(ranges);
    }
    return { lines, verified };
  },
});

/** Each line with a breakpoint, from 1. */
export const breakpointLines = (state: EditorState): number[] => {
  const out: number[] = [];
  const iter = state.field(breakpoints).lines.iter();
  while (iter.value) {
    out.push(state.doc.lineAt(iter.from).number);
    iter.next();
  }
  return out;
};

/** Marks which breakpoint lines map to loaded code. */
export const markVerified = (lines: readonly number[]) =>
  verifyBreakpoints.of(new Set(lines));

// ------------------------------------------------------------- paused line

const setPaused = StateEffect.define<number | null>();
const pausedLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPaused)) {
        value =
          e.value === null || e.value > tr.state.doc.lines
            ? Decoration.none
            : Decoration.set([
                Decoration.line({ class: 'cm-paused' }).range(
                  tr.state.doc.line(e.value).from,
                ),
              ]);
      }
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});
export const pausedAt = (line: number | null) => setPaused.of(line);

// ------------------------------------------------------------- suspension marks

class HintWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly tip: string,
  ) {
    super();
  }
  override eq(other: HintWidget) {
    return other.label === this.label && other.tip === this.tip;
  }
  override toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-hint';
    span.textContent = this.label;
    span.title = this.tip;
    return span;
  }
}
const setHints =
  StateEffect.define<{ label: string; offset: number; tip: string }[]>();
const hints = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHints)) {
        value = Decoration.set(
          e.value
            .filter(h => h.offset <= tr.state.doc.length)
            .map(h =>
              Decoration.widget({
                widget: new HintWidget(h.label, h.tip),
                side: -1,
              }).range(h.offset),
            ),
          true,
        );
      }
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

// ------------------------------------------------------------- print it

class PrintedWidget extends WidgetType {
  constructor(private readonly lines: readonly string[]) {
    super();
  }
  override eq(other: PrintedWidget) {
    return other.lines.join('\n') === this.lines.join('\n');
  }
  override toDOM() {
    const span = document.createElement('span');
    const last = this.lines.at(-1);
    span.className = last?.startsWith('! ') ? 'cm-printed bang' : 'cm-printed';
    span.textContent = ` ${last ?? '…'}`;
    span.title = this.lines.length
      ? this.lines.join('\n')
      : 'Nothing printed yet';
    return span;
  }
}

const setPrinted = StateEffect.define<{
  lines: readonly string[];
  offset: number;
} | null>();
// The latest print it, after its selection, until the text changes.
const printed = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged) {
      value = Decoration.none;
    }
    for (const e of tr.effects) {
      if (e.is(setPrinted)) {
        value =
          e.value === null || e.value.offset > tr.state.doc.length
            ? Decoration.none
            : Decoration.set([
                Decoration.widget({
                  widget: new PrintedWidget(e.value.lines),
                  side: 1,
                }).range(e.value.offset),
              ]);
      }
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});
/** Shows what a print it printed after `offset`, or clears it. */
export const printedAt = (
  at: { lines: readonly string[]; offset: number } | null,
) => setPrinted.of(at);

/** The selected text, or the cursor's line, and where it ends. */
export const selectionToRun = (
  state: EditorState,
): { end: number; source: string } => {
  const { from, to } = state.selection.main;
  if (from !== to) {
    return { source: state.sliceDoc(from, to), end: to };
  }
  const line = state.doc.lineAt(from);
  return { source: line.text, end: line.to };
};

// ------------------------------------------------------------- the editor

export type EditorHooks = {
  /** Each tab's breakpoints changed. */
  breakpointsChanged(): void;
  changed(text: string): void;
  /** Go to a location in another tab, by URI. */
  goTo(uri: string, line: number, character: number): void;
  references(lines: string[]): void;
  /** Do it, print it or inspect it: run the selection against the session. */
  run(how: SelectionAction): void;
  save(): void;
  selected?(): void;
};

export const createEditorState = (
  text: string,
  uri: string,
  lsp: LspClient,
  hooks: EditorHooks,
): EditorState => {
  const completion = async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const word = context.matchBefore(/[\p{L}\p{N}_]*/u);
    if (!word || (word.from === word.to && !context.explicit)) {
      return null;
    }
    type Item = {
      detail?: string;
      documentation?: string;
      insertText?: string;
      insertTextFormat?: number;
      kind?: number;
      label: string;
    };
    const result = await lsp.request<{ items?: Item[] } | Item[] | null>(
      'textDocument/completion',
      {
        textDocument: { uri },
        position: positionOf(context.state.doc, context.pos),
      },
    );
    const items = Array.isArray(result) ? result : (result?.items ?? []);
    return {
      from: word.from,
      options: items.map(i => ({
        label: i.label,
        ...(i.detail ? { detail: i.detail } : {}),
        ...(typeof i.documentation === 'string'
          ? { info: i.documentation }
          : {}),
        // The LSP's only snippet field is `${1}`, CodeMirror's `${}`.
        ...(i.insertText === undefined
          ? {}
          : {
              apply:
                i.insertTextFormat === 2
                  ? snippet(i.insertText.replaceAll(/\$\{\d+\}/gu, '${}'))
                  : i.insertText,
            }),
        type:
          i.kind === 3 ? 'function' : i.kind === 14 ? 'keyword' : 'variable',
      })),
    };
  };
  const hover = hoverTooltip(async (view, pos) => {
    const result = await lsp.request<{
      contents: { value: string } | string;
    } | null>('textDocument/hover', {
      textDocument: { uri },
      position: positionOf(view.state.doc, pos),
    });
    if (!result) {
      return null;
    }
    const value =
      typeof result.contents === 'string'
        ? result.contents
        : result.contents.value;
    return {
      pos,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-hover';
        dom.textContent = value;
        return { dom };
      },
    };
  });
  const definition = (view: EditorView) => {
    void lsp
      .request<{ range: { start: Position }; uri: string } | null>(
        'textDocument/definition',
        {
          textDocument: { uri },
          position: positionOf(view.state.doc, view.state.selection.main.head),
        },
      )
      .then(location => {
        if (location) {
          hooks.goTo(
            location.uri,
            location.range.start.line,
            location.range.start.character,
          );
        }
      });
    return true;
  };
  const references = (view: EditorView) => {
    void lsp
      .request<{ range: { start: Position }; uri: string }[] | null>(
        'textDocument/references',
        {
          textDocument: { uri },
          position: positionOf(view.state.doc, view.state.selection.main.head),
          context: { includeDeclaration: true },
        },
      )
      .then(locations =>
        hooks.references(
          (locations ?? []).map(
            l =>
              `${decodeURIComponent(l.uri.replace(/^.*\//u, ''))}:${l.range.start.line + 1}:${l.range.start.character + 1}`,
          ),
        ),
      );
    return true;
  };
  const rename = (view: EditorView) => {
    const position = positionOf(view.state.doc, view.state.selection.main.head);
    void lsp
      .request<{ placeholder: string } | null>('textDocument/prepareRename', {
        textDocument: { uri },
        position,
      })
      .then(async prepared => {
        if (!prepared) {
          return;
        }
        const newName = prompt(
          `Rename ${prepared.placeholder} to`,
          prepared.placeholder,
        );
        if (!newName || newName === prepared.placeholder) {
          return;
        }
        const edit = await lsp.request<{
          changes: Record<
            string,
            { newText: string; range: { end: Position; start: Position } }[]
          >;
        }>('textDocument/rename', { textDocument: { uri }, position, newName });
        for (const [target, edits] of Object.entries(edit.changes)) {
          editHook(target, edits);
        }
      })
      .catch((error: Error) => hooks.references([`Rename: ${error.message}`]));
    return true;
  };
  const bindings: KeyBinding[] = [
    { key: 'F12', run: definition },
    { key: 'Shift-F12', run: references },
    { key: 'F2', run: rename },
    ...(
      [
        ['Mod-d', 'do'],
        ['Mod-p', 'print'],
        ['Mod-i', 'inspect'],
      ] as const
    ).map(([key, how]) => ({
      key,
      run: () => {
        hooks.run(how);
        return true;
      },
    })),
    {
      key: 'Mod-s',
      run: () => {
        hooks.save();
        return true;
      },
    },
  ];
  const extensions: Extension[] = [
    lineNumbers(),
    gutter({
      class: 'cm-breakpoints',
      markers: v => v.state.field(breakpoints).lines,
      initialSpacer: () => new BreakpointMarker(true),
      domEventHandlers: {
        mousedown(view, line) {
          view.dispatch({ effects: toggleBreakpoint.of(line.from) });
          hooks.breakpointsChanged();
          return true;
        },
      },
    }),
    breakpoints,
    pausedLine,
    hints,
    printed,
    lintGutter(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    northtalk,
    syntaxHighlighting(style),
    autocompletion({ override: [completion] }),
    hover,
    keymap.of([...bindings, indentWithTab, ...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of(update => {
      if (update.selectionSet) {
        hooks.selected?.();
      }
      if (update.docChanged) {
        hooks.changed(update.state.doc.toString());
      }
    }),
  ];
  return EditorState.create({ doc: text, extensions });
};

// Applying a rename's edits needs the page's tabs; it registers this hook.
let editHook: (
  uri: string,
  edits: { newText: string; range: { end: Position; start: Position } }[],
) => void = () => {};
export const onEdits = (hook: typeof editHook) => {
  editHook = hook;
};

/** The language server's diagnostics, as a CodeMirror transaction. */
export const diagnosticsSpec = (
  state: EditorState,
  diagnostics: readonly LspDiagnostic[],
) =>
  setDiagnostics(
    state,
    diagnostics.map((d): Diagnostic => ({
      from: offsetOf(state.doc, d.range.start),
      to: Math.max(
        offsetOf(state.doc, d.range.start),
        offsetOf(state.doc, d.range.end),
      ),
      severity:
        d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
      message: `${d.message} (${d.code})`,
      source: d.source,
    })),
  );

/** Fetches the suspension marks for a document and shows them. */
export const refreshHints = async (
  view: EditorView,
  uri: string,
  lsp: LspClient,
) => {
  const doc = view.state.doc;
  const result = await lsp.request<
    { label: string; position: Position; tooltip?: string }[] | null
  >('textDocument/inlayHint', {
    textDocument: { uri },
    range: {
      start: { line: 0, character: 0 },
      end: positionOf(doc, doc.length),
    },
  });
  if (view.state.doc !== doc) {
    return;
  }
  view.dispatch({
    effects: setHints.of(
      (result ?? []).map(h => ({
        label: h.label,
        offset: offsetOf(doc, h.position),
        tip: h.tooltip ?? '',
      })),
    ),
  });
};

export { toggleBreakpoint };
