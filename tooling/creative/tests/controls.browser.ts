// Dedicated page: the controls Add-on during Browse (#1902). The page and
// the Play worker load the built chunk, as for a real Project.
import { CONTROLS_ADD_ON } from '../src/add-ons/controls';
import { pageAddOns } from '../src/add-ons/page';
import { createAnyElement } from '../src/elements/registry';
import { createElement, createProject, type AddOnKind } from '../src/model';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';

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
  throw new Error(`Timed out: ${what}`);
};
const kind = (name: string) => `${CONTROLS_ADD_ON}#${name}` as AddOnKind;

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

  const problems = await pageAddOns.load([
    { id: CONTROLS_ADD_ON, version: '1.0.0' },
  ]);
  assert(!problems.length, JSON.stringify(problems));
  const project = createProject('Controls browser check');
  project.addOns = [{ id: CONTROLS_ADD_ON, version: '1.0.0' }];
  const volume = {
    ...createAnyElement(kind('slider'), 'volume'),
    left: 20,
    top: 20,
    width: 200,
  };
  volume.script =
    'on change value\n  set the left of shown to value * 100\n  set the width of runs to the width of runs + 1\nend change\n';
  const mute = {
    ...createAnyElement(kind('toggle'), 'mute'),
    left: 20,
    top: 80,
  };
  mute.script =
    'on change muted\n  set the visible of shown to not muted\nend change\n';
  const pad = {
    ...createAnyElement(kind('xy'), 'pad'),
    left: 260,
    top: 20,
    width: 100,
    height: 100,
  };
  // The Page hears the pad's change, which the pad doesn't handle.
  project.pages[0]!.script =
    'on change x, y\n  set the top of shown to 200 + y * 100\nend change\n';
  const shown = { ...createElement('button', 'shown'), top: 300 };
  // Counts the slider's change Runs in its width.
  const runs = { ...createElement('rectangle', 'runs'), top: 400, width: 0 };
  project.pages[0]!.elements.push(volume, mute, pad, shown, runs);
  const shell = mountStack(project);
  mountPlay(shell);

  const reader = (name: string) =>
    document.querySelector<HTMLElement>(
      `#reader [data-element="${name}"] [role]`,
    )!;
  const shownBox = () =>
    document.querySelector<HTMLElement>('#reader [data-element="shown"]')!;

  await test('in Edit a control draws but takes no input', () => {
    const slider = document.querySelector<HTMLElement>(
      '#page [data-element="volume"] [role="slider"]',
    );
    assert(slider, 'the slider draws in Edit');
    assert(slider!.tabIndex === -1, 'it is not in the tab order');
  });

  document.querySelector<HTMLButtonElement>('#menu [aria-pressed]')!.click();
  await until(() => !!reader('volume'), 'Browse shows the slider');

  await test('dragging a slider moves it at once and delivers its last value', async () => {
    const slider = reader('volume');
    const box = slider.getBoundingClientRect();
    const at = (fraction: number) => ({
      bubbles: true,
      pointerId: 1,
      clientX: box.left + box.width * fraction,
      clientY: box.top + box.height / 2,
    });
    slider.dispatchEvent(new PointerEvent('pointerdown', at(0.1)));
    for (let step = 1; step <= 20; step++) {
      slider.dispatchEvent(
        new PointerEvent('pointermove', at(0.1 + step * 0.02)),
      );
    }
    slider.dispatchEvent(new PointerEvent('pointerup', at(0.5)));
    // Preact draws on its next tick, before the worker answers.
    await until(
      () => Math.abs(Number(slider.getAttribute('aria-valuenow')) - 0.5) < 0.01,
      'the slider shows 0.5 at once',
    );
    await until(
      () => Math.abs(Number.parseFloat(shownBox().style.left) - 50) < 1,
      'the Script saw the last value',
    );
    const runCount = Number.parseFloat(
      document.querySelector<HTMLElement>('#reader [data-element="runs"]')!
        .style.width,
    );
    assert(
      runCount >= 1 && runCount < 21,
      `21 changes ran the Script ${runCount} times, not once each`,
    );
  });

  await test('keys move a focused slider and reach its Script', async () => {
    const slider = reader('volume');
    slider.focus();
    slider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );
    await until(
      () => slider.getAttribute('aria-valuenow') === '1',
      'End is the maximum',
    );
    await until(
      () => shownBox().style.left === '100px',
      'End reached the Script',
    );
    slider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    await until(
      () => shownBox().style.left === '0px',
      'Home reached the Script',
    );
  });

  await test('a toggle switches with Space and tells its Script', async () => {
    const toggle = reader('mute');
    assert(toggle.getAttribute('role') === 'switch', 'it is a switch');
    toggle.focus();
    toggle.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
    );
    await until(
      () => toggle.getAttribute('aria-checked') === 'true',
      'it is on',
    );
    await until(() => shownBox().hidden === true, 'the Script hid the button');
    toggle.click();
    await until(() => shownBox().hidden === false, 'a click switched it back');
  });

  await test('an XY pad sends x and y up its Message Path', async () => {
    const xy = reader('pad');
    const box = xy.getBoundingClientRect();
    xy.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 2,
        clientX: box.left + box.width * 0.25,
        clientY: box.top + box.height * 0.25,
      }),
    );
    xy.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }),
    );
    await until(
      () => Math.abs(Number.parseFloat(shownBox().style.top) - 275) < 2,
      `the Page heard y (top ${shownBox().style.top})`,
    );
  });

  return results;
};
