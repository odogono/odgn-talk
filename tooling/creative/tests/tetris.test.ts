import { describe, expect, test } from 'bun:test';
import { createTetrisProject } from '../src/examples/tetris';
import { COLUMNS, EMPTY_COLOUR, ROWS } from '../src/examples/tetris-rules';
import { PlaySession, PUMP_FUEL } from '../src/play';
import { type Project, textOf } from '../src/model';
import { createCanvasTetrisProject } from '../src/examples/tetris-canvas';
import { type ExampleContent } from '../src/examples';
import { thaw } from '../src/readonly';
import { CELL, PREVIEW_CELL } from '../src/examples/tetris-layout';
import { text } from '@northtalk/ts';

// A Play Session on Tetris with an explicit clock, as the browser drives it.
const start = async (
  create: () => Promise<ExampleContent>,
  extraHandlers = '',
) => {
  const { project } = await create();
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
  // Read what a Canvas would paint, including later rectangles covering
  // earlier ones in the preview. No pixels or Script state are inspected.
  const drawingCells = (name: string, size: number) => {
    const canvas = play.page.elements.find(e => e.name === name);
    if (canvas?.kind !== 'canvas') {
      throw new Error(`Missing Canvas ${name}`);
    }
    let colour = EMPTY_COLOUR;
    const cells = new Map<string, string>();
    for (const command of play.drawingOf(canvas)) {
      if (command.op === 'fill') {
        colour = command.args[0]!.slice(1, -1);
      } else if (command.op === 'rectangle') {
        const [x, y, width, height] = command.args.map(Number);
        expect([width, height]).toEqual([size, size]);
        cells.set(`${y! / size + 1},${x! / size + 1}`, colour);
      }
    }
    return cells;
  };
  const filled = () => {
    if (play.page.elements.some(e => e.name === 'boardCanvas')) {
      return [...drawingCells('boardCanvas', CELL)]
        .filter(([, colour]) => colour !== EMPTY_COLOUR)
        .map(([cell]) => cell);
    }
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
  return { play, frame, key, filled, shown, settle, drawingCells };
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

// Fills the bottom `full` rows except column `gap`, sets the line count, and
// hangs a vertical I piece over the gap. The Handler is added to the Page
// Script for the test only, so the Example Project's source stays as shipped.
const setUp = async (
  create: () => Promise<ExampleContent>,
  full: number,
  gap: number,
  lineCount: number,
) => {
  const game = await start(
    create,
    `
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
`,
  );
  game.play.group.deliver(game.play.objects.get(game.play.page)!, {
    name: 'testSetUp',
    args: [],
  });
  await game.settle();
  return game;
};

for (const [suite, create] of [
  ['Element Tetris', createTetrisProject],
  ['Canvas Tetris', createCanvasTetrisProject],
] as const) {
  describe(suite, () => {
    test('a piece spawns in the top rows, four squares, centred', async () => {
      const { play, filled } = await start(create);
      expect(play.problems).toEqual([]);
      const cells = filled();
      expect(cells).toHaveLength(4);
      expect(Math.max(...rowsOf(cells))).toBeLessThanOrEqual(2);
      expect(Math.min(...columnsOf(cells))).toBeGreaterThanOrEqual(4);
      expect(Math.max(...columnsOf(cells))).toBeLessThanOrEqual(7);
    });

    test('arrows move the piece and the walls stop it', async () => {
      const { play, key, filled } = await start(create);
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
      const { frame, filled } = await start(create);
      const top = Math.min(...rowsOf(filled()));
      await frame(999);
      expect(Math.min(...rowsOf(filled()))).toBe(top);
      await frame(1);
      expect(Math.min(...rowsOf(filled()))).toBe(top + 1);
    });

    test('turning a T piece clockwise then back restores its squares', async () => {
      const game = await start(
        create,
        `
on testRotation
  put 3 into kind
  put item kind of shapes into squares
  put 2 into pieceTop
  put 3 into pieceLeft
  put true into changed
  paint
end testRotation
`,
      );
      game.play.group.deliver(game.play.objects.get(game.play.page)!, {
        name: 'testRotation',
        args: [],
      });
      await game.settle();
      const before = game.filled().sort();
      expect(before).toEqual(['3,5', '4,4', '4,5', '4,6']);
      await game.key('ArrowUp');
      expect(game.filled().sort()).toEqual(['3,5', '4,5', '4,6', '5,5']);
      await game.key('z');
      expect(game.filled().sort()).toEqual(before);
      expect(game.play.problems).toEqual([]);
    });

    test('soft and hard drops score and lock the piece on the floor', async () => {
      const { key, filled, shown } = await start(create);
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
      const { play, key, shown, filled } = await start(create);
      const gameOver = () =>
        play.isVisible(play.elementsOf().find(e => e.name === 'gameOver')!);
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

    test('a hard drop that fills four rows clears them and scores a Tetris', async () => {
      const game = await setUp(create, 4, 5, 0);
      await game.key(' ');
      expect(game.play.problems).toEqual([]);
      expect(game.shown('linesText')).toBe('Lines: 4');
      // 16 rows of hard drop at 2 each, then 800 for four lines at level 1.
      expect(game.shown('scoreText')).toBe('Score: 832');
      // Only the new piece is left.
      expect(game.filled()).toHaveLength(4);
    });

    test('every ten lines raises the level and speeds up gravity', async () => {
      const game = await setUp(create, 1, 5, 9);
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

    test('the Performance window captures Tetris workload without thresholds', async () => {
      const { play, frame, key } = await start(create);
      play.performance.start(1);
      for (let i = 0; i < 20; i++) {
        await frame(50);
      }
      await key('ArrowLeft');
      const snapshot = play.performance.snapshot(PUMP_FUEL)!;
      expect(snapshot.status).toBe('capturing');
      expect(snapshot.fuel).toBeGreaterThan(0);
      expect(snapshot.scripts.reduce((sum, s) => sum + s.fuel, 0)).toBe(
        snapshot.fuel,
      );
      expect(snapshot.scripts.some(s => s.frames?.delivered)).toBe(true);
    });
  });
}

test('Canvas Tetris ships empty surfaces with ordinary controls above or beside them', async () => {
  const { project } = await createCanvasTetrisProject();
  const elements = project.pages[0]!.elements;
  const canvases = elements.filter(e => e.kind === 'canvas');
  expect(canvases.map(e => e.name)).toEqual(['boardCanvas', 'previewCanvas']);
  for (const canvas of canvases) {
    expect(canvas.drawing).toEqual([]);
  }
  expect(elements.some(e => /^(cell|next)_/.test(e.name))).toBe(false);
  expect(elements.find(e => e.name === 'scoreText')?.kind).toBe('text');
  expect(elements.find(e => e.name === 'restartButton')?.kind).toBe('button');
  expect(elements.find(e => e.name === 'gameOverAlert')?.kind).toBe('group');
  expect(elements.findIndex(e => e.name === 'gameOverAlert')).toBeGreaterThan(
    elements.findIndex(e => e.name === 'boardCanvas'),
  );
});

const normalize = (cells: [string, string][]) => {
  const top = Math.min(...rowsOf(cells.map(([cell]) => cell)));
  const left = Math.min(...columnsOf(cells.map(([cell]) => cell)));
  return cells
    .map(([cell, colour]) => {
      const [r, c] = cell.split(',').map(Number);
      return `${r! - top},${c! - left}:${colour}`;
    })
    .sort();
};

test('the Canvas preview becomes the next falling piece, with the same shape and colour', async () => {
  const game = await start(createCanvasTetrisProject);
  const preview = [...game.drawingCells('previewCanvas', PREVIEW_CELL)].filter(
    ([, colour]) => colour !== EMPTY_COLOUR,
  );
  expect(preview).toHaveLength(4);
  await game.key(' ');
  const spawned = [...game.drawingCells('boardCanvas', CELL)].filter(
    ([cell, colour]) =>
      Number(cell.split(',')[0]) <= 2 && colour !== EMPTY_COLOUR,
  );
  expect(normalize(spawned)).toEqual(normalize(preview));
  expect(game.play.problems).toEqual([]);
});

test('a second Browse clears the retained last game and keeps only one frame of commands', async () => {
  const game = await start(createCanvasTetrisProject);
  for (let i = 0; i < 5; i++) {
    await game.key(' ');
  }
  expect(game.filled().length).toBeGreaterThan(4);
  game.play.commitDrawings();
  const saved = thaw<Project>(game.play.project);
  for (const canvas of saved.pages[0]!.elements.filter(
    e => e.kind === 'canvas',
  )) {
    expect(canvas.drawing.length).toBeGreaterThan(0);
    // A mark made in Edit must also disappear when openPage starts the game.
    canvas.drawing.push({ op: 'ellipse', args: ['1', '1', '2', '2'] });
  }
  const next = await start(async () => ({ project: saved, assets: new Map() }));
  expect(next.filled()).toHaveLength(4);
  expect(next.shown('scoreText')).toBe('Score: 0');
  for (let i = 0; i < 30; i++) {
    await next.key(i % 2 ? 'ArrowLeft' : 'ArrowRight');
  }
  for (const canvas of next.play.page.elements.filter(
    e => e.kind === 'canvas',
  )) {
    const drawing = next.play.drawingOf(canvas);
    expect(drawing.some(command => command.op === 'ellipse')).toBe(false);
    expect(drawing.filter(command => command.op === 'rectangle')).toHaveLength(
      canvas.name === 'boardCanvas' ? ROWS * COLUMNS : 20,
    );
    expect(drawing.length).toBeLessThan(410);
  }
  expect(next.play.problems).toEqual([]);
});
