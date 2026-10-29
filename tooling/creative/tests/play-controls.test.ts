import { describe, expect, test } from 'bun:test';
import { controls, type ControlsView } from '../src/play-controls';
import type { StoppedRun } from '../src/play-protocol';

const view = (o: Partial<ControlsView> = {}): ControlsView => ({
  navigating: false,
  paused: false,
  ended: false,
  ...o,
});
const stoppedRun = { frames: [] } as unknown as StoppedRun;

describe('controls', () => {
  test('with no session, or an ended one, nothing is allowed', () => {
    for (const v of [undefined, view({ ended: true, paused: true })]) {
      expect(controls(v, 'browse')).toEqual({
        live: false,
        paused: false,
        running: false,
        takesInput: false,
        textEditable: false,
        browsing: false,
        atStoppedRun: false,
        pauseLabel: 'Pause',
        frameStepEnabled: false,
        frameStepTitle: "Step one frame (⌘')",
        statementStepsShown: false,
      });
    }
  });

  test('a running session takes input and frames', () => {
    expect(controls(view(), 'present')).toMatchObject({
      live: true,
      running: true,
      takesInput: true,
      textEditable: true,
      browsing: false,
      frameStepEnabled: false,
    });
    expect(controls(view(), 'browse').browsing).toBe(true);
  });

  test('between Pages, input waits but frames go on', () => {
    expect(controls(view({ navigating: true }), 'browse')).toMatchObject({
      running: true,
      takesInput: false,
      textEditable: false,
    });
  });

  test('a paused session drops input and offers a frame Step', () => {
    expect(controls(view({ paused: true }), 'browse')).toMatchObject({
      paused: true,
      running: false,
      takesInput: false,
      // As before: the open text editor checks navigation, not Pause.
      textEditable: true,
      pauseLabel: 'Resume',
      frameStepEnabled: true,
      statementStepsShown: false,
    });
  });

  test('a Stopped Run offers Statement Steps in place of a frame Step', () => {
    expect(
      controls(view({ paused: true, stoppedRun }), 'browse'),
    ).toMatchObject({
      atStoppedRun: true,
      frameStepEnabled: false,
      frameStepTitle: 'Finish the stopped Run first',
      statementStepsShown: true,
    });
  });
});
