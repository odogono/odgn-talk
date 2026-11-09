// The built-in Piano Roll Add-on (ADR 0175, #2181): a Literal Editor that
// shows a Mini-Notation literal as a grid, cycles left to right and a row per
// note pitch or sound name, and lights each step as it sounds. Editing
// (#2182) rewrites one step's text at a time: select a note (linked to the
// Code Browser's selection), move it with ↑↓ or by dragging, Delete makes it
// a rest, S splits and M merges, and clicking a rest's cell writes a note
// there. Clicking under a sounding note adds a Chord member, and Delete takes
// one out (#2187); that is the only bracket the Piano Roll writes. It draws with plain DOM and Folio's
// style variables, so it needs nothing from Folio at run time.
import type { LiteralEditorHost, LiteralEditorView } from '../api';
import { defineAddOn } from '../api';
import type { LiteralState } from '../../literal-editors';
import { PIANO_ROLL_ADD_ON, PIANO_ROLL_VERSION } from './ids';
import {
  addToChord,
  fromRest,
  merge,
  rename,
  split,
  stepAt,
  remove,
  type EditResult,
  type TextEdit,
} from './edits';
import {
  noteLabel,
  pianoRollLayout,
  restOffsets,
  restsAsWords,
  type RollLayout,
} from './layout';

export { PIANO_ROLL_ADD_ON, PIANO_ROLL_VERSION } from './ids';

const ROW = 14;
const LABEL = 40;
const STEP = 16;
const MIN_CYCLE = 96;

type Shown = Extract<LiteralState, { text: string }>;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration> = {},
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  return node;
};

/** How wide one cycle is drawn, in pixels. */
const cycleWidth = (layout: RollLayout) =>
  Math.max(MIN_CYCLE, layout.steps * STEP);

/** Draws `layout` as the grid and its bars; the bars by their index. */
const drawGrid = (
  layout: RollLayout,
): { bars: HTMLElement[]; grid: HTMLElement } => {
  const width = cycleWidth(layout);
  const total = width * layout.cycles;
  const grid = el(
    'div',
    {
      position: 'relative',
      width: `${LABEL + total}px`,
      height: `${ROW * (layout.rows.length + 1)}px`,
      font: '11px ui-monospace, monospace',
    },
    { class: 'piano-roll-grid', role: 'img' },
  );
  // Cycle numbers along the top.
  for (let c = 0; c < layout.cycles; c++) {
    const number = el('div', {
      position: 'absolute',
      left: `${LABEL + c * width + 3}px`,
      top: '0',
      color: 'var(--muted)',
    });
    number.textContent = String(c + 1);
    grid.append(number);
  }
  layout.rows.forEach((row, i) => {
    const top = ROW * (i + 1);
    const lane = el('div', {
      position: 'absolute',
      left: `${LABEL}px`,
      top: `${top}px`,
      width: `${total}px`,
      height: `${ROW}px`,
      borderBottom: '1px solid rgb(0 0 0 / 8%)',
      background: row.black ? 'rgb(0 0 0 / 6%)' : 'transparent',
    });
    const label = el(
      'div',
      {
        position: 'absolute',
        left: '0',
        top: `${top}px`,
        width: `${LABEL - 4}px`,
        lineHeight: `${ROW}px`,
        textAlign: 'right',
        color: 'var(--muted)',
      },
      { class: 'piano-roll-row' },
    );
    label.textContent = row.label;
    grid.append(lane, label);
  });
  // A line at each step, darker at each cycle.
  for (let s = 0; s <= layout.cycles * layout.steps; s++) {
    grid.append(
      el('div', {
        position: 'absolute',
        left: `${LABEL + (s * width) / layout.steps}px`,
        top: `${ROW}px`,
        width: '1px',
        height: `${ROW * layout.rows.length}px`,
        background: s % layout.steps === 0 ? 'var(--muted)' : 'rgb(0 0 0 / 8%)',
      }),
    );
  }
  const bars = layout.notes.map(note => {
    const left = LABEL + (note.cycle + note.begin) * width;
    const right = Math.min(
      LABEL + (note.cycle + note.end) * width,
      LABEL + total,
    );
    const bar = el(
      'div',
      {
        position: 'absolute',
        left: `${left + 1}px`,
        top: `${ROW * (note.row + 1) + 1}px`,
        width: `${Math.max(3, right - left - 3)}px`,
        height: `${ROW - 3}px`,
        borderRadius: '3px',
        background: 'var(--accent)',
      },
      {
        class: 'piano-roll-note',
        'data-cycle': String(note.cycle),
        'data-from': String(note.from),
        'data-row': String(note.row),
      },
    );
    grid.append(bar);
    return bar;
  });
  return { bars, grid };
};

/** Where the note `name` an edit adds to a Chord starts. */
const addedAt = (edit: TextEdit, name: string): number =>
  edit.from +
  (edit.insert.startsWith(`[${name},`)
    ? 1
    : edit.insert.endsWith(`,${name}]`)
      ? edit.insert.length - name.length - 1
      : edit.insert.startsWith(',')
        ? 1
        : 0);

const open = (host: LiteralEditorHost): LiteralEditorView => {
  let fullRange = false;
  let shown: Shown | undefined;
  let layout: RollLayout | undefined;
  let bars: HTMLElement[] = [];
  // The playhead sits at the start of the step last heard.
  const playhead = el(
    'div',
    {
      position: 'absolute',
      top: '0',
      bottom: '0',
      width: '2px',
      background: 'var(--number)',
      pointerEvents: 'none',
    },
    { class: 'piano-roll-playhead' },
  );
  playhead.hidden = true;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const toolbar = el('div', {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
    padding: '0.3rem 0.5rem',
    borderBottom: '1px solid var(--line)',
    fontSize: '0.85rem',
  });
  const summary = el('span', { color: 'var(--muted)' });
  const range = el('button', {}, { type: 'button', class: 'piano-roll-range' });
  const hint = el(
    'span',
    { color: 'var(--muted)' },
    { class: 'piano-roll-hint' },
  );
  const scroller = el(
    'div',
    {
      overflow: 'auto',
      flex: '1',
      minHeight: '0',
      padding: '0.3rem 0',
      outline: 'none',
    },
    {
      class: 'piano-roll-scroller',
      tabindex: '0',
      'aria-label':
        'Notes: ↑↓ move, Shift for an octave, Delete removes, S splits, M merges',
    },
  );
  toolbar.append(summary, range, hint);
  host.element.append(toolbar, scroller);

  const draw = () => {
    range.textContent = fullRange ? 'Fit pitches' : 'Full range';
    range.hidden = layout?.mode !== 'pitch';
    if (!shown || shown.kind !== 'ready') {
      return;
    }
    const at = restOffsets(shown.pattern.layers);
    const restPattern = at.length
      ? host.parse(restsAsWords(shown.text, at))
      : undefined;
    layout = pianoRollLayout(shown.pattern, {
      fullRange,
      ...(restPattern ? { rests: { at, pattern: restPattern } } : {}),
    });
    range.hidden = layout.mode !== 'pitch';
    summary.textContent = `${layout.cycles} ${layout.cycles === 1 ? 'cycle' : 'cycles'}`;
    const drawn = drawGrid(layout);
    bars = drawn.bars;
    drawn.grid.append(playhead);
    scroller.replaceChildren(drawn.grid);
    mark();
  };

  // --- Editing (#2182) ------------------------------------------------------

  /** The selected step, by where its text starts. */
  let selected: number | undefined;

  const mark = () => {
    for (const bar of bars) {
      const on = selected !== undefined && bar.dataset.from === `${selected}`;
      bar.classList.toggle('selected', on);
      bar.style.outline = on ? '2px solid var(--text)' : '';
    }
  };
  const selectedNote = () => layout?.notes.find(note => note.from === selected);

  /** Selects the note at `from`, and its text when `link` says so. */
  const select = (from: number | undefined, link = true) => {
    selected = from;
    mark();
    const note = selectedNote();
    if (link && note) {
      host.select(note.from, note.to);
    }
  };

  const say = (text: string) => {
    hint.textContent = text;
  };

  /** Applies `result`, then selects the step that starts at `next`. */
  const apply = (result: EditResult, next?: number) => {
    if ('problem' in result) {
      say(`Can't: ${result.problem}.`);
      return;
    }
    const problem = host.replace(result.from, result.to, result.insert);
    if (problem) {
      say(`Can't: ${problem}.`);
      return;
    }
    say('');
    select(next ?? result.from);
  };

  /** The selected note moved `by` rows: semitones up, or sound rows down. */
  const move = (by: number) => {
    const note = selectedNote();
    if (!shown || shown.kind !== 'ready' || !layout || !note) {
      return;
    }
    const row = layout.rows[note.row]!;
    const name =
      layout.mode === 'pitch'
        ? row.note! + by >= 0 && row.note! + by <= 127
          ? noteLabel(row.note! + by)
          : undefined
        : layout.rows[note.row - by]?.label;
    if (name !== undefined) {
      apply(rename(shown.pattern.layers, note.from, name), note.from);
    }
  };

  scroller.addEventListener('keydown', event => {
    if (!shown || shown.kind !== 'ready' || selected === undefined) {
      return;
    }
    const layers = shown.pattern.layers;
    const at = selected;
    const handled = () => event.preventDefault();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      handled();
      const step = layout?.mode === 'pitch' && event.shiftKey ? 12 : 1;
      move(event.key === 'ArrowUp' ? step : -step);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      handled();
      // A Chord's member leaves it; a lone note becomes a rest (#2187).
      apply(remove(layers, at), at);
    } else if (event.key === 's' || event.key === 'S') {
      handled();
      // The first of the two halves stays selected, inside its bracket.
      apply(split(layers, at), at + 1);
    } else if (event.key === 'm' || event.key === 'M') {
      handled();
      apply(merge(layers, at));
    } else if (event.key === 'Escape') {
      handled();
      select(undefined, false);
    }
  });

  // A press on a note selects it, and dragging it up or down moves it; a
  // press on a rest's cell writes the row's note or sound there.
  let drag: { from: number; y: number } | undefined;
  scroller.addEventListener('pointerdown', event => {
    const grid = scroller.firstElementChild as HTMLElement | null;
    if (!grid || !layout || !shown || shown.kind !== 'ready') {
      return;
    }
    scroller.focus();
    const bar = (event.target as HTMLElement).closest<HTMLElement>(
      '.piano-roll-note',
    );
    if (bar) {
      const from = Number(bar.dataset.from);
      say('');
      select(from);
      drag = { from, y: event.clientY };
      return;
    }
    const box = grid.getBoundingClientRect();
    const x = event.clientX - box.left - LABEL;
    const row = Math.floor((event.clientY - box.top) / ROW) - 1;
    const width = cycleWidth(layout);
    const cycle = Math.floor(x / width);
    const t = x / width - cycle;
    const rest = layout.rests.find(
      r => r.cycle === cycle && t >= r.begin && t < r.end,
    );
    const label = layout.rows[row]?.label;
    if (x < 0 || label === undefined) {
      return;
    }
    if (rest) {
      apply(fromRest(shown.pattern.layers, rest.from, label), rest.from);
      return;
    }
    // A note sounding then gains this row's note as a Chord (#2187): the
    // step written first, when several sound.
    const sounding = layout.notes
      .filter(n => n.cycle === cycle && t >= n.begin && t < n.end)
      .sort((a, b) => a.from - b.from)[0];
    if (!sounding) {
      say(
        'Only a rest’s or a note’s column takes a note; change the rhythm in the text.',
      );
      return;
    }
    const result = addToChord(
      shown.pattern.layers,
      sounding.from,
      label,
      layout.rows[row]!.note,
    );
    apply(result, 'problem' in result ? undefined : addedAt(result, label));
  });
  scroller.addEventListener('pointerup', event => {
    const started = drag;
    drag = undefined;
    if (!started || started.from !== selected) {
      return;
    }
    const rows = Math.round((started.y - event.clientY) / ROW);
    if (rows !== 0) {
      move(rows);
    }
  });
  range.addEventListener('click', () => {
    fullRange = !fullRange;
    draw();
  });

  return {
    show(state) {
      shown = state;
      // A selection whose step is gone is dropped.
      if (
        selected !== undefined &&
        state.kind === 'ready' &&
        stepAt(state.pattern.layers, selected)?.kind !== 'word'
      ) {
        selected = undefined;
      }
      // An invalid literal keeps its last grid, which the window greys.
      draw();
    },
    caret(at) {
      const note = layout?.notes.find(n => at >= n.from && at < n.to);
      if (note) {
        select(note.from, false);
      }
    },
    heard({ cycle, from, to, ms }) {
      if (!layout) {
        return;
      }
      const lit = layout.notes.flatMap((note, i) =>
        note.from === from &&
        note.to === to &&
        (cycle === undefined || note.cycle === cycle % layout!.cycles)
          ? [bars[i]!]
          : [],
      );
      if (lit[0]) {
        playhead.style.left = lit[0].style.left;
        playhead.hidden = false;
        // It goes once nothing has sounded for a moment, as after Stop.
        clearTimeout(idle);
        idle = setTimeout(() => (playhead.hidden = true), ms + 250);
      }
      for (const bar of lit) {
        bar.classList.add('playing');
        bar.style.background = 'var(--number)';
        const timer = setTimeout(() => {
          timers.delete(timer);
          bar.classList.remove('playing');
          bar.style.background = 'var(--accent)';
        }, ms);
        timers.add(timer);
      }
    },
    close() {
      clearTimeout(idle);
      for (const timer of timers) {
        clearTimeout(timer);
      }
    },
  };
};

export default defineAddOn({
  id: PIANO_ROLL_ADD_ON,
  version: PIANO_ROLL_VERSION,
  kinds: {},
  literalEditors: {
    'piano-roll': { label: 'Piano Roll', literal: 'mini-notation', open },
  },
});
