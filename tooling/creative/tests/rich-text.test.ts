import { expect, test } from 'bun:test';
import {
  createElement,
  createProject,
  plainTextOf,
  replacePlainText,
  richTextFromPlainText,
  textOf,
} from '../src/model';
import {
  alignTextRange,
  rangeAlign,
  rangeHasStyle,
  replaceTextRange,
  styleTextRange,
} from '../src/rich-text';
import { StackEditor } from '../src/editing';
import { readProjectFile, writeProjectFile } from '../src/project-file';

const sample = () => {
  const element = createElement('text', 'note');
  if (element.kind !== 'text') {
    throw new Error('Expected text');
  }
  return element;
};

test('format part of a run across paragraphs, and remove it without losing other marks', () => {
  const text = richTextFromPlainText('hello\nworld');
  const selected = { start: 2, end: 8 };
  const styled = styleTextRange(text, selected, {
    bold: true,
    italic: true,
    underline: true,
    color: '#ff0000',
  });
  expect(plainTextOf(styled)).toBe('hello\nworld');
  expect(styled).toEqual([
    {
      runs: [
        { text: 'he' },
        {
          text: 'llo',
          bold: true,
          italic: true,
          underline: true,
          color: '#ff0000',
        },
      ],
    },
    {
      runs: [
        {
          text: 'wo',
          bold: true,
          italic: true,
          underline: true,
          color: '#ff0000',
        },
        { text: 'rld' },
      ],
    },
  ]);
  expect(rangeHasStyle(styled, selected, 'bold')).toBe(true);
  expect(rangeHasStyle(styled, { start: 0, end: 8 }, 'bold')).toBe(false);
  const removed = styleTextRange(styled, selected, {
    bold: false,
    color: undefined,
  });
  expect(removed[0]!.runs[1]).toEqual({
    text: 'llo',
    italic: true,
    underline: true,
  });
  expect(
    styleTextRange(removed, selected, { italic: false, underline: false }),
  ).toEqual(text);
  expect(text).toEqual(richTextFromPlainText('hello\nworld'));
});

test('replacement joins paragraphs and preserves the styled prefix, inserted text and suffix', () => {
  const text = [
    { runs: [{ text: 'a😀b', bold: true }] },
    { runs: [{ text: 'cde', italic: true }] },
  ];
  const inserted = [
    { runs: [{ text: 'X', underline: true }] },
    { runs: [{ text: 'Y' }] },
  ];
  const result = replaceTextRange(text, { start: 3, end: 6 }, inserted);
  expect(result).toEqual([
    {
      runs: [
        { text: 'a😀', bold: true },
        { text: 'X', underline: true },
      ],
    },
    { runs: [{ text: 'Y' }, { text: 'de', italic: true }] },
  ]);
  expect(
    replaceTextRange(
      result,
      { start: 0, end: plainTextOf(result).length },
      richTextFromPlainText(''),
    ),
  ).toEqual(richTextFromPlainText(''));
  expect(
    replaceTextRange(
      richTextFromPlainText('ab'),
      { start: 1, end: 1 },
      richTextFromPlainText('\n'),
    ),
  ).toEqual(richTextFromPlainText('a\nb'));
});

test('plain text replacement clears mixed formatting even if the text is unchanged', () => {
  const element = sample();
  element.richText = [
    {
      runs: [
        {
          text: 'same',
          bold: true,
          italic: true,
          underline: true,
          color: 'red',
        },
      ],
    },
  ];
  expect(textOf(element)).toBe('same');
  replacePlainText(element, 'same');
  expect(element.richText).toEqual(richTextFromPlainText('same'));
  replacePlainText(element, 'one\r\ntwo\n');
  expect(textOf(element)).toBe('one\ntwo\n');
});

test('text edits are steps in the Stack editor history, and formatting survives Project files', async () => {
  const project = createProject('Rich');
  const element = sample();
  project.pages[0]!.elements.push(element);
  const editor = new StackEditor(project);
  const history = editor.textHistory(element);
  const original = structuredClone(element.richText);
  history.set(
    styleTextRange(
      original,
      { start: 0, end: 4 },
      { bold: true, italic: true, underline: true, color: '#ff0000' },
    ),
  );
  const styled = structuredClone(history.element.richText);
  editor.edit(({ project, tree }) => {
    tree.setGeometry(
      project.pages[0]!.elements.find(e => e.name === history.element.name)!,
      { left: 99 },
    );
  });
  history.set(styleTextRange(styled, { start: 0, end: 4 }, { bold: false }));
  const removed = structuredClone(history.element.richText);
  history.set(removed);
  history.undo();
  expect(history.element.richText).toEqual(styled);
  expect(history.element.left).toBe(99);
  history.undo();
  expect(history.element.left).toBe(40);
  history.undo();
  expect(history.element.richText).toEqual(original);
  expect(history.canUndo).toBe(false);
  history.redo();
  history.redo();
  history.redo();
  expect(history.element.richText).toEqual(removed);
  const read = await readProjectFile(
    await writeProjectFile(project, new Map()),
  );
  expect(read.project).toEqual(project);
  history.undo();
  history.set(richTextFromPlainText('new'));
  expect(history.canRedo).toBe(false);
});

test('alignment belongs to paragraphs and survives styling and edits', () => {
  const text = alignTextRange(
    richTextFromPlainText('one\ntwo\nthree'),
    { start: 5, end: 5 },
    'center',
  );
  expect(text.map(p => p.align)).toEqual([undefined, 'center', undefined]);
  expect(rangeAlign(text, { start: 5, end: 6 })).toBe('center');
  expect(rangeAlign(text, { start: 0, end: 6 })).toBeUndefined();

  const styled = styleTextRange(text, { start: 2, end: 10 }, { bold: true });
  expect(styled.map(p => p.align)).toEqual([undefined, 'center', undefined]);

  // A new paragraph inside a centred one is centred too.
  const split = replaceTextRange(
    text,
    { start: 5, end: 5 },
    richTextFromPlainText('\n'),
  );
  expect(plainTextOf(split)).toBe('one\nt\nwo\nthree');
  expect(split.map(p => p.align)).toEqual([
    undefined,
    'center',
    'center',
    undefined,
  ]);

  // Joining paragraphs keeps the first one's alignment.
  const joined = replaceTextRange(
    alignTextRange(text, { start: 0, end: 0 }, 'right'),
    { start: 2, end: 6 },
    richTextFromPlainText(''),
  );
  expect(joined).toEqual([
    { align: 'right', runs: [{ text: 'ono' }] },
    { runs: [{ text: 'three' }] },
  ]);

  expect(alignTextRange(text, { start: 0, end: 13 }, 'left')).toEqual(
    richTextFromPlainText('one\ntwo\nthree'),
  );
});

test("plain text writes keep each paragraph's alignment", () => {
  const element = sample();
  element.richText = [
    { align: 'right', runs: [{ text: 'a', bold: true }] },
    { align: 'center', runs: [{ text: 'b' }] },
  ];
  replacePlainText(element, 'x\ny\nz');
  expect(element.richText).toEqual([
    { align: 'right', runs: [{ text: 'x' }] },
    { align: 'center', runs: [{ text: 'y' }] },
    { align: 'center', runs: [{ text: 'z' }] },
  ]);
});

test('alignment round-trips through a Project file', async () => {
  const project = createProject('Aligned');
  const element = sample();
  element.richText = [
    { align: 'justify', runs: [{ text: 'a' }] },
    { runs: [{ text: 'b' }] },
  ];
  project.pages[0]!.elements.push(element);
  const read = await readProjectFile(
    await writeProjectFile(project, new Map()),
  );
  expect(read.project.pages[0]!.elements[0]).toHaveProperty(
    'richText',
    element.richText,
  );
});
