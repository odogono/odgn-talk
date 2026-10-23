// The browser half of the Tetris benchmark (#1542), bundled into `dist/` by
// bench-tetris-browser.ts and run on a page without main.js. It Browses one
// Tetris with the Performance window open, plays the scripted game on
// requestAnimationFrame, and returns frame rate, Fuel and the page's time
// handling the worker's views.
import { createCanvasTetrisProject } from '../src/examples/tetris-canvas';
import { createTetrisProject } from '../src/examples/tetris';
import { type PerformanceSnapshot } from '../src/performance';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';
import { showWindow } from '../src/windows';
import { KEY_EVERY, SEED, tetrisKeys } from './bench-tetris-moves';

const until = async (check: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out');
};
const nextFrame = () =>
  new Promise<number>(resolve => requestAnimationFrame(resolve));

export const runTetrisBench = async (
  game: 'element' | 'canvas',
  ms: number,
) => {
  // Time the page's handling of each worker message, which applies views
  // and paints Elements or Canvases, and keep the latest snapshot.
  let snapshot: PerformanceSnapshot | undefined;
  let views = 0;
  let handlerMs = 0;
  const Base = Worker;
  globalThis.Worker = class extends Base {
    set onmessage(handler: ((event: MessageEvent) => void) | null) {
      super.onmessage =
        handler &&
        ((event: MessageEvent) => {
          const response = event.data?.response;
          if (response?.kind === 'performance') {
            snapshot = response.snapshot;
          }
          const started = performance.now();
          handler(event);
          if (response?.kind === 'view') {
            views++;
            handlerMs += performance.now() - started;
          }
        });
    }
  };
  const { project } =
    game === 'canvas'
      ? await createCanvasTetrisProject()
      : await createTetrisProject();
  const shell = mountStack(project);
  mountPlay(shell);
  const button = (title: string) =>
    document.querySelector<HTMLButtonElement>(
      `#tool-modes [title^="${title}:"]`,
    )!;
  const reader = document.querySelector<HTMLElement>('#reader')!;
  const node = (name: string) =>
    reader.querySelector<HTMLElement>(`[data-element="${name}"]`);
  // The Performance window captures from the start when open at Browse.
  showWindow('performance-window');
  // Browse seeds `random` from the clock; give it the benchmark's seed.
  const now = Date.now;
  Date.now = () => Number(SEED);
  button('Browse').click();
  Date.now = now;
  await until(() => !!node('scoreText'));
  reader.focus();
  const keys = tetrisKeys();
  const press = (key: string) => {
    for (const type of ['keydown', 'keyup']) {
      reader.dispatchEvent(
        new KeyboardEvent(type, { key, code: key, bubbles: true }),
      );
    }
  };
  let frames = 0;
  let pressed = 0;
  let games = 1;
  let longFrames = 0;
  let last = await nextFrame();
  const started = last;
  while (last - started < ms) {
    const time = await nextFrame();
    // A frame that took over 1.5 vibrations of a 60 Hz display.
    if (time - last > 25) {
      longFrames++;
    }
    last = time;
    frames++;
    if (frames % KEY_EVERY === 0) {
      if (node('gameOverAlert')?.checkVisibility()) {
        games++;
        node('restartButton')!.click();
        reader.focus();
      } else {
        press(keys[pressed++ % keys.length]!);
      }
    }
  }
  const elapsed = last - started;
  const score = node('scoreText')?.textContent;
  button('Edit').click();
  await until(() => snapshot?.status === 'stopped');
  const final = snapshot!;
  const delivered = final.scripts.reduce(
    (sum, script) => sum + (script.frames?.delivered ?? 0),
    0,
  );
  const skipped = final.scripts.reduce(
    (sum, script) => sum + (script.frames?.skipped ?? 0),
    0,
  );
  const frameFuel = final.scripts
    .flatMap(script => script.origins)
    .filter(row => row.origin === 'frame')
    .reduce((sum, row) => sum + row.fuel, 0);
  return {
    passed: true,
    game,
    score,
    games,
    seconds: elapsed / 1000,
    pageFps: (frames / elapsed) * 1000,
    longFrames,
    deliveredFps: delivered / final.elapsed,
    skipped,
    fuelPerFrame: final.fuel / delivered,
    frameFuelPerFrame: frameFuel / delivered,
    viewsPerFrame: views / frames,
    viewMsPerFrame: handlerMs / frames,
  };
};
