// Dedicated page without main.js; exercises Info, history and the Play renderer.
import { createElement, createProject } from '../src/model';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Info');
};
const project = createProject('Border widths');
for (const [index, kind] of (['rectangle', 'ellipse'] as const).entries()) {
  const element = createElement(kind, kind);
  element.left += index * 240;
  element.script =
    'on click {button: 0}\n set the thickness of me to 0\nend click';
  project.pages[0]!.elements.push(element);
}
export const shell = mountStack(project);
mountPlay(shell);

const border = (name: string, reader = false) => {
  const node = document.querySelector<HTMLElement>(
    `${reader ? '#reader' : '#page'} [data-element="${name}"]`,
  )!;
  return getComputedStyle(node).borderTopWidth;
};
const setThickness = (value: number) => {
  const input = document.querySelector<HTMLInputElement>(
    '[data-field="thickness"]',
  )!;
  assert(input.min === '0', 'Info allows zero');
  input.value = String(value);
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

export const runBrowserTests = async () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = async (name: string, run: () => void | Promise<void>) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };
  for (const kind of ['rectangle', 'ellipse']) {
    await test(`${kind} Info renders zero, thin and thick borders with undo/redo`, async () => {
      shell.editor.click(kind);
      shell.redraw();
      await until(
        () => !!document.querySelector('#info [data-field="thickness"]'),
      );
      assert(border(kind) === '2px', 'Default border is 2px');
      for (const width of [0, 1, 6]) {
        setThickness(width);
        assert(border(kind) === `${width}px`, `Border renders ${width}px`);
        shell.editor.undo();
        shell.redraw();
        assert(border(kind) === '2px', 'Undo restores default');
        shell.editor.redo();
        shell.redraw();
        assert(border(kind) === `${width}px`, 'Redo restores width');
        shell.editor.undo();
        shell.redraw();
      }
      setThickness(-1);
      assert(border(kind) === '0px', 'Negative Info input clamps to zero');
      shell.editor.undo();
      shell.redraw();
    });
  }
  for (const mode of ['Browse', 'Present']) {
    await test(`${mode} renders Script border changes and restores authored borders on exit`, async () => {
      const toggle = document.querySelector<HTMLButtonElement>(
        '#menu [aria-pressed]',
      )!;
      const tool = (name: string) =>
        [
          ...document.querySelectorAll<HTMLButtonElement>('#tool-modes button'),
        ].find(button => button.textContent?.includes(name))!;
      (mode === 'Present' ? toggle : tool('Browse')).click();
      for (const kind of ['rectangle', 'ellipse']) {
        assert(
          border(kind, true) === '2px',
          'Reader starts with authored border',
        );
        document
          .querySelector<HTMLElement>(`#reader [data-element="${kind}"]`)!
          .click();
        for (let i = 0; i < 100 && border(kind, true) !== '0px'; i++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert(border(kind, true) === '0px', 'Script removes reader border');
      }
      (mode === 'Present' ? toggle : tool('Edit')).click();
      for (const kind of ['rectangle', 'ellipse']) {
        assert(border(kind) === '2px', 'Stop restores authored border');
      }
    });
  }
  return results;
};
