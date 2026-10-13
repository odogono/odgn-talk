import { expect, test } from 'bun:test';
import {
  createElement,
  createProject,
  duplicateElement,
  duplicatePage,
  freshName,
  isIdentifierName,
  plainTextOf,
  richTextFromPlainText,
  suggestName,
  type TextElement,
} from '../src/model';

test('names are identifiers', () => {
  expect(isIdentifierName('climbButton')).toBe(true);
  expect(isIdentifierName('cellar_2')).toBe(true);
  expect(isIdentifierName('Climb the stairs')).toBe(false);
  expect(isIdentifierName('2cellar')).toBe(false);
  expect(isIdentifierName('')).toBe(false);
});

test('a fresh name numbers its way past taken names', () => {
  const taken = new Set(['door', 'door2']);
  expect(freshName('window', taken)).toBe('window');
  expect(freshName('door', taken)).toBe('door3');
});

test('a name is suggested from free text such as a label', () => {
  expect(suggestName('Climb the stairs →')).toBe('climbTheStairs');
  expect(suggestName('!!!')).toBe('element');
});

test('plain text joins paragraphs, and plain text makes unformatted rich text', () => {
  expect(plainTextOf(richTextFromPlainText('one\ntwo'))).toBe('one\ntwo');
  expect(
    plainTextOf([
      { runs: [{ text: 'a' }, { text: 'b', bold: true }] },
      { runs: [{ text: 'c' }] },
    ]),
  ).toBe('ab\nc');
});

test('a duplicated Element is independent of the original', () => {
  const original = createElement('text', 'note') as TextElement;
  const copy = duplicateElement(original, new Set(['note'])) as TextElement;
  expect(copy.name).toBe('note2');
  copy.left = 999;
  copy.richText[0]!.runs[0]!.text = 'changed';
  expect(original.left).toBe(40);
  expect(plainTextOf(original.richText)).toBe('Text');
});

test('a duplicated Page is independent and keeps its Element names', () => {
  const project = createProject('Mystery');
  const page = project.pages[0]!;
  page.elements.push(createElement('button', 'goButton'));
  const copy = duplicatePage(page, new Set(['page1']));
  expect(copy.name).toBe('page12');
  expect(copy.elements[0]!.name).toBe('goButton');
  copy.elements[0]!.left = 999;
  copy.background = '#000000';
  expect(page.elements[0]!.left).toBe(40);
  expect(page.background).not.toBe('#000000');
});
