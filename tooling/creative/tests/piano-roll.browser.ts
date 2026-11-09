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

  return results;
};
