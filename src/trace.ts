// Writing Trace records (chapter 11, The Trace): a record's name, its ids,
// then its keys in corpus.toml's order, each as key=value, one per line.
import { coreRaised } from './machine';
import { listValues, map, type Value } from './values';

/** A record's line: absent keys, and absent optional ids, are left out. */
export const recordLine = (
  name: string,
  ids: readonly (string | null | undefined)[],
  keys: readonly (readonly [string, string | null | undefined])[],
  input = false,
): string =>
  [
    `${input ? '> ' : ''}${name}`,
    ...ids.filter((id): id is string => id !== null && id !== undefined),
    ...keys.flatMap(([k, v]) =>
      v === null || v === undefined ? [] : [`${k}=${v}`],
    ),
  ].join(' ');

/** A list of ids, `[a, b]`. */
export const idList = (ids: readonly string[]): string | null =>
  ids.length ? `[${ids.join(', ')}]` : null;

/**
 * A value as a Trace writes it: its display form, with every Core-raised
 * error map written without its `message`, wherever it appears (chapter 11).
 */
export const traceValue = (v: Value): string => stripped(v).toString();

const stripped = (root: Value): Value => {
  // Rebuild only what holds a Core-raised map, leaves first, without recursion.
  const order: Value[] = [];
  const pending: Value[] = [root];
  while (pending.length) {
    const v = pending.pop()!;
    order.push(v);
    if (v.kind === 'list') {
      for (let i = 1; i <= v.length; i++) {
        pending.push(v.index(i));
      }
    } else if (v.kind === 'map') {
      for (const [, value] of v.entries()) {
        pending.push(value);
      }
    }
  }
  const done = new Map<Value, Value>();
  for (let i = order.length - 1; i >= 0; i--) {
    const v = order[i]!;
    if (v.kind === 'list') {
      const items = Array.from(
        { length: v.length },
        (_, j) => done.get(v.index(j + 1)) ?? v.index(j + 1),
      );
      done.set(
        v,
        items.some((item, j) => item !== v.index(j + 1))
          ? listValues(items)
          : v,
      );
    } else if (v.kind === 'map') {
      const core = coreRaised.has(v);
      const entries = v
        .entries()
        .filter(([k]) => !(core && k === 'message'))
        .map(([k, value]) => [k, done.get(value) ?? value] as [string, Value]);
      const changed =
        core || entries.some(([, value], j) => value !== v.entries()[j]![1]);
      done.set(v, changed ? map(entries) : v);
    }
  }
  return done.get(root) ?? root;
};
