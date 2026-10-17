// Run on /tetris-test.html, a page without main.js, as described in README.md.
import { createTetrisProject, EMPTY_COLOUR } from '../src/examples/tetris';
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

const probe = document.createElement('span');
const sameColour = (a: string, b: string) => {
  probe.style.color = a;
  const left = probe.style.color;
  probe.style.color = b;
  return left === probe.style.color;
};
