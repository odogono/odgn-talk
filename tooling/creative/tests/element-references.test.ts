// Folio's Page Object Collection (#1143): `element ... of aPage` and
// `the number of elements of aPage`, in Play, the Message Box and Edit.
import { expect, test } from 'bun:test';
import { exportManifest, text } from '@northtalk/ts';
import { readManifest } from '../../stack/src/lsp/manifest';
import { StackEditor } from '../src/editing';
import { type MessageReply, runInEdit, settle } from '../src/message';
import {
  createElement,
  createPage,
  createProject,
  ELEMENT_KINDS,
} from '../src/model';
import { PlaySession } from '../src/play';
import { scriptManifest } from '../src/script-manifest';

// page1 holds one Element of each kind, backmost first; the second is
// hidden and none has a Script. page2 holds one button; page3 is empty.
const fixture = () => {
  const project = createProject('Story');
  const page = project.pages[0]!;
  page.elements = ELEMENT_KINDS.map(kind => createElement(kind, `${kind}1`));
  page.elements[1]!.visible = false;
  const other = createPage('page2');
  other.elements.push(createElement('button', 'far'));
  project.pages.push(other, createPage('page3'));
  return project;
};

const run = async (
  play: PlaySession,
  command: string,
): Promise<MessageReply> => {
  const started = play.runMessage(command);
  return started.ok
    ? settle(play, started.result, () => play.pump(0n))
    : { error: started.error };
};
const value = async (play: PlaySession, command: string) => {
  const reply = await run(play, command);
  expect(reply.error).toBeUndefined();
  return reply.text;
};
const names = (play: PlaySession) => play.page.elements.map(e => e.name);

test('the collection holds every kind, hidden and Script-less, in z-order', async () => {
  const play = new PlaySession(fixture());
  const count = ELEMENT_KINDS.length;
  expect(await value(play, 'the number of elements of thisPage')).toBe(
    String(count),
  );
  for (const [i, name] of names(play).entries()) {
    expect(await value(play, `the name of element ${i + 1} of thisPage`)).toBe(
      name,
    );
    expect(
      await value(play, `the name of element ${i - count} of thisPage`),
    ).toBe(name);
    expect(await value(play, `the name of element "${name}" of thisPage`)).toBe(
      name,
    );
  }
  expect(await value(play, 'the name of the last element of thisPage')).toBe(
    names(play).at(-1),
  );
  expect(await value(play, 'the name of the first element of thisPage')).toBe(
    names(play)[0],
  );
  for (const missing of [
    '0',
    String(count + 1),
    String(-count - 1),
    '9007199254740993',
    '"missing"',
    '""',
    '"1"',
    `"${ELEMENT_KINDS[0]!.toUpperCase()}1"`,
  ]) {
    expect(await value(play, `element ${missing} of thisPage`)).toBeUndefined();
  }
  expect(play.problems).toEqual([]);
});

test('another Page is readable while not showing; an empty Page has none', async () => {
  const play = new PlaySession(fixture());
  expect(await value(play, 'the number of elements of page2')).toBe('1');
  expect(await value(play, 'the name of element "far" of page2')).toBe('far');
  expect(await value(play, 'the label of element 1 of page2')).toBe('Button');
  expect(await value(play, 'element "button1" of page2')).toBeUndefined();
  expect(await value(play, 'the number of elements of page3')).toBe('0');
  expect(await value(play, 'element -1 of page3')).toBeUndefined();
});

test('a Project or Element receiver has no collection', async () => {
  const play = new PlaySession(fixture());
  for (const command of [
    'element 1 of project',
    'the number of elements of project',
    'element "x" of button1',
    'the number of elements of button1',
  ]) {
    expect((await run(play, command)).error).toMatch(/^line 1: /u);
  }
  expect(
    (await run(play, 'set the fill of element "nope" of thisPage to "red"'))
      .error,
  ).toMatch(/^line 1: /u);
});

test('the elements Grant keeps find and its missing-name error', async () => {
  const play = new PlaySession(fixture());
  expect(
    (await run(play, 'ask elements to find "button1", thisPage')).error,
  ).toBeUndefined();
  expect((await run(play, 'ask elements to find "nope", thisPage')).error).toBe(
    'line 1: "elements" failed while doing "find"',
  );
  expect(await value(play, 'element "nope" of thisPage')).toBeUndefined();
});

test('create and clone go to the front, delete removes, a reused name is a new handle', async () => {
  const project = fixture();
  const before = structuredClone(project);
  // The Page Script retains a handle and reports through button1's label.
  project.pages[0]!.script = `script variable kept
on keyDown k
  if k is "keep" then
    put element "dyn" of thisPage into kept
  else if k is "same" then
    set the label of button1 to "" & (kept is element "dyn" of thisPage)
  else
    set the label of button1 to the name of kept
  end if
end keyDown`;
  const play = new PlaySession(project);
  const ask = async (key: string) => {
    play.send(play.page, 'keyDown', [text(key)]);
    for (let i = 0; i < 20; i++) {
      play.pump(0n);
      await Promise.resolve();
    }
    return value(play, 'the label of button1');
  };
  const count = ELEMENT_KINDS.length;
  await run(play, 'ask elements to create "rectangle", thisPage, "dyn"');
  expect(await value(play, 'the name of element -1 of thisPage')).toBe('dyn');
  expect(await value(play, 'the number of elements of thisPage')).toBe(
    String(count + 1),
  );
  await run(play, 'ask elements to clone button1');
  const clone = names(play).at(-1)!;
  expect(clone).not.toBe('button1');
  expect(await value(play, 'the name of the last element of thisPage')).toBe(
    clone,
  );
  expect(await value(play, `the name of element "${clone}" of thisPage`)).toBe(
    clone,
  );

  await ask('keep');
  expect(await ask('same')).toBe('true');
  // Reordering moves positions but keeps the retained handle's identity.
  play.reorder(play.page, [...play.page.elements].reverse());
  expect(await value(play, 'the name of element 1 of thisPage')).toBe(clone);
  expect(await ask('same')).toBe('true');
  expect(await ask('name')).toBe('dyn');

  expect(
    await run(play, 'tell elements to delete element "dyn" of thisPage'),
  ).toEqual({ text: undefined });
  play.pump(0n);
  expect(await value(play, 'element "dyn" of thisPage')).toBeUndefined();
  expect(await value(play, 'the number of elements of thisPage')).toBe(
    String(count + 1),
  );
  await run(play, 'ask elements to create "ellipse", thisPage, "dyn"');
  expect(play.page.elements.at(-1)).toHaveProperty('kind', 'ellipse');
  expect(await value(play, 'element "dyn" of thisPage is nothing')).toBe(
    'false',
  );
  expect(await ask('same')).toBe('false');
  expect(play.problems).toEqual([]);
  await ask('name');
  expect(play.problems).toHaveLength(1);
  play.stop(0n);
  project.pages[0]!.script = before.pages[0]!.script;
  expect(project).toEqual(before);
  expect(new PlaySession(project).page.elements.map(e => e.name)).toEqual(
    before.pages[0]!.elements.map(e => e.name),
  );
});

test('in Edit a write through a reference is one undoable edit; a failure changes nothing', async () => {
  const project = fixture();
  const editor = new StackEditor(project);
  const rectangle = editor.project.pages[0]!.elements.find(
    e => e.kind === 'rectangle',
  )!;
  const fill = (rectangle as { fill: string }).fill;
  expect(
    await runInEdit(
      editor,
      'set the fill of element "rectangle1" of thisPage to "red"',
    ),
  ).toEqual({ text: undefined });
  expect(editor.element(rectangle.name)!.id).toBe(rectangle.id);
  expect(editor.element(rectangle.name)).toHaveProperty('fill', 'red');
  editor.undo();
  expect(
    editor.project.pages[0]!.elements.find(e => e.name === 'rectangle1'),
  ).toHaveProperty('fill', fill);

  const before = structuredClone(editor.project);
  const reply = await runInEdit(
    editor,
    'set the fill of element 99 of thisPage to "red"',
  );
  expect(reply.error).toMatch(/^line 1: /u);
  expect(editor.project).toEqual(before);
});

test('Play and the authoring Manifest declare the same Page collection', () => {
  const project = fixture();
  const play = new PlaySession(project, 0, { events: false });
  const exported = (name: string) =>
    (
      JSON.parse(
        exportManifest({
          kind: 'folio',
          version: '1',
          grants: {},
          objectKinds: [play.objectKind(name)!],
        }),
      ) as { objectKinds: { elements?: unknown }[] }
    ).objectKinds[0]!.elements;
  const authored = scriptManifest(project, project.pages[0]!).objectKinds as {
    elements?: unknown;
    name: string;
  }[];
  expect(exported('page')).toEqual(
    authored.find(kind => kind.name === 'page')!.elements,
  );
  expect(exported('page')).toMatchObject({
    countCost: { fuel: 1, alloc: 0 },
    atCost: { fuel: 1, alloc: 0 },
    findCost: { fuel: 1, alloc: 0 },
  });
  for (const name of [
    'project',
    ...ELEMENT_KINDS.filter(kind => kind !== 'group'),
  ]) {
    expect(exported(name)).toBeUndefined();
    expect(
      authored.find(kind => kind.name === name) as { elements?: unknown },
    ).not.toHaveProperty('elements');
  }
  // The language server still reads the Manifest.
  expect(
    readManifest(scriptManifest(project, project.pages[0]!)).objectKinds.has(
      'page',
    ),
  ).toBe(true);
});
