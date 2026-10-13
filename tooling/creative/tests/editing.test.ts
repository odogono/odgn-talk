import { expect, test } from 'bun:test';
import {
  checkElementName,
  checkPageName,
  labelSuggestion,
  resizeBox,
  StackEditor,
} from '../src/editing';
import { createProject, type ButtonElement } from '../src/model';

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
  expect(rectangle!.left).toBe(before.r + 30);
  expect(ellipse!.top).toBe(before.e - 11);
  expect(line!.left).toBe(before.l);
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
  const line = editor.element('line1')!;
  editor.startResize('s')!.to(0, -500);
  expect(line.height).toBe(0);

  editor.click('rectangle1');
  const rectangle = editor.element('rectangle1')!;
  editor.startResize('s')!.to(0, -500);
  expect(rectangle.height).toBe(8);
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
  const editor = editorWith('button', 'button');
  const [first, second] = editor.page.elements as ButtonElement[];
  first!.label = 'Climb the stairs →';
  expect(labelSuggestion(editor.page, first!)).toBe('climbTheStairs');
  first!.name = 'climbTheStairs';
  expect(labelSuggestion(editor.page, first!)).toBeUndefined();
  second!.label = 'Climb the stairs';
  expect(labelSuggestion(editor.page, second!)).toBe('climbTheStairs2');
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
