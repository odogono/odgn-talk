import { expect, test } from 'bun:test';
import { parseSource } from '@odgn/northtalk';
import {
  createElement,
  createPage,
  createProject,
  textOf,
  type TextElement,
} from '../src/model';
import { PlaySession } from '../src/play';
import {
  recipeEdit,
  recipePlacement,
  recipeSource,
  recipeTargets,
} from '../src/recipes';
import { StackEditor } from '../src/editing';
import { scriptNameProblems } from '../src/script-names';

const fixture = () => {
  const project = createProject('Mystery');
  const page = project.pages[0]!;
  const button = createElement('button', 'door');
  const text = createElement('text', 'clue');
  page.elements.push(button, text, createElement('rectangle', 'cover'));
  project.pages.push(createPage('cellar'), createPage('attic'));
  project.pages[1]!.elements.push(createElement('button', 'remote'));
  return { project, page, button, text };
};
const drain = (play: PlaySession) => {
  for (let i = 0; i < 100; i++) {
    if (play.pump(0n).state !== 'sliced') {
      return;
    }
  }
  throw new Error('Still running');
};
const insert = (
  source: string,
  action: string,
  position: 'new' | 'start' | 'end' | 'cursor',
  cursor = 0,
) => {
  const edit = recipeEdit(source, action, position, cursor);
  return source.slice(0, edit.from) + edit.insert + source.slice(edit.from);
};

test('targets offer all Pages, only local Elements, and me for the owner', () => {
  const { project, page, button } = fixture();
  for (const owner of [project, page, button]) {
    expect(recipeTargets(project, owner, 'navigate').map(t => t.name)).toEqual([
      'page1',
      'cellar',
      'attic',
    ]);
  }
  expect(recipeTargets(project, project, 'show')).toEqual([]);
  expect(recipeTargets(project, button, 'text')).toEqual([
    { name: 'door', reference: 'me', property: 'label' },
    { name: 'clue', reference: 'clue', property: 'text' },
  ]);
  expect(recipeTargets(project, page, 'hide').map(t => t.reference)).toEqual([
    'door',
    'clue',
    'cover',
  ]);
});

test('each Recipe produces editable source with the intended runtime effect', async () => {
  const { project, button } = fixture();
  const targets = recipeTargets(project, button, 'show');
  expect(recipeSource('show', targets[0]!)).toBe(
    'set the visible of me to true',
  );
  expect(recipeSource('hide', targets[2]!)).toBe(
    'set the visible of cover to false',
  );
  expect(
    recipeSource('text', recipeTargets(project, button, 'text')[0]!, 'Open'),
  ).toBe('set the label of me to "Open"');
  expect(
    recipeSource('navigate', recipeTargets(project, button, 'navigate')[1]!),
  ).toBe('tell pages to show cellar');
  button.script = insert('', recipeSource('hide', targets[2]!), 'new');
  button.script = insert(
    button.script,
    recipeSource('text', recipeTargets(project, button, 'text')[0]!, 'Open'),
    'start',
  );
  button.script = insert(
    button.script,
    recipeSource('navigate', recipeTargets(project, button, 'navigate')[1]!),
    'end',
  );
  const play = new PlaySession(project);
  play.send(play.page.elements[0]!, 'click');
  drain(play);
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    drain(play);
  }
  expect(play.page.name).toBe('cellar');
  expect(play.project.pages[0]!.elements[2]!.visible).toBe(false);
  expect((play.project.pages[0]!.elements[0] as { label: string }).label).toBe(
    'Open',
  );
  expect(play.problems).toEqual([]);
  play.stop(0n);
});

for (const value of [
  '',
  'plain',
  String.raw`C:\new`,
  '"quoted"',
  'first\nsecond',
  'CR\rLF\r\n',
  '` ${me} \\ " 😀\t\u0000',
]) {
  test(`text Recipe preserves literal value ${JSON.stringify(value)}`, () => {
    const { project, button } = fixture();
    button.script = insert(
      '',
      recipeSource('text', recipeTargets(project, button, 'text')[1]!, value),
      'new',
    );
    expect(parseSource(button.script).error).toBeNull();
    const play = new PlaySession(project);
    play.send(play.page.elements[0]!, 'click');
    drain(play);
    expect(play.problems).toEqual([]);
    expect(textOf(play.page.elements[1] as TextElement)).toBe(
      value.replaceAll('\r\n', '\n').replaceAll('\r', '\n'),
    );
    play.stop(0n);
  });
}

test('parser placement ignores handler-like comments and strings and respects bare ends', () => {
  const source = '-- on click\non openPage\n put "on click" into x\nend\n';
  expect(recipePlacement(source)).toEqual({ kind: 'new' });
  const handler =
    'on click -- header\n  -- body\n  set the visible of me to true\n  -- end comment\nend\n';
  for (const position of ['start', 'end'] as const) {
    const result = insert(handler, 'set the visible of me to false', position);
    expect(parseSource(result).error).toBeNull();
    expect(result).toContain('-- end comment');
    expect(result.match(/on click/gu)).toHaveLength(1);
  }
  expect(
    insert(
      'on click\r\nend click\r\n',
      'set the visible of me to true',
      'start',
    ),
  ).toBe('on click\r\n  set the visible of me to true\r\nend click\r\n');
});

for (const source of [
  'on click where true\nend click',
  'on click\nend\non click\nend',
  'on click\n return\nend',
  'on click\n if true then return\nend',
  'on click\n pass click\nend',
  'on click\n throw "oops"\nend',
  'on click\nfinally\nend',
  'on click x\nend',
  'on click, queued\nend',
  'on click\n nonsense ???',
]) {
  test(`unsafe insertion requires cursor: ${source}`, () => {
    expect(recipePlacement(source)).toEqual({ kind: 'cursor' });
    expect(() =>
      recipeEdit(source, 'set the visible of me to false', 'new'),
    ).toThrow();
    expect(() =>
      recipeEdit(source, 'set the visible of me to false', 'start'),
    ).toThrow();
    const result = insert(
      source,
      'set the visible of me to false',
      'cursor',
      source.indexOf('\n') + 1,
    );
    expect(result.match(/on click/gu)?.length).toBe(
      source.match(/on click/gu)?.length,
    );
  });
}

test('creation and rename avoid reserved bindings and Page/Element collisions', () => {
  const { project } = fixture();
  const editor = new StackEditor(project);
  for (const name of [
    'me',
    'thisPage',
    'project',
    'pages',
    'elements',
    'sound',
    'on',
    '_',
    'cellar',
  ]) {
    expect(editor.renameElement('door', name).ok).toBe(false);
  }
  expect(editor.renamePage('remote').ok).toBe(false);
  editor.edit(({ project }) => {
    project.pages[1]!.name = 'button1';
  });
  expect(editor.addElement('button').name).toBe('button2');
  editor.edit(({ project }) => {
    project.pages[0]!.elements.push(createElement('button', 'page4'));
  });
  expect(editor.addPage().name).toBe('page5');
});

test('conflicting imported Projects are preserved and refused before Play', () => {
  const { project } = fixture();
  project.pages[0]!.elements[0]!.name = 'cellar';
  const before = JSON.stringify(project);
  expect(scriptNameProblems(project).length).toBe(2);
  expect(() => new PlaySession(project)).toThrow('Rename it in Info');
  expect(JSON.stringify(project)).toBe(before);
});

test('sound Recipes offer only audio assets and play through the Play Host', () => {
  const { project, page, button } = fixture();
  project.assets.push(
    {
      name: 'waves',
      fileName: 'waves.mp3',
      hash: 'a'.repeat(64),
      mediaType: 'audio/mpeg',
      size: 3,
    },
    {
      name: 'lamp',
      fileName: 'lamp.png',
      hash: 'b'.repeat(64),
      mediaType: 'image/png',
      size: 3,
    },
  );
  for (const owner of [project, page, button]) {
    expect(recipeTargets(project, owner, 'playSound')).toEqual([
      { name: 'waves', reference: 'waves' },
    ]);
  }
  const targets = recipeTargets(project, button, 'playSound');
  expect(recipeSource('playSound', targets[0]!)).toBe(
    'tell sound to play "waves"',
  );
  expect(recipeSource('loopSound', targets[0]!)).toBe(
    'tell sound to loop "waves"',
  );
  const stops = recipeTargets(project, button, 'stopSound');
  expect(recipeSource('stopSound', stops[0]!)).toBe('tell sound to stop');
  expect(recipeSource('stopSound', stops[1]!)).toBe(
    'tell sound to stop "waves"',
  );
  button.script = insert('', recipeSource('loopSound', targets[0]!), 'new');
  expect(parseSource(button.script).error).toBeNull();
  const play = new PlaySession(project);
  play.send(play.page.elements[0]!, 'click');
  drain(play);
  expect(play.problems).toEqual([]);
  expect(play.sounds.playing()).toEqual([
    { owner: 'element:page1/door', name: 'waves', loop: true },
  ]);
  play.stop(0n);
  expect(play.sounds.playing()).toEqual([]);
});
