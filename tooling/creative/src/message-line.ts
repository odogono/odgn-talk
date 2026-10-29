// One Message Box line, whichever engine runs it: Edit's throwaway session,
// a running Play Session, or a Stopped Run's frame (ADR 0147). The line's
// grammar, its usage errors, the `:fuel` refusal and the Fuel line are
// decided here; each engine only runs an expression or a command.
import { fuelText, type FuelRow } from './fuel';
import { fuelCommand, inspectCommand } from './message-script';
import { type MessageReply } from './message';

export type MaybePromise<T> = Promise<T> | T;

/** A Fuel measurement's reply, and the row its Fuel line prints. */
export type MeasuredReply = { reply: MessageReply; row?: FuelRow };

export type LineEngine = {
  /** Runs a command, a line that isn't a Message Box verb. */
  command(text: string): MaybePromise<MessageReply>;
  /** Evaluates `:inspect`'s expression, encoded as the Variables window shows it. */
  inspect(expression: string): MaybePromise<MessageReply>;
} & (
  | {
      /** Runs `:fuel`'s command, measuring the Fuel it and its Runs use. */
      fuel(command: string): MaybePromise<MeasuredReply>;
    }
  /** Why this engine can't measure Fuel. */
  | { fuelRefusal: string }
);

/** Applies `f` now to a value, or once a Promise settles. */
export const whenReady = <T, U>(
  value: MaybePromise<T>,
  f: (value: T) => U,
): MaybePromise<U> =>
  typeof (value as Partial<Promise<T>>)?.then === 'function'
    ? (value as Promise<T>).then(f)
    : f(value as T);

/** The Fuel line follows the command's value or error. */
const withFuel = ({ reply, row }: MeasuredReply): MessageReply => {
  if (!row) {
    return reply;
  }
  const line = fuelText(row);
  return reply.error === undefined
    ? {
        ...reply,
        text: reply.text === undefined ? line : `${reply.text}\n${line}`,
      }
    : { error: `${reply.error}\n${line}` };
};

/**
 * Runs one line. A synchronous engine answers synchronously, so a Stopped
 * Run's reply still comes before the Watches it changes.
 */
export const runLine = (
  text: string,
  engine: LineEngine,
): MaybePromise<MessageReply> => {
  const inspect = inspectCommand(text);
  if (inspect) {
    return 'error' in inspect
      ? { error: inspect.error }
      : engine.inspect(inspect.expression);
  }
  const fuel = fuelCommand(text);
  if (fuel) {
    if ('fuelRefusal' in engine) {
      return { error: engine.fuelRefusal };
    }
    return 'error' in fuel
      ? { error: fuel.error }
      : whenReady(engine.fuel(fuel.command), withFuel);
  }
  return engine.command(text);
};
