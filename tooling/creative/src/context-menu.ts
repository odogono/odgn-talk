// A right-click menu of commands, closed by choosing one, Escape, or a
// click elsewhere. Only one is open at a time.
import { h } from './dom';

export type MenuItem = { disabled?: boolean; label: string; run(): void };

let open: (() => void) | undefined;

export const showContextMenu = (
  x: number,
  y: number,
  items: readonly MenuItem[],
): void => {
  open?.();
  const menu = h('div', { class: 'context-menu', role: 'menu' });
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    open = undefined;
  };
  const outside = (event: Event) => {
    if (!menu.contains(event.target as Node)) {
      close();
    }
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close();
    }
  };
  for (const item of items) {
    const button = h(
      'button',
      { type: 'button', role: 'menuitem', disabled: item.disabled },
      item.label,
    );
    button.addEventListener('click', () => {
      close();
      item.run();
    });
    menu.append(button);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  open = close;
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
};
