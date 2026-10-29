// Dedicated page without main.js; tests authoring and the real worker renderer.
import { BUTTON_STYLES, createElement, createProject } from '../src/model';
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
  throw new Error('Timed out waiting for button update');
};

const project = createProject('Button styles');
const picture = createElement('rectangle', 'picture');
Object.assign(picture, { left: 40, top: 310, width: 200, height: 44 });
picture.script = `on click {button: 2}
  set the text of status to "secondary"
end click
on click {button: 0, x, y}
  set the text of status to "primary " & x & "," & y
end click
on pointerHeld {held} where held > 0
  set the text of status to "held"
end pointerHeld`;
project.pages[0]!.elements.push(picture);
for (const [index, style] of BUTTON_STYLES.entries()) {
  const button = createElement('button', style);
  Object.assign(button, { style, top: 40 + index * 90, label: style });
  if (style === 'transparent') {
    button.script = `script variable clicks = 0
on click {button: 0}
  add 1 to clicks
  set the text of status to "click " & clicks
end click
on pointerEnter
  set the text of status to "entered"
end pointerEnter
on pointerLeave
  set the text of status to "left"
end pointerLeave`;
  } else if (style === 'rounded') {
    button.script = `on click {button: 0}
  if the style of me is "rounded" then
    set the style of me to "transparent"
  else
    set the style of me to "shadowed"
  end if
  set the font of me to "monospace"
  set the textSize of me to 26
  set the label of me to "Changed"
end click`;
  }
  project.pages[0]!.elements.push(button);
}
const status = createElement('text', 'status');
Object.assign(status, { left: 300, top: 40 });
project.pages[0]!.elements.push(status);
export const shell = mountStack(project);
mountPlay(shell);

const element = (name: string, reader = false) =>
  document.querySelector<HTMLElement>(
    `${reader ? '#reader' : '#page'} [data-element="${name}"]`,
  )!;
const change = (name: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(
    `#info [data-field="${name}"]`,
  )!;
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
};
const assertInvisible = (node: HTMLElement) => {
  const css = getComputedStyle(node);
  assert(css.backgroundColor === 'rgba(0, 0, 0, 0)', 'No fill is painted');
  assert(css.borderTopWidth === '0px', 'No border is painted');
  assert(css.boxShadow === 'none', 'No shadow is painted');
  assert(
    getComputedStyle(node.querySelector('.button-label')!).visibility ===
      'hidden',
    'The label is not painted',
  );
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
  await test('Info changes button font, size and style with undo/redo', async () => {
    shell.editor.click('rounded');
    shell.redraw();
    await until(() => !!document.querySelector('#info [data-field="style"]'));
    assert(
      getComputedStyle(element('rounded')).borderRadius === '8px',
      'Rounded default',
    );
    const look = () =>
      element('rounded').style.cssText + element('rounded').className;
    for (const [property, value] of [
      ['font', 'serif'],
      ['textSize', '26'],
      ...BUTTON_STYLES.filter(style => style !== 'rounded').map(style => [
        'style',
        style,
      ]),
    ]) {
      const before = look();
      change(property!, value!);
      const node = element('rounded');
      const css = getComputedStyle(node);
      assert(
        property === 'font'
          ? css.fontFamily === value
          : property === 'textSize'
            ? css.fontSize === `${value}px`
            : node.classList.contains(`button-${value}`),
        `Info renders ${property}`,
      );
      if (property === 'font') {
        assert(
          [
            ...document.querySelector<HTMLSelectElement>(
              '#info [data-field="font"]',
            )!.options,
          ].some(option => option.value === 'system-ui, sans-serif'),
          'The system font stays available after changing fonts',
        );
      }
      const changed = look();
      shell.editor.undo();
      shell.redraw();
      assert(look() === before, `Undo restores ${property}`);
      shell.editor.redo();
      shell.redraw();
      assert(look() === changed, `Redo restores ${property}`);
      shell.editor.undo();
      shell.redraw();
    }
    change('textSize', '-1');
    assert(
      getComputedStyle(element('rounded')).fontSize === '1px',
      'Info clamps size above zero',
    );
    shell.editor.undo();
    shell.editor.click(undefined);
    shell.redraw();
    assertInvisible(element('transparent'));
    assert(
      getComputedStyle(element('transparent')).outlineStyle === 'dashed',
      'Edit reveals the hit area',
    );
  });
  for (const mode of ['Browse', 'Present']) {
    await test(`${mode} renders styles, invisible hit targets and keyboard activation`, async () => {
      const toggle = document.querySelector<HTMLButtonElement>(
        '#menu [aria-pressed]',
      )!;
      const tool = (name: string) =>
        [
          ...document.querySelectorAll<HTMLButtonElement>('#tool-modes button'),
        ].find(button => button.textContent?.includes(name))!;
      (mode === 'Present' ? toggle : tool('Browse')).click();
      try {
        await until(() => !!element('transparent', true));
        assert(
          getComputedStyle(element('rectangle', true)).borderTopWidth === '1px',
          'Rectangle border',
        );
        assert(
          getComputedStyle(element('rectangle', true)).borderRadius === '0px',
          'Rectangle corners',
        );
        assert(
          getComputedStyle(element('shadowed', true)).boxShadow !== 'none',
          'Shadowed border',
        );
        const invisible = element('transparent', true);
        assertInvisible(invisible);
        assert(
          getComputedStyle(invisible).outlineStyle === 'none',
          'Reader hides the Edit outline',
        );
        assert(
          invisible.getAttribute('aria-label') === 'transparent',
          'Invisible button has an accessible name',
        );
        assert(
          invisible.tabIndex === 0 &&
            invisible.getAttribute('role') === 'button',
          'Keyboard target',
        );
        const box = invisible.getBoundingClientRect();
        assert(
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ) === invisible,
          'Transparent button covers the picture',
        );
        const output = () => element('status', true).textContent;
        invisible.dispatchEvent(
          new PointerEvent('pointerenter', { pointerType: 'mouse' }),
        );
        await until(() => output() === 'entered');
        invisible.dispatchEvent(
          new PointerEvent('pointerleave', { pointerType: 'mouse' }),
        );
        await until(() => output() === 'left');
        invisible.click();
        await until(() => output() === 'click 1');
        invisible.focus();
        assert(
          document.activeElement === invisible,
          'Invisible button receives focus',
        );
        assert(
          getComputedStyle(invisible).outlineStyle === 'solid',
          'Keyboard focus reveals a ring',
        );
        for (const [index, key] of ['Enter', ' '].entries()) {
          invisible.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true }),
          );
          invisible.dispatchEvent(
            new KeyboardEvent('keyup', { key, bubbles: true }),
          );
          await until(() => output() === `click ${index + 2}`);
        }
        const pictured = element('picture', true);
        const at = pictured.getBoundingClientRect();
        const scale = at.width / pictured.offsetWidth;
        pictured.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            detail: 1,
            clientX: at.x + 10 * scale,
            clientY: at.y + 20 * scale,
          }),
        );
        await until(() => output() === 'primary 10,20');
        const menu = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
        });
        pictured.dispatchEvent(menu);
        assert(menu.defaultPrevented, 'Play keeps the context menu away');
        pictured.dispatchEvent(
          new MouseEvent('auxclick', { bubbles: true, button: 2, detail: 1 }),
        );
        await until(() => output() === 'secondary');
        pictured.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            isPrimary: true,
            clientX: at.x + 1,
            clientY: at.y + 1,
          }),
        );
        await until(() => output() === 'held');
        pictured.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true }),
        );
        // A press on a label and its release must land on the same node, so
        // a write elsewhere on the Page keeps unchanged labels in place.
        const label = element('rounded', true).querySelector('.button-label');
        invisible.click();
        await until(() => output() === 'click 4');
        assert(
          element('rounded', true).querySelector('.button-label') === label,
          'An unchanged button keeps its label node',
        );
        const changing = element('rounded', true);
        changing.click();
        await until(() => changing.classList.contains('button-transparent'));
        assertInvisible(changing);
        assert(
          changing.getAttribute('aria-label') === 'Changed',
          'Script label updates accessible name',
        );
        assert(
          getComputedStyle(changing).fontFamily === 'monospace',
          'Script font renders',
        );
        assert(
          getComputedStyle(changing).fontSize === '26px',
          'Script size renders',
        );
        changing.click();
        await until(() => changing.classList.contains('button-shadowed'));
        assert(
          getComputedStyle(changing.querySelector('.button-label')!)
            .visibility === 'visible',
          'Leaving transparent restores label',
        );
        assert(
          getComputedStyle(changing).backgroundColor !== 'rgba(0, 0, 0, 0)',
          'Leaving transparent restores fill',
        );
      } finally {
        (mode === 'Present' ? toggle : tool('Edit')).click();
      }
      assert(
        getComputedStyle(element('rounded')).fontSize === '18px',
        'Stop restores authored typography',
      );
      assert(
        element('rounded').classList.contains('button-rounded'),
        'Stop restores authored style',
      );
    });
  }
  return results;
};
