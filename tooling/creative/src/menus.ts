// The header's Folio, File and Edit menus, and the About window.
import { byId } from './dom';

/**
 * Keeps one header menu open at a time. A menu closes when one of its
 * commands is chosen, on a click outside it, or on Escape.
 */
export const mountMenus = (core: string): void => {
  const menus = [
    ...document.querySelectorAll<HTMLDetailsElement>('#menu details.menu'),
  ];
  for (const menu of menus) {
    menu.addEventListener('toggle', () => {
      if (menu.open) {
        menus.filter(m => m !== menu).forEach(m => (m.open = false));
      }
    });
    menu.querySelector('.menu-commands')!.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('button')) {
        menu.open = false;
      }
    });
  }
  document.addEventListener('pointerdown', event => {
    for (const menu of menus) {
      if (!menu.contains(event.target as Node)) {
        menu.open = false;
      }
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      menus.forEach(m => (m.open = false));
    }
  });

  byId('about-core').textContent = core;
  byId('show-about').addEventListener('click', () => {
    byId('about-window').hidden = false;
  });
  byId('close-about').addEventListener('click', () => {
    byId('about-window').hidden = true;
  });
};
