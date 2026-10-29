// A save's values as the TS Core reads them (chapter 10, The save format):
// Host Objects by their place in `objects`, Function Values by their code in
// `functions`, and Text Patterns compiled again from their source. Every
// read is checked, so a value no Core could have made is `invalid save`.
import { checkSource } from './checker';
import { civilFromFields, isInstant } from './dates';
import { HostError } from './errors';
import { lowerTree } from './lowering';
import { coreRaised, loadScript } from './machine';
import type { ObjectState } from './objects';
import type { SaveReader } from './save-format';
import type { ValueIO } from './save-records';
import { scriptNames } from './save-state';
import { parseUnit } from './units';
import {
  bytes,
  canonicalNumber,
  civilOf,
  functionValue,
  instantOf,
  listValues,
  map,
  nothing,
  bool,
  quantityOf,
  range,
  text,
  type FunctionRef,
  type Value,
} from './values';

const invalid = (): never => {
  throw new HostError('invalid save');
};

/** The most digits a Number's coefficient has (chapter 3). */
const maxCoefficient = 10n ** 34n;

/** Makes a Function Value from its saved parts and its code's entry. */
export type FunctionMaker = (
  code: number | undefined,
  display: string,
  home: string,
  captures: readonly (readonly [string, Value])[],
) => Value;

/** Skips a value without making it: the first restore pass's reader. */
export const skipValue = (r: SaveReader): void => {
  // Each entry is a value to skip, or a map pair: its key, then its value.
  const work: boolean[] = [false];
  while (work.length) {
    if (work.pop()) {
      r.name();
    }
    switch (r.byte()) {
      case 0:
        break;
      case 1:
        r.bool();
        break;
      case 2:
        r.bool();
        r.wideUint(128);
        r.sint();
        break;
      case 3:
        r.bool();
        r.wideUint(128);
        r.sint();
        r.name();
        break;
      case 4:
        r.byte();
        r.text();
        break;
      case 5:
        r.bytes();
        break;
      case 6:
        for (let n = r.count(); n > 0; n--) {
          work.push(false);
        }
        break;
      case 7:
        r.byte();
        for (let n = r.count(); n > 0; n--) {
          work.push(true);
        }
        break;
      case 8:
        work.push(false, false);
        break;
      case 9:
        r.bigSint();
        r.uint();
        break;
      case 10:
        r.sint();
        r.uint();
        r.uint();
        if (r.bool()) {
          r.uint();
          r.uint();
          r.uint();
          r.uint();
        }
        break;
      case 11:
        r.text();
        break;
      case 12:
        if (r.uint() === 0) {
          r.name();
        }
        r.name();
        work.push(false);
        break;
      case 13:
        r.uint();
        break;
      default:
        invalid();
    }
  }
};

/** One container whose children are still being read. */
type Open =
  | { items: Value[]; k: 'list'; n: number }
  | { k: 'map'; keys: string[]; marks: number; n: number; values: Value[] }
  | { items: Value[]; k: 'range' }
  | {
      code: number | undefined;
      display: string;
      home: string;
      k: 'function';
    };

/** Values as a restore reads them. */
export class ValueReader implements ValueIO<Value> {
  constructor(
    private objects: readonly ObjectState[],
    /** Each function's home, in `functions`. */
    private homes: readonly string[],
    private makeFunction: FunctionMaker,
  ) {}

  write(): void {
    throw new Error('A ValueReader reads');
  }

  /** A value; containers wait on a heap stack, so depth costs no JS stack. */
  read(r: SaveReader): Value {
    const stack: Open[] = [];
    for (;;) {
      let v = this.one(r, stack);
      while (v !== undefined) {
        const top = stack.at(-1);
        if (!top) {
          return v;
        }
        switch (top.k) {
          case 'list':
            top.items.push(v);
            if (top.items.length < top.n) {
              v = undefined;
              continue;
            }
            stack.pop();
            v = listValues(top.items);
            continue;
          case 'map':
            top.values.push(v);
            if (top.values.length < top.n) {
              top.keys.push(r.name());
              v = undefined;
              continue;
            }
            stack.pop();
            v = this.mapOf(top.keys, top.values, top.marks);
            continue;
          case 'range':
            top.items.push(v);
            if (top.items.length < 2) {
              v = undefined;
              continue;
            }
            stack.pop();
            v = this.rangeOf(top.items[0]!, top.items[1]!);
            continue;
          case 'function': {
            stack.pop();
            if (v.kind !== 'map') {
              invalid();
            }
            v = this.makeFunction(top.code, top.display, top.home, v.entries());
            continue;
          }
        }
      }
    }
  }

  private mapOf(keys: string[], values: Value[], marks: number): Value {
    if (new Set(keys).size !== keys.length) {
      invalid();
    }
    const v = map(keys.map((k, i) => [k, values[i]!]));
    if (marks & 1) {
      coreRaised.add(v);
    }
    return v;
  }

  private rangeOf(from: Value, to: Value): Value {
    try {
      return range(from, to);
    } catch {
      return invalid();
    }
  }

  private decimal(r: SaveReader) {
    const negative = r.bool();
    const coefficient = r.wideUint(128);
    const exponent = r.sint();
    if (coefficient >= maxCoefficient || exponent < -6176 || exponent > 0) {
      invalid();
    }
    return canonicalNumber({
      negative: negative && coefficient !== 0n,
      coefficient,
      exponent,
    });
  }

  /** A leaf, or undefined once a container opens. */
  private one(r: SaveReader, stack: Open[]): Value | undefined {
    switch (r.byte()) {
      case 0:
        return nothing;
      case 1:
        return bool(r.bool());
      case 2:
        return this.decimal(r);
      case 3: {
        const n = this.decimal(r);
        const shown = r.name();
        try {
          const v = quantityOf(n.asDecimal()!, parseUnit(shown));
          return v.toString() === `${n.toString()} ${shown}` ? v : invalid();
        } catch {
          return invalid();
        }
      }
      case 4: {
        const marks = r.byte();
        if (marks > 3) {
          invalid();
        }
        const v = text(r.text());
        if (marks & 2) {
          scriptNames.add(v);
        }
        return v;
      }
      case 5:
        return bytes(r.bytes());
      case 6: {
        const n = r.count();
        if (n === 0) {
          return listValues([]);
        }
        stack.push({ k: 'list', n, items: [] });
        return undefined;
      }
      case 7: {
        const marks = r.byte();
        if (marks > 3) {
          invalid();
        }
        const n = r.count();
        if (n === 0) {
          return this.mapOf([], [], marks);
        }
        stack.push({ k: 'map', n, marks, keys: [r.name()], values: [] });
        return undefined;
      }
      case 8:
        stack.push({ k: 'range', items: [] });
        return undefined;
      case 9: {
        const seconds = r.bigSint();
        const micros = r.uint();
        const us = seconds * 1_000_000n + BigInt(micros);
        return micros >= 1_000_000 || !isInstant(us)
          ? invalid()
          : instantOf(us);
      }
      case 10: {
        const year = r.sint();
        const month = r.uint();
        const day = r.uint();
        const time = r.optional(r => [r.uint(), r.uint(), r.uint(), r.uint()]);
        const c = civilFromFields({
          year,
          month,
          day,
          ...(time
            ? {
                hour: time[0]!,
                minute: time[1]!,
                second: time[2]!,
                microsecond: time[3]!,
              }
            : {}),
        });
        return typeof c === 'string' ? invalid() : civilOf(c);
      }
      case 11:
        return patternOf(r.text());
      case 12: {
        const code = r.ref(this.homes.length);
        const display = r.name();
        // A value with code takes its home from it.
        const home = code === undefined ? r.name() : this.homes[code]!;
        stack.push({ k: 'function', code, display, home });
        return undefined;
      }
      case 13:
        return this.objects[r.index(this.objects.length)]!.handle.value;
      default:
        return invalid();
    }
  }
}

/** A Text Pattern from its canonical source, compiled again. */
const patternOf = (source: string): Value => {
  const checked = checkSource(`script variable savedPattern = ${source}`);
  if (!checked.ok || !checked.tree) {
    invalid();
  }
  const v = loadScript(lowerTree(checked.tree!, { name: 'saved-pattern' }), {
    patternSize: Number.MAX_SAFE_INTEGER,
  }).variables[0]!;
  return v.kind === 'pattern' && v.patternSource() === source ? v : invalid();
};

/** A Function Value's display form's place: `<function home:place …>`. */
export const placeOf = (display: string): { home: string; place: string } => {
  const m = /^<function ([^:]+):([^ >]+)(?: .*)?>$/s.exec(display);
  return m ? { home: m[1]!, place: m[2]! } : invalid();
};

export const functionOf = (ref: FunctionRef): Value => functionValue(ref);
