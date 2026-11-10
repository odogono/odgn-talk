// Dedicated page: the Piano Roll Add-on (ADR 0175, #2181) opened from the
// Code Browser on an 8-cycle lead pattern: a bar per step across every
// cycle, pitch rows with a full-range toggle, and only the sounding cycle's
// step lit.
import { AddOnLoader } from '../src/add-ons/loader';
import pianoRoll from '../src/add-ons/piano-roll';
import { PIANO_ROLL_REF } from '../src/add-ons/piano-roll/ids';
import { createProject } from '../src/model';
import { mountStack } from '../src/stack';
import { mountWindows } from '../src/windows';
import { patternTexts } from '../src/pattern-checks';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

new AddOnLoader().register(pianoRoll);

const LEAD = `<[f4 f4 g4 g4 g4 g4 c4 c4]
    [c4 c4 a4 a4 c5 c5 g4 g4]
    [g4 a4 c4 c4 c4 c4 a4 a4]
    [c5 c5 e5 e5 e5 e5 f4 f4]
    [a#4 a#4 a#4 a#4 c4 c4 a4 a4]
    [a4 a4 c4 c4 e4 e4 c5 c5]
    [f5 f5 d5 d5 d5 d5 f4 f4]
    [a4 a4 a4 a4 c4 c4 e4 e4]>`;

const project = createProject('Piano Roll');
project.addOns = [PIANO_ROLL_REF];
// A lone note and a lone sound, each to delete and write again (#2214).
project.script = `on openScript\n  loop \`\n    ${LEAD}\n    \` on lead\n  loop \`c4\` on pad\n  loop \`bd\` on drums\nend openScript`;
const shell = mountStack(project);
mountWindows();

const roll = () =>
  document.querySelector<HTMLElement>('.literal-editor-window');
const notes = () => [
  ...roll()!.querySelectorAll<HTMLElement>('.piano-roll-note'),
];
const lit = () => notes().filter(n => n.classList.contains('playing'));
const rows = () =>
  [...roll()!.querySelectorAll('.piano-roll-row')].map(r => r.textContent);

// Editing (#2182): the first step of the pattern, `f4` at its third
// character, through keys and presses on the grid.
const first = () => notes().find(n => n.dataset.from === '2')!;
const scroller = () =>
  roll()!.querySelector<HTMLElement>('.piano-roll-scroller')!;
const key = (key: string, shiftKey = false) =>
  scroller().dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }),
  );
const press = (target: Element, clientX: number, clientY: number) =>
  target.dispatchEvent(
    new PointerEvent('pointerdown', { clientX, clientY, bubbles: true }),
  );
const pattern = () => patternTexts(shell.editor.project.script)[0]!.text;
const hint = () => roll()!.querySelector('.piano-roll-hint')!.textContent;

// A press on the first step's column, in the row labelled `label`.
const rowTop = (label: string) =>
  [...roll()!.querySelectorAll('.piano-roll-row')]
    .find(r => r.textContent === label)!
    .getBoundingClientRect().top + 5;
const pressFirstColumn = (label: string) => {
  const grid = scroller().firstElementChild!;
  press(grid, grid.getBoundingClientRect().left + 45, rowTop(label));
};

// A press and a release in place, as a tap.
const tap = (target: Element, clientX: number, clientY: number) => {
  press(target, clientX, clientY);
  target.dispatchEvent(
    new PointerEvent('pointerup', { clientX, clientY, bubbles: true }),
  );
};

// A new window on the literal by the `index`th gutter mark (#2214).
const windowOn = async (index: number) => {
  const before = document.querySelectorAll('.literal-editor-window').length;
  const marks = document.querySelectorAll<HTMLButtonElement>(
    '.literal-editor-mark',
  );
  marks[index]!.click();
  await until(
    () => document.querySelectorAll('.literal-editor-window').length > before,
    'another window',
  );
  return [
    ...document.querySelectorAll<HTMLElement>('.literal-editor-window'),
  ].at(-1)!;
};
export const runBrowserTests = async () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = async (name: string, run: () => void | Promise<void>) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };

  shell.openScript(shell.editor.project);

  await test('the gutter mark opens the Piano Roll on the pattern', async () => {
    await until(
      () => !!document.querySelector('.literal-editor-mark'),
      'the gutter mark',
    );
    document.querySelector<HTMLButtonElement>('.literal-editor-mark')!.click();
    await until(() => !!roll(), 'the window');
    assert(roll()!.textContent!.includes('Piano Roll'), 'titled Piano Roll');
  });

  await test('every step of every cycle is a bar', () => {
    assert(roll()!.textContent!.includes('8 cycles'), 'eight cycles');
    assert(notes().length === 64, `${notes().length} bars`);
    const cycles = new Set(notes().map(n => n.dataset.cycle));
    assert(cycles.size === 8, `${cycles.size} cycles of bars`);
  });

  await test('rows fit the pitches with a margin, and can show all', () => {
    assert(rows()[0] === 'g#5', `top row ${rows()[0]}`);
    assert(rows().at(-1) === 'a3', `bottom row ${rows().at(-1)}`);
    roll()!.querySelector<HTMLButtonElement>('.piano-roll-range')!.click();
    assert(rows()[0] === 'c8', `full range top ${rows()[0]}`);
    roll()!.querySelector<HTMLButtonElement>('.piano-roll-range')!.click();
    assert(rows()[0] === 'g#5', 'fits again');
  });

  await test('only the sounding cycle’s step lights', async () => {
    const script = shell.editor.project.script;
    const { text } = patternTexts(script)[0]!;
    // The first step of the second alternative, which sounds in cycle 1.
    const from = text.indexOf('[c4 c4 a4') + 1;
    shell.code.light(0, script, { cycle: 9, from, to: from + 2, text }, 120);
    assert(lit().length === 1, `${lit().length} lit`);
    assert(lit()[0]!.dataset.cycle === '1', `cycle ${lit()[0]!.dataset.cycle}`);
    await until(() => lit().length === 0, 'the light to go out');
    const playhead = roll()!.querySelector<HTMLElement>(
      '.piano-roll-playhead',
    )!;
    await until(() => playhead.hidden === true, 'the playhead to go');
  });

  await test('a pressed note is selected, and ↑ raises it a semitone', () => {
    const bar = first().getBoundingClientRect();
    press(first(), bar.left + 2, bar.top + 2);
    assert(first().classList.contains('selected'), 'selected');
    key('ArrowUp');
    assert(pattern().startsWith('<[f#4 f4 g4'), pattern());
    assert(first().classList.contains('selected'), 'still selected');
    key('ArrowDown', true);
    assert(pattern().startsWith('<[f#3 f4 g4'), pattern());
    key('ArrowUp', true);
    key('ArrowDown');
    assert(pattern().startsWith('<[f4 f4 g4'), pattern());
  });

  await test('Delete makes a rest, and its cell takes a row’s note', () => {
    key('Delete');
    assert(pattern().startsWith('<[- f4 g4'), pattern());
    const grid = scroller().firstElementChild!;
    const g4 = [...roll()!.querySelectorAll('.piano-roll-row')].find(
      r => r.textContent === 'g4',
    )!;
    const box = grid.getBoundingClientRect();
    press(grid, box.left + 45, g4.getBoundingClientRect().top + 5);
    assert(pattern().startsWith('<[g4 f4 g4'), pattern());
  });

  await test('S splits the note within its step, and M merges it', () => {
    key('s');
    assert(pattern().startsWith('<[[g4 g4] f4'), pattern());
    key('m');
    assert(pattern().startsWith('<[g4 f4'), pattern());
  });

  await test('a cell under a note adds it as a Chord, and Delete takes it out (#2187)', () => {
    pressFirstColumn('c5');
    assert(pattern().startsWith('<[[g4,c5] f4'), pattern());
    pressFirstColumn('a4');
    assert(pattern().startsWith('<[[g4,a4,c5] f4'), pattern());
    const a4 = notes().find(n => n.classList.contains('selected'))!;
    assert(a4.dataset.from === '6', `selected ${a4.dataset.from}`);
    key('Delete');
    assert(pattern().startsWith('<[[g4,c5] f4'), pattern());
    const c5 = notes().find(n => n.dataset.from === '6')!;
    const bar = c5.getBoundingClientRect();
    press(c5, bar.left + 2, bar.top + 2);
    key('Delete');
    assert(pattern().startsWith('<[g4 f4'), pattern());
    assert(hint() === '', `hint ${hint()}`);
  });

  await test('a second tap on the selected note removes it (#2190)', () => {
    pressFirstColumn('c5');
    assert(pattern().startsWith('<[[g4,c5] f4'), pattern());
    const added = notes().find(n => n.classList.contains('selected'))!;
    const bar = added.getBoundingClientRect();
    tap(added, bar.left + 2, bar.top + 2);
    assert(pattern().startsWith('<[g4 f4'), pattern());
    assert(!notes().some(n => n.classList.contains('selected')), 'none');
    const g4 = notes().find(n => n.dataset.from === '2')!;
    const box = g4.getBoundingClientRect();
    tap(g4, box.left + 2, box.top + 2);
    assert(pattern().startsWith('<[g4 f4'), pattern());
  });

  await test('a press on a row name changes nothing', () => {
    const before = pattern();
    const label = [
      ...roll()!.querySelectorAll<HTMLElement>('.piano-roll-row'),
    ][0]!;
    const box = label.getBoundingClientRect();
    press(label, box.left + 5, box.top + 5);
    assert(pattern() === before, 'unchanged');
  });

  // Emptied patterns keep rows to write into (#2214), in their own windows.
  const textOf = (index: number) =>
    patternTexts(shell.editor.project.script)[index]!.text;
  const emptyThenWrite = (win: HTMLElement, index: number, row: string) => {
    const scroll = win.querySelector<HTMLElement>('.piano-roll-scroller')!;
    const bar = win.querySelector<HTMLElement>('.piano-roll-note')!;
    const box = bar.getBoundingClientRect();
    press(bar, box.left + 2, box.top + 2);
    scroll.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }),
    );
    assert(textOf(index) === '-', textOf(index));
    const labels = () =>
      [...win.querySelectorAll('.piano-roll-row')].map(r => r.textContent);
    assert(labels().includes(row), `rows ${labels().join(' ')}`);
    const rangeHidden =
      win.querySelector<HTMLButtonElement>('.piano-roll-range')!.hidden;
    const grid = scroll.firstElementChild!;
    const top =
      [...win.querySelectorAll('.piano-roll-row')]
        .find(r => r.textContent === row)!
        .getBoundingClientRect().top + 5;
    press(grid, grid.getBoundingClientRect().left + 45, top);
    return { labels, rangeHidden };
  };

  await test('deleting the sole note keeps pitch rows to write into', async () => {
    const win = await windowOn(1);
    const { labels, rangeHidden } = emptyThenWrite(win, 1, 'd4');
    assert(!rangeHidden, 'Full range offered');
    assert(textOf(1) === 'd4', textOf(1));
    assert(labels()[0] === 'f4', `top row ${labels()[0]}`);
  });

  await test('an emptied pitch grid shows the full range and fits again', async () => {
    const win = [
      ...document.querySelectorAll<HTMLElement>('.literal-editor-window'),
    ].at(-1)!;
    const scroll = win.querySelector<HTMLElement>('.piano-roll-scroller')!;
    const bar = win.querySelector<HTMLElement>('.piano-roll-note')!;
    const box = bar.getBoundingClientRect();
    press(bar, box.left + 2, box.top + 2);
    scroll.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }),
    );
    assert(textOf(1) === '-', textOf(1));
    const range = win.querySelector<HTMLButtonElement>('.piano-roll-range')!;
    const top = () => win.querySelector('.piano-roll-row')!.textContent;
    const fitted = top();
    range.click();
    assert(top() === 'c8', `full range top ${top()}`);
    range.click();
    assert(top() === fitted, `fits again ${top()}`);
  });

  await test('deleting the sole sound keeps its row to write into', async () => {
    const win = await windowOn(2);
    const { labels, rangeHidden } = emptyThenWrite(win, 2, 'bd');
    assert(rangeHidden, 'no Full range for sounds');
    assert(textOf(2) === 'bd', textOf(2));
    assert(labels().join(' ') === 'bd', `rows ${labels().join(' ')}`);
  });

  await test('another window on a rest-only pattern starts around C4', async () => {
    // The pad window was left at `-`, after its rows reached f4 (#2214).
    assert(textOf(1) === '-', textOf(1));
    for (const win of document.querySelectorAll<HTMLElement>(
      '.literal-editor-window',
    )) {
      win
        .querySelector<HTMLButtonElement>(
          '.window-close, [aria-label^="Close"]',
        )
        ?.click();
    }
    const win = await windowOn(1);
    const top = win.querySelector('.piano-roll-row')!.textContent;
    assert(top === 'd#4', `top row ${top}`);
  });

  return results;
};
