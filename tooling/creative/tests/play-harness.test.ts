import { expect, test } from 'bun:test';
import { createCanvasTetrisProject } from '../src/examples/tetris-canvas';
import { PlayHarness } from '../src/play-harness';

// Plays a few hard drops and returns everything the Canvases drew.
const play = async (seed?: bigint) => {
  const { project } = await createCanvasTetrisProject();
  const game = await PlayHarness.start(
    project,
    seed === undefined ? {} : { seed },
  );
  for (let i = 0; i < 6; i++) {
    await game.key(' ');
  }
  expect(game.play.problems).toEqual([]);
  return JSON.stringify([
    game.drawingOf('boardCanvas'),
    game.drawingOf('previewCanvas'),
  ]);
};

test('a run is the same every time from the default seed', async () => {
  expect(await play()).toBe(await play());
});

test('the seed decides the pieces', async () => {
  expect(await play(0n)).toBe(await play());
  expect(await play(7n)).toBe(await play(7n));
  expect(await play(7n)).not.toBe(await play());
});
