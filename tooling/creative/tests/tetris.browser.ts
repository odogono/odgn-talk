// Run on /tetris-test.html, a page without main.js, as described in README.md.
import { createTetrisProject } from '../src/examples/tetris';
import { COLUMNS, EMPTY_COLOUR, ROWS } from '../src/examples/tetris-rules';
import { createCanvasTetrisProject } from '../src/examples/tetris-canvas';
import { CELL } from '../src/examples/tetris-layout';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean, tries = 150) => {
  for (let i = 0; i < tries; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out');
};

export const runBrowserTests = async () => {
  const { project } = await createTetrisProject();
  const shell = mountStack(project);
  mountPlay(shell);
  const toggle = document.querySelector<HTMLButtonElement>(
    '#menu [aria-pressed]',
  )!;
  const reader = document.querySelector<HTMLElement>('#reader')!;
  const lit = () =>
    [...reader.querySelectorAll<HTMLElement>('[data-element^="cell_"]')]
      .filter(node => {
        const fill = node.style.background || node.style.backgroundColor;
        return fill && !sameColour(fill, EMPTY_COLOUR);
      })
      .map(node => node.dataset.element!);
  const press = (key: string) => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    reader.dispatchEvent(event);
    return event.defaultPrevented;
  };
  toggle.click();
  reader.focus();
  await until(() => lit().length === 4);
  const spawned = lit().join();
  // Gravity moves the piece within about a second.
  await until(() => lit().join() !== spawned);
  const fell = lit().join();
  assert(press('ArrowLeft'), 'A handled arrow key would scroll the page');
  await until(() => lit().join() !== fell);
  // Hard drops lock pieces; time them to see whether painting keeps up.
  const started = performance.now();
  for (let i = 0; i < 5; i++) {
    const before = lit().length;
    press(' ');
    await until(() => lit().length > before);
  }
  const perDrop = (performance.now() - started) / 5;
  toggle.click();
  return {
    passed: true,
    perDropMs: Math.round(perDrop),
    checks: [
      'a piece spawns',
      'gravity moves it',
      'arrow keys move it without scrolling',
      'hard drops lock pieces',
    ],
  };
};

// Checks the worker, Canvas views, ordinary controls and retained Drawing
// together. Run after a reload, separately from the Element game above.
export const runCanvasBrowserTests = async () => {
  const { project } = await createCanvasTetrisProject();
  const shell = mountStack(project);
  mountPlay(shell);
  const browse = document.querySelector<HTMLButtonElement>(
    '#tool-modes [title^="Browse:"]',
  )!;
  const edit = document.querySelector<HTMLButtonElement>(
    '#tool-modes [title^="Edit:"]',
  )!;
  const reader = document.querySelector<HTMLElement>('#reader')!;
  const score = () =>
    reader.querySelector('[data-element="scoreText"]')?.textContent;
  const press = (key: string) =>
    reader.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  const drawing = () => {
    const board = shell.editor.page.elements.find(
      e => e.name === 'boardCanvas',
    );
    if (board?.kind !== 'canvas') {
      throw new Error('Missing board Canvas');
    }
    return board.drawing;
  };
  browse.click();
  await until(() => reader.querySelectorAll('canvas').length === 2);
  reader.focus();
  press('ArrowDown');
  await until(() => score() === 'Score: 1');
  reader.querySelector<HTMLElement>('[data-element="restartButton"]')!.click();
  await until(() => score() === 'Score: 0');
  reader.focus();
  press(' ');
  await until(() => Number(score()?.replace('Score: ', '')) > 1);
  edit.click();
  await until(() => drawing().length > 0);
  // Stop may interrupt paint: ADR 0116 deliberately retains partial frames.
  const rectangles = drawing().filter(command => command.op === 'rectangle');
  assert(
    rectangles.length > 0 && rectangles.length <= ROWS * COLUMNS,
    'Return to Edit did not retain a bounded board Drawing',
  );
  const previous = drawing();
  browse.click();
  await until(() => reader.querySelectorAll('canvas').length === 2);
  reader.focus();
  press('ArrowDown');
  await until(() => score() === 'Score: 1');
  edit.click();
  await until(() => drawing() !== previous);
  // Later rectangles paint over earlier ones: a move repaints the cells the
  // piece left with the empty colour.
  let colour = EMPTY_COLOUR;
  const cells = new Map<string, string>();
  for (const command of drawing()) {
    if (command.op === 'fill') {
      colour = (command.args[0] as string).slice(1, -1);
    } else if (command.op === 'rectangle') {
      cells.set(`${command.args[0]},${command.args[1]}`, colour);
    }
  }
  const filled = [...cells].filter(([, shown]) => shown !== EMPTY_COLOUR);
  assert(
    filled.every(([cell]) => Number(cell.split(',')[1]) < 3 * CELL),
    'The second Browse kept locked cells from the previous game',
  );
  assert(
    filled.length <= 4,
    'The second Browse kept cells from the previous game',
  );
  return {
    passed: true,
    checks: [
      'board and preview Canvas views',
      'keyboard input and ordinary New Game button',
      'Drawing retained in Edit',
      'second Browse starts a fresh game',
    ],
  };
};

const probe = document.createElement('span');
const sameColour = (a: string, b: string) => {
  probe.style.color = a;
  const left = probe.style.color;
  probe.style.color = b;
  return left === probe.style.color;
};
