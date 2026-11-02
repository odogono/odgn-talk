// Perform (#1999, from #1905): one window shared by the performer and the
// audience, with the stage on the left, scaled to fit, and the code pane and
// docked Palettes on the right. The divider and the code's zoom are
// remembered for each Project, so a set opens as it was last played.
import { type CodeSelection } from './code-browser-panel';
import { h } from './dom';
import { showWindow } from './windows';

/** A Script the code pane showed, as one of its tabs (#2000). */
export type PerformTab = { label: string; source: CodeSelection };

/** The Transport as the worker last sent it, with when it arrived (ms). */
export type ClockAnchor = {
  at: number;
  beatsPerBar: number;
  count?: number;
  tempo: number;
};

/**
 * The toolbar's tempo and position at page time `now` (ms), such as
 * “120 BPM · bar 3.2”, counting on from the anchor by the tempo.
 */
export const clockText = (
  anchor: ClockAnchor | undefined,
  now: number,
): string => {
  if (!anchor) {
    return '';
  }
  const tempo = `${anchor.tempo} BPM`;
  if (anchor.count === undefined) {
    return tempo;
  }
  const count = Math.floor(
    anchor.count + (Math.max(0, now - anchor.at) * anchor.tempo) / 60_000,
  );
  const bar = Math.floor(count / anchor.beatsPerBar) + 1;
  const beat = (count % anchor.beatsPerBar) + 1;
  return `${tempo} · bar ${bar}.${beat}`;
};

/** How many recent Scripts the code pane keeps as tabs. */
export const MAX_TABS = 5;

const tabKey = (source: CodeSelection) => `${source.kind}:${source.id}`;

/**
 * The tabs after `shown` is shown: an open tab stays in its place, and a new
 * one goes last, the least recently shown dropped past the limit.
 */
export const recentTabs = (
  tabs: readonly PerformTab[],
  shown: PerformTab,
  max = MAX_TABS,
): { current: number; tabs: PerformTab[] } => {
  const at = tabs.findIndex(t => tabKey(t.source) === tabKey(shown.source));
  if (at >= 0) {
    const next = [...tabs];
    next[at] = shown;
    return { tabs: next, current: at };
  }
  const next = [...tabs, shown].slice(-max);
  return { tabs: next, current: next.length - 1 };
};

/** Where the divider sits and how large the code is, for one Project. */
export type PerformSettings = {
  /** The stage's share of the window's width, from 0.2 to 0.8. */
  split: number;
  /** The code pane's zoom, from 0.5 to 3. */
  zoom: number;
};

export const DEFAULT_PERFORM: PerformSettings = { split: 0.6, zoom: 1 };
export const MIN_SPLIT = 0.2;
export const MAX_SPLIT = 0.8;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
/** How much one ⌘+ or ⌘− changes the zoom. */
export const ZOOM_STEP = 0.1;

const KEY = 'northtalk-creative-perform';

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Settings brought into range, any missing or broken field the default. */
export const normalPerform = (value: unknown): PerformSettings => {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<
    string,
    unknown
  >;
  const number = (field: keyof PerformSettings, min: number, max: number) => {
    const n = raw[field];
    return typeof n === 'number' && Number.isFinite(n)
      ? clamp(n, min, max)
      : DEFAULT_PERFORM[field];
  };
  return {
    split: number('split', MIN_SPLIT, MAX_SPLIT),
    zoom: Math.round(number('zoom', MIN_ZOOM, MAX_ZOOM) * 10) / 10,
  };
};

/** Every Project's settings, by Project name. */
type Stored = Record<string, unknown>;

const readAll = (storage: Storage | undefined): Stored => {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Stored) : {};
  } catch {
    return {};
  }
};

const browserStorage = (): Storage | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

/** A Project's Perform settings as last left. */
export const loadPerform = (
  project: string,
  storage = browserStorage(),
): PerformSettings => normalPerform(readAll(storage)[project]);

/** Remembers a Project's Perform settings; storage is optional. */
export const savePerform = (
  project: string,
  settings: PerformSettings,
  storage = browserStorage(),
): void => {
  try {
    storage?.setItem(
      KEY,
      JSON.stringify({
        ...readAll(storage),
        [project]: normalPerform(settings),
      }),
    );
  } catch {
    /* Optional. */
  }
};

/** The zoom one ⌘+ (1) or ⌘− (-1) gives. */
export const zoomed = (zoom: number, direction: 1 | -1): number =>
  normalPerform({
    split: DEFAULT_PERFORM.split,
    zoom: zoom + direction * ZOOM_STEP,
  }).zoom;

/**
 * The Perform layout while a session performs: it takes the reader into its
 * stage column and docks the Code Browser in its code pane, giving both back
 * when Perform ends.
 */
export class PerformLayout {
  readonly node: HTMLElement;
  readonly code: HTMLElement;
  /** Where #2001 docks Palettes. */
  readonly palettes: HTMLElement;
  readonly divider: HTMLElement;
  /** Hush, Revert, and the tempo and bar (#2002). */
  readonly toolbar: HTMLElement;
  readonly hushButton: HTMLButtonElement;
  readonly revertButton: HTMLButtonElement;
  readonly clock: HTMLElement;
  /** The recent Scripts, one tab each. */
  readonly tabBar: HTMLElement;
  /** The last error, shown over the code instead of in the Errors window. */
  readonly banner: HTMLElement;
  #tabs: PerformTab[] = [];
  #anchor: ClockAnchor | undefined;
  #ticking: ReturnType<typeof setInterval> | undefined;
  #current = -1;
  #open: (source: CodeSelection) => void = () => {};
  #stage: HTMLElement;
  #project = '';
  #settings = DEFAULT_PERFORM;
  #reader: { node: HTMLElement; parent: ParentNode | null } | undefined;
  #browser: HTMLElement | undefined;
  #onResize: () => void = () => {};

  constructor() {
    this.#stage = h('div', { class: 'perform-stage' });
    this.divider = h('div', {
      class: 'perform-divider',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize the stage and the code',
      tabindex: '0',
    });
    this.hushButton = h(
      'button',
      {
        type: 'button',
        'data-hush': '',
        title: 'Hush: silence every sound and pattern, and keep playing (⌘⇧.)',
      },
      'Hush',
    );
    this.revertButton = h(
      'button',
      {
        type: 'button',
        'data-revert': '',
        title: 'Revert: put back the Script as Play last loaded it',
      },
      'Revert',
    );
    this.clock = h('span', {
      class: 'perform-clock',
      'aria-live': 'off',
      'aria-label': 'Tempo and bar',
    });
    this.toolbar = h(
      'div',
      { class: 'perform-toolbar', role: 'toolbar', 'aria-label': 'Perform' },
      this.hushButton,
      this.revertButton,
      this.clock,
    );
    this.tabBar = h('div', {
      class: 'perform-tabs',
      role: 'tablist',
      'aria-label': 'Recent Scripts',
    });
    this.banner = h('div', {
      class: 'perform-error',
      role: 'alert',
      hidden: true,
    });
    this.code = h('div', { class: 'perform-code', 'aria-label': 'Code' });
    this.palettes = h('div', {
      class: 'perform-palettes',
      'aria-label': 'Palettes',
    });
    this.node = h(
      'div',
      { id: 'perform', hidden: true },
      this.#stage,
      this.divider,
      h(
        'div',
        { class: 'perform-side' },
        this.toolbar,
        this.tabBar,
        this.banner,
        this.code,
        this.palettes,
      ),
    );
    this.#dragDivider();
  }

  get settings(): PerformSettings {
    return this.#settings;
  }

  /**
   * Lays out `reader` for the Project named `project`; `open` shows a tab's
   * Script in the Code Browser.
   */
  mount(
    reader: HTMLElement,
    project: string,
    onResize: () => void,
    open: (source: CodeSelection) => void = () => {},
  ): void {
    this.#project = project;
    this.#open = open;
    this.#tabs = [];
    this.#current = -1;
    this.#drawTabs();
    this.problem(undefined);
    this.#onResize = onResize;
    this.#settings = loadPerform(project);
    this.#reader = { node: reader, parent: reader.parentNode };
    this.#stage.append(reader);
    document.body.append(this.node);
    this.node.hidden = false;
    showWindow('code-browser');
    const browser = document.getElementById('code-browser') ?? undefined;
    if (browser) {
      browser.classList.add('docked');
      this.code.append(browser);
      this.#browser = browser;
    }
    this.#apply();
  }

  /** Gives the reader and the Code Browser back, when Perform ends. */
  unmount(): void {
    if (this.#reader) {
      (this.#reader.parent ?? document.body).append(this.#reader.node);
    }
    if (this.#browser) {
      this.#browser.classList.remove('docked');
      this.#browser.style.removeProperty('font-size');
      document.body.append(this.#browser);
    }
    this.#reader = undefined;
    this.#browser = undefined;
    clearInterval(this.#ticking);
    this.#ticking = undefined;
    this.#anchor = undefined;
    this.node.hidden = true;
    this.node.remove();
  }

  /** Notes the Code Browser showing `tab`, adding or selecting its tab. */
  shown(tab: PerformTab): void {
    if (!this.mounted) {
      return;
    }
    ({ tabs: this.#tabs, current: this.#current } = recentTabs(
      this.#tabs,
      tab,
    ));
    this.#drawTabs();
  }

  /** Counts on from the Transport the worker sent, while mounted. */
  showTransport(anchor: ClockAnchor | undefined): void {
    this.#anchor = anchor;
    this.#tick();
    if (!this.#ticking && this.mounted) {
      this.#ticking = setInterval(() => this.#tick(), 50);
    }
  }

  #tick(): void {
    this.clock.textContent = clockText(this.#anchor, performance.now());
  }

  /** Shows an error over the code, or clears it. */
  problem(message: string | undefined): void {
    this.banner.hidden = !message;
    this.banner.textContent = message ?? '';
  }

  #drawTabs(): void {
    this.tabBar.replaceChildren(
      ...this.#tabs.map((tab, index) => {
        const button = h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(index === this.#current),
          },
          tab.label,
        );
        button.addEventListener('click', () => this.#open(tab.source));
        return button;
      }),
    );
  }

  get mounted(): boolean {
    return this.#reader !== undefined;
  }

  /** Changes the code's zoom by one step, and remembers it. */
  zoom(direction: 1 | -1): void {
    this.#set({
      ...this.#settings,
      zoom: zoomed(this.#settings.zoom, direction),
    });
  }

  /** Moves the divider to the stage's share `split`, and remembers it. */
  split(split: number): void {
    this.#set({ ...this.#settings, split });
  }

  #set(next: PerformSettings): void {
    this.#settings = normalPerform(next);
    savePerform(this.#project, this.#settings);
    this.#apply();
  }

  #apply(): void {
    const { split, zoom } = this.#settings;
    this.node.style.gridTemplateColumns = `${split * 100}fr auto ${(1 - split) * 100}fr`;
    this.code.style.fontSize = `${zoom * 100}%`;
    this.divider.setAttribute('aria-valuenow', String(Math.round(split * 100)));
    this.#onResize();
  }

  /** Moves the divider to where a pointer is across the layout. */
  #splitAt(event: PointerEvent): void {
    const box = this.node.getBoundingClientRect();
    if (box.width) {
      this.split((event.clientX - box.left) / box.width);
    }
  }

  #dragDivider(): void {
    let dragging = false;
    this.divider.addEventListener('pointerdown', event => {
      event.preventDefault();
      this.divider.setPointerCapture?.(event.pointerId);
      dragging = true;
    });
    this.divider.addEventListener('pointermove', event => {
      if (dragging) {
        this.#splitAt(event);
      }
    });
    this.divider.addEventListener('pointerup', event => {
      if (dragging) {
        dragging = false;
        this.#splitAt(event);
      }
    });
    this.divider.addEventListener('keydown', event => {
      const step =
        event.key === 'ArrowLeft'
          ? -0.05
          : event.key === 'ArrowRight'
            ? 0.05
            : 0;
      if (step) {
        event.preventDefault();
        this.split(this.#settings.split + step);
      }
    });
  }
}
