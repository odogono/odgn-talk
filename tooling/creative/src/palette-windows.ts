// Palette windows during Browse and Present (#1903): one floating window per
// Palette, in the shared window chrome, listed in the Window menu while Play
// runs. Opening and closing go through the Play worker, which owns whether
// each is open, so a Script's `show` and the reader's close box agree.
import { h } from './dom';
import { type MirrorPalette } from './play-mirror';
import { bringWindowForward, floatingWindow } from './windows';

type PaletteWindow = {
  close: HTMLButtonElement;
  item: HTMLButtonElement;
  node: HTMLElement;
  page: HTMLElement;
  title: HTMLElement;
};

/** A Palette's window id; its position is kept under it across sessions. */
export const paletteWindowId = (name: string): string => `palette-${name}`;

export class PaletteWindows {
  #windows = new Map<string, PaletteWindow>();
  #open = new Map<string, boolean>();

  constructor(
    private readonly options: {
      /** Draws a Palette's Elements into its page node. */
      render(palette: MirrorPalette, page: HTMLElement): void;
      /** Asks the worker to open or close a Palette's window. */
      setOpen(name: string, open: boolean): void;
    },
  ) {}

  #create(palette: MirrorPalette): PaletteWindow {
    const { close, node, title } = floatingWindow({
      id: paletteWindowId(palette.name),
      className: 'palette-window',
      closeLabel: `Close ${palette.title}`,
      label: palette.title,
      left: 32 + this.#windows.size * 24,
      top: 96 + this.#windows.size * 24,
    });
    const page = h('div', { class: 'page palette-page' });
    node.append(page);
    node.hidden = true;
    close.addEventListener('click', event => {
      // The worker answers with the window closed; it never hides here first.
      event.stopPropagation();
      this.options.setOpen(palette.name, false);
    });
    const item = h(
      'button',
      {
        type: 'button',
        role: 'menuitemcheckbox',
        'data-palette': palette.name,
      },
      palette.title,
    );
    item.addEventListener('click', () =>
      this.options.setOpen(palette.name, !this.#open.get(palette.name)),
    );
    document.querySelector('#window-menu .menu-commands')?.append(item);
    document.body.append(node);
    // stack.ts makes it draggable and places it where it was last left.
    node.dispatchEvent(new Event('script-window-opened', { bubbles: true }));
    const made = { close, item, node, page, title };
    this.#windows.set(palette.name, made);
    return made;
  }

  /** Brings each window in line with its Palette as the worker last sent it. */
  draw(palettes: ReadonlyMap<string, MirrorPalette>): void {
    for (const palette of palettes.values()) {
      const win = this.#windows.get(palette.name) ?? this.#create(palette);
      win.title.textContent = palette.title;
      win.node.setAttribute('aria-label', palette.title);
      win.item.textContent = palette.title;
      win.item.setAttribute('aria-checked', String(palette.open));
      Object.assign(win.page.style, {
        width: `${palette.width}px`,
        height: `${palette.height}px`,
        background: palette.background,
      });
      if (palette.open && win.node.hidden) {
        win.node.hidden = false;
        bringWindowForward(win.node);
      } else if (!palette.open) {
        win.node.hidden = true;
      }
      this.#open.set(palette.name, palette.open);
      this.options.render(palette, win.page);
    }
  }

  /** Removes every window and menu item, when Play ends. */
  clear(): void {
    for (const win of this.#windows.values()) {
      win.node.remove();
      win.item.remove();
    }
    this.#windows.clear();
    this.#open.clear();
  }
}
