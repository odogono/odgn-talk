import { thaw } from '../src/readonly';
import { expect, test } from 'bun:test';
import { StackEditor } from '../src/editing';
import {
  allElements,
  checkHierarchy,
  groupElement,
  refreshBounds,
  updateGeometry,
} from '../src/tree/rules';
import { createElement, createProject, type Element } from '../src/model';
import { runInEdit, settle, type MessageReply } from '../src/message';
import { PlaySession } from '../src/play';
import { ReaderTextHistory } from '../src/play-text';
import {
  migrateProjectJson,
  readProjectFile,
  serializeProject,
  validateProjectJson,
  writeProjectFile,
  CURRENT_FORMAT,
} from '../src/project-file';
import { ownerById, scriptManifest } from '../src/script-manifest';
import { scriptNameProblems } from '../src/script-names';
import { openProjectStorage } from '../src/storage';
import { createFakeIdb } from './fake-indexeddb';

const leaf = (name: string, left = 10, top = 20): Element => ({
  ...createElement('button', name),
  left,
  top,
});
const fixture = () => {
  const project = createProject('Groups');
  project.pages[0]!.elements = [
    leaf('a'),
    groupElement('panel', [
      leaf('b', 100),
      groupElement('inner', [leaf('c', 200)]),
    ]),
    leaf('d', 400),
  ];
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

test('Group collapses interleaved siblings at the frontmost selected layer and Undo preserves owners', () => {
  const project = createProject('Group');
  project.pages[0]!.elements = [leaf('a'), leaf('b'), leaf('c')];
  const editor = new StackEditor(project);
  const original = editor.snapshot();
  const id = editor.element('a')!.id!;
  editor.click('a');
  editor.click('c', { shift: true });
  editor.groupSelection();
  expect(editor.page.elements.map(e => e.name)).toEqual(['b', 'group1']);
  expect(editor.element('group1')).toMatchObject({
    kind: 'group',
    members: [{ name: 'a' }, { name: 'c' }],
  });
  expect(ownerById(editor.project, id)?.name).toBe('a');
  expect(editor.selected.map(e => e.name)).toEqual(['group1']);
  editor.undo();
  expect(editor.project).toEqual(original);
  editor.redo();
  expect(editor.element('a')!.id).toBe(id);
});

test('entered scope controls insertion, selection, movement and history; Page navigation exits', () => {
  const editor = new StackEditor(fixture());
  editor.click('c');
  expect(editor.selection).toEqual(['panel']);
  editor.enterGroup('panel');
  editor.click('c');
  expect(editor.selection).toEqual(['inner']);
  editor.enterGroup('inner');
  editor.click('c');
  const c = structuredClone(editor.element('c')!);
  const added = editor.addElement('rectangle');
  expect(editor.element('inner')).toMatchObject({
    members: [{ name: 'c' }, { name: added.name }],
  });
  editor.undo();
  expect(editor.scope).toHaveLength(2);
  expect(editor.selection).toEqual(['c']);
  const move = editor.startMove();
  move.to(25, 30);
  move.finish();
  expect(editor.element('c')).toMatchObject({
    left: c.left + 25,
    top: c.top + 30,
  });
  expect(editor.element('inner')).toMatchObject({
    left: c.left + 25,
    top: c.top + 30,
  });
  editor.leaveGroup();
  expect(editor.selection).toEqual(['inner']);
  editor.goToPage(0);
  expect(editor.scope).toEqual([]);
});

test('ungroup carries only the removed visibility mask, preserves member ids, and restores Scripts on Undo', () => {
  const editor = new StackEditor(fixture());
  editor.edit(({ project, tree }) => {
    const group = project.pages[0]!.elements[1]!;
    tree.setProperty(group, 'visible', false);
    tree.setScript(group, 'on click\nend');
  });
  const before = editor.snapshot();
  const id = editor.element('b')!.id;
  editor.click('panel');
  editor.ungroupSelection();
  expect(editor.page.elements.map(e => e.name)).toEqual([
    'a',
    'b',
    'inner',
    'd',
  ]);
  expect(editor.element('b')).toMatchObject({ visible: false, id });
  expect(editor.element('inner')!.visible).toBe(false);
  expect(editor.element('c')!.visible).toBe(true);
  editor.undo();
  expect(editor.project).toEqual(before);
});

test('recursive Duplicate translates each leaf once, changes every name/id and keeps Script source', () => {
  const editor = new StackEditor(fixture());
  editor.edit(({ project, tree }) => {
    tree.setScript(project.pages[0]!.elements[1]!, 'on click\n hide b\nend');
  });
  const source = editor.element('panel')!;
  editor.click('panel');
  editor.duplicate();
  const copied = editor.selected[0]!;
  const originals = allElements([source]);
  const copies = allElements([copied]);
  expect(copies).toHaveLength(originals.length);
  copies.forEach((e, i) => {
    expect(e.name).not.toBe(originals[i]!.name);
    expect(e.id).not.toBe(originals[i]!.id);
    expect(e.left).toBe(originals[i]!.left + 20);
    expect(e.top).toBe(originals[i]!.top + 20);
  });
  expect(copied.script).toBe(source.script);
});

test('format 5 persists nested membership and empty anchors, strips all ids and migrates leaf Projects', async () => {
  const editor = new StackEditor(fixture());
  editor.edit(({ project, tree }) => {
    tree.insert(project.pages[0]!, groupElement('empty', []));
  });
  const json = serializeProject(editor.project);
  expect(json.format).toBe(CURRENT_FORMAT);
  const saved = JSON.stringify(json);
  expect(saved).not.toContain('"id":');
  expect(saved).toContain('emptyPosition');
  const read = await readProjectFile(
    await writeProjectFile(editor.project, new Map()),
  );
  expect(serializeProject(read.project)).toEqual(json);
  const old = createProject('Old');
  old.pages[0]!.elements = [leaf('original')];
  const migrated = validateProjectJson(
    migrateProjectJson({ ...serializeProject(old), format: 1 }),
  );
  expect(migrated).toEqual({ project: old });
});

test('validation rejects nested name collisions, cycles and hierarchy limits; independent leaves stay unlimited', () => {
  const project = fixture();
  const group = project.pages[0]!.elements[1]!;
  if (group.kind !== 'group') {
    throw new Error('fixture');
  }
  group.members[0]!.name = 'a';
  const result = validateProjectJson(serializeProject(project));
  expect(result).toHaveProperty('issues');
  if ('issues' in result) {
    expect(result.issues.some(i => i.path.includes('members[0].name'))).toBe(
      true,
    );
  }
  group.members.push(group);
  expect(() => checkHierarchy(project.pages[0]!.elements)).toThrow(
    'one parent',
  );
  expect(() =>
    groupElement(
      'large',
      Array.from({ length: 1024 }, (_, i) => leaf(`b${i}`)),
    ),
  ).toThrow('1024');
  expect(() =>
    checkHierarchy(Array.from({ length: 1500 }, (_, i) => leaf(`b${i}`))),
  ).not.toThrow();
  let nested = groupElement('g0', []);
  for (let i = 1; i < 32; i++) {
    nested = groupElement(`g${i}`, [nested]);
  }
  expect(() => checkHierarchy([nested])).not.toThrow();
  expect(() => groupElement('tooDeep', [nested])).toThrow('32');
});

test('Play group/Page collections have direct/postorder membership and bindings include every descendant', async () => {
  const project = fixture();
  const play = new PlaySession(project);
  const expected = ['a', 'b', 'c', 'inner', 'panel', 'd'];
  for (const [i, name] of expected.entries()) {
    expect(await value(play, `the name of element ${i + 1} of thisPage`)).toBe(
      name,
    );
  }
  expect(await value(play, 'the number of elements of thisPage')).toBe('6');
  expect(await value(play, 'the number of elements of panel')).toBe('2');
  expect(await value(play, 'element "c" of panel is nothing')).toBe('true');
  expect(await value(play, 'element "b" of panel is b')).toBe('true');
  expect(await value(play, 'element "c" of thisPage is c')).toBe('true');
  const manifest = scriptManifest(project, project.pages[0]!.elements[1]!);
  expect(manifest.objects.map(o => o.name)).toContain('c');
  expect(
    manifest.objectKinds
      .find(k => k.name === 'group')!
      .props.find(p => p.name === 'width')!.readOnly,
  ).toBe(true);
  expect(scriptNameProblems(project)).toEqual([]);
});

test('Play moves recompute ancestor boxes; visibility masks preserve flags and do not stop frame Scripts', async () => {
  const project = fixture();
  project.pages[0]!.elements[1]!.script =
    'on frame elapsed\n set the left of b to the left of b + 1\nend';
  const play = new PlaySession(project);
  expect(await run(play, 'set the left of panel to 300')).toEqual({
    text: undefined,
  });
  expect(await value(play, 'the left of b')).toBe('300');
  expect(await value(play, 'the left of c')).toBe('400');
  expect(await run(play, 'set the left of c to 50')).toEqual({
    text: undefined,
  });
  expect(await value(play, 'the left of inner')).toBe('50');
  expect(await value(play, 'the left of panel')).toBe('50');
  await run(play, 'hide b');
  await run(play, 'hide panel');
  expect(play.isVisible(play.elementsOf().find(e => e.name === 'c')!)).toBe(
    false,
  );
  expect(await value(play, 'the visible of c')).toBe('true');
  expect(play.wantsFrames).toBe(true);
  play.frame(0n);
  for (let i = 0; i < 20; i++) {
    play.pump(0n);
  }
  expect(await value(play, 'the left of b')).toBe('301');
  await run(play, 'show panel');
  expect(await value(play, 'the visible of b')).toBe('false');
  expect(
    (await run(play, 'set the width of panel to 999')).error,
  ).toBeDefined();
});

test('member messages pass through nested group Scripts with the original target', async () => {
  const project = fixture();
  const panel = project.pages[0]!.elements[1]!;
  panel.script = 'on click\n set the label of b to the name of the target\nend';
  const play = new PlaySession(project);
  const c = play.elementsOf().find(e => e.name === 'c')!;
  expect(play.handles(c, 'click')).toBe(true);
  play.send(c, 'click');
  for (let i = 0; i < 20; i++) {
    play.pump(0n);
  }
  expect(await value(play, 'the label of b')).toBe('c');
  expect(play.problems).toEqual([]);
});

test('runtime clone installs all descendants and Scripts, uses fresh names, and deletion leaves no live members', async () => {
  const project = fixture();
  project.pages[0]!.elements[1]!.script =
    'on click\n set the visible of me to false\nend';
  const play = new PlaySession(project);
  expect(await run(play, 'ask elements to clone panel')).toEqual({
    text: undefined,
  });
  expect(await value(play, 'the number of elements of thisPage')).toBe('10');
  expect(await value(play, 'the left of b2')).toBe('120');
  await run(play, 'send click to panel2');
  expect(await value(play, 'the visible of panel2')).toBe('false');
  await run(play, 'tell elements to delete panel2');
  expect(await value(play, 'element "c2" of thisPage is nothing')).toBe('true');
  expect(await value(play, 'the number of elements of thisPage')).toBe('6');
  expect(
    (await run(play, 'ask elements to create "group", thisPage')).error,
  ).toBeDefined();
});

test('incremental Play indexes match a full rebuild after nested create, clone and delete', async () => {
  const play = new PlaySession(fixture());
  const matchesRebuild = async () => {
    const elements = play.page.elements;
    expect(play.elementsOf()).toEqual(allElements(elements));
    const rebuilt = thaw<Element[]>(elements);
    refreshBounds(rebuilt);
    expect(elements).toEqual(rebuilt);
    for (const e of allElements(elements)) {
      expect(
        await value(play, `the name of element "${e.name}" of thisPage`),
      ).toBe(e.name);
    }
  };
  await run(play, 'ask elements to clone c');
  await matchesRebuild();
  expect(await value(play, 'the number of elements of inner')).toBe('2');
  await run(play, 'ask elements to clone b');
  await matchesRebuild();
  await run(play, 'tell elements to delete inner');
  await matchesRebuild();
  expect(await value(play, 'element "c" of thisPage is nothing')).toBe('true');
  await run(play, 'ask elements to create "rectangle", thisPage, "e"');
  await matchesRebuild();
  expect(await value(play, 'the number of elements of thisPage')).toBe('6');
});

test('deleting the last member keeps an empty group and its anchor and Script', async () => {
  const project = fixture();
  const play = new PlaySession(project);
  await run(play, 'tell elements to delete c');
  expect(await value(play, 'the number of elements of inner')).toBe('0');
  expect(await value(play, 'the left of inner')).toBe('200');
  expect(await value(play, 'the width of inner')).toBe('0');
  expect(await value(play, 'the number of elements of panel')).toBe('2');
});

test('failed geometry preflight changes nothing and Edit Message Box preserves recursive owner ids and Undo', async () => {
  const root = groupElement('root', [
    leaf('near', -1e308),
    leaf('far', -1e308),
  ]);
  const before = structuredClone(root);
  expect(() => updateGeometry(root, root.members[1]!, { left: 1e308 })).toThrow(
    'finite',
  );
  expect(root).toEqual(before);
  const editor = new StackEditor(fixture());
  const id = editor.element('c')!.id;
  const original = editor.snapshot();
  expect(await runInEdit(editor, 'set the left of panel to 200')).toEqual({
    text: undefined,
  });
  expect(editor.element('c')).toMatchObject({ id, left: 300 });
  editor.undo();
  expect(editor.project).toEqual(original);
  expect(
    (await runInEdit(editor, 'set the width of panel to 999')).error,
  ).toBeDefined();
  expect(editor.project).toEqual(original);
});

test('browser storage and earlier versions round-trip group membership and empty anchors', async () => {
  const storage = await openProjectStorage(createFakeIdb().factory);
  const project = fixture();
  const saved = await storage.saveProject(undefined, project, { now: 1 });
  project.pages[0]!.elements.push(groupElement('empty', []));
  await storage.saveProject(saved.id, project, { now: 2 });
  expect(
    serializeProject((await storage.loadProject(saved.id)).project),
  ).toEqual(serializeProject(project));
  storage.close();
});

test('Fuel refusal leaves moves, recursive clones and deletes unapplied', () => {
  const project = fixture();
  project.pages[0]!.script = `on move
  set the left of panel to 700
end
on copy
  ask elements to clone panel
end
on remove
  tell elements to delete panel
end`;
  const play = new PlaySession(project, 0, { events: false });
  const before = structuredClone(play.project);
  for (const [name, fuelPerRun] of [
    ['move', 1000],
    ['copy', 5100],
    ['remove', 5010],
  ] as const) {
    play.group.deliver(play.objects.get(play.page)!, {
      name,
      limits: { fuelPerRun },
    });
    for (let i = 0; i < 10; i++) {
      play.pump(0n);
    }
    expect(play.project).toEqual(before);
  }
  expect(play.problems).toHaveLength(3);
});

test('nested clone growth and editor insertion reject the next node without changes', async () => {
  const project = createProject('Full group');
  project.pages[0]!.elements = [
    groupElement(
      'full',
      Array.from({ length: 1023 }, (_, i) => leaf(`b${i}`)),
    ),
  ];
  const editor = new StackEditor(project);
  editor.enterGroup('full');
  const before = editor.snapshot();
  expect(() => editor.addElement('button')).toThrow('1024');
  expect(editor.project).toEqual(before);
  const play = new PlaySession(project);
  const unchanged = structuredClone(play.project);
  expect((await run(play, 'ask elements to clone b0')).error).toBeDefined();
  expect(play.project).toEqual(unchanged);
});

test('reader text growth updates recursive clone Fuel authorization before any copy', () => {
  const project = createProject('Reader clone');
  const field = createElement('text', 'entry');
  if (field.kind !== 'text') {
    throw new Error('fixture');
  }
  field.editable = true;
  project.pages[0]!.elements = [groupElement('panel', [field])];
  project.pages[0]!.script = 'on copy\n ask elements to clone panel\nend';
  const play = new PlaySession(project, 0, { events: false });
  const entry = play.elementsOf().find(e => e.name === 'entry')!;
  if (entry.kind !== 'text') {
    throw new Error('fixture');
  }
  new ReaderTextHistory(play, entry).set([
    { runs: [{ text: 'x'.repeat(20_000) }] },
  ]);
  play.group.deliver(play.objects.get(play.page)!, {
    name: 'copy',
    limits: { fuelPerRun: 10_000 },
  });
  for (let i = 0; i < 20; i++) {
    play.pump(0n);
  }
  expect(play.elementsOf()).toHaveLength(2);
  expect(play.problems).toHaveLength(1);
});
