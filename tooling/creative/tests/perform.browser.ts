// Dedicated page: Perform (#1999) plays the Project with the stage on the
// left and the code pane on the right, the divider and code zoom remembered
// for the Project, while Present stays full-window with the code hidden.
import { createElement, createProject } from '../src/model';
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

try {
  localStorage.removeItem('northtalk-creative-perform');
} catch {
  /* Optional. */
}
const project = createProject('Perform check');
const button = { ...createElement('button', 'go'), left: 20, top: 20 };
button.script =
  'on click {button: 0}\n set the label of me to "went"\nend click';
project.pages[0]!.elements.push(button);
const shell = mountStack(project);
mountWindows();
mountPlay(shell);

const perform = () =>
  document.querySelector<HTMLButtonElement>('#play-controls [data-perform]')!;
const present = () =>
  document.querySelector<HTMLButtonElement>('#play-controls [aria-pressed]')!;
const layout = () => document.getElementById('perform');
const showing = (node: Element | null) =>
  !!node && (node as HTMLElement).offsetParent !== null;
const key = (init: KeyboardEventInit) =>
  document.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, metaKey: true, ...init }),
  );

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

  await test('Perform puts the stage left and the code right, and plays', async () => {
    perform().click();
    await until(
      () => !!layout()?.querySelector('#reader [data-element="go"]'),
      'the stage in Perform',
    );
    assert(perform().getAttribute('aria-pressed') === 'true', 'Perform is on');
    assert(!showing(document.getElementById('desk')), 'the editor is hidden');
    const code = layout()!.querySelector('.perform-code #code-browser');
    assert(showing(code), 'the Code Browser is docked in the code pane');
    const stage = layout()!.querySelector('.perform-stage')!;
    assert(
      stage.getBoundingClientRect().right <= code!.getBoundingClientRect().left,
      'the stage is left of the code',
    );
    const go = layout()!.querySelector<HTMLElement>('[data-element="go"]')!;
    go.click();
    await until(() => go.textContent === 'went', 'the button’s Script');
  });

  await test('the divider and code zoom are remembered for the Project', async () => {
    const divider = layout()!.querySelector<HTMLElement>('.perform-divider')!;
    const box = layout()!.getBoundingClientRect();
    const at = (x: number) => ({
      bubbles: true,
      pointerId: 1,
      clientX: box.left + box.width * x,
      clientY: box.top + 50,
    });
    divider.dispatchEvent(new PointerEvent('pointerdown', at(0.6)));
    divider.dispatchEvent(new PointerEvent('pointermove', at(0.45)));
    divider.dispatchEvent(new PointerEvent('pointerup', at(0.4)));
    assert(
      divider.getAttribute('aria-valuenow') === '40',
      `the divider is at ${divider.getAttribute('aria-valuenow')}`,
    );
    key({ key: '=' });
    key({ key: '=' });
    const code = layout()!.querySelector<HTMLElement>('.perform-code')!;
    assert(
      code.style.fontSize === '120%',
      `the zoom is ${code.style.fontSize}`,
    );
    key({ key: 'Enter', shiftKey: true });
    await until(() => !layout(), 'Perform to end');
    assert(
      showing(document.getElementById('desk')),
      'the editor is back after Perform',
    );
    key({ key: 'Enter', shiftKey: true });
    await until(() => !!layout(), 'Perform again');
    assert(
      layout()!
        .querySelector('.perform-divider')!
        .getAttribute('aria-valuenow') === '40' &&
        layout()!.querySelector<HTMLElement>('.perform-code')!.style
          .fontSize === '120%',
      'the divider and zoom come back',
    );
    perform().click();
    await until(() => !layout(), 'Perform to stop');
  });

  await test('Present is unchanged: full-window with the code hidden', async () => {
    present().click();
    await until(
      () => !!document.querySelector('#reader [data-element="go"]'),
      'Present',
    );
    assert(!layout(), 'no Perform layout');
    assert(
      !showing(document.getElementById('code-browser')),
      'no code while presenting',
    );
    present().click();
  });
  return results;
};
