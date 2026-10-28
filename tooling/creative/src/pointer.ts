// Pointer input as Scripts receive it (ADR 0145). `click` and `pointerHeld`
// each carry one map, so a Handler picks a button or a position with
// Destructuring and a Guard, and new keys never change a message's arity.
import { fromValue, num, record, type Value } from '@northtalk/ts';

/** The pattern a Handler for primary clicks only takes. */
export const PRIMARY_CLICK = '{button: 0}';

/** `button` is the DOM's: 0 primary, 1 middle, 2 secondary. */
export type ClickEvent = { button: number; x: number; y: number };

/** A reader message's argument as it crosses from the page to the worker. */
export type ReaderArg = string | Readonly<Record<string, number>>;

/** A pointer event map as a Script receives it. */
export const pointerValue = (event: Readonly<Record<string, number>>): Value =>
  record(
    Object.fromEntries(
      Object.entries(event).map(([key, value]) => [key, num(value)]),
    ),
  );

/** A click in Page units, from the Element's top-left corner. */
export const clickEvent = (
  button: number,
  x: number,
  y: number,
): ClickEvent => ({ button, x: Math.round(x), y: Math.round(y) });

/**
 * A Harness click: a primary click at the Element's centre, with any of
 * `given`'s keys in its place.
 */
export const harnessClick = (
  size: { height: number; width: number },
  given?: Value | null,
): Value => {
  const event: Record<string, number> = {
    ...clickEvent(0, size.width / 2, size.height / 2),
  };
  if (given) {
    for (const [key, value] of given.entries()) {
      event[key] = Number(fromValue(value));
    }
  }
  return pointerValue(event);
};
