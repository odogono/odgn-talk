import { expect, test } from 'bun:test';
import { type Envelope } from '@northtalk/tooling/worker-supervisor';
import { StackEditor } from '../src/editing';
import { runInEdit, settle } from '../src/message';
import {
  createElement,
  createProject,
  duplicateElement,
  type CanvasElement,
  type Project,
} from '../src/model';
import { PlaySession } from '../src/play';
import { PlayHost } from '../src/play-host';
import { commitDrawings, PlayMirror } from '../src/play-mirror';
import { type PlayRequest } from '../src/play-protocol';
import {
  readProjectFile,
  validateProject,
  writeProjectFile,
} from '../src/project-file';
import { scriptOwners } from '../src/script-manifest';

const fixture = () => {
  const project = createProject('Drawing');
  project.pages[0]!.elements.push(
    createElement('canvas', 'board'),
    createElement('button', 'go'),
  );
  return project;
};
const canvasOf = (project: { pages: readonly { elements: unknown }[] }) =>
  (project.pages[0]!.elements as CanvasElement[])[0]!;

const run = async (play: PlaySession, command: string) => {
  const started = play.runMessage(command);
  return started.ok
    ? settle(play, started.result, () => play.pump(0n))
    : { error: started.error };
};
const drain = (play: PlaySession) => {
  for (let i = 0; i < 100; i++) {
    if (play.pump(0n).state !== 'sliced') {
      return;
    }
  }
};
const drawn = (play: PlaySession) =>
  play.drawingOf(canvasOf(play.project)).map(c => [c.op, ...c.args]);

test('drawing appends commands to the Play Drawing, not the Project', async () => {
  const project = fixture();
  const play = new PlaySession(project);
  expect(
    await run(
      play,
      'ask canvas to fill board, "#ff0000"\n ask canvas to rectangle board, 10, 20, 30.5, 40',
    ),
  ).toEqual({ text: undefined });
  expect(drawn(play)).toEqual([
    ['fill', '"#ff0000"'],
    ['rectangle', '10', '20', '30.5', '40'],
  ]);
  expect(canvasOf(project).drawing).toEqual([]);
  expect(play.problems).toEqual([]);
});

test('clear and background reset the Drawing to the current style', async () => {
  const play = new PlaySession(fixture());
  await run(
    play,
    `tell canvas
  fill board, "#ff0000"
  noStroke board
  strokeWidth board, 3
  line board, 0, 0, 5, 5
  fill board, "#00ff00"
end tell`,
  );
  await run(play, 'ask canvas to clear board');
  const style = [['fill', '"#00ff00"'], ['noStroke'], ['strokeWidth', '3']];
  expect(drawn(play)).toEqual(style);
  // A background every frame keeps one frame's commands.
  for (let frame = 0; frame < 3; frame++) {
    await run(
      play,
      'ask canvas to background board, "#000000"\n ask canvas to ellipse board, 50, 50, 10, 10',
    );
  }
  expect(drawn(play)).toEqual([
    ...style,
    ['background', '"#000000"'],
    ['ellipse', '50', '50', '10', '10'],
  ]);
});

test('shapes and stroke styles join the retained list', async () => {
  const play = new PlaySession(fixture());
  await run(
    play,
    `tell canvas
  strokeCap board, "round"
  strokeJoin board, "bevel"
  point board, 5, 6
  circle board, 20, 20, 10
  triangle board, 0, 0, 10, 0, 5, 8
  arc board, 40, 40, 20, 10, 0, pi / 2
  roundedRectangle board, 1, 2, 30, 20, 4
end tell`,
  );
  expect(play.problems).toEqual([]);
  expect(drawn(play)).toEqual([
    ['strokeCap', '"round"'],
    ['strokeJoin', '"bevel"'],
    ['point', '5', '6'],
    ['circle', '20', '20', '10'],
    ['triangle', '0', '0', '10', '0', '5', '8'],
    ['arc', '40', '40', '20', '10', '0', drawn(play)[5]![6]!],
    ['roundedRectangle', '1', '2', '30', '20', '4'],
  ]);
  expect(Number(drawn(play)[5]![6])).toBeCloseTo(Math.PI / 2);
  // Cap and join are current style, so they survive a clear.
  await run(play, 'ask canvas to strokeCap board, "square"');
  await run(play, 'ask canvas to clear board');
  expect(drawn(play)).toEqual([
    ['strokeCap', '"square"'],
    ['strokeJoin', '"bevel"'],
  ]);
});

test('polygon and polyline keep their points as one command each', async () => {
  const play = new PlaySession(fixture());
  await run(
    play,
    `put [] into points
repeat for each i in 0..2
  put [...points, [i * 10, 5 - i]] into points
end repeat
tell canvas
  polygon board, points
  polyline board, [[0, 0], [1.5, 2]]
end tell`,
  );
  expect(play.problems).toEqual([]);
  expect(drawn(play)).toEqual([
    [
      'polygon',
      [
        ['0', '5'],
        ['10', '4'],
        ['20', '3'],
      ],
    ],
    [
      'polyline',
      [
        ['0', '0'],
        ['1.5', '2'],
      ],
    ],
  ]);
});

test('bad points are catchable', async () => {
  const play = new PlaySession(fixture());
  for (const call of [
    'polygon board, [[1, 1]]',
    'polygon board, [[1, 1], [2]]',
    'polyline board, [[1, 1], [2, 2000000]]',
    'polygon board, many',
  ]) {
    expect(
      await run(
        play,
        `put [[1, 1]] into many
repeat 10 times
  put [...many, ...many] into many
end repeat
try\n ask canvas to ${call}\ncatch e\n return e's code\nend try`,
      ),
    ).toMatchObject({ text: 'invalid canvas argument' });
  }
  expect(drawn(play)).toEqual([]);
});

test('bad shape and stroke style arguments are catchable', async () => {
  const play = new PlaySession(fixture());
  for (const call of [
    'strokeCap board, "flat"',
    'strokeJoin board, "sharp"',
    'circle board, 1, 1, 0',
    'arc board, 1, 1, 10, -1, 0, 1',
    'roundedRectangle board, 0, 0, 10, 10, -1',
  ]) {
    expect(
      await run(
        play,
        `try\n ask canvas to ${call}\ncatch e\n return e's code\nend try`,
      ),
    ).toMatchObject({ text: 'invalid canvas argument' });
  }
  expect(drawn(play)).toEqual([]);
});

test('transforms are retained, and push and pop save the style', async () => {
  const play = new PlaySession(fixture());
  await run(
    play,
    `tell canvas
  fill board, "#ff0000"
  push board
  translate board, 10, 20.5
  rotate board, 0.5
  scale board, 2, -1
  fill board, "#00ff00"
  rectangle board, 0, 0, 5, 5
  pop board
end tell`,
  );
  expect(drawn(play)).toEqual([
    ['fill', '"#ff0000"'],
    ['push'],
    ['translate', '10', '20.5'],
    ['rotate', '0.5'],
    ['scale', '2', '-1'],
    ['fill', '"#00ff00"'],
    ['rectangle', '0', '0', '5', '5'],
    ['pop'],
  ]);
  // The style pop restored survives a clear.
  await run(play, 'ask canvas to clear board');
  expect(drawn(play)).toEqual([['fill', '"#ff0000"']]);
});

test('clear resets the transform and empties the push stack', async () => {
  const play = new PlaySession(fixture());
  await run(
    play,
    `tell canvas
  push board
  translate board, 5, 5
  fill board, "#00ff00"
  background board, "#000000"
end tell`,
  );
  expect(drawn(play)).toEqual([
    ['fill', '"#00ff00"'],
    ['background', '"#000000"'],
  ]);
  expect((await run(play, 'ask canvas to pop board')).error).toContain(
    'pop needs a matching push',
  );
});

test('an unmatched pop and deep push nesting are catchable', async () => {
  const play = new PlaySession(fixture());
  expect(
    await run(
      play,
      `try
  ask canvas to pop board
catch {code: "invalid canvas argument"}
  return "caught"
end try`,
    ),
  ).toMatchObject({ text: 'caught' });
  await run(play, 'ask canvas to push board\n'.repeat(64));
  expect(drawn(play)).toHaveLength(64);
  expect((await run(play, 'ask canvas to push board')).error).toContain(
    'push nests at most 64 deep',
  );
  expect(drawn(play)).toHaveLength(64);
});

test('a frame Script painting background keeps one frame of commands', async () => {
  const project = fixture();
  canvasOf(project).script = `on frame elapsed
  tell canvas
    background me, "#1d2b35"
    noStroke me
    fill me, "#e0a458"
    ellipse me, 60, 40, 30, 30
    fill me, "#ffffff"
    textSize me, 16
    text me, "Score: 10", 8, 20
  end tell
end frame`;
  const play = new PlaySession(project);
  for (let frame = 0n; frame < 5n; frame++) {
    play.frame(frame * 16_000n);
    drain(play);
    // A Script's next frame waits for its last frame Run to settle.
    await Promise.resolve();
  }
  expect(play.problems).toEqual([]);
  expect(drawn(play).map(([op]) => op)).toEqual([
    'noStroke',
    'fill',
    'textSize',
    'background',
    'noStroke',
    'fill',
    'ellipse',
    'fill',
    'textSize',
    'text',
  ]);
});

test('a full Drawing raises a catchable canvas limit', async () => {
  const project = fixture();
  canvasOf(project).drawing = Array.from({ length: 10_000 }, () => ({
    op: 'line',
    args: ['0', '0', '1', '1'],
  }));
  const play = new PlaySession(project);
  expect(
    await run(
      play,
      `try
  ask canvas to line board, 0, 0, 2, 2
catch {code: "canvas limit"}
  return "full"
end try`,
    ),
  ).toMatchObject({ text: 'full' });
  expect(drawn(play)).toHaveLength(10_000);
  // Clearing makes room again.
  await run(
    play,
    'ask canvas to clear board\n ask canvas to line board, 0, 0, 2, 2',
  );
  expect(drawn(play)).toEqual([['line', '0', '0', '2', '2']]);
});

test('bad arguments and non-Canvas targets are catchable errors', async () => {
  const play = new PlaySession(fixture());
  for (const [command, message] of [
    ['fill board, "red"', 'Colors use #RRGGBB or #RRGGBBAA'],
    ['rectangle board, 0, 0, -1, 4', 'must be positive'],
    ['line board, 0, 0, 2000000, 0', 'within ±1000000'],
    ['fill go, "#ff0000"', 'Expected "canvas"'],
  ] as const) {
    expect((await run(play, `ask canvas to ${command}`)).error).toContain(
      message,
    );
  }
  expect(drawn(play)).toEqual([]);
  expect(
    await run(
      play,
      `try
  ask canvas to fill board, "red"
catch {code: "invalid canvas argument"}
  return "caught"
end try`,
    ),
  ).toMatchObject({ text: 'caught' });
});

test('cloning a Canvas copies its Drawing', async () => {
  const project = fixture();
  const play = new PlaySession(project);
  await run(play, 'ask canvas to line board, 0, 0, 3, 3');
  await run(
    play,
    'ask elements to clone board into copy\n ask canvas to clear board\n ask canvas to line copy, 1, 1, 2, 2',
  );
  const copy = play.page.elements.find(
    e => e.name !== 'board' && e.kind === 'canvas',
  );
  expect(copy).toBeDefined();
  expect(play.drawingOf(copy as CanvasElement).map(c => c.args)).toEqual([
    ['0', '0', '3', '3'],
    ['1', '1', '2', '2'],
  ]);
  expect(drawn(play)).toEqual([]);
  // Duplicating in Edit copies the Drawing as well.
  const board = canvasOf(project);
  board.drawing = [{ op: 'noFill', args: [] }];
  const duplicate = duplicateElement(board, new Set(['board']));
  expect(duplicate).toMatchObject({ name: 'board2', drawing: board.drawing });
  expect((duplicate as CanvasElement).drawing).not.toBe(board.drawing);
});

// A host wired straight to a mirror, as the page and worker would be.
const hosted = (project: Project) => {
  let id = 1;
  const mirror = new PlayMirror(() => {});
  const host = new PlayHost(sent => {
    const reply = structuredClone(sent);
    if (reply.response.kind === 'view') {
      mirror.apply(reply.response);
    }
  });
  const request = (request: PlayRequest) =>
    host.receive({ id: id++, request } satisfies Envelope<PlayRequest>);
  request({
    kind: 'open',
    session: 1,
    project: structuredClone(project),
    pageIndex: 0,
    seed: 0n,
  });
  return { mirror, request };
};
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
};

test('the page gets each Drawing change and commits it on return to Edit', async () => {
  const project = fixture();
  canvasOf(project).drawing = [{ op: 'noFill', args: [] }];
  const editor = new StackEditor(project);
  const owners = scriptOwners(editor.project);
  const { mirror, request } = hosted(editor.snapshot() as Project);
  const board = () => mirror.elementsOf()[0] as CanvasElement;
  expect(board().drawing).toEqual([{ op: 'noFill', args: [] }]);
  const shown = board().drawing;
  request({
    kind: 'message',
    session: 1,
    text: 'ask canvas to line board, 0, 0, 4, 4',
  });
  await until(() => board().drawing.length === 2);
  // An addition extends the same list, so the renderer paints only it.
  expect(board().drawing).toBe(shown);
  request({
    kind: 'message',
    session: 1,
    text: 'ask canvas to background board, "#123456"\n ask canvas to line board, 1, 2, 3, 4',
  });
  await until(() => board().drawing.length === 3);
  const final = [
    { op: 'noFill', args: [] },
    { op: 'background', args: ['"#123456"'] },
    { op: 'line', args: ['1', '2', '3', '4'] },
  ];
  expect(board().drawing).toEqual(final);
  request({ kind: 'stop', session: 1 });
  commitDrawings(editor, owners, mirror);
  expect(canvasOf(editor.project).drawing).toEqual(final);
  editor.undo();
  expect(canvasOf(editor.project).drawing).toEqual([
    { op: 'noFill', args: [] },
  ]);
});

test('a Message Box line in Edit draws as one undoable edit', async () => {
  const editor = new StackEditor(fixture());
  expect(
    await runInEdit(
      editor,
      'ask canvas to fill board, "#ff0000"\n ask canvas to line board, 0, 0, 1, 1',
    ),
  ).toEqual({ text: undefined });
  await runInEdit(editor, 'ask canvas to line board, 1, 1, 2, 2');
  expect(canvasOf(editor.project).drawing.map(c => c.op)).toEqual([
    'fill',
    'line',
    'line',
  ]);
  editor.undo();
  expect(canvasOf(editor.project).drawing.map(c => c.op)).toEqual([
    'fill',
    'line',
  ]);
  editor.clearDrawing(canvasOf(editor.project));
  expect(canvasOf(editor.project).drawing).toEqual([]);
  editor.undo();
  expect(canvasOf(editor.project).drawing).toHaveLength(2);
});

test('the Project file keeps the Drawing and rejects invalid ones', async () => {
  const project = fixture();
  canvasOf(project).drawing = [
    { op: 'fill', args: ['"#ff0000"'] },
    { op: 'text', args: ['"Score: 10"', '4', '12.5'] },
    { op: 'push', args: [] },
    { op: 'rotate', args: ['-0.5'] },
    {
      op: 'polygon',
      args: [
        [
          ['0', '0'],
          ['10', '0'],
          ['5', '8.5'],
        ],
      ],
    },
  ];
  const loaded = await readProjectFile(
    await writeProjectFile(project, new Map()),
  );
  expect(canvasOf(loaded.project).drawing).toEqual(canvasOf(project).drawing);
  for (const drawing of [
    [{ op: 'fill', args: ['"red"'] }],
    [{ op: 'size', args: ['10', '10'] }],
    [{ op: 'clear', args: [] }],
    [{ op: 'line', args: ['0', '0'] }],
    [{ op: 'pop', args: [] }],
    [{ op: 'polygon', args: [[['0', '0']]] }],
    [{ op: 'polygon', args: [[['0', '0'], ['1']]] }],
    // Numbers, not their display spelling.
    [
      {
        op: 'polyline',
        args: [
          [
            ['0', '0'],
            [1, 2],
          ],
        ],
      },
    ] as never,
    [{ op: 'rectangle', args: [[['0', '0']], '1', '1', '1'] }],
    Array.from({ length: 65 }, () => ({ op: 'push', args: [] })),
    Array.from({ length: 10_001 }, () => ({ op: 'noFill', args: [] })),
  ]) {
    canvasOf(project).drawing = drawing;
    expect(validateProject(project)).toMatchObject([
      { path: 'pages[0].elements[0].drawing' },
    ]);
  }
});

// ADR 0116: the page never gets a Drawing cleared but not yet redrawn.
const redraw = (script: string) => {
  const project = fixture();
  project.pages[0]!.elements.find(e => e.name === 'go')!.script = script;
  const play = new PlaySession(project);
  drain(play);
  play.takeDrawingChanges();
  play.send(
    play.page.elements.find(e => e.name === 'go')!,
    'click',
  );
  return play;
};

test('a reset Drawing is held back until the Run that reset it ends', () => {
  const play = redraw(`on click
  ask canvas to clear board
  repeat for each i in 1..2000
    ask canvas to rectangle board, 0, 0, i, 1
  end repeat
end click`);
  const board = canvasOf(play.project);
  expect(play.problems.map(p => `${p.line}: ${p.message}`)).toEqual([]);
  expect(play.pump(0n).state).toBe('sliced');
  expect(drawn(play).length).toBeGreaterThan(0);
  expect(play.takeDrawingChanges()).toEqual([]);
  drain(play);
  expect(play.takeDrawingChanges()).toEqual([board]);
  expect(play.drawingChangesSince(board)?.commands).toHaveLength(2000);
});

test('a reset Drawing is released when its Run waits', () => {
  const play = redraw(`on click
  ask canvas to clear board
  ask canvas to rectangle board, 0, 0, 1, 1
  wait 1000 ms
  ask canvas to rectangle board, 1, 1, 1, 1
end click`);
  drain(play);
  expect(play.problems).toEqual([]);
  expect(play.takeDrawingChanges()).toEqual([canvasOf(play.project)]);
  expect(drawn(play)).toHaveLength(1);
});
