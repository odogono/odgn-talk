// A Canvas Element's Drawing (ADR 0116): a retained command list. `clear`
// and `background` reset it to the current style, so style survives a clear
// and a Script that paints `background` every frame keeps one frame's list.
// They also reset the transform and empty the `push` stack, as p5.js does
// at the start of each `draw`.
import {
  CANVAS_LIMITS,
  CANVAS_SIGNATURES,
  canvasCommandProblem,
  canvasStackDepth,
  type CanvasCommand,
} from '@northtalk/tooling/canvas';
import { ScriptError } from '@northtalk/ts';
import type { DeepReadonly } from './readonly';

/** The Playground's Operations without `size`; one unit is one Page pixel. */
export const DRAWING_OPERATIONS = Object.keys(CANVAS_SIGNATURES).filter(
  op => op !== 'size',
);

// Commands in the same group replace each other as the current style.
const STYLE_GROUPS: Readonly<Record<string, string>> = {
  fill: 'fill',
  noFill: 'fill',
  stroke: 'stroke',
  noStroke: 'stroke',
  strokeWidth: 'strokeWidth',
  strokeCap: 'strokeCap',
  strokeJoin: 'strokeJoin',
  textSize: 'textSize',
};

/** Why stored data is not a Drawing, or undefined when it is one. */
export const drawingProblem = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) {
    return 'expected a list of drawing commands';
  }
  if (value.length > CANVAS_LIMITS.commands) {
    return `a Drawing holds at most ${CANVAS_LIMITS.commands} commands`;
  }
  let depth = 0;
  const stackProblem = (op: string) => {
    try {
      depth = canvasStackDepth(op, depth);
      return undefined;
    } catch (error) {
      return error instanceof ScriptError ? error.message : String(error);
    }
  };
  for (const [i, command] of value.entries()) {
    const problem =
      canvasCommandProblem(command) ??
      (DRAWING_OPERATIONS.includes((command as CanvasCommand).op) &&
      (command as CanvasCommand).op !== 'clear'
        ? undefined
        : `a Drawing cannot hold ${(command as CanvasCommand).op}`) ??
      stackProblem((command as CanvasCommand).op);
    if (problem) {
      return `command ${i + 1}: ${problem}`;
    }
  }
  return undefined;
};

/** How far a reader has seen a Drawing: its count of resets and its length. */
export type DrawingMark = { readonly length: number; readonly resets: number };

/** A Drawing's commands since a mark: all of them after a reset. */
export type DrawingChange = {
  commands: CanvasCommand[];
  mark: DrawingMark;
  reset: boolean;
};

/**
 * A Play Session's working copy of one Drawing. Readers follow it with
 * `changesSince`, so each learns of a reset or new commands in one place.
 */
export class Drawing {
  commands: CanvasCommand[];
  #resets = 0;
  #style = new Map<string, CanvasCommand>();
  // The style each open `push` saved; `pop` restores it.
  #saved: Map<string, CanvasCommand>[] = [];

  constructor(initial: DeepReadonly<CanvasCommand[]>) {
    this.commands = initial.map(command => ({
      op: command.op,
      args: command.args.map(arg =>
        typeof arg === 'object' ? arg.map(point => [...point]) : arg,
      ),
    }));
    for (const command of this.commands) {
      this.#note(command);
    }
  }

  #note(command: CanvasCommand): void {
    if (command.op === 'push') {
      this.#saved.push(new Map(this.#style));
    } else if (command.op === 'pop') {
      this.#style = this.#saved.pop()!;
    }
    const group = STYLE_GROUPS[command.op];
    if (group) {
      this.#style.set(group, command);
    }
  }

  /**
   * Adds an accepted command, or throws a catchable `canvas limit`, or
   * `invalid canvas argument` for an unmatched `pop` or too deep a `push`.
   */
  add(command: CanvasCommand): void {
    canvasStackDepth(command.op, this.#saved.length);
    if (command.op === 'clear' || command.op === 'background') {
      this.commands = [
        ...this.#style.values(),
        ...(command.op === 'background' ? [command] : []),
      ];
      this.#saved = [];
      this.#resets++;
      return;
    }
    if (this.commands.length >= CANVAS_LIMITS.commands) {
      throw new ScriptError(
        'canvas limit',
        `A Drawing is limited to ${CANVAS_LIMITS.commands} commands; clear it to continue`,
      );
    }
    this.commands.push(command);
    this.#note(command);
  }

  /**
   * What changed since `mark`, or undefined when nothing has. Without a mark,
   * or after a reset, the change is the whole Drawing, sharing its array.
   */
  changesSince(mark?: DrawingMark): DrawingChange | undefined {
    const now = { resets: this.#resets, length: this.commands.length };
    const reset = mark?.resets !== now.resets;
    if (!reset && now.length === mark.length) {
      return undefined;
    }
    return {
      reset,
      commands: reset ? this.commands : this.commands.slice(mark.length),
      mark: now,
    };
  }
}

/**
 * The page's copy of a Drawing, kept from the changes the worker sends. A
 * reset replaces `commands` with a new array and new commands extend the
 * same one, so a painter that keeps the array it painted repaints only after
 * a reset.
 */
export class ReceivedDrawing {
  #commands: CanvasCommand[] = [];
  get commands(): CanvasCommand[] {
    return this.#commands;
  }

  apply(change: { commands: readonly CanvasCommand[]; reset: boolean }): void {
    if (change.reset) {
      this.#commands = [...change.commands];
    } else {
      for (const command of change.commands) {
        this.#commands.push(command);
      }
    }
  }
}
