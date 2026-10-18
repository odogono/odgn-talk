import { expect, test } from 'bun:test';
import {
  createElement,
  createPage,
  createProject,
  type ButtonElement,
} from '../src/model';
import {
  PAGE_HANDLES,
  MIN_PAGE_HEIGHT,
  MIN_PAGE_WIDTH,
  checkElementName,
  checkPageName,
  labelSuggestion,
  resizeBox,
  StackEditor,
} from '../src/editing';

test('Page handles resize around the centre with a fixed top and minimum size', () => {
  expect(PAGE_HANDLES).toEqual(['w', 'e', 'sw', 's', 'se']);
  for (const handle of PAGE_HANDLES) {
    const project = createProject('Resize');
    project.pages[0]!.elements.push(createElement('rectangle', 'box'));
    project.pages.push(createPage('other'));
    const editor = new StackEditor(project);
    const width = editor.project.designWidth;
    const height = editor.page.height;
    const otherHeight = editor.project.pages[1]!.height;
    const beforeElements = structuredClone(editor.page.elements);
    const gesture = editor.startPageResize(handle)!;
    gesture.to(20, 30);
    expect(editor.project.designWidth).toBe(
      width + (handle.includes('e') ? 40 : handle.includes('w') ? -40 : 0),
    );
    expect(editor.page.height).toBe(height + (handle.includes('s') ? 30 : 0));
    expect(editor.project.pages[1]!.height).toBe(otherHeight);
    expect(editor.page.elements).toEqual(beforeElements);
    gesture.to(handle.includes('w') ? 10_000 : -10_000, -10_000);
    expect(editor.project.designWidth).toBe(
      handle === 's' ? width : MIN_PAGE_WIDTH,
    );
    expect(editor.page.height).toBe(
      handle.includes('s') ? MIN_PAGE_HEIGHT : height,
    );
    gesture.finish();
    editor.undo();
    expect(editor.project.designWidth).toBe(width);
    expect(editor.page.height).toBe(height);
    expect(editor.canUndo).toBe(false);
    editor.redo();
    expect(editor.project.designWidth).toBe(
      handle === 's' ? width : MIN_PAGE_WIDTH,
    );
  }
});

test('Page resize rejects read-only edits and stale gestures cannot change another Page', () => {
  const project = createProject('Resize');
  project.pages.push(createPage('other'));
  const editor = new StackEditor(project);
  editor.readOnly = true;
  expect(editor.startPageResize('se')).toBeUndefined();
  editor.readOnly = false;
  const gesture = editor.startPageResize('se')!;
  gesture.to(20, 30);
  editor.goToPage(1);
  const before = structuredClone(editor.project);
  gesture.to(500, 500);
  gesture.finish();
  expect(editor.project).toEqual(before);
});

const editorWith = (...kinds: Parameters<StackEditor['addElement']>[0][]) => {
  const editor = new StackEditor(createProject('Mystery'));
  for (const kind of kinds) {
    editor.addElement(kind);
  }
  editor.selectPage();
  return editor;
};

test('new Elements are named by kind and selected', () => {
  const editor = editorWith();
  expect(editor.addElement('button').name).toBe('button1');
  expect(editor.addElement('button').name).toBe('button2');
  expect(editor.addElement('text').name).toBe('text1');
  expect(editor.selection).toEqual(['text1']);
});

test('a click selects one Element, and empty space selects the Page', () => {
  const editor = editorWith('rectangle', 'ellipse');
  editor.click('rectangle1');
  expect(editor.selection).toEqual(['rectangle1']);
  editor.click('ellipse1');
  expect(editor.selection).toEqual(['ellipse1']);
  editor.click(undefined);
  expect(editor.selection).toEqual([]);
});

test('Shift-click adds and removes Elements from the selection', () => {
  const editor = editorWith('rectangle', 'ellipse', 'line');
  editor.click('rectangle1');
  editor.click('line1', { shift: true });
  expect(editor.selected.map(e => e.name)).toEqual(['rectangle1', 'line1']);
  editor.click('rectangle1', { shift: true });
  expect(editor.selection).toEqual(['line1']);
  editor.click(undefined, { shift: true });
  expect(editor.selection).toEqual(['line1']);
});

test('a click on a selected Element keeps the group, so it can be dragged', () => {
  const editor = editorWith('rectangle', 'ellipse');
  editor.click('rectangle1');
  editor.click('ellipse1', { shift: true });
  editor.click('rectangle1');
  expect(editor.selection).toEqual(['rectangle1', 'ellipse1']);
});

test('moving drags every selected Element from where it started', () => {
  const editor = editorWith('rectangle', 'ellipse', 'line');
  editor.click('rectangle1');
  editor.click('ellipse1', { shift: true });
  const [rectangle, ellipse, line] = editor.page.elements;
  const before = { r: rectangle!.left, e: ellipse!.top, l: line!.left };
  const move = editor.startMove();
  move.to(5, 5);
  move.to(30.4, -10.6);
  expect(editor.element('rectangle1')!.left).toBe(before.r + 30);
  expect(editor.element('ellipse1')!.top).toBe(before.e - 11);
  expect(editor.element('line1')!.left).toBe(before.l);
});

test('resizing keeps the opposite edge and a minimum size', () => {
  const box = { left: 100, top: 100, width: 200, height: 100 };
  expect(resizeBox(box, 'se', 20, 10)).toEqual({
    left: 100,
    top: 100,
    width: 220,
    height: 110,
  });
  expect(resizeBox(box, 'nw', 20, 10)).toEqual({
    left: 120,
    top: 110,
    width: 180,
    height: 90,
  });
  expect(resizeBox(box, 'e', 0, 50)).toEqual(box);
  expect(resizeBox(box, 'w', 500, 0, 8)).toEqual({
    left: 292,
    top: 100,
    width: 8,
    height: 100,
  });
});

test('a resize needs exactly one selected Element, and lines may go flat', () => {
  const editor = editorWith('rectangle', 'line');
  expect(editor.startResize('se')).toBeUndefined();
  editor.click('rectangle1');
  editor.click('line1', { shift: true });
  expect(editor.startResize('se')).toBeUndefined();

  editor.click('rectangle1', { shift: true });
  editor.startResize('s')!.to(0, -500);
  expect(editor.element('line1')!.height).toBe(0);

  editor.click('rectangle1');
  editor.startResize('s')!.to(0, -500);
  expect(editor.element('rectangle1')!.height).toBe(8);
});

test('an Element name must be an identifier, unique within its Page', () => {
  const editor = editorWith('button', 'text');
  const page = editor.page;
  expect(checkElementName(page, 'climbButton', 'button1')).toEqual({
    ok: true,
  });
  expect(checkElementName(page, 'button1', 'button1')).toEqual({ ok: true });

  const duplicate = checkElementName(page, 'text1', 'button1');
  expect(duplicate.ok).toBe(false);
  expect(duplicate).toMatchObject({
    message: 'Another Element on this Page is already named “text1”.',
    suggestion: 'text2',
  });

  expect(checkElementName(page, 'Climb the stairs', 'button1')).toMatchObject({
    ok: false,
    suggestion: 'climbTheStairs',
  });
});

test('a refused rename leaves the name, and a rename follows the selection', () => {
  const editor = editorWith('button', 'text');
  editor.click('button1');
  expect(editor.renameElement('button1', 'text1').ok).toBe(false);
  expect(editor.element('button1')).toBeDefined();
  expect(editor.renameElement('button1', 'climbButton').ok).toBe(true);
  expect(editor.selection).toEqual(['climbButton']);
});

test('the same Element name may be used on another Page', () => {
  const editor = editorWith('button');
  editor.addPage();
  expect(checkElementName(editor.page, 'button1')).toEqual({ ok: true });
});

test('a Page name must be an identifier, unique within the Project', () => {
  const editor = editorWith();
  editor.addPage();
  expect(editor.page.name).toBe('page2');
  expect(checkPageName(editor.project, 'page1', 'page2')).toMatchObject({
    ok: false,
    suggestion: 'page3',
  });
  expect(editor.renamePage('2nd page').ok).toBe(false);
  expect(editor.renamePage('lampRoom').ok).toBe(true);
  expect(editor.project.pages.map(p => p.name)).toEqual(['page1', 'lampRoom']);
});

test("a button's name is suggested from its label", () => {
  const project = createProject('Labels');
  const page = project.pages[0]!;
  page.elements = [
    createElement('button', 'button1'),
    createElement('button', 'button2'),
  ];
  const [first, second] = page.elements as ButtonElement[];
  first!.label = 'Climb the stairs →';
  expect(labelSuggestion(page, first!)).toBe('climbTheStairs');
  first!.name = 'climbTheStairs';
  expect(labelSuggestion(page, first!)).toBeUndefined();
  second!.label = 'Climb the stairs';
  expect(labelSuggestion(page, second!)).toBe('climbTheStairs2');
});

test('Pages are added after the showing one, and reordered', () => {
  const editor = editorWith();
  editor.addPage();
  editor.addPage();
  expect(editor.project.pages.map(p => p.name)).toEqual([
    'page1',
    'page2',
    'page3',
  ]);
  editor.goToPage(0);
  editor.addPage();
  expect(editor.page.name).toBe('page4');
  expect(editor.pageIndex).toBe(1);

  editor.movePage(1, 3);
  expect(editor.project.pages.map(p => p.name)).toEqual([
    'page1',
    'page2',
    'page3',
    'page4',
  ]);
  expect(editor.page.name).toBe('page4');
  editor.nextPage();
  expect(editor.pageIndex).toBe(3);
  editor.previousPage();
  expect(editor.page.name).toBe('page3');
});

test('changing Page clears the selection', () => {
  const editor = editorWith('rectangle');
  editor.click('rectangle1');
  editor.addPage();
  expect(editor.selection).toEqual([]);
  expect(editor.page.elements).toEqual([]);
});

test('live views are independently owned, preserve node identities, and snapshots stay detached', () => {
  const project = createProject('Live');
  project.pages[0]!.elements.push(
    createElement('button', 'button1'),
    createElement('text', 'text1'),
  );
  project.pages.push(createPage('other'));
  const editor = new StackEditor(project);
  const button = editor.element('button1')!;
  const page = editor.page;
  const before = editor.snapshot();
  project.name = 'External change';
  expect(editor.project.name).toBe('Live');
  expect(Object.isFrozen(editor.project)).toBe(false);
  expect(() => {
    // @ts-expect-error Interaction metadata remains immutable.
    editor.state.value.selection.push('forbidden');
  }).toThrow();
  editor.renameElement('button1', 'renamed');
  expect(editor.element('renamed')).toBe(button);
  expect(editor.page).toBe(page);
  expect(before.pages[0]!.elements[0]!.name).toBe('button1');
  editor.undo();
  expect(editor.project).toEqual(before);
  expect(editor.element('button1')!.id).toBe(button.id);
});
