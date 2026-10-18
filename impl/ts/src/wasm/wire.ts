// Message Layer frames as JSON text. Values are already in the Value
// Encoding, so a frame carries them as raw text; replies are read in order,
// with duplicate keys refused, so a Value inside one decodes exactly.
import { quoteJSON } from '../encoding';
import {
  isJsonNumber as isNumber,
  isJsonObject as isObject,
  readOrderedJSON,
  type Json,
} from '../readers';

const raw = Symbol('raw JSON');
const sep = Symbol('separator');

/** Text already in JSON, such as a Value Encoding, placed in a frame as is. */
export class Raw {
  readonly [raw] = true;
  constructor(readonly json: string) {}
}

export type Frame =
  | null
  | boolean
  | number
  | string
  | Raw
  | readonly Frame[]
  | { readonly [key: string]: Frame | undefined };

class Sep {
  readonly [sep] = true;
  constructor(readonly text: string) {}
}

/** A frame's JSON; undefined fields are left out. */
export const frameJSON = (frame: Frame): string => {
  const out: string[] = [];
  const pending: (Frame | Sep)[] = [frame];
  while (pending.length) {
    const next = pending.pop()!;
    if (next === null) {
      out.push('null');
    } else if (typeof next === 'string') {
      out.push(quoteJSON(next));
    } else if (typeof next === 'number' || typeof next === 'boolean') {
      out.push(JSON.stringify(next));
    } else if (raw in next) {
      out.push((next as Raw).json);
    } else if (Array.isArray(next)) {
      out.push('[');
      pending.push(new Sep(']'));
      for (let i = next.length - 1; i >= 0; i--) {
        pending.push(next[i]!);
        if (i > 0) {
          pending.push(new Sep(','));
        }
      }
    } else if (sep in next) {
      out.push((next as Sep).text);
    } else {
      const entries = Object.entries(next).filter(([, v]) => v !== undefined);
      out.push('{');
      pending.push(new Sep('}'));
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, value] = entries[i]!;
        pending.push(
          value as Frame,
          new Sep(`${i > 0 ? ',' : ''}${quoteJSON(key)}:`),
        );
      }
    }
  }
  return out.join('');
};

export type { Json };
export const readReply = (s: string): Json => readOrderedJSON(s);

/** A member of a JSON object, or undefined. */
export const field = (j: Json | undefined, key: string): Json | undefined => {
  if (!isObject(j)) {
    return undefined;
  }
  for (const [k, v] of j.pairs) {
    if (k === key) {
      return v;
    }
  }
  return undefined;
};
export const has = (j: Json | undefined, key: string): boolean =>
  field(j, key) !== undefined;
export const textOf = (j: Json | undefined): string | undefined =>
  typeof j === 'string' ? j : undefined;
/** Integers cross as JSON numbers below 2⁵³ and as decimal text above. */
export const intOf = (j: Json | undefined): number | undefined =>
  isNumber(j)
    ? Number(j.source)
    : typeof j === 'string' && /^-?\d+$/.test(j)
      ? Number(j)
      : undefined;
export const boolOf = (j: Json | undefined): boolean | undefined =>
  typeof j === 'boolean' ? j : undefined;
export const listOf = (j: Json | undefined): Json[] =>
  Array.isArray(j) ? j : [];
export const textsOf = (j: Json | undefined): string[] =>
  listOf(j).map(t => textOf(t) ?? '');
export const entriesOf = (j: Json | undefined): [string, Json][] =>
  isObject(j) ? j.pairs : [];

/** Protocol data that holds no Values, as plain JavaScript. */
export const plain = (j: Json | undefined): unknown => {
  if (j === undefined || j === null || typeof j !== 'object') {
    return j;
  }
  if (Array.isArray(j)) {
    return j.map(plain);
  }
  if (isNumber(j)) {
    return Number(j.source);
  }
  return Object.fromEntries(j.pairs.map(([k, v]) => [k, plain(v)]));
};
