import { expect, test } from 'bun:test';
import { StackEditor } from '../src/editing';
import { runInEdit, sessionCommand, settle } from '../src/message';
import {
  createElement,
  createPage,
  createProject,
  ELEMENT_KINDS,
} from '../src/model';
import { PlaySession } from '../src/play';

const fixture = () => {
  const project = createProject('Story');
  project.pages[0]!.elements.push(createElement('button', 'button1'));
  project.pages.push(createPage('page2'));
  return project;
};

const run = async (play: PlaySession, command: string) => {
  const started = play.runMessage(command);
  return started.ok
    ? settle(play, started.result, () => play.pump(0n))
    : { error: started.error };
};

test('a command changes Play State and an expression prints its value', async () => {
  const project = fixture();
  const before = structuredClone(project);
  const play = new PlaySession(project);
  expect(await run(play, 'set the visible of button1 to false')).toEqual({
    text: undefined,
  });
  expect(play.page.elements[0]!.visible).toBe(false);
  expect(await run(play, 'the label of button1')).toEqual({ text: 'Button' });
  expect(await run(play, '3 + 4')).toEqual({ text: '7' });
  expect(project).toEqual(before);
  expect(play.problems).toEqual([]);
});

test('Script properties round-trip across Element kinds, Pages and the Project', async () => {
  const project = createProject('Properties');
  project.pages[0]!.elements = ELEMENT_KINDS.map(kind =>
    createElement(kind, `${kind}1`),
  );
  const before = structuredClone(project);
  const play = new PlaySession(project);
  const writes = [
    ['text1', 'text', '"Plain"', 'Plain'],
    ['text1', 'textAlign', '"right"', 'right'],
    ['text1', 'textColor', '"red"', 'red'],
    ['text1', 'textSize', '18', '18'],
    ['text1', 'font', '"serif"', 'serif'],
    ['text1', 'editable', 'true', 'true'],
    ['image1', 'image', '"photo"', 'photo'],
    ['button1', 'label', '"Go"', 'Go'],
    ['button1', 'fill', '"blue"', 'blue'],
    ['button1', 'textColor', '"white"', 'white'],
    ['rectangle1', 'fill', '"green"', 'green'],
    ['rectangle1', 'stroke', '"black"', 'black'],
    ['rectangle1', 'thickness', '0', '0'],
    ['ellipse1', 'thickness', '4', '4'],
    // Preserve the existing line policy; only rectangle/ellipse reject negatives.
    ['line1', 'thickness', '-1', '-1'],
    ['line1', 'stroke', '"yellow"', 'yellow'],
    ['page1', 'background', '"pink"', 'pink'],
    ['page1', 'height', '700', '700'],
  ];
  for (const kind of ELEMENT_KINDS) {
    const owner = `${kind}1`;
    writes.push(
      [owner, 'left', '100', '100'],
      [owner, 'top', '200', '200'],
      [owner, 'visible', 'false', 'false'],
    );
    if (kind !== 'group') {
      writes.push(
        [owner, 'width', '150', '150'],
        [owner, 'height', '80', '80'],
      );
    }
    expect(await run(play, `the name of ${owner}`)).toEqual({ text: owner });
  }
  for (const [owner, field, value, result] of writes) {
    expect(await run(play, `set the ${field} of ${owner} to ${value}`)).toEqual(
      {
        text: undefined,
      },
    );
    expect(await run(play, `the ${field} of ${owner}`)).toEqual({
      text: result,
    });
  }
  expect(await run(play, 'the name of page1')).toEqual({ text: 'page1' });
  expect(await run(play, 'the name of project')).toEqual({
    text: 'Properties',
  });
  for (const field of ['width', 'height']) {
    expect(
      (await run(play, `set the ${field} of group1 to 10`)).error,
    ).toBeDefined();
    expect(await run(play, `the ${field} of group1`)).toEqual({ text: '0' });
  }
  expect(project).toEqual(before);
  expect(play.problems).toEqual([]);
});

test('errors name the command line, not the Errors window', async () => {
  const play = new PlaySession(fixture());
  expect(await run(play, '1 / 0')).toEqual({
    error: 'line 1: Division by zero',
  });
  expect((await run(play, 'set x to')).error).toContain('line 1');
  expect(play.problems).toEqual([]);
});

test('in Edit a command is one undoable authored edit that keeps session-local ids', async () => {
  const project = fixture();
  const editor = new StackEditor(project);
  const button = editor.page.elements[0]!;
  expect(await runInEdit(editor, 'set the label of button1 to "Go"')).toEqual({
    text: undefined,
  });
  expect(editor.page.elements[0]!.id).toBe(button.id);
  expect(editor.page.elements[0]).toBe(button);
  expect(editor.page.elements[0]).toHaveProperty('label', 'Go');
  editor.undo();
  expect(editor.page.elements[0]).toHaveProperty('label', 'Button');
});

test('in Edit, created Elements are kept and navigation moves the editor', async () => {
  const editor = new StackEditor(fixture());
  await runInEdit(editor, 'ask elements to create "rectangle", thisPage');
  expect(editor.page.elements.map(e => e.kind)).toEqual([
    'button',
    'rectangle',
  ]);
  await runInEdit(editor, 'tell pages to show page2');
  expect(editor.page.name).toBe('page2');
});

test('in Edit, a failing command changes nothing and read-only refuses', async () => {
  const project = fixture();
  const editor = new StackEditor(project);
  const before = editor.snapshot();
  expect(
    (
      await runInEdit(
        editor,
        'set the label of button1 to "X"\n put 1 / 0 into y',
      )
    ).error,
  ).toContain('Division by zero');
  expect(editor.project).toEqual(before);
  expect(editor.canUndo).toBe(false);
  editor.readOnly = true;
  expect(
    (await runInEdit(editor, 'set the label of button1 to "X"')).error,
  ).toContain('read-only');
  expect(editor.project).toEqual(before);
});

test('hide and show are Host Commands, whose errors name the command line', async () => {
  const play = new PlaySession(fixture());
  expect(await run(play, 'hide button1')).toEqual({ text: undefined });
  expect(play.page.elements[0]!.visible).toBe(false);
  expect(await run(play, 'show button1')).toEqual({ text: undefined });
  expect(play.page.elements[0]!.visible).toBe(true);
  expect(await run(play, 'hide 42')).toEqual({
    error: 'line 1: wrong argument',
  });
  const failed = await run(
    play,
    'put 1 into target\nhide target\nhide button1',
  );
  expect(failed.error).toMatch(/^line 2: Expected/u);
  expect(play.page.elements[0]!.visible).toBe(true);
  expect(play.problems).toEqual([]);
});

test('in Edit, hide is one undoable authored edit', async () => {
  const project = fixture();
  const editor = new StackEditor(project);
  expect(await runInEdit(editor, 'hide button1')).toEqual({ text: undefined });
  expect(editor.page.elements[0]!.visible).toBe(false);
  editor.undo();
  expect(editor.page.elements[0]!.visible).toBe(true);
});

test('expressions and unchanged writes preserve the root and redo history', async () => {
  const editor = new StackEditor(fixture());
  editor.renameElement('button1', 'renamed');
  editor.undo();
  const before = editor.state.value;
  expect(await runInEdit(editor, '3 + 4')).toEqual({ text: '7' });
  expect(await runInEdit(editor, 'show button1')).toEqual({ text: undefined });
  expect(editor.state.value).toBe(before);
  expect(editor.canUndo).toBe(false);
  expect(editor.canRedo).toBe(true);
});

test('Message Box clones get fresh ids while unchanged owners keep theirs', async () => {
  const editor = new StackEditor(fixture());
  const button = editor.element('button1')!;
  const page = editor.page.id;
  await runInEdit(editor, 'ask elements to clone button1');
  expect(editor.page.id).toBe(page);
  expect(editor.element('button1')).toBe(button);
  expect(editor.element('button2')!.id).toBeDefined();
  expect(editor.element('button2')!.id).not.toBe(button.id);
  editor.undo();
  expect(editor.element('button1')).toBe(button);
  expect(editor.element('button2')).toBeUndefined();
});

test('a stale Edit command cannot overwrite a newer edit, including edit then undo', async () => {
  for (const undo of [false, true]) {
    const editor = new StackEditor(fixture());
    const command = runInEdit(editor, 'set the label of button1 to "Stale"');
    editor.edit(({ project, tree }) =>
      tree.setProperty(project.pages[0]!.elements[0]!, 'label', 'Newer'),
    );
    if (undo) {
      editor.undo();
    }
    const before = editor.snapshot();
    expect((await command).error).toContain('Run it again');
    expect(editor.project).toEqual(before);
  }
});

const targeted = async (
  play: PlaySession,
  id: number,
  command: string,
  now = 0n,
) => {
  const started = play.runMessage(command, id);
  return started.ok
    ? settle(play, started.result, () => play.pump(now))
    : { error: started.error };
};

test('targeted commands share live variables, ownership and functions without persisting locals', async () => {
  const project = fixture();
  project.pages[0]!.elements[0]!.script =
    'script variable score = 3\non click\n add 1 to score\nend click';
  const play = new PlaySession(project);
  const target = play.messageTargets[0]!;
  expect(await targeted(play, target.id, 'score')).toEqual({ text: '3' });
  expect(await targeted(play, target.id, 'put 8 into score')).toEqual({
    text: undefined,
  });
  play.send(play.page.elements[0]!, 'click');
  expect(await targeted(play, target.id, 'score')).toEqual({ text: '9' });
  expect(await targeted(play, target.id, 'the name of me')).toEqual({
    text: 'button1',
  });
  expect(await targeted(play, target.id, 'put 2 into scor')).toEqual({
    text: undefined,
  });
  expect((await targeted(play, target.id, 'scor + 0')).error).toBeDefined();
  expect((await run(play, 'score + 0')).error).toBeDefined();
  expect(project.pages[0]!.elements[0]!.script).toContain('score = 3');
});

test('targeted errors distinguish submitted lines from authored handlers', async () => {
  const project = fixture();
  project.script =
    'script variable score = 3\non fail\n put 1 / 0 into x\nend fail';
  const play = new PlaySession(project);
  const target = play.messageTargets[0]!;
  expect(await targeted(play, target.id, '1 / 0')).toEqual({
    error: 'line 1: Division by zero',
  });
  expect(play.problems).toEqual([]);
  expect((await targeted(play, target.id, 'fail')).error).toContain(
    'project: line 3: Division by zero',
  );
  expect(play.problems[0]?.line).toBe(3);
});

test('navigation invalidates the loaded instance but keeps the Project target', async () => {
  const project = fixture();
  project.script = 'script variable total = 4';
  project.pages[0]!.script = 'script variable score = 3';
  const play = new PlaySession(project);
  const [root, page] = play.messageTargets;
  await run(play, 'tell pages to show page2');
  for (let i = 0; i < 5; i++) {
    play.pump(0n);
  }
  expect((await targeted(play, page!.id, 'score')).error).toContain(
    'unavailable',
  );
  expect(await targeted(play, root!.id, 'total')).toEqual({ text: '4' });
  await run(play, 'tell pages to show page1');
  for (let i = 0; i < 5; i++) {
    play.pump(0n);
  }
  expect((await targeted(play, page!.id, 'score')).error).toContain(
    'unavailable',
  );
  const fresh = play.messageTargets.find(t => t.label === page!.label)!;
  expect(fresh.id).not.toBe(page!.id);
  expect(await targeted(play, fresh.id, 'score')).toEqual({ text: '3' });
});

test('commands cannot escape their wrapper to declare Script names', async () => {
  const project = fixture();
  project.script = 'script variable score = 3';
  const play = new PlaySession(project);
  const target = play.messageTargets[0]!;
  expect(
    (
      await targeted(
        play,
        target.id,
        'end folioMessage1\nscript variable injected = 1\non folioMessage1',
      )
    ).error,
  ).toBeDefined();
  expect((await targeted(play, target.id, 'injected + 0')).error).toBeDefined();
  expect(await targeted(play, target.id, 'score')).toEqual({ text: '3' });
});

// Reaching the real 1,000-command cap compiles against accumulated units on
// each Extend; shared Woodpecker load has pushed this past 30 s (#1488).
test('repeated commands reuse code, avoid authored names, and respect the distinct-command cap', async () => {
  const project = fixture();
  project.script = 'script variable folioMessage1 = 7';
  const play = new PlaySession(project);
  const id = play.messageTargets[0]!.id;
  expect(await targeted(play, id, 'folioMessage1')).toEqual({ text: '7' });
  const identity = play.group.fingerprint();
  expect(await targeted(play, id, 'folioMessage1')).toEqual({ text: '7' });
  expect(play.group.fingerprint()).toEqual(identity);
  for (let i = 1; i < 1000; i++) {
    expect(await targeted(play, id, String(i))).toEqual({ text: String(i) });
  }
  expect((await targeted(play, id, '1000')).error).toContain('Restart Play');
  expect(await targeted(play, id, 'folioMessage1')).toEqual({ text: '7' });
}, 120_000);

test('overlapping commands retain their own errors and completed effects', async () => {
  const project = fixture();
  project.script = 'script variable score = 0';
  const play = new PlaySession(project);
  const id = play.messageTargets[0]!.id;
  const slow = play.runMessage(
    'put 4 into score\nwait 1 s\nput 1 / 0 into x',
    id,
  );
  expect(slow.ok).toBe(true);
  if (!slow.ok) {
    return;
  }
  const slowError = slow.result.catch((error: Error) => error.message);
  play.pump(0n);
  expect(await targeted(play, id, 'score')).toEqual({ text: '4' });
  expect(await targeted(play, id, '2 / 0')).toEqual({
    error: 'line 1: Division by zero',
  });
  play.pump(1_000_000n);
  expect(await slowError).toBe('line 3: Division by zero');
  expect(await targeted(play, id, 'score', 1_000_000n)).toEqual({ text: '4' });
  expect(play.problems).toEqual([]);
});

test('deleting an Element invalidates its target and stopped sessions expose none', async () => {
  const project = fixture();
  project.pages[0]!.elements[0]!.script = 'script variable score = 3';
  const play = new PlaySession(project);
  const target = play.messageTargets[0]!;
  await run(play, 'tell elements to delete button1');
  expect(play.messageTargets).toEqual([]);
  expect((await targeted(play, target.id, 'score')).error).toContain(
    'unavailable',
  );
  play.stop(0n);
  expect(play.messageTargets).toEqual([]);
});

test(':describe and :apropos read the context Script and the Project Libraries', () => {
  const script = [
    '--| Doubles a number.',
    'function double n',
    '  return n * 2',
    'end double',
    '',
    'use square from shapes',
  ].join('\n');
  const libraries = [
    {
      name: 'shapes',
      source:
        '--| Squares a number.\nfunction square n\n  return n * n\nend square\n',
    },
  ];
  expect(sessionCommand(':describe double', script, libraries)).toEqual({
    text: [
      'describe {target: {name: "double", origin: "session"}, origin: "session", declaration: "function", signature: "function double n"}',
      'doc "Doubles a number."',
      'arity 1..1',
    ].join('\n'),
  });
  expect(sessionCommand(':describe square', script, libraries)?.text).toContain(
    'doc "Squares a number."',
  );
  expect(sessionCommand(':apropos doub', script, libraries)?.text).toContain(
    'name {target: {name: "double", origin: "session"}',
  );
  expect(sessionCommand(':apropos squ', '', libraries)?.text).toContain(
    'import: "use square from shapes"',
  );
  expect(sessionCommand(':describe nope', script, libraries)).toEqual({
    error: '! no such name',
  });
  expect(sessionCommand('3 + 4', script, libraries)).toBeUndefined();
});
