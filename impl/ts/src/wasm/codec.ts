// Values crossing to and from one Group's guest. Host Objects cross as
// `{"$object": [kind, id]}` and Function Values as the guest's
// `{"$function": [home, display, token]}`; both are checked against the
// Group before they're sent, as the in-process Core checks `wrong group`.
import { encodeValue } from '../encoding';
import { HostError } from '../errors';
import type { HostObject } from '../objects';
import { fromJson } from '../readers';
import { functionValue, patternValue, type Value } from '../values';
import { quoteJSON } from '../encoding';
import { Raw, type Json } from './wire';

/** What a Function Value made by a guest holds in place of code. */
type GuestFunction = { readonly group: object; readonly token: string };

export type Codec = {
  readonly identity: object;
  object(kind: string, id: string): HostObject | undefined;
};

const wrongGroup = (what: string): never => {
  throw new HostError('wrong group', `${what} belongs to another Group`);
};

/** Refuses another Group's Host Objects and Function Values, anywhere inside. */
const checkOwned = (codec: Codec, v: Value): void => {
  const pending = [v];
  while (pending.length) {
    const next = pending.pop()!;
    switch (next.kind) {
      case 'object': {
        const ref = next.asObjectRef()!;
        const own = codec.object(ref.kind, ref.id);
        if (!own || own.value.asObjectRef()!.handle !== ref.handle) {
          wrongGroup(`Host Object ${ref.kind} ${ref.id}`);
        }
        break;
      }
      case 'function': {
        const code = next.asFunction()!.code as GuestFunction | undefined;
        if (code?.group !== codec.identity) {
          wrongGroup('the Function Value');
        }
        break;
      }
      case 'list':
        for (let i = 1; i <= next.length; i++) {
          pending.push(next.index(i));
        }
        break;
      case 'map':
        for (const [, item] of next.entries()) {
          pending.push(item);
        }
        break;
      case 'range': {
        const { from, to } = next.asRange()!;
        pending.push(from, to);
        break;
      }
    }
  }
};

export const encode = (codec: Codec, v: Value): Raw => {
  checkOwned(codec, v);
  return new Raw(
    encodeValue(v, other => {
      if (other.kind === 'pattern') {
        return `{"$pattern":${quoteJSON(other.patternSource()!)}}`;
      }
      const f = other.asFunction()!;
      const code = f.code as GuestFunction;
      return `{"$function":[${quoteJSON(f.home)},${quoteJSON(other.toString())},${quoteJSON(code.token)}]}`;
    }),
  );
};

export const encodeAll = (codec: Codec, vs: readonly Value[]): Raw[] =>
  vs.map(v => encode(codec, v));

// `<function home:place {captures}>`, split so the TS display rebuilds it.
const guestFunction = (codec: Codec, data: Json): Value => {
  if (
    !Array.isArray(data) ||
    data.length !== 3 ||
    !data.every(part => typeof part === 'string')
  ) {
    throw new HostError('invalid value', 'Malformed $function');
  }
  const [home, display, token] = data as [string, string, string];
  const inner = display.replace(/^<function /, '').replace(/>$/, '');
  const colon = inner.indexOf(':');
  return functionValue({
    home,
    displayHome: colon >= 0 ? inner.slice(0, colon) : inner,
    place: colon >= 0 ? inner.slice(colon + 1) : '',
    identity: token,
    captures: [],
    maySuspend: false,
    code: Object.freeze({ group: codec.identity, token }),
    group: codec.identity,
  });
};

// A Text Pattern keeps its canonical source; the guest compiles it again
// whenever it comes back, so the Host side holds no matcher.
const guestPattern = (data: Json): Value => {
  if (typeof data !== 'string') {
    throw new HostError('invalid value', 'Malformed $pattern');
  }
  return patternValue({ source: data, program: 0, data: null });
};

export const decode = (codec: Codec, j: Json | undefined): Value =>
  fromJson(
    j ?? null,
    (kind, id) => codec.object(kind, id),
    undefined,
    (tag, data) =>
      tag === '$function' ? guestFunction(codec, data) : guestPattern(data),
  );
