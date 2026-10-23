// Dedicated page without main.js; browses a Project with the Variables
// window open and reads it as an author would.
import { createElement, createProject } from '../src/model';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';
import { showWindow } from '../src/windows';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean, message: string) => {
  for (let i = 0; i < 150; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
};
const node = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const headings = () =>
  [
    ...document.querySelectorAll(
      '.variables-script:not(.variables-watches) h3',
    ),
  ].map(h => h.textContent);
const row = (name: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '.variables-script:not(.variables-watches) li',
    ),
  ].find(li => li.querySelector('.name')?.textContent?.endsWith(name));
const value = (name: string) => row(name)?.querySelector('.value');

const project = createProject('Variables window');
project.pages[0]!.name = 'Home';
const go = createElement('button', 'go');
go.script = [
  'script variable presses = 0',
  'on click',
  ' put presses + 1 into presses',
  'end click',
].join('\n');
project.pages[0]!.elements.push(go, createElement('button', 'quiet'));
project.pages[0]!.script = [
  'script variable board = [[1, 2], [3]]',
  'script variable target = nothing',
  'on openPage',
  ' put go into target',
  'end openPage',
].join('\n');
const shell = mountStack(project);
mountPlay(shell);
const mode = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('#tool-modes button')].find(
    b => b.textContent?.includes(label),
  )!;

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
  await test('lists the showing Page’s Scripts while browsing', async () => {
    assert(node('variables-window').hidden, 'Variables window opened itself');
    showWindow('variables-window');
    assert(!node('variables-empty').hidden, 'Empty note hidden before Play');
    mode('Browse').click();
    await until(
      () => value('target')?.textContent === 'go',
      'The Element reference never showed its name',
    );
    assert(
      JSON.stringify(headings()) === JSON.stringify(['Home', 'Home › go']),
      `headings were ${JSON.stringify(headings())}`,
    );
    assert(value('presses')?.textContent === '0', 'presses is not 0');
    assert(value('board')?.textContent === 'list of 2', 'board not summed up');
  });

  await test('expanding a list keeps it open across refreshes', async () => {
    row('board')!.querySelector('button')!.click();
    await until(() => !!row('1'), 'board did not open');
    assert(
      row('1')!.querySelector('.value')!.textContent === 'list of 2',
      'board’s first item is not a list',
    );
    document.querySelector<HTMLElement>('#reader [data-element="go"]')!.click();
    await until(
      () => value('presses')?.textContent === '1',
      'presses did not change',
    );
    assert(
      value('presses')!.classList.contains('changed'),
      'The changed value was not highlighted',
    );
    assert(!!row('1'), 'board closed on refresh');
  });

  await test('an Element reference selects its Element', async () => {
    value('target')!.querySelector('button')!.click();
    await until(
      () => shell.editor.selected.map(e => e.name).join() === 'go',
      'go was not selected',
    );
  });

  await test('values stay after the session ends', async () => {
    mode('Edit').click();
    await until(
      () => !node('variables-ended').hidden,
      'The ended note never showed',
    );
    assert(value('presses')?.textContent === '1', 'Values went with Play');
    mode('Browse').click();
    await until(
      () => node('variables-ended').hidden === true,
      'A new session kept the ended note',
    );
    mode('Edit').click();
  });
  await test('Watches evaluate while paused, in their chosen context', async () => {
    mode('Browse').click();
    await until(() => value('presses') !== undefined, 'Browse did not start');
    const add = (text: string, context?: string) => {
      const input =
        document.querySelector<HTMLInputElement>('.watch-add input')!;
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (context) {
        const select =
          document.querySelector<HTMLSelectElement>('.watch-add select')!;
        select.value = [...select.options].find(o => o.text === context)!.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document
        .querySelector<HTMLButtonElement>('.watch-add button[type=submit]')!
        .click();
    };
    const watchText = (i: number) =>
      [...document.querySelectorAll<HTMLElement>('li.watch')]
        .at(i)
        ?.querySelector('.value')?.textContent ?? '';
    await until(
      () =>
        [
          ...document.querySelectorAll<HTMLOptionElement>(
            '.watch-add select option',
          ),
        ].some(o => o.text.endsWith('go')),
      'The loaded contexts never reached the Watches',
    );
    const goContext = [
      ...document.querySelectorAll<HTMLOptionElement>(
        '.watch-add select option',
      ),
    ].find(o => o.text.endsWith('go'))!.text;
    add('presses * 10', goContext);
    add('1 + 1');
    await until(
      () => document.querySelectorAll('li.watch').length === 2,
      'The Watches were not added',
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    assert(watchText(1) === '—', 'A Watch ran while Play was running');
    const [, pause] = document.querySelectorAll<HTMLButtonElement>(
      '#play-controls button',
    );
    pause!.click();
    await until(
      () => watchText(0) === '0' && watchText(1) === '2',
      `Watches read ${watchText(0)} and ${watchText(1)}`,
    );
    document.querySelector<HTMLButtonElement>('li.watch .remove')!.click();
    await until(
      () => document.querySelectorAll('li.watch').length === 1,
      'A Watch was not removed',
    );
    pause!.click();
    mode('Edit').click();
  });
  return results;
};
