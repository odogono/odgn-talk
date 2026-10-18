// Dedicated page without main.js; drives the Preact Errors window directly.
import { ErrorsWindow } from '../src/errors';
import { createElement, createProject } from '../src/model';
import { mountStack } from '../src/stack';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean, message: string) => {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
};
const node = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const items = () => [...document.querySelectorAll('#error-list li')];
const buttons = () => [
  ...document.querySelectorAll<HTMLButtonElement>('#error-list button'),
];

const project = createProject('Errors window');
project.pages[0]!.name = 'Home';
project.pages[0]!.elements.push(
  createElement('button', 'go'),
  createElement('button', 'gone'),
);
export const shell = mountStack(project);
const errors = new ErrorsWindow(shell);
const owner = (name: string) =>
  shell.editor.project.pages[0]!.elements.find(e => e.name === name)!;

export const runBrowserTests = async () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };
  await test('starts empty and hidden', async () => {
    assert(node('errors-window').hidden, 'Errors window starts visible');
    assert(!node('errors-empty').hidden, 'Empty note hidden at start');
    assert(!items().length && errors.count === 0, 'Errors listed at start');
  });

  await test('problems append with labels and show the window', async () => {
    errors.add([
      { line: 3, message: 'Project problem', owner: shell.editor.project },
      { line: 2, message: 'Go problem', owner: owner('go') },
    ]);
    assert(errors.count === 2, `count is ${errors.count}, not 2`);
    assert(!node('errors-window').hidden, 'add did not show the window');
    await until(() => items().length === 2, 'First problems not listed');
    assert(node('errors-empty').hidden, 'Empty note shown with problems');
    const first = items()[0]!;
    errors.add([{ message: 'Gone problem', owner: owner('gone') }]);
    await until(() => items().length === 3, 'Appended problem not listed');
    assert(items()[0] === first, 'Appending rebuilt the earlier problems');
    const labels = [...document.querySelectorAll('#error-list .where')].map(
      where => where.textContent,
    );
    assert(
      JSON.stringify(labels) ===
        JSON.stringify(['Project, line 3', 'Home › go, line 2', 'Home › gone']),
      `labels were ${JSON.stringify(labels)}`,
    );
    assert(
      buttons().every(
        b =>
          !b.disabled && b.title === 'Open this Script' && b.type === 'button',
      ),
      'A reported problem starts disabled or untitled',
    );
    assert(
      buttons()[1]!.lastElementChild!.textContent === 'Go problem',
      'Problem message missing',
    );
  });

  await test("opening a problem opens its owner's Script", async () => {
    buttons()[1]!.click();
    await until(
      () => !!document.querySelector('.script-window'),
      'No Script window opened',
    );
  });

  await test("a vanished owner's problem is disabled", async () => {
    shell.editor.edit(({ project }) => {
      const page = project.pages[0]!;
      page.elements = page.elements.filter(e => e.name !== 'gone');
    });
    const gone = buttons()[2]!;
    gone.click();
    await until(() => gone.disabled, 'Vanished owner left enabled');
    assert(
      gone.title === 'This is no longer in the Project',
      `title is ${JSON.stringify(gone.title)}`,
    );
    assert(
      buttons()[0]!.title === 'Open this Script' && !buttons()[0]!.disabled,
      'Another problem changed with the vanished one',
    );
  });

  await test('Clear empties the list and keeps the window', async () => {
    node('clear-errors').click();
    assert(errors.count === 0, 'Clear left a count');
    await until(() => !items().length, 'Clear left problems listed');
    assert(!node('errors-empty').hidden, 'Empty note hidden after Clear');
    assert(!node('errors-window').hidden, 'Clear hid the window');
  });

  await test('a closed window opens again on the next problem', async () => {
    node('close-errors').click();
    assert(node('errors-window').hidden, 'Close left the window visible');
    errors.add([{ message: 'Again', owner: owner('go') }]);
    assert(!node('errors-window').hidden, 'add did not reopen the window');
    await until(() => items().length === 1, 'Reopened problem not listed');
    errors.clear();
    await until(() => !items().length, 'clear() left problems listed');
  });

  return results;
};
