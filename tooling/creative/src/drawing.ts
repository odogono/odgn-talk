// A Canvas Element's Drawing (ADR 0116): a retained command list. `clear`
// and `background` reset it to the current style, so style survives a clear
// and a Script that paints `background` every frame keeps one frame's list.
import {
  CANVAS_LIMITS,
  CANVAS_SIGNATURES,
  canvasCommandProblem,
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
  for (const [i, command] of value.entries()) {
    const problem =
      canvasCommandProblem(command) ??
      (DRAWING_OPERATIONS.includes((command as CanvasCommand).op) &&
      (command as CanvasCommand).op !== 'clear'
        ? undefined
        : `a Drawing cannot hold ${(command as CanvasCommand).op}`);
    if (problem) {
      return `command ${i + 1}: ${problem}`;
    }
  }
  return undefined;
};

/**
 * A Play Session's working copy of one Drawing. `commands` is replaced by a
 * new array on each reset and appended to otherwise, so a reader can tell a
 * reset from new commands by identity alone.
 */
export class Drawing {
  commands: CanvasCommand[];
  readonly #style = new Map<string, CanvasCommand>();

  constructor(initial: DeepReadonly<CanvasCommand[]>) {
    this.commands = initial.map(command => ({
      op: command.op,
      args: [...command.args],
    }));
    for (const command of this.commands) {
      this.#note(command);
    }
  }

  #note(command: CanvasCommand): void {
    const group = STYLE_GROUPS[command.op];
    if (group) {
      this.#style.set(group, command);
    }
  }

  /** Adds an accepted command, or throws a catchable `canvas limit`. */
  add(command: CanvasCommand): void {
    if (command.op === 'clear' || command.op === 'background') {
      this.commands = [
        ...this.#style.values(),
        ...(command.op === 'background' ? [command] : []),
      ];
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
}
