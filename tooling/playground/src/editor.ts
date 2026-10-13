// The Playground's editor: the shared NorthTalk editor, with a breakpoint
// gutter, the paused line, print it, and keys to run a selection or save.
import {
  northtalkEditor,
  type LanguageHooks,
} from '@odgn/northtalk-editor/editor';
import type { LspClient } from '@odgn/northtalk-editor/lsp-client';
import {
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  lineNumbers,
  WidgetType,
  type DecorationSet,
  type KeyBinding,
} from '@codemirror/view';
import type { SelectionAction } from './session';

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

export type EditorHooks = LanguageHooks & {
  /** Each tab's breakpoints changed. */
  breakpointsChanged(): void;
  /** Do it, print it or inspect it: run the selection against the session. */
  run(how: SelectionAction): void;
  save(): void;
};

export const createEditorState = (
  text: string,
  uri: string,
  lsp: LspClient,
  hooks: EditorHooks,
): EditorState => {
  const bindings: KeyBinding[] = [
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
  return EditorState.create({
    doc: text,
    extensions: [
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
      printed,
      ...northtalkEditor(uri, lsp, hooks, bindings),
    ],
  });
};

export { toggleBreakpoint };
