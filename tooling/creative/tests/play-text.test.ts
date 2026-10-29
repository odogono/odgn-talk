import { expect, test } from 'bun:test';
import {
  createElement,
  createPage,
  createProject,
  richTextFromPlainText,
  textOf,
} from '../src/model';
import { PlaySession } from '../src/play';
import { ReaderTextHistory } from '../src/play-text';

const fixture = () => {
  const project = createProject('Journal');
  const journal = createElement('text', 'journal');
  if (journal.kind !== 'text') {
    throw new Error('Expected text');
  }
  journal.editable = true;
  journal.richText = [
    { runs: [{ text: 'Authored', italic: true, color: '#123456' }] },
  ];
  const output = createElement('button', 'output');
  journal.script =
    'on textChanged\n set the label of output to the text of me\nend textChanged';
  project.pages[0]!.elements.push(journal, output);
  project.pages.push(createPage('page2'));
  project.pages[0]!.script =
    'on click\n tell pages to show page2\nend click\non closePage\n wait 1 s\nend closePage';
  const play = new PlaySession(project);
  const element = play.page.elements[0]!;
  if (element.kind !== 'text') {
    throw new Error('Expected text');
  }
  return {
    project,
    play,
    element,
    authoredText: journal.richText,
    history: new ReaderTextHistory(play, element),
  };
};
const drain = (play: PlaySession) => {
  for (let i = 0; i < 100; i++) {
    if (play.pump(0n).state !== 'sliced') {
      return;
    }
  }
  throw new Error('Did not become idle');
};

test('reader formatting and paragraphs notify the Element with new plain text and stay in Play State', () => {
  const { project, play, element, history } = fixture();
  const original = structuredClone(project);
  const edited = [
    {
      runs: [{ text: 'Reader', bold: true, underline: true, color: '#ff0000' }],
    },
    { runs: [{ text: 'journal', italic: true }] },
  ];
  history.set(edited);
  drain(play);
  expect(play.problems).toEqual([]);
  expect(play.page.elements[1]).toHaveProperty('label', 'Reader\njournal');
  expect(element.richText).toEqual(edited);
  // Caller mutation must not change an already recorded reader edit.
  edited[0]!.runs[0]!.text = 'Changed elsewhere';
  expect(textOf(element)).toBe('Reader\njournal');
  expect(project).toEqual(original);
  play.stop(0n);
  expect(new PlaySession(project).page.elements[0]).toEqual(
    original.pages[0]!.elements[0],
  );
});

test('reader undo and redo notify handlers and never touch authored history', () => {
  const { project, play, element, history, authoredText } = fixture();
  const original = structuredClone(project);
  history.set(richTextFromPlainText('Reader'));
  history.undo();
  drain(play);
  expect(element.richText).toEqual(authoredText);
  expect(play.page.elements[1]).toHaveProperty('label', 'Authored');
  expect(history.canUndo).toBe(false);
  expect(history.canRedo).toBe(true);
  history.redo();
  drain(play);
  expect(play.page.elements[1]).toHaveProperty('label', 'Reader');
  expect(project).toEqual(original);
});

test('format-only edits send textChanged and identical edits do not', () => {
  const { play, history } = fixture();
  drain(play);
  const output = play.page.elements[1]!;
  if (output.kind !== 'button') {
    throw new Error('Expected button');
  }
  history.set([{ runs: [{ text: 'Authored', bold: true }] }]);
  drain(play);
  expect(output.label).toBe('Authored');
  play.runMessage('set the label of output to "No change"');
  drain(play);
  history.set([{ runs: [{ text: 'Authored', bold: true }] }]);
  drain(play);
  expect(output.label).toBe('No change');
});

test('a Script replacing the same plain text clears formatting and resets reader history', () => {
  const { play, element, history } = fixture();
  history.set([{ runs: [{ text: 'Authored', bold: true }] }]);
  play.group
    .script('element:page1/journal')!
    .reload(
      element.script! +
        '\non click\n set the text of me to "Authored"\nend click',
      'reset variables',
    );
  play.send(element, 'click');
  drain(play);
  expect(element.richText).toEqual(richTextFromPlainText('Authored'));
  expect(history.canUndo).toBe(false);
  history.undo();
  expect(element.richText).toEqual(richTextFromPlainText('Authored'));
  expect(play.problems).toEqual([]);
});

for (const blocked of [
  'ended',
  'navigating',
  'other Page',
  'read-only',
  'hidden',
] as const) {
  test(`${blocked} reader text cannot change Play State or enqueue textChanged`, () => {
    const { play, element, history } = fixture();
    drain(play);
    if (blocked === 'ended') {
      play.stop(0n);
    } else if (blocked === 'navigating') {
      play.send(play.page, 'click');
      drain(play);
    } else if (blocked === 'other Page') {
      play.pageIndex = 1;
    } else if (blocked === 'read-only') {
      play.runMessage('set the editable of journal to false');
      drain(play);
    } else {
      play.runMessage('hide journal');
      drain(play);
    }
    const original = structuredClone(element.richText);
    history.set(richTextFromPlainText('Rejected'));
    expect(element.richText).toEqual(original);
    expect(history.canUndo).toBe(false);
    expect(
      play.group.inspect().scripts.every(s => s.mailbox.length === 0),
    ).toBe(true);
  });
}
