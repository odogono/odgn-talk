// Run in a real browser (commands in README.md); no DOM emulator.
import { StackEditor } from '../src/editing';
import {
  createElement,
  createProject,
  plainTextOf,
  richTextFromPlainText,
  type TextElement,
} from '../src/model';
import {
  readRichText,
  renderRichText,
  richTextFromHtml,
  selectionInText,
  selectTextRange,
} from '../src/rich-text-dom';
import { InPlaceTextEditor } from '../src/text-editor';

// Text history over a one-Element Project; undo replaces the Element's
// object, so tests read it through `history.element`.
const historyFor = (element: TextElement) => {
  const project = createProject('Browser');
  project.pages[0]!.elements.push(element);
  return new StackEditor(project).textHistory(element);
};

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map(key => [key, item[key]]),
      );
    }
    return item;
  });
const equal = (actual: unknown, expected: unknown) => {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(
      `Expected ${stableJson(expected)}, got ${stableJson(actual)}`,
    );
  }
};

export const runBrowserTests = () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = (name: string, run: () => void) => {
    try {
      run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };
  test('web and word processor paste keeps only allowed marks', () => {
    equal(
      richTextFromHtml(
        '<div><p><b>B</b><i>I</i><u>U</u><span style="color:#ff0000;font-size:99px;background:blue;font-family:serif">C</span><a href="https://example.com" onclick="alert(1)">link</a><img src="x" onerror="alert(1)"><script>alert(1)</script><style>p{color:blue}</style></p><p><span style="font-weight:700;font-style:italic;text-decoration:underline">Word</span></p></div>',
      ),
      [
        {
          runs: [
            { text: 'B', bold: true },
            { text: 'I', italic: true },
            { text: 'U', underline: true },
            { text: 'C', color: 'rgb(255, 0, 0)' },
            { text: 'link' },
          ],
        },
        { runs: [{ text: 'Word', bold: true, italic: true, underline: true }] },
      ],
    );
  });
  test('nested blocks, lists, empty paragraphs and clipboard indentation preserve plain text', () => {
    equal(
      plainTextOf(
        richTextFromHtml(
          '<div>\n <p>one</p>\n <p><br></p>\n <p>two</p>\n</div>',
        ),
      ),
      'one\n\ntwo',
    );
    equal(
      plainTextOf(richTextFromHtml('<ul><li>one</li><li>two</li></ul>')),
      'one\ntwo',
    );
    equal(plainTextOf(richTextFromHtml('<p>one<br>two</p>')), 'one\ntwo');
  });
  test('nested explicit normal styles override inherited marks', () => {
    equal(
      richTextFromHtml(
        '<b><i><u>A<span style="font-weight:normal;font-style:normal;text-decoration:none">B</span>C</u></i></b>',
      ),
      [
        {
          runs: [
            { text: 'A', bold: true, italic: true, underline: true },
            { text: 'B' },
            { text: 'C', bold: true, italic: true, underline: true },
          ],
        },
      ],
    );
  });
  test('empty paragraphs render and read without growing extra paragraphs', () => {
    const node = document.createElement('div');
    for (const text of ['', '\n', 'one\n\ntwo\n', '\nlast', '😀']) {
      const rich = richTextFromPlainText(text);
      renderRichText(node, rich);
      equal(readRichText(node), rich);
    }
  });
  test('DOM selection offsets include separators and UTF-16 text', () => {
    const node = document.createElement('div');
    document.body.append(node);
    try {
      renderRichText(node, richTextFromPlainText('a😀\n\nbc'));
      for (const range of [
        { start: 0, end: 7 },
        { start: 3, end: 5 },
        { start: 4, end: 4 },
        { start: 6, end: 7 },
      ]) {
        selectTextRange(node, range);
        equal(selectionInText(node), range);
      }
    } finally {
      node.remove();
    }
  });
  test('toolbar, paste, paragraph insertion, history and reopening edit the model', () => {
    const element = createElement('text', 'browserTest');
    if (element.kind !== 'text') {
      throw new Error('Expected text');
    }
    const history = historyFor(element);
    const fixture = document.createElement('div');
    const node = document.createElement('div');
    const toolbar = document
      .querySelector('#text-toolbar')!
      .cloneNode(true) as HTMLElement;
    toolbar.removeAttribute('id');
    fixture.append(node, toolbar);
    document.body.append(fixture);
    renderRichText(node, history.element.richText);
    let editor: InPlaceTextEditor | undefined;
    const open = () => {
      editor = new InPlaceTextEditor(
        node,
        toolbar,
        history,
        () => {},
        () => editor?.destroy(),
      );
    };
    const command = (name: string) =>
      toolbar
        .querySelector<HTMLButtonElement>(`[data-text-command="${name}"]`)!
        .click();
    try {
      open();
      command('bold');
      equal(history.element.richText[0]!.runs[0]!.bold, true);
      command('bold');
      equal(history.element.richText, richTextFromPlainText('Text'));
      command('undo');
      equal(history.element.richText[0]!.runs[0]!.bold, true);
      command('redo');
      equal(history.element.richText, richTextFromPlainText('Text'));
      const data = new DataTransfer();
      data.setData('text/html', '<p><u>one</u></p><p>two</p>');
      node.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
      equal(plainTextOf(history.element.richText), 'one\ntwo');
      equal(history.element.richText[0]!.runs[0]!.underline, true);
      node.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertParagraph',
          cancelable: true,
        }),
      );
      equal(plainTextOf(history.element.richText), 'one\ntwo\n');
      command('undo');
      equal(plainTextOf(history.element.richText), 'one\ntwo');
      editor?.destroy();
      open();
      command('clear');
      equal(history.element.richText, richTextFromPlainText('one\ntwo'));
      command('undo');
      equal(history.element.richText[0]!.runs[0]!.underline, true);
      command('redo');
      equal(history.element.richText, richTextFromPlainText('one\ntwo'));
      const plain = new DataTransfer();
      plain.setData('text/plain', 'x\ny');
      node.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: plain, cancelable: true }),
      );
      equal(history.element.richText, richTextFromPlainText('x\ny'));
    } finally {
      editor?.destroy();
      fixture.remove();
    }
  });
  test('composition is committed as one text edit', () => {
    const element = createElement('text', 'ime');
    if (element.kind !== 'text') {
      throw new Error('Expected text');
    }
    const history = historyFor(element);
    const node = document.createElement('div');
    const toolbar = document
      .querySelector('#text-toolbar')!
      .cloneNode(true) as HTMLElement;
    toolbar.removeAttribute('id');
    document.body.append(node, toolbar);
    renderRichText(node, history.element.richText);
    const editor = new InPlaceTextEditor(
      node,
      toolbar,
      history,
      () => {},
      () => {},
    );
    try {
      node.dispatchEvent(new CompositionEvent('compositionstart'));
      node.querySelector('span')!.textContent = '日本語';
      node.dispatchEvent(new InputEvent('input', { isComposing: true }));
      equal(plainTextOf(history.element.richText), 'Text');
      node.dispatchEvent(new CompositionEvent('compositionend'));
      equal(plainTextOf(history.element.richText), '日本語');
      history.undo();
      equal(plainTextOf(history.element.richText), 'Text');
      equal(history.canUndo, false);
    } finally {
      editor.destroy();
      node.remove();
      toolbar.remove();
    }
  });
  test('alignment is set from the toolbar and survives typing and paste', () => {
    const element = createElement('text', 'aligned') as TextElement;
    element.richText = richTextFromPlainText('one\ntwo');
    const history = historyFor(element);
    const node = document.createElement('div');
    const toolbar = document
      .querySelector('#text-toolbar')!
      .cloneNode(true) as HTMLElement;
    toolbar.removeAttribute('id');
    document.body.append(node, toolbar);
    renderRichText(node, history.element.richText);
    const editor = new InPlaceTextEditor(
      node,
      toolbar,
      history,
      () => {},
      () => {},
      { selectAll: false },
    );
    const button = (align: string) =>
      toolbar.querySelector<HTMLButtonElement>(
        `[data-text-command="align-${align}"]`,
      )!;
    try {
      selectTextRange(node, { start: 5, end: 5 });
      document.dispatchEvent(new Event('selectionchange'));
      equal(button('left').getAttribute('aria-pressed'), 'true');
      button('center').click();
      equal(
        history.element.richText.map(p => p.align),
        [undefined, 'center'],
      );
      equal(button('center').getAttribute('aria-pressed'), 'true');
      equal((node.children[1] as HTMLElement).style.textAlign, 'center');
      // Typing is read back from the DOM, which carries the alignment.
      node.children[1]!.querySelector('span')!.textContent = 'twox';
      node.dispatchEvent(new InputEvent('input'));
      equal(history.element.richText[1], {
        align: 'center',
        runs: [{ text: 'twox' }],
      });
      equal(
        readRichText(node).map(p => p.align),
        [undefined, 'center'],
      );
      equal(
        richTextFromHtml(
          '<p style="text-align:right">a</p><p style="text-align:start">b</p>',
        ),
        [{ align: 'right', runs: [{ text: 'a' }] }, { runs: [{ text: 'b' }] }],
      );
      button('right').click();
      history.undo();
      equal(history.element.richText[1]!.align, 'center');
    } finally {
      editor.destroy();
      node.remove();
      toolbar.remove();
    }
  });
  return results;
};
