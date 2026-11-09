// Dedicated page without main.js; Palettes (#1903) in Edit, Browse and
// Present: authored from the strip and Info, shown in floating windows that
// the Window menu lists, with Scripts that outlast Page changes.
import {
  createElement,
  createPage,
  createPalette,
  createProject,
} from '../src/model';
import { paletteWindowId } from '../src/palette-windows';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';
import { mountWindows } from '../src/windows';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 150; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const project = createProject('Palettes');
project.pages[0]!.elements.push(createElement('button', 'shower'));
project.pages[0]!.elements[0]!.script =
  'on click {button: 0}\n show extras\nend click';
project.pages.push(createPage('page2'));
const mixer = createPalette('mixer');
mixer.palette.title = 'The mixer';
const tap = createElement('button', 'tap');
tap.left = 10;
tap.top = 10;
tap.width = 120;
// A Script Variable survives only while the Script stays loaded.
tap.script = [
  'script variable taps = 0',
  'on click {button: 0}',
  ' add 1 to taps',
  ' set the label of me to "Taps " & taps',
  ' tell pages to show page2',
  'end click',
].join('\n');
mixer.elements.push(tap);
const extras = createPalette('extras');
extras.palette.openOnPlay = false;
project.pages.push(mixer, extras);
// Stale positions from another run would move the windows.
try {
  localStorage.removeItem('northtalk-creative-windows');
} catch {
  /* Optional. */
}
export const shell = mountStack(project);
mountWindows();
mountPlay(shell);

const win = (name: string) =>
  document.getElementById(paletteWindowId(name)) as HTMLElement | null;
/** Whether a Palette's window is there and showing. */
const isOpen = (name: string) => !!win(name) && win(name)!.hidden !== true;
const tool = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('#tool-modes button')].find(
    button => button.textContent?.includes(name),
  )!;
const toggle = () =>
  document.querySelector<HTMLButtonElement>('#play-controls [data-play]')!;
const present = () =>
  document.querySelector<HTMLButtonElement>('#present-project')!;
const menuItem = (name: string) =>
  document.querySelector<HTMLButtonElement>(
    `#window-menu [data-palette="${name}"]`,
  );
const label = (name: string) =>
  win(name)?.querySelector('[data-element="tap"]')?.textContent ?? '';
const field = (name: string, value: string | boolean) => {
  const input = document.querySelector<HTMLInputElement>(
    `#info [data-field="${name}"]`,
  )!;
  if (typeof value === 'boolean') {
    input.checked = value;
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

/** A pointer event's init at a point on the screen. */
const at = (x: number, y: number) => ({
  bubbles: true,
  pointerId: 1,
  clientX: x,
  clientY: y,
});

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

  await test('the strip lists Palettes after the Pages, and Info edits them', async () => {
    const labels = [
      ...document.querySelectorAll('#thumbnails [data-page] > span'),
    ].map(span => span.textContent);
    assert(
      JSON.stringify(labels) ===
        JSON.stringify([
          '1. page1',
          '2. page2',
          'Palette: mixer',
          'Palette: extras',
        ]),
      `Strip lists ${labels.join(', ')}`,
    );
    document
      .querySelector<HTMLButtonElement>('#thumbnails [data-page="2"]')!
      .click();
    await until(
      () => !!document.querySelector('#info [data-field="paletteTitle"]'),
      'Palette Info',
    );
    assert(
      document.getElementById('page-number')!.textContent === 'Palette',
      'The caption says a Palette shows',
    );
    field('paletteWidth', '300');
    await until(
      () => document.getElementById('page')!.style.width === '300px',
      'the stage at the Palette’s width',
    );
    field('openOnPlay', false);
    assert(shell.editor.page.palette?.openOnPlay === false, 'Opening is set');
    shell.editor.undo();
    shell.editor.undo();
    assert(
      shell.editor.page.palette?.width === 240 &&
        shell.editor.page.palette.openOnPlay,
      'Undo restores the width and opening',
    );
    const before = shell.editor.project.pages.length;
    document.getElementById('add-palette')!.click();
    assert(
      shell.editor.project.pages.length === before + 1 &&
        shell.editor.page.name === 'palette3',
      'Add Palette adds and shows one',
    );
    shell.editor.undo();
    shell.editor.goToPage(0);
  });

  for (const mode of ['Browse', 'Present'] as const) {
    await test(`${mode} shows open Palettes in windows whose Scripts outlast Page changes`, async () => {
      shell.editor.goToPage(0);
      (mode === 'Present' ? present() : toggle()).click();
      await until(() => isOpen('mixer'), 'mixer');
      assert(!isOpen('extras'), 'A Palette not set to open stays closed');
      assert(
        win('mixer')!.querySelector('.bar span')!.textContent === 'The mixer',
        'The window has the Palette’s title',
      );
      win('mixer')!.querySelector<HTMLElement>('[data-element="tap"]')!.click();
      await until(() => label('mixer') === 'Taps 1', 'the first tap');
      await until(
        () =>
          document.querySelector('#reader [data-element="shower"]') === null,
        'page2',
      );
      win('mixer')!.querySelector<HTMLElement>('[data-element="tap"]')!.click();
      await until(
        () => label('mixer') === 'Taps 2',
        'a tap after the Page changed',
      );
      win('mixer')!.querySelector<HTMLButtonElement>('.bar .close')!.click();
      await until(() => !isOpen('mixer'), 'the close box');
      (mode === 'Present' ? toggle() : tool('Edit')).click();
      await until(() => !win('mixer'), 'the windows to go with Play');
    });
  }

  await test('the Window menu lists Palettes while browsing, and a Script shows one', async () => {
    shell.editor.goToPage(0);
    toggle().click();
    await until(() => !!menuItem('extras'), 'the menu items');
    assert(
      menuItem('mixer')!.textContent === 'The mixer' &&
        menuItem('mixer')!.getAttribute('aria-checked') === 'true',
      'An open Palette is checked',
    );
    menuItem('mixer')!.click();
    await until(() => !isOpen('mixer'), 'the menu closing it');
    menuItem('mixer')!.click();
    await until(() => isOpen('mixer'), 'the menu opening it');
    document
      .querySelector<HTMLElement>('#reader [data-element="shower"]')!
      .click();
    await until(() => isOpen('extras'), 'show extras');
    assert(
      menuItem('extras')!.getAttribute('aria-checked') === 'true',
      'show checks its menu item',
    );
    tool('Edit').click();
    await until(() => !menuItem('mixer'), 'the menu items to go');
  });

  await test('a dragged Palette window keeps its place in the next session', async () => {
    toggle().click();
    await until(() => isOpen('mixer'), 'mixer');
    const bar = win('mixer')!.querySelector<HTMLElement>('.bar')!;
    const start = bar.getBoundingClientRect();
    bar.dispatchEvent(
      new PointerEvent('pointerdown', at(start.left + 40, start.top + 5)),
    );
    bar.dispatchEvent(
      new PointerEvent('pointermove', at(start.left + 140, start.top + 85)),
    );
    bar.dispatchEvent(
      new PointerEvent('pointerup', at(start.left + 140, start.top + 85)),
    );
    const moved = win('mixer')!.offsetLeft;
    tool('Edit').click();
    await until(() => !win('mixer'), 'Play to end');
    toggle().click();
    await until(() => !!win('mixer'), 'mixer again');
    assert(
      win('mixer')!.offsetLeft === moved,
      `The window returns to ${moved}, not ${win('mixer')!.offsetLeft}`,
    );
    tool('Edit').click();
  });
  return results;
};
