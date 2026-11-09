// The built-in Piano Roll Add-on (ADR 0175, #2181): a Literal Editor that
// shows a Mini-Notation literal as a grid, cycles left to right and a row per
// note pitch or sound name, and lights each step as it sounds. It only shows
// the literal; editing comes with #2182. It draws with plain DOM and Folio's
// style variables, so it needs nothing from Folio at run time.
import type { LiteralEditorHost, LiteralEditorView } from '../api';
import { defineAddOn } from '../api';
import type { LiteralState } from '../../literal-editors';
import { PIANO_ROLL_ADD_ON, PIANO_ROLL_VERSION } from './ids';
import { pianoRollLayout, type RollLayout } from './layout';

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
      },
    );
    grid.append(bar);
    return bar;
  });
  return { bars, grid };
};

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
  const scroller = el('div', {
    overflow: 'auto',
    maxWidth: '640px',
    maxHeight: '360px',
    padding: '0.3rem 0',
  });
  toolbar.append(summary, range);
  host.element.append(toolbar, scroller);

  const draw = () => {
    range.textContent = fullRange ? 'Fit pitches' : 'Full range';
    range.hidden = layout?.mode !== 'pitch';
    if (!shown || shown.kind !== 'ready') {
      return;
    }
    layout = pianoRollLayout(shown.pattern, { fullRange });
    range.hidden = layout.mode !== 'pitch';
    summary.textContent = `${layout.cycles} ${layout.cycles === 1 ? 'cycle' : 'cycles'}`;
    const drawn = drawGrid(layout);
    bars = drawn.bars;
    drawn.grid.append(playhead);
    scroller.replaceChildren(drawn.grid);
  };
  range.addEventListener('click', () => {
    fullRange = !fullRange;
    draw();
  });

  return {
    show(state) {
      shown = state;
      // An invalid literal keeps its last grid, which the window greys.
      draw();
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
