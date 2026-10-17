import { expect, test } from 'bun:test';
import {
  COLUMNS,
  createTetrisProject,
  EMPTY_COLOUR,
  ROWS,
} from '../src/examples/tetris';
import { PlaySession } from '../src/play';
import { textOf } from '../src/model';
import { text } from '@odgn/northtalk';

// A Play Session on Tetris with an explicit clock, as the browser drives it.
const start = async (extraHandlers = '') => {
  const { project } = await createTetrisProject();
  project.pages[0]!.script += extraHandlers;
  const play = new PlaySession(project);
  let clock = 0n;
  const settle = async () => {
    for (let i = 0; i < 2000; i++) {
      const result = play.pump(clock);
      await Promise.resolve();
      if (result.state !== 'sliced') {
        return;
      }
    }
    throw new Error('Did not become idle');
  };
  await settle();
  const frame = async (ms: number) => {
    clock += BigInt(ms) * 1000n;
    play.frame(clock);
    await settle();
  };
  const key = async (name: string) => {
    play.send(play.page, 'keyDown', [text(name)]);
    await settle();
    await frame(1);
  };
  const fill = (name: string) =>
    (play.page.elements.find(e => e.name === name) as { fill: string }).fill;
  const filled = () => {
    const out: string[] = [];
    for (let r = 1; r <= ROWS; r++) {
      for (let c = 1; c <= COLUMNS; c++) {
        if (fill(`cell_${r}_${c}`) !== EMPTY_COLOUR) {
          out.push(`${r},${c}`);
        }
      }
    }
    return out;
  };
  const shown = (name: string) => {
    const element = play.page.elements.find(e => e.name === name)!;
    return element.kind === 'text' ? textOf(element) : '';
  };
  await frame(0);
  return { play, frame, key, filled, shown, settle };
};

const columnsOf = (cells: string[]) =>
  cells.map(cell => Number(cell.split(',')[1]));
const rowsOf = (cells: string[]) =>
  cells.map(cell => Number(cell.split(',')[0]));

test('Tetris builds 200 board cells and a 4x4 preview', async () => {
  const { project } = await createTetrisProject();
  const names = project.pages[0]!.elements.map(e => e.name);
  expect(names.filter(n => n.startsWith('cell_'))).toHaveLength(200);
  expect(names.filter(n => n.startsWith('next_'))).toHaveLength(16);
});

test('a piece spawns in the top rows, four squares, centred', async () => {
  const { play, filled } = await start();
  expect(play.problems).toEqual([]);
  const cells = filled();
  expect(cells).toHaveLength(4);
  expect(Math.max(...rowsOf(cells))).toBeLessThanOrEqual(2);
  expect(Math.min(...columnsOf(cells))).toBeGreaterThanOrEqual(4);
  expect(Math.max(...columnsOf(cells))).toBeLessThanOrEqual(7);
});

test('arrows move the piece and the walls stop it', async () => {
  const { play, key, filled } = await start();
  const before = Math.min(...columnsOf(filled()));
  await key('ArrowLeft');
  expect(Math.min(...columnsOf(filled()))).toBe(before - 1);
  for (let i = 0; i < 12; i++) {
    await key('ArrowLeft');
  }
  expect(Math.min(...columnsOf(filled()))).toBe(1);
  for (let i = 0; i < 12; i++) {
    await key('ArrowRight');
  }
  expect(Math.max(...columnsOf(filled()))).toBe(COLUMNS);
  expect(play.problems).toEqual([]);
});

test('gravity drops the piece once per second at level 1', async () => {
  const { frame, filled } = await start();
  const top = Math.min(...rowsOf(filled()));
  await frame(999);
  expect(Math.min(...rowsOf(filled()))).toBe(top);
  await frame(1);
  expect(Math.min(...rowsOf(filled()))).toBe(top + 1);
});

test('turning changes the shape unless the piece is the O', async () => {
  const { key, filled } = await start();
  const before = filled().sort();
  await key('ArrowDown');
  await key('ArrowDown');
  const lowered = filled().sort();
  await key('ArrowUp');
  const turned = filled().sort();
  await key('z');
  expect(filled().sort()).toEqual(lowered);
  const isO =
    new Set(rowsOf(before)).size === 2 && new Set(columnsOf(before)).size === 2;
  if (!isO) {
    expect(turned).not.toEqual(lowered);
  }
});

test('soft and hard drops score and lock the piece on the floor', async () => {
  const { key, filled, shown } = await start();
  await key('ArrowDown');
  expect(shown('scoreText')).toBe('Score: 1');
  await key(' ');
  const score = Number(shown('scoreText').replace('Score: ', ''));
  expect(score).toBeGreaterThan(1 + 2 * 15);
  // The locked piece sits on the floor and a new one has spawned.
  expect(Math.max(...rowsOf(filled()))).toBe(ROWS);
  expect(filled()).toHaveLength(8);
});

test('stacking pieces to the top ends the game, and Restart starts again', async () => {
  const { play, key, shown, filled } = await start();
  const gameOver = () =>
    play.page.elements.find(e => e.name === 'gameOver')!.visible;
  for (let i = 0; i < 40 && !gameOver(); i++) {
    await key(' ');
  }
  expect(gameOver()).toBe(true);
  expect(play.problems).toEqual([]);
  const restart = play.page.elements.find(e => e.name === 'restartButton')!;
  play.send(restart, 'click');
  await key('ArrowLeft');
  expect(gameOver()).toBe(false);
  expect(shown('scoreText')).toBe('Score: 0');
  expect(filled()).toHaveLength(4);
});

// Fills the bottom `full` rows except column `gap`, sets the line count, and
// hangs a vertical I piece over the gap. The Handler is added to the Page
// Script for the test only, so the Example Project's source stays as shipped.
const setUp = async (full: number, gap: number, lineCount: number) => {
  const game = await start(`
on testSetUp
  repeat for each r in ${ROWS - full + 1}..${ROWS}
    repeat for each c in 1..${COLUMNS}
      if c is not ${gap} then
        put 3 into item c of item r of board
      end if
    end repeat
  end repeat
  put ${lineCount} into lines
  put lines div 10 + 1 into level
  put 1 into kind
  put [[1, 2], [2, 2], [3, 2], [4, 2]] into squares
  put 0 into pieceTop
  put ${gap - 2} into pieceLeft
  put true into changed
  paint
end testSetUp
`);
  game.play.group.deliver(game.play.objects.get(game.play.page)!, {
    name: 'testSetUp',
    args: [],
  });
  await game.settle();
  return game;
};

test('a hard drop that fills four rows clears them and scores a Tetris', async () => {
  const game = await setUp(4, 5, 0);
  await game.key(' ');
  expect(game.play.problems).toEqual([]);
  expect(game.shown('linesText')).toBe('Lines: 4');
  // 16 rows of hard drop at 2 each, then 800 for four lines at level 1.
  expect(game.shown('scoreText')).toBe('Score: 832');
  // Only the new piece is left.
  expect(game.filled()).toHaveLength(4);
});

test('every ten lines raises the level and speeds up gravity', async () => {
  const game = await setUp(1, 5, 9);
  await game.key(' ');
  expect(game.shown('linesText')).toBe('Lines: 10');
  expect(game.shown('levelText')).toBe('Level: 2');
  // key() already let 1 ms pass since the new piece spawned.
  const top = Math.min(...rowsOf(game.filled()));
  await game.frame(923);
  expect(Math.min(...rowsOf(game.filled()))).toBe(top);
  await game.frame(1);
  expect(Math.min(...rowsOf(game.filled()))).toBe(top + 1);
});
