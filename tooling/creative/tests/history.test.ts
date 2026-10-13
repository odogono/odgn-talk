import { expect, test } from 'bun:test';
import { StackEditor, type LayerOrder } from '../src/editing';
import { createElement, createProject } from '../src/model';

const makeEditor = () => {
  const project = createProject('Mystery');
  project.script = 'on startPlay\nend startPlay';
  project.assets.push({
    name: 'picture',
    hash: 'abc',
    fileName: 'picture.png',
    mediaType: 'image/png',
    size: 3,
  });
  project.pages[0]!.elements = ['a', 'b', 'c', 'd', 'e'].map(name =>
    createElement('text', name),
  );
  return new StackEditor(project);
};

const select = (editor: StackEditor, ...names: string[]) => {
  editor.selectPage();
  for (const name of names) {
    editor.click(name, { shift: true });
  }
};

const checkUndo = (editor: StackEditor, change: () => void) => {
  const before = structuredClone(editor.project);
  const pageIndex = editor.pageIndex;
  const selection = [...editor.selection];
  change();
  const after = structuredClone(editor.project);
  expect(after).not.toEqual(before);
  editor.undo();
  expect(editor.project).toEqual(before);
  expect(editor.pageIndex).toBe(pageIndex);
  expect(editor.selection).toEqual(selection);
  editor.redo();
  expect(editor.project).toEqual(after);
};

for (const names of [['a'], ['a', 'c']]) {
  test(`duplicate ${names.length} Elements with fresh names, offset and independent rich text`, () => {
    const editor = makeEditor();
    select(editor, ...names);
    checkUndo(editor, () => editor.duplicate());
    expect(editor.selection).toEqual(names.map(n => `${n}2`));
    for (const name of names) {
      const source = editor.element(name)!;
      const copy = editor.element(`${name}2`)!;
      expect(copy).toEqual({
        ...source,
        name: `${name}2`,
        left: source.left + 20,
        top: source.top + 20,
      });
      if (copy.kind === 'text' && source.kind === 'text') {
        copy.richText[0]!.runs[0]!.text = 'Changed copy';
        expect(source.richText[0]!.runs[0]!.text).toBe('Text');
      }
    }
  });

  test(`delete ${names.length} Elements and restore their exact layers`, () => {
    const editor = makeEditor();
    select(editor, ...names);
    checkUndo(editor, () => editor.delete());
    expect(editor.page.elements.map(e => e.name)).toEqual(
      ['a', 'b', 'c', 'd', 'e'].filter(n => !names.includes(n)),
    );
    expect(editor.selection).toEqual([]);
  });
}

test('duplicates reserve names of originals and of every copy', () => {
  const editor = makeEditor();
  editor.page.elements.push(createElement('button', 'a2'));
  select(editor, 'a2', 'a');
  editor.duplicate();
  expect(editor.selection).toEqual(['a3', 'a4']);
});

test('duplicate a Page after itself, preserving layout and independent nested data', () => {
  const editor = makeEditor();
  editor.page.script = 'on openPage\nend openPage';
  checkUndo(editor, () => editor.duplicate());
  expect(editor.pageIndex).toBe(1);
  expect(editor.page).toEqual({ ...editor.project.pages[0]!, name: 'page2' });
  editor.page.elements[0]!.left = 500;
  expect(editor.project.pages[0]!.elements[0]!.left).toBe(40);
});

test('delete first, middle and last Pages, retaining a showing Page', () => {
  for (const index of [0, 1, 2]) {
    const editor = makeEditor();
    editor.addPage();
    editor.addPage();
    editor.goToPage(index);
    const removed = editor.page.name;
    checkUndo(editor, () => editor.delete());
    expect(editor.canDelete).toBe(false);
    expect(editor.project.pages.map(p => p.name)).not.toContain(removed);
    expect(editor.page).toBeDefined();
  }
});

test('a Page is deleted only when explicitly selected', () => {
  const editor = makeEditor();
  editor.addPage();
  expect(editor.selection).toEqual([]);
  expect(editor.canDelete).toBe(false);
  editor.delete();
  expect(editor.project.pages).toHaveLength(2);
  const element = editor.addElement('rectangle');
  editor.delete();
  expect(editor.element(element.name)).toBeUndefined();
  expect(editor.canDelete).toBe(false);
  editor.click(undefined);
  expect(editor.canDelete).toBe(true);
  checkUndo(editor, () => editor.delete());
  expect(editor.project.pages).toHaveLength(1);
});

test('the final Page cannot be deleted, but its Elements can', () => {
  const editor = makeEditor();
  expect(editor.canDelete).toBe(false);
  editor.delete();
  expect(editor.canUndo).toBe(false);
  select(editor, 'a', 'b', 'c', 'd', 'e');
  expect(editor.canDelete).toBe(true);
  checkUndo(editor, () => editor.delete());
  expect(editor.page.elements).toEqual([]);
});

const layerCases: { names: string[]; order: LayerOrder; result: string[] }[] = [
  { order: 'forward', names: ['b'], result: ['a', 'c', 'b', 'd', 'e'] },
  { order: 'backward', names: ['b'], result: ['b', 'a', 'c', 'd', 'e'] },
  { order: 'front', names: ['b'], result: ['a', 'c', 'd', 'e', 'b'] },
  { order: 'back', names: ['b'], result: ['b', 'a', 'c', 'd', 'e'] },
  { order: 'forward', names: ['b', 'c'], result: ['a', 'd', 'b', 'c', 'e'] },
  { order: 'backward', names: ['b', 'c'], result: ['b', 'c', 'a', 'd', 'e'] },
  { order: 'front', names: ['b', 'd'], result: ['a', 'c', 'e', 'b', 'd'] },
  { order: 'back', names: ['b', 'd'], result: ['b', 'd', 'a', 'c', 'e'] },
  { order: 'forward', names: ['b', 'd'], result: ['a', 'c', 'b', 'e', 'd'] },
  { order: 'backward', names: ['b', 'd'], result: ['b', 'a', 'd', 'c', 'e'] },
  {
    order: 'forward',
    names: ['c', 'd', 'e'],
    result: ['a', 'b', 'c', 'd', 'e'],
  },
  { order: 'backward', names: ['a', 'b'], result: ['a', 'b', 'c', 'd', 'e'] },
];
for (const { order, names, result } of layerCases) {
  test(`${order} for ${names.join(', ')} keeps selection and relative order`, () => {
    const editor = makeEditor();
    select(editor, ...[...names].reverse());
    const before = structuredClone(editor.project);
    editor.orderLayers(order);
    expect(editor.page.elements.map(e => e.name)).toEqual(result);
    expect(editor.selection).toEqual([...names].reverse());
    editor.undo();
    expect(editor.project).toEqual(before);
  });
}

test('moves, resizes and live Info changes each undo as one edit', () => {
  const editor = makeEditor();
  select(editor, 'a', 'c');
  checkUndo(editor, () => {
    const move = editor.startMove();
    for (let i = 1; i <= 50; i++) {
      move.to(i, -i);
    }
    move.finish();
  });
  select(editor, 'a');
  checkUndo(editor, () => {
    const resize = editor.startResize('nw')!;
    resize.to(10, 20);
    resize.to(50, 40);
    resize.finish();
  });
  checkUndo(editor, () => {
    const edit = editor.startEdit();
    for (const name of ['M', 'My', 'Mystery revised']) {
      edit.change(() => {
        editor.project.name = name;
      });
    }
    edit.finish();
  });
});

test('a no-op gesture and navigation keep redo, a new edit discards it', () => {
  const editor = makeEditor();
  select(editor, 'a');
  editor.duplicate();
  editor.undo();
  const move = editor.startMove();
  move.to(30, 40);
  move.to(0, 0);
  move.finish();
  editor.selectPage();
  expect(editor.canUndo).toBe(false);
  expect(editor.canRedo).toBe(true);
  editor.renamePage('renamed');
  expect(editor.canRedo).toBe(false);
});

test('undo finishes a pending gesture and later stale updates cannot mutate history', () => {
  const editor = makeEditor();
  select(editor, 'a');
  const before = structuredClone(editor.project);
  const move = editor.startMove();
  move.to(30, 40);
  expect(editor.canUndo).toBe(true);
  editor.undo();
  move.to(100, 100);
  move.finish();
  expect(editor.project).toEqual(before);
  editor.redo();
  expect(editor.element('a')!.left).toBe(70);
});

test('long mixed history repeats every Project exactly without drift', () => {
  const editor = makeEditor();
  const project = editor.project;
  const states = [structuredClone(project)];
  const record = (change: () => void) => {
    change();
    states.push(structuredClone(project));
  };
  for (let i = 0; i < 20; i++) {
    select(editor, 'a');
    record(() => {
      const move = editor.startMove();
      move.to(3.4, -1.7);
      move.finish();
    });
    record(() => {
      const resize = editor.startResize('se')!;
      resize.to(2, 1);
      resize.finish();
    });
    record(() => editor.renameElement('a', 'renamed'));
    record(() => editor.renameElement('renamed', 'a'));
    record(() => editor.duplicate());
    record(() => editor.orderLayers('back'));
    record(() => editor.delete());
    record(() => editor.addElement('image'));
    record(() => editor.delete());
    editor.selectPage();
    record(() => editor.renamePage(`scene${i}`));
    record(() =>
      editor.edit(() => {
        project.designWidth++;
        editor.page.height++;
        editor.page.background = i % 2 ? '#123456' : '#654321';
        editor.page.elements[0]!.script = `on click\n  put ${i}\nend click`;
      }),
    );
    record(() => editor.addPage());
    record(() => editor.movePage(editor.pageIndex, 0));
    editor.selectPage();
    record(() => editor.delete());
  }
  for (let round = 0; round < 3; round++) {
    for (let i = states.length - 2; i >= 0; i--) {
      editor.undo();
      expect(project).toBe(editor.project);
      expect(project).toEqual(states[i]!);
    }
    expect(editor.canUndo).toBe(false);
    for (const state of states.slice(1)) {
      editor.redo();
      expect(project).toEqual(state);
    }
    expect(editor.canRedo).toBe(false);
  }
});

test('onChange is told of edits, live drags, undo and redo (#752)', () => {
  const editor = makeEditor();
  const notices: string[] = [];
  editor.onChange = () => notices.push(editor.project.pages.length.toString());
  editor.addPage();
  expect(notices.length).toBeGreaterThan(0);

  editor.goToPage(0);
  const beforeDrag = notices.length;
  select(editor, 'a');
  const gesture = editor.startMove();
  gesture.to(5, 5);
  expect(notices.length).toBeGreaterThan(beforeDrag); // A live notice.
  gesture.finish();

  const beforeUndo = notices.length;
  editor.undo();
  expect(notices.length).toBeGreaterThan(beforeUndo);
  const beforeRedo = notices.length;
  editor.redo();
  expect(notices.length).toBeGreaterThan(beforeRedo);

  // Selection and navigation alone are not authored changes.
  const settled = notices.length;
  editor.click('b');
  editor.goToPage(0);
  expect(notices).toHaveLength(settled);
});

test('replaceProject loads another Project without history or a change notice', () => {
  const editor = makeEditor();
  const reference = editor.project;
  editor.addPage();
  let notices = 0;
  editor.onChange = () => notices++;
  const other = createProject('Other');
  editor.replaceProject(other);
  expect(editor.project).toBe(reference);
  expect(editor.project).toEqual(other);
  expect(editor.project).not.toBe(other);
  expect(editor.canUndo).toBe(false);
  expect(editor.canRedo).toBe(false);
  expect(editor.pageIndex).toBe(0);
  expect(editor.selection).toEqual([]);
  expect(notices).toBe(0);
});

test('a read-only editor rolls back every change but still navigates', () => {
  const editor = makeEditor();
  editor.addPage();
  const before = structuredClone(editor.project);
  let notices = 0;
  editor.onChange = () => notices++;
  editor.readOnly = true;

  select(editor, 'a');
  editor.addElement('button');
  editor.duplicate();
  editor.delete();
  const gesture = editor.startMove();
  gesture.to(10, 10);
  gesture.finish();
  editor.undo();
  expect(editor.project).toEqual(before);
  expect(editor.canUndo).toBe(false);
  expect(notices).toBe(0);

  editor.goToPage(1);
  expect(editor.pageIndex).toBe(1);

  editor.readOnly = false;
  expect(editor.canUndo).toBe(true);
});
