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
  editor.edit(() => {
    history.element.left = 99;
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
