// Chapter 9: only colon-containing Host message names have a Selector contract.
import { grammar } from './generated/syntax';
const reserved = new Set(grammar.reserved);
const allowed = new Set(grammar.labels.reserved);
const excluded = new Set(grammar.labels.excluded);
const name = (part: string) =>
  part !== '_' && /^[A-Z_a-z]\w*$/.exec(part)?.[0] === part;
export const validMessageSelector = (
  message: string,
  arity: number,
): boolean => {
  if (!message.includes(':')) {
    return true;
  }
  const parts = message.split(':');
  if (parts.pop() !== '' || parts.length < 2 || parts.length !== arity) {
    return false;
  }
  const first = parts.shift()!;
  return (
    name(first) &&
    first !== 'all' &&
    !reserved.has(first) &&
    parts.every(
      part =>
        name(part) &&
        (!reserved.has(part) || allowed.has(part)) &&
        !excluded.has(part),
    )
  );
};
// Chapter 5: a computed message name must be one a static `send` could
// write, a Name or a Selector with one argument per part (ADR 0057).
export const validComputedMessageName = (
  message: string,
  arity: number,
): boolean =>
  message.includes(':')
    ? validMessageSelector(message, arity)
    : name(message) && message !== 'all' && !reserved.has(message);
