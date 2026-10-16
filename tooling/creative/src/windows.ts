// Every floating window shares one title bar (close box and title), one way
// to show, hide and bring it forward, and the Window menu that lists the
// ones an author opens and closes. Dragging and positions live in stack.ts.
import { byId, h } from './dom';

export const bringWindowForward = (window: HTMLElement): void => {
  document
    .querySelectorAll('.window')
    .forEach(other => other.classList.toggle('front', other === window));
};

/** A floating window's title bar: its close box, then its title. */
export const windowBar = (label: string, closeLabel = 'Close') => {
  const title = h('span', {}, label);
  const close = h('button', {
    type: 'button',
    class: 'close',
    'aria-label': closeLabel,
    title: closeLabel,
  });
  return { bar: h('div', { class: 'bar' }, close, title), close, title };
};

/** A floating window built in code, with the shared title bar. */
export type FloatingWindow = {
  close: HTMLButtonElement;
  node: HTMLElement;
  title: HTMLElement;
};

export const floatingWindow = (o: {
  className?: string;
  closeLabel?: string;
  id: string;
  label: string;
  left: number;
  top: number;
}): FloatingWindow => {
  const { bar, close, title } = windowBar(o.label, o.closeLabel);
  const node = h(
    'section',
    {
      id: o.id,
      class: `window ${o.className ?? ''}`.trim(),
      'aria-label': o.label,
      'data-left': o.left,
      'data-top': o.top,
    },
    bar,
  );
  return { close, node, title };
};

// Windows whose showing needs more than unhiding, such as the Message Box,
// which is built the first time it opens.
const openers = new Map<string, () => void>();
export const setWindowOpener = (id: string, open: () => void): void => {
  openers.set(id, open);
};

// The windows an author closed stay closed across reloads.
const CLOSED_KEY = 'northtalk-creative-closed-windows';
const remembered = new Set(['tools-window', 'info-window']);
const rememberClosed = () => {
  try {
    localStorage.setItem(
      CLOSED_KEY,
      JSON.stringify(
        [...remembered].filter(id => document.getElementById(id)?.hidden),
      ),
    );
  } catch {
    /* Optional. */
  }
};

export const showWindow = (id: string): void => {
  const open = openers.get(id);
  if (open) {
    open();
  } else {
    const win = byId(id);
    win.hidden = false;
    bringWindowForward(win);
  }
  rememberClosed();
};

export const hideWindow = (id: string): void => {
  const win = document.getElementById(id);
  if (win) {
    win.hidden = true;
  }
  rememberClosed();
};

const isShowing = (id: string) => {
  const win = document.getElementById(id);
  return !!win && !win.hidden;
};

/**
 * Wires every window's close box and the Window menu, and closes the
 * windows the author closed last time.
 */
export const mountWindows = (): void => {
  try {
    const closed = JSON.parse(
      localStorage.getItem(CLOSED_KEY) ?? '[]',
    ) as string[];
    for (const id of closed.filter(id => remembered.has(id))) {
      document.getElementById(id)?.setAttribute('hidden', '');
    }
  } catch {
    /* Optional. */
  }
  // Script windows remove themselves; every other close box hides.
  document.addEventListener('click', event => {
    const close = (event.target as HTMLElement).closest(
      '.window > .bar > .close',
    );
    const win = close?.closest<HTMLElement>('.window');
    if (win && !win.classList.contains('script-window')) {
      hideWindow(win.id);
    }
  });
  const menu = document.getElementById('window-menu') as HTMLDetailsElement;
  if (!menu) {
    return;
  }
  const items = [...menu.querySelectorAll<HTMLButtonElement>('[data-window]')];
  const draw = () => {
    for (const item of items) {
      const id = item.dataset.window!;
      item.setAttribute('aria-checked', String(isShowing(id)));
      // The Page's Info window has nothing to show while browsing.
      item.disabled =
        id === 'info-window' && document.body.classList.contains('browsing');
    }
  };
  menu.addEventListener('toggle', draw);
  menu.addEventListener('click', event => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-window]',
    );
    if (!item) {
      return;
    }
    const id = item.dataset.window!;
    if (isShowing(id)) {
      hideWindow(id);
    } else {
      showWindow(id);
    }
    draw();
  });
};
