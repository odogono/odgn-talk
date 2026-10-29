// What the Play page lets the reader and author do, from the worker's last
// view of the session: the one place its buttons and gates are decided.
import type { PlayView } from './play-protocol';
import type { PlayMode } from './stack';

/** The parts of a session's view the controls depend on. */
export type ControlsView = Pick<
  PlayView,
  'navigating' | 'paused' | 'ended' | 'stoppedRun'
>;

export type Controls = {
  /** A Stopped Run holds the session: its frames can be chosen. */
  atStoppedRun: boolean;
  /** Playing in Browse: Breakpoints, Watches and Variables apply. */
  browsing: boolean;
  /** A frame Step can move the session on: paused with no Stopped Run. */
  frameStepEnabled: boolean;
  frameStepTitle: string;
  /** A session is playing: it hasn't ended. */
  live: boolean;
  /** Paused, while playing. */
  paused: boolean;
  pauseLabel: 'Pause' | 'Resume';
  /** Playing and not paused: its frames and held presses go on. */
  running: boolean;
  /** Statement Steps are offered: paused at a Stopped Run (ADR 0147). */
  statementStepsShown: boolean;
  /** Reader input is taken: playing, not paused, not between Pages. */
  takesInput: boolean;
  /** An editable Text Element may take typing: playing, not between Pages. */
  textEditable: boolean;
};

export const controls = (
  view: ControlsView | undefined,
  mode: PlayMode | undefined,
): Controls => {
  const live = Boolean(view && !view.ended);
  const paused = live && view!.paused;
  const stoppedRun = live && Boolean(view!.stoppedRun);
  // A frame can't move on until a Stopped Run finishes (ADR 0147).
  const atStop = paused && stoppedRun;
  return {
    live,
    paused,
    running: live && !view!.paused,
    takesInput: live && !view!.navigating && !view!.paused,
    textEditable: live && !view!.navigating,
    browsing: live && mode === 'browse',
    atStoppedRun: stoppedRun,
    pauseLabel: paused ? 'Resume' : 'Pause',
    frameStepEnabled: paused && !stoppedRun,
    frameStepTitle: atStop
      ? 'Finish the stopped Run first'
      : "Step one frame (⌘')",
    statementStepsShown: atStop,
  };
};
