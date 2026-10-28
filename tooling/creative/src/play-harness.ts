import { text, type Value } from '@northtalk/ts';
import type { CanvasCommand } from '@northtalk/tooling/canvas';
import { textOf, type Element, type Project } from './model';
import { PlaySession, type PlayMessage } from './play';
import { harnessClick, pointerValue } from './pointer';
import { thaw, type DeepReadonly } from './readonly';

/** How many Pump turns `settle` allows before it calls the session stuck. */
const SETTLE_TURNS = 2000;

export type PlayHarnessOptions = {
  /**
   * Handlers appended to the first Page's Script for this run only, so a test
   * can set up a board the Example Project doesn't expose (ADR 0133).
   */
  extend?: string;
  /** Seeds `random`; 0 by default, so every run of a test is the same. */
  seed?: bigint;
};

/**
 * A Play Session on an Example Project, driven by a virtual clock the way
 * Browse drives it in the browser, for Folio's own tests (ADR 0133).
 * Every input settles before it returns.
 */
export class PlayHarness {
  /** The virtual clock, in microseconds, as `pump` and `frame` take it. */
  clock = 0n;

  private constructor(readonly play: PlaySession) {}

  static async start(
    project: DeepReadonly<Project>,
    options: PlayHarnessOptions = {},
  ): Promise<PlayHarness> {
    let start = project;
    if (options.extend) {
      const copy = thaw<Project>(project);
      copy.pages[0]!.script += options.extend;
      start = copy;
    }
    const harness = new PlayHarness(
      new PlaySession(start, 0, { seed: options.seed ?? 0n }),
    );
    await harness.settle();
    return harness;
  }

  /** Pumps at the current clock until no Run is left mid-slice. */
  async settle(): Promise<void> {
    for (let i = 0; i < SETTLE_TURNS; i++) {
      const result = this.play.pump(this.clock);
      // Lets Run promises, such as a finished `frame`, resolve between turns.
      await Promise.resolve();
      if (result.state !== 'sliced') {
        return;
      }
    }
    throw new Error('Did not become idle');
  }

  /** Moves the clock `ms` on, delivers one `frame` and settles. */
  async frame(ms: number): Promise<void> {
    this.clock += BigInt(ms) * 1000n;
    this.play.frame(this.clock);
    await this.settle();
  }

  /** Sends `keyDown` then `keyUp` to the Page, then lets 1 ms of frames pass. */
  async key(name: string): Promise<void> {
    this.play.send(this.play.page, 'keyDown', [text(name)]);
    await this.settle();
    this.play.send(this.play.page, 'keyUp', [text(name)]);
    await this.settle();
    await this.frame(1);
  }

  /**
   * Clicks the named Element on the current Page: a primary click at its
   * centre, unless `event` gives `button`, `x` or `y`.
   */
  async click(
    name: string,
    event: Partial<Record<'button' | 'x' | 'y', number>> = {},
  ): Promise<void> {
    const element = this.element(name);
    const given = Object.keys(event).length
      ? pointerValue(event as Record<string, number>)
      : undefined;
    await this.send(name, 'click', [harnessClick(element, given)]);
  }

  /** Reports a press on the named Element held for `held` ms. */
  async hold(name: string, held: number): Promise<void> {
    const { width, height } = this.element(name);
    await this.send(name, 'pointerHeld', [
      pointerValue({
        held,
        x: Math.round(width / 2),
        y: Math.round(height / 2),
      }),
    ]);
  }

  async send(
    name: string,
    message: PlayMessage,
    args: Value[] = [],
  ): Promise<void> {
    this.play.send(this.element(name), message, args);
    await this.settle();
  }

  /** Delivers a message to the current Page, such as an `extend` Handler. */
  async deliver(name: string, args: Value[] = []): Promise<void> {
    this.play.group.deliver(this.play.objects.get(this.play.page)!, {
      name,
      args,
    });
    await this.settle();
  }

  /** The named Element on the current Page, as Play has changed it. */
  element(name: string): DeepReadonly<Element> {
    const found = this.play.page.elements.find(e => e.name === name);
    if (!found) {
      throw new Error(`No Element ${name} on Page ${this.play.page.name}`);
    }
    return found;
  }

  /** The text a Text Element shows. */
  text(name: string): string {
    const found = this.element(name);
    if (found.kind !== 'text') {
      throw new Error(`Element ${name} is not text`);
    }
    return textOf(found);
  }

  /** What the named Canvas would paint, in drawing order. */
  drawingOf(name: string): DeepReadonly<CanvasCommand[]> {
    const canvas = this.element(name);
    if (canvas.kind !== 'canvas') {
      throw new Error(`Element ${name} is not a Canvas`);
    }
    return this.play.drawingOf(canvas);
  }
}
