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
project.script = `on openScript\n  loop \`\n    ${LEAD}\n    \` on lead\nend openScript`;
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

  return results;
};
