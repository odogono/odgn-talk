import { expect, test } from 'bun:test';
import { CANVAS_LIMITS } from '@northtalk/tooling/canvas';
import {
  CELL,
  COLUMNS,
  createSonarProject,
  HOLD_MS,
  MARGIN,
  MINES,
  ROWS,
} from '../src/examples/sonar';
import { type CanvasElement } from '../src/model';
import { PlayHarness } from '../src/play-harness';
import { runProjectTests } from '../src/test-runner';

const middle = (i: number) => MARGIN + (i - 1) * CELL + CELL / 2;

// Sonar on the Play harness. `extend` adds Handlers to the sea's Script for
// the test only: pinging every safe cell, or the first mine, after a first
// ping has laid the mines.
const start = async () => {
  const { project } = await createSonarProject();
  const sea = project.pages[0]!.elements.find(e => e.name === 'sea')!;
  sea.script += `
on sweepSafely
  repeat for each r in 1..rows
    repeat for each c in 1..columns
      if not item c of item r of mines then
        pingAt centre(c), centre(r)
      end if
    end repeat
  end repeat
end sweepSafely
on hitMine
  repeat for each r in 1..rows
    repeat for each c in 1..columns
      if item c of item r of mines then
        pingAt centre(c), centre(r)
        return
      end if
    end repeat
  end repeat
end hitMine
`;
  const game = await PlayHarness.start(project);
  await game.frame(16);
  const deliver = async (name: string) => {
    const target = game.play.page.elements.find(e => e.name === 'sea')!;
    game.play.group.deliver(game.play.objects.get(target)!, {
      name,
      args: [],
    });
    await game.settle();
  };
  return { game, deliver, status: () => game.text('statusText') };
};

test('Sonar is one Canvas on a Page that fits the design width', async () => {
  const { project } = await createSonarProject();
  const page = project.pages[0]!;
  const sea = page.elements.find(e => e.name === 'sea') as CanvasElement;
  expect(sea.kind).toBe('canvas');
  expect(sea.width).toBe(MARGIN * 2 + COLUMNS * CELL);
  expect(sea.height).toBe(MARGIN * 2 + ROWS * CELL);
  for (const element of page.elements) {
    expect(element.left + element.width).toBeLessThanOrEqual(
      project.designWidth,
    );
  }
});

test('the shipped Test Script passes', async () => {
  const { project } = await createSonarProject();
  const results = await runProjectTests(project);
  expect(results.map(r => [r.test, r.ok, r.problems])).toEqual(
    results.map(r => [r.test, true, []]),
  );
  expect(results.length).toBeGreaterThan(0);
});

test('uncovering every safe cell wins and marks every mine', async () => {
  const { game, deliver, status } = await start();
  await game.click('sea', { x: middle(5), y: middle(5) });
  await deliver('sweepSafely');
  expect(status()).toBe('Sea cleared. Every mine is marked.');
  // Later clicks do nothing once the dive is over.
  await game.click('sea', { button: 2, x: middle(1), y: middle(1) });
  expect(status()).toBe('Sea cleared. Every mine is marked.');
});

test('pinging a mine sinks the dive, and New dive starts again', async () => {
  const { game, deliver, status } = await start();
  await game.click('sea', { x: middle(5), y: middle(5) });
  expect(status()).toBe(`${MINES} mines left`);
  await deliver('hitMine');
  expect(status()).toBe('Hull breached. Try a new dive.');
  await game.click('newDive');
  expect(status()).toBe(`${MINES} mines left`);
});

test('a short press pings and a long one plants a buoy without pinging', async () => {
  const { game, status } = await start();
  await game.hold('sea', HOLD_MS - 50);
  expect(status()).toBe(`${MINES} mines left`);
  await game.hold('sea', HOLD_MS);
  expect(status()).toBe(`${MINES - 1} mines left`);
  // The release after the long press doesn't ping.
  await game.click('sea', { x: middle(5), y: middle(5) });
  await game.click('sea', { button: 2, x: middle(5), y: middle(5) });
  expect(status()).toBe(`${MINES} mines left`);
});

test('a frame redraws the whole sea within the Canvas limits', async () => {
  const { game } = await start();
  await game.click('sea', { x: middle(5), y: middle(5) });
  for (let i = 0; i < 30; i++) {
    await game.frame(16);
  }
  const drawing = game.drawingOf('sea');
  expect(drawing.length).toBeLessThan(CANVAS_LIMITS.commands / 4);
  expect(game.play.problems).toEqual([]);
});
