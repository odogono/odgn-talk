// The Playing Highlight (#2176): while browsing, the Code Browser outlines
// the Mini-Notation text of each Pattern Event as it sounds. The ranges are
// found in the text the browser shows when the event sounds, so edits
// elsewhere move them and an edited pattern goes dark until Punched In.
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { patternTexts } from './pattern-checks';

/** A lit range of the shown source, end exclusive. */
export type LitRange = { from: number; to: number };

/**
 * Where the event's characters `from`–`to` of pattern `text` are in
 * `source`: once for each pattern literal written with exactly that text.
 */
export const patternRanges = (
  source: string,
  text: string,
  from: number,
  to: number,
): LitRange[] =>
  patternTexts(source)
    .filter(found => found.text === text)
    .map(found => found.range(from, to))
    .filter(range => range.from < range.to);

const light = StateEffect.define<{ id: number; ranges: LitRange[] }>();
const unlight = StateEffect.define<number | null>();

const mark = (id: number) =>
  Decoration.mark({ class: 'cm-playing', attributes: { 'data-lit': `${id}` } });

const lit = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(light)) {
        const length = tr.state.doc.length;
        value = value.update({
          add: e.value.ranges
            .filter(r => r.to <= length)
            .map(r => mark(e.value.id).range(r.from, r.to)),
          sort: true,
        });
      } else if (e.is(unlight)) {
        const id = e.value;
        value =
          id === null
            ? Decoration.none
            : value.update({
                filter: (_from, _to, d) =>
                  d.spec.attributes?.['data-lit'] !== `${id}`,
              });
      }
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

/** The editor extension that draws the Playing Highlight. */
export const playingHighlight = (): Extension => lit;

let nextId = 1;

/** Lights `ranges` in `view` for `ms`, then puts them out. */
export const lightFor = (
  view: EditorView,
  ranges: LitRange[],
  ms: number,
): void => {
  if (!ranges.length) {
    return;
  }
  const id = nextId++;
  view.dispatch({ effects: light.of({ id, ranges }) });
  setTimeout(() => view.dispatch({ effects: unlight.of(id) }), ms);
};

/** Puts out every lit range in `view`. */
export const unlightAll = (view: EditorView): void =>
  view.dispatch({ effects: unlight.of(null) });

const KEY = 'northtalk-creative-playing-highlight';

/** Whether this browser shows the Playing Highlight; on unless turned off. */
export const highlightOn = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
};

/** Remembers whether this browser shows the Playing Highlight. */
export const setHighlightOn = (on: boolean): void => {
  try {
    if (on) {
      localStorage.removeItem(KEY);
    } else {
      localStorage.setItem(KEY, 'off');
    }
  } catch {
    // Without storage it lasts for this visit only.
  }
};
