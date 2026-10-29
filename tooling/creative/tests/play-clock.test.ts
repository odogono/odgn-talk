import { describe, expect, test } from 'bun:test';
import type { PumpResult } from '@northtalk/ts';
import { PlayClock, STEP } from '../src/play-clock';

const setup = () => {
  let ms = 1000;
  const clock = new PlayClock(() => ms);
  return {
    clock,
    wait: (by: number) => {
      ms += by;
    },
  };
};
const ended = { state: 'idle' } as const;
const continued = (): PumpResult => ({}) as PumpResult;

describe('Pause and the Play clock', () => {
  test('paused time grows while paused and stops on Resume', () => {
    const { clock, wait } = setup();
    wait(50);
    expect(clock.pausedTime()).toBe(0);
    clock.pause();
    wait(200);
    expect(clock.pausedTime()).toBe(200);
    clock.resume();
    wait(300);
    expect(clock.pausedTime()).toBe(200);
  });

  test('pausing twice keeps the first Pause', () => {
    const { clock, wait } = setup();
    clock.pause();
    wait(100);
    clock.pause();
    wait(100);
    expect(clock.pausedTime()).toBe(200);
  });

  test('a new session starts unpaused, keeping the paused time', () => {
    const { clock, wait } = setup();
    clock.pause();
    wait(100);
    clock.newSession();
    expect(clock.paused).toBe(false);
    wait(100);
    expect(clock.pausedTime()).toBe(100);
  });
});

describe('a frame Step', () => {
  test('moves a paused session on by one frame, as frames of work', () => {
    const { clock } = setup();
    clock.pause();
    expect(clock.nextPump(false)).toEqual({ outOfBand: true });
    expect(clock.frameStep(false)).toBe(true);
    expect(clock.pausedTime()).toBe(-STEP);
    expect(clock.nextPump(false)).toEqual({ outOfBand: false });
    clock.afterPump(ended, 0n);
    expect(clock.nextPump(false)).toEqual({ outOfBand: true });
  });

  test('is refused unless paused, or while a Run is stopped', () => {
    const { clock } = setup();
    expect(clock.frameStep(false)).toBe(false);
    clock.pause();
    expect(clock.frameStep(true)).toBe(false);
    expect(clock.pausedTime()).toBe(0);
  });
});

describe('a Stopped Run', () => {
  test('a Breakpoint hit pauses the session at the innermost frame', () => {
    const { clock, wait } = setup();
    clock.stoppedAt('r1');
    expect(clock.paused).toBe(true);
    wait(100);
    expect(clock.pausedTime()).toBe(100);
    clock.selectFrame(2);
    clock.stoppedAt('r1');
    expect(clock.frame).toBe(2);
    clock.stoppedAt('r2');
    expect(clock.frame).toBe(0);
  });

  test('holds every Pump until a Resume or Statement Step continues it, once', () => {
    const { clock } = setup();
    clock.stoppedAt('r1');
    expect(clock.nextPump(true)).toBeUndefined();
    clock.continueWith(continued);
    expect(clock.nextPump(true)).toEqual({
      advance: continued,
      outOfBand: true,
    });
    expect(clock.nextPump(true)).toBeUndefined();
  });
});

describe('after a Pump', () => {
  test('a slice continues at once, leaving a Step running', () => {
    const { clock } = setup();
    clock.pause();
    clock.frameStep(false);
    expect(clock.afterPump({ state: 'sliced' }, 0n)).toEqual({ sliced: true });
    expect(clock.nextPump(false)?.outOfBand).toBe(false);
  });

  test('an unpaused session waits for its next deadline', () => {
    const { clock } = setup();
    expect(
      clock.afterPump({ state: 'idle', nextDeadline: 5000n }, 2000n),
    ).toEqual({ finishWatches: false, startWatches: false, delay: 3 });
    expect(
      clock.afterPump({ state: 'idle', nextDeadline: 1000n }, 2000n),
    ).toMatchObject({ delay: 0 });
  });

  test('a paused session has no deadline to wait for', () => {
    const { clock } = setup();
    clock.pause();
    clock.afterPump(ended, 0n);
    expect(
      clock.afterPump({ state: 'idle', nextDeadline: 5000n }, 2000n),
    ).toEqual({ finishWatches: false, startWatches: false });
  });
});

describe('Watches', () => {
  test('a Pause, a Step and a Message Box line each make them due once', () => {
    const { clock } = setup();
    clock.messageSent();
    expect(clock.afterPump(ended, 0n)).toMatchObject({ startWatches: false });
    clock.pause();
    expect(clock.afterPump(ended, 0n)).toMatchObject({ startWatches: true });
    expect(clock.afterPump(ended, 0n)).toMatchObject({ startWatches: false });
    clock.frameStep(false);
    expect(clock.afterPump(ended, 0n)).toMatchObject({ startWatches: true });
    clock.messageSent();
    expect(clock.afterPump(ended, 0n)).toMatchObject({ startWatches: true });
  });

  test('changed Watches are due only while paused', () => {
    const { clock } = setup();
    clock.watchesChanged();
    expect(clock.afterPump(ended, 0n)).toMatchObject({ startWatches: false });
    clock.pause();
    clock.afterPump(ended, 0n);
    clock.watchesChanged();
    expect(clock.afterPump(ended, 0n)).toMatchObject({ startWatches: true });
  });

  test('their own Pumps end by settling them', () => {
    const { clock } = setup();
    clock.watchesStarted();
    expect(clock.watching).toBe(true);
    expect(clock.afterPump({ state: 'sliced' }, 0n)).toEqual({ sliced: true });
    expect(clock.watching).toBe(true);
    expect(clock.afterPump(ended, 0n)).toMatchObject({ finishWatches: true });
    expect(clock.watching).toBe(false);
  });
});
