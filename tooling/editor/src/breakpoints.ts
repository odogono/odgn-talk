// Breakpoints and the paused line, for any page that debugs NorthTalk: a
// gutter that toggles a breakpoint on a click, marks for which of them map to
// loaded code, and the line a paused Run is stopped at.
import { Facet, RangeSet, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  type DecorationSet,
} from '@codemirror/view';

// ------------------------------------------------------------- breakpoints

class BreakpointMarker extends GutterMarker {
  constructor(
    private readonly verified: boolean,
    private readonly unverifiedTitle: string,
  ) {
    super();
  }
  override eq(other: BreakpointMarker) {
    return (
      other.verified === this.verified &&
      other.unverifiedTitle === this.unverifiedTitle
    );
  }
  override toDOM() {
    const dot = document.createElement('span');
    dot.className = this.verified ? 'bp' : 'bp bp-unverified';
    dot.textContent = '●';
    dot.title = this.verified ? 'Breakpoint' : this.unverifiedTitle;
    return dot;
  }
}

const toggleBreakpoint = StateEffect.define<number>();
const verifyBreakpoints = StateEffect.define<Set<number>>();

const unverifiedTitle = Facet.define<string, string>({
  combine: values => values[0] ?? 'Breakpoint, not in loaded code',
});

const breakpoints = StateField.define<{
  lines: RangeSet<GutterMarker>;
  verified: Set<number>;
}>({
  create: () => ({ lines: RangeSet.empty, verified: new Set() }),
  update(value, tr) {
    const title = tr.state.facet(unverifiedTitle);
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
          : lines.update({
              add: [new BreakpointMarker(false, title).range(e.value)],
            });
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
        ranges.push(
          new BreakpointMarker(verified.has(line), title).range(iter.from),
        );
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

export { toggleBreakpoint };

/**
 * The breakpoint gutter and paused line. `changed` runs after each click
 * toggles a breakpoint; `unverified` titles a breakpoint not in loaded code.
 */
export const breakpointGutter = (
  changed: () => void,
  unverified?: string,
): Extension => [
  unverified === undefined ? [] : unverifiedTitle.of(unverified),
  gutter({
    class: 'cm-breakpoints',
    markers: v => v.state.field(breakpoints).lines,
    initialSpacer: () => new BreakpointMarker(true, ''),
    domEventHandlers: {
      mousedown(view, line) {
        view.dispatch({ effects: toggleBreakpoint.of(line.from) });
        changed();
        return true;
      },
    },
  }),
  breakpoints,
  pausedLine,
];
