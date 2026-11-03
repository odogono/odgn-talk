// Dedicated page: Palettes in Perform (#2001). A Palette docks in the
// column under the code unless it is set to float over the stage, and the
// Window menu still opens and closes them.
import { createElement, createPalette, createProject } from '../src/model';
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

const project = createProject('Perform Palettes');
project.play = 'perform';
project.pages[0]!.elements.push(createElement('button', 'go'));
const mixer = createPalette('mixer');
const tap = { ...createElement('button', 'tap'), left: 10, top: 10 };
tap.script =
  'on click {button: 0}\n  set the label of me to "tapped"\nend click';
mixer.elements.push(tap);
const pads = createPalette('pads');
pads.palette.float = true;
project.pages.push(mixer, pads);
const shell = mountStack(project);
mountWindows();
mountPlay(shell);

const perform = () =>
  document.querySelector<HTMLButtonElement>('#play-controls [data-play]')!;
const win = (name: string) => document.getElementById(paletteWindowId(name));
// A floating window is fixed, so it has no offsetParent; a box shows it.
const showing = (node: Element | null) =>
  !!node && node.getClientRects().length > 0;
const menuItem = (name: string) =>
  document.querySelector<HTMLButtonElement>(
    `#window-menu [data-palette="${name}"]`,
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

  await test('a Palette docks under the code, and one set to float floats', async () => {
    perform().click();
    await until(() => showing(win('mixer')) && showing(win('pads')), 'both');
    assert(
      win('mixer')!.closest('#perform .perform-palettes'),
      'mixer is docked in the column',
    );
    assert(!win('pads')!.closest('#perform'), 'pads floats over the stage');
    const tapNode = win('mixer')!.querySelector<HTMLElement>(
      '[data-element="tap"]',
    )!;
    tapNode.click();
    await until(
      () => tapNode.textContent === 'tapped',
      'a docked Palette’s Script',
    );
  });

  await test('the Window menu still opens and closes Palettes', async () => {
    assert(showing(document.getElementById('window-menu')), 'the menu shows');
    menuItem('mixer').click();
    await until(() => !showing(win('mixer')), 'the menu closing mixer');
    assert(
      !showing(document.querySelector('.perform-palettes')),
      'the empty column goes',
    );
    menuItem('mixer').click();
    await until(() => showing(win('mixer')), 'the menu opening mixer');
    assert(win('mixer')!.closest('.perform-palettes'), 'docked again');
  });

  await test('Browse floats every Palette, as before', async () => {
    perform().click();
    await until(() => !win('mixer'), 'Perform to end');
    [...document.querySelectorAll<HTMLButtonElement>('#tool-modes button')]
      .find(b => b.textContent?.includes('Browse'))!
      .click();
    await until(() => showing(win('mixer')), 'mixer in Browse');
    assert(!win('mixer')!.classList.contains('docked'), 'mixer floats');
    [...document.querySelectorAll<HTMLButtonElement>('#tool-modes button')]
      .find(b => b.textContent?.includes('Edit'))!
      .click();
  });
  return results;
};
