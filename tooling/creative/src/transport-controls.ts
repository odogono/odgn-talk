// Browse's live-coding controls (ADR 0174, from Perform's toolbar #2002):
// Hush silences and keeps playing, Revert puts back the shown Script as Play
// loaded it, and the clock shows the tempo and bar as the Transport moves.
import { h } from './dom';

/** The Transport as the worker last sent it, with when it arrived (ms). */
export type ClockAnchor = {
  at: number;
  /** The bars before the bar line `count` counts from. */
  bar?: number;
  beatsPerBar: number;
  count?: number;
  tempo: number;
};

/**
 * The clock's tempo and position at page time `now` (ms), such as
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
  const bar = (anchor.bar ?? 0) + Math.floor(count / anchor.beatsPerBar) + 1;
  const beat = (count % anchor.beatsPerBar) + 1;
  return `${tempo} · bar ${bar}.${beat}`;
};

/** Hush, Revert and the clock, shown in the play controls while browsing. */
export class TransportControls {
  readonly hushButton: HTMLButtonElement;
  readonly revertButton: HTMLButtonElement;
  readonly clock: HTMLElement;
  #anchor: ClockAnchor | undefined;
  #ticking: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.hushButton = h(
      'button',
      {
        type: 'button',
        'data-hush': '',
        hidden: true,
        title: 'Hush: silence every sound and pattern, and keep playing (⌘⇧.)',
      },
      'Hush',
    );
    this.revertButton = h(
      'button',
      {
        type: 'button',
        'data-revert': '',
        hidden: true,
        title: 'Revert: put back the Script as Play last loaded it',
      },
      'Revert',
    );
    this.clock = h('span', {
      class: 'play-clock',
      'aria-live': 'off',
      'aria-label': 'Tempo and bar',
    });
  }

  /** Shows the controls while browsing, and stops the clock otherwise. */
  shown(browsing: boolean): void {
    this.hushButton.hidden = !browsing;
    this.revertButton.hidden = !browsing;
    if (!browsing) {
      this.show(undefined);
    }
  }

  /** Counts on from the Transport the worker sent; undefined clears it. */
  show(anchor: ClockAnchor | undefined): void {
    this.#anchor = anchor;
    this.#tick();
    if (anchor && !this.#ticking) {
      this.#ticking = setInterval(() => this.#tick(), 50);
    } else if (!anchor && this.#ticking) {
      clearInterval(this.#ticking);
      this.#ticking = undefined;
    }
  }

  #tick(): void {
    this.clock.textContent = clockText(this.#anchor, performance.now());
  }
}
