// Dedicated page without main.js; see README.md. Uses the real Stack shell.
import { createElement, createPage, createProject } from '../src/model';
import { MIN_PAGE_HEIGHT, MIN_PAGE_WIDTH, PAGE_HANDLES } from '../src/editing';
import { mountStack } from '../src/stack';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const handle = (name: string) =>
  document.querySelector<HTMLElement>(`[data-page-handle="${name}"]`)!;
const centered = () => {
  const desk = document.querySelector<HTMLElement>('#desk')!;
  const stage = document.querySelector<HTMLElement>('#stage')!;
  const style = getComputedStyle(desk);
  const bounds = desk.getBoundingClientRect();
  const left = bounds.left + Number.parseFloat(style.paddingLeft);
  const right =
    bounds.left + desk.clientWidth - Number.parseFloat(style.paddingRight);
  const rect = stage.getBoundingClientRect();
  assert(
    Math.abs((rect.left + rect.right) / 2 - (left + right) / 2) <= 2,
    'Page stays centred in the desk',
  );
};
const project = createProject('Page resizing');
project.designWidth = 400;
project.pages[0]!.height = 240;
project.pages[0]!.elements.push(createElement('rectangle', 'box'));
project.pages.push(createPage('other'));
export const shell = mountStack(project);

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
  test('five Page handles, no top edge, and keyboard resize stays centred', () => {
    assert(
      document.querySelectorAll('[data-page-handle]').length ===
        PAGE_HANDLES.length,
      'Five handles',
    );
    assert(
      !document.querySelector('[data-page-handle*="n"]'),
      'No top handles',
    );
    const top = document.querySelector('#stage')!.getBoundingClientRect().top;
    handle('se').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        shiftKey: true,
        bubbles: true,
      }),
    );
    handle('se').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    assert(
      project.designWidth === 410 && shell.editor.page.height === 241,
      'Keyboard resizes both dimensions',
    );
    assert(
      document.querySelector('#stage')!.getBoundingClientRect().top === top,
      'Top stays fixed',
    );
    centered();
    shell.editor.undo();
    shell.editor.undo();
    shell.redraw();
    assert(
      project.designWidth === 400 && shell.editor.page.height === 240,
      'Undo restores size',
    );
  });
  test('Info enforces the same minimum sizes', () => {
    for (const field of ['designWidth', 'pageHeight']) {
      const input = document.querySelector<HTMLInputElement>(
        `[data-field="${field}"]`,
      )!;
      input.value = '1';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    assert(
      project.designWidth === MIN_PAGE_WIDTH &&
        shell.editor.page.height === MIN_PAGE_HEIGHT,
      'Minimum width and height',
    );
    centered();
    shell.editor.undo();
    shell.editor.undo();
    shell.redraw();
  });
  test('handles follow selection and disappear in read-only and Play', () => {
    shell.editor.click('box');
    shell.redraw();
    assert(!handle('s'), 'Element selection hides Page handles');
    shell.editor.selectPage();
    shell.redraw();
    assert(handle('s'), 'Page selection restores handles');
    shell.setReadOnly(true);
    assert(!handle('s'), 'Read-only hides handles');
    shell.setReadOnly(false);
    shell.setPlaying(true);
    assert(!handle('s'), 'Play hides handles');
    shell.setPlaying(false);
    assert(handle('s'), 'Edit restores handles');
  });
  for (const [name, dx, dy] of [
    ['se', 30, 40],
    ['w', 25, 99],
    ['s', 500, -1000],
  ] as const) {
    test(`pointer ${name} drag respects scale, fixed top, minimums and one-step undo`, () => {
      const stage = document.querySelector<HTMLElement>('#stage')!;
      const bounds = stage.getBoundingClientRect();
      const before = structuredClone(project);
      const rect = handle(name).getBoundingClientRect();
      const scale =
        document.querySelector('#page')!.getBoundingClientRect().width /
        project.designWidth;
      const event = (type: string, x: number, y: number) =>
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: rect.x + rect.width / 2 + x,
          clientY: rect.y + rect.height / 2 + y,
        });
      handle(name).dispatchEvent(event('pointerdown', 0, 0));
      stage.dispatchEvent(event('pointermove', dx / 2, dy / 2));
      stage.dispatchEvent(event('pointermove', dx, dy));
      stage.dispatchEvent(event('pointerup', dx, dy));
      const width =
        name === 's'
          ? 400
          : Math.max(
              MIN_PAGE_WIDTH,
              Math.round(400 + ((name === 'w' ? -2 : 2) * dx) / scale),
            );
      const height =
        name === 'w'
          ? 240
          : Math.max(MIN_PAGE_HEIGHT, Math.round(240 + dy / scale));
      assert(
        project.designWidth === width && shell.editor.page.height === height,
        `Pointer resize gives ${width} × ${height}`,
      );
      assert(
        stage.getBoundingClientRect().top === bounds.top,
        'Top stays fixed',
      );
      assert(
        JSON.stringify(project.pages[0]!.elements) ===
          JSON.stringify(before.pages[0]!.elements),
        'Elements stay in place',
      );
      assert(
        project.pages[1]!.height === before.pages[1]!.height,
        'Other Page height stays unchanged',
      );
      centered();
      shell.editor.undo();
      shell.redraw();
      assert(
        JSON.stringify(project) === JSON.stringify(before),
        'Entire drag undoes in one step',
      );
      shell.editor.redo();
      shell.redraw();
      assert(
        project.designWidth === width && shell.editor.page.height === height,
        'Redo restores size',
      );
      shell.editor.undo();
      shell.redraw();
    });
  }
  return results;
};
