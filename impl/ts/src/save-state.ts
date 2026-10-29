// The TS Core's state as the shared save format's records (ADR 0144,
// spec/data/save-format.toml), and back. The Group gathers its state and
// rebuilds from what a restore reads; a Run's own records are save-runs.ts's.
import type { Grant, ValueOperation } from './capabilities';
import { HostError } from './errors';
import { costModel, languageVersion } from './generated/machine';
import type { Library } from './library';
import type { Code, Script } from './machine';
import { canonicalJSON, grantData } from './manifest';
import type { ObjectState } from './objects';
import {
  type SaveReader,
  type SaveSection,
  SaveWriter,
  readSave,
  saveSections,
  TextTable,
  writeSave,
} from './save-format';
import {
  RecordWriter,
  type FunctionRecord,
  type SaveRecords,
  type Unit,
  type ValueIO,
} from './save-records';
import { decimalParts, map, Value } from './values';
import { coreRaised } from './machine';
import { functionHead } from './code-unit';

const invalid = (): never => {
  throw new HostError('invalid save');
};

export const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], b => Number.parseInt(b, 16));
export const bytesHex = (bytes: Uint8Array) =>
  [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

/** A Script value's Script-name mark, for a Receiver on an operand stack. */
export const scriptNames = new WeakSet<Value>();

/** Where each code unit is, for a save's code positions. */
export type UnitPlaces = {
  /** A Library the Group holds, by its code. */
  library(code: Code): number | undefined;
  /** A Script's units, base first, then its extensions. */
  scriptUnits(home: string): readonly Code[] | undefined;
};

/** A unit relative to the Script `home`. */
export const unitOf = (places: UnitPlaces, home: string, code: Code): Unit => {
  const units = places.scriptUnits(home) ?? [];
  const at = units.indexOf(code);
  if (at === 0) {
    return { k: 'own' };
  }
  if (at > 0) {
    return { k: 'extension', extension: at - 1 };
  }
  if (code.stdlib) {
    return { k: 'stdlib', name: code.name };
  }
  const library = places.library(code);
  if (library === undefined) {
    throw new Error(`a save names code it can't place: ${code.name}`);
  }
  return { k: 'library', library };
};

type FunctionCode = {
  body: import('./code-unit').Body;
  code: Code;
  home: Script;
};

/**
 * Values as a save writes them: Host Objects by their place in `objects`,
 * and Function Value code numbered as the writer first meets it.
 */
export class ValueWriter implements ValueIO<Value> {
  readonly functions: FunctionRecord[] = [];
  private met = new Map<unknown, number>();

  constructor(
    private objects: ReadonlyMap<ObjectState, number>,
    private places: UnitPlaces,
  ) {}

  private meet(fn: import('./values').FunctionRef): number | undefined {
    const code = fn.code;
    const c = code as Partial<FunctionCode> & {
      home?: { live: boolean };
      unit?: string;
    };
    // Its home still has its code unless a Reload replaced it; a Stop
    // leaves it.
    const live =
      !!c.body &&
      !!c.code &&
      !!c.home &&
      this.places.scriptUnits(fn.home)?.[0] === (c.home as unknown);
    // One entry per body in each home, however many code objects bind it.
    const key = live
      ? `${fn.home}\u0000${c.code!.name}\u0000${c.code!.identity}\u0000${c.body!.index}`
      : code;
    const known = this.met.get(key);
    if (known !== undefined) {
      return known;
    }
    const head = functionHead(code);
    if (!head) {
      return undefined;
    }
    const record: FunctionRecord = {
      home: fn.home,
      name: head.name ?? '',
      required: head.min,
      total: head.max,
      unit: hexBytes(c.code?.identity ?? c.unit ?? ''),
      body: live
        ? {
            unit: unitOf(this.places, fn.home, c.code!),
            body: c.body!.index,
          }
        : undefined,
    };
    const at = this.functions.length;
    this.functions.push(record);
    this.met.set(key, at);
    return at;
  }

  read(): Value {
    throw new Error('A ValueWriter writes');
  }

  write(w: SaveWriter, root: Value): void {
    const work: (Value | string)[] = [root];
    while (work.length) {
      const v = work.pop()!;
      if (typeof v === 'string') {
        w.name(v);
        continue;
      }
      switch (v.kind) {
        case 'nothing':
          w.byte(0);
          break;
        case 'boolean':
          w.byte(1).bool(v.asBool()!);
          break;
        case 'number':
          w.byte(2);
          decimal(w, v.asDecimal()!);
          break;
        case 'quantity': {
          const q = v.asQuantityRef()!;
          w.byte(3);
          decimal(w, q.number);
          w.name(quantityUnit(v));
          break;
        }
        case 'text':
          w.byte(4)
            .byte(scriptNames.has(v) ? 2 : 0)
            .text(v.asText()!);
          break;
        case 'bytes':
          w.byte(5).bytes(v.bytesView()!);
          break;
        case 'list': {
          w.byte(6).uint(v.length);
          for (let i = v.length; i > 0; i--) {
            work.push(v.index(i));
          }
          break;
        }
        case 'map': {
          const pairs = v.entries();
          w.byte(7)
            .byte(coreRaised.has(v) ? 1 : 0)
            .uint(pairs.length);
          for (let i = pairs.length - 1; i >= 0; i--) {
            work.push(pairs[i]![1], pairs[i]![0]);
          }
          break;
        }
        case 'range': {
          const r = v.asRange()!;
          work.push(r.to, r.from);
          w.byte(8);
          break;
        }
        case 'instant': {
          const us = v.asInstant()!;
          w.byte(9);
          instant(w, us);
          break;
        }
        case 'civil date': {
          const c = v.civilRef()!;
          w.byte(10)
            .sint(c.year)
            .uint(c.month)
            .uint(c.day)
            .bool(c.us !== null);
          if (c.us !== null) {
            const us = c.us;
            w.uint(Number(us / 3_600_000_000n))
              .uint(Number((us / 60_000_000n) % 60n))
              .uint(Number((us / 1_000_000n) % 60n))
              .uint(Number(us % 1_000_000n));
          }
          break;
        }
        case 'pattern':
          w.byte(11).text(v.patternSource()!);
          break;
        case 'function': {
          const fn = v.asFunction()!;
          const code = this.meet(fn);
          w.byte(12).ref(code).name(v.toString());
          // A value with code takes its home from it.
          if (code === undefined) {
            w.name(fn.home);
          } else if (this.functions[code]!.home !== fn.home) {
            throw new Error('A Function Value has another home than its code');
          }
          work.push(captureMap(fn.captures));
          break;
        }
        case 'object': {
          const at = this.objects.get(v.asObjectRef()!.handle as ObjectState);
          w.byte(13).index(at ?? invalid());
          break;
        }
      }
    }
  }
}

/** A Function Value's captures as the Map a save holds. */
const captureMap = (pairs: readonly (readonly [string, Value])[]) =>
  map(pairs.map(([k, v]) => [k, v]));

const decimal = (w: SaveWriter, d: import('./values').Decimal) => {
  const p = decimalParts(d);
  w.bool(p.negative).wideUint(p.coefficient).sint(p.exponent);
};

const instant = (w: SaveWriter, us: bigint) => {
  let seconds = us / 1_000_000n;
  let micros = us % 1_000_000n;
  if (micros < 0n) {
    micros += 1_000_000n;
    seconds -= 1n;
  }
  w.sint(seconds).uint(Number(micros));
};

/** A Quantity's Unit as its display form shows it after the magnitude. */
const quantityUnit = (v: Value): string => {
  const shown = v.toString();
  const n = v.asQuantityRef()!.number.toString();
  return shown.slice(n.length + 1);
};

/** What a Group's save reads from it. */
export type GroupSnapshot = {
  libraries: ReadonlyMap<string, Library>;
  name: string;
};

export const versions = {
  language: languageVersion,
  costModel: costModel.version,
};
export type SectionWriter = (w: RecordWriter<Value>) => void;

/** Frames each section in tag order, the functions section written last. */
export const encodeSections = (
  header: Parameters<typeof writeSave>[0],
  values: ValueWriter,
  bodies: Partial<Record<keyof typeof saveSections, SectionWriter>>,
): Uint8Array => {
  const sections: SaveSection[] = [];
  const written = new Map<number, Uint8Array>();
  // Every section but `functions` and `texts` adds to the texts table as it
  // is written; `functions` adds last, and `texts` holds the table.
  const texts = new TextTable();
  for (const [name, tag] of Object.entries(saveSections)) {
    const body = bodies[name as keyof typeof saveSections];
    if (!body || tag === saveSections.functions) {
      continue;
    }
    const w = new SaveWriter(texts);
    body(new RecordWriter(w, values));
    written.set(tag, w.finish());
  }
  const fw = new SaveWriter(texts);
  new RecordWriter(fw, values).functions(values.functions);
  written.set(saveSections.functions, fw.finish());
  written.set(
    saveSections.texts,
    new SaveWriter().list(texts.texts, (w, t) => w.text(t)).finish(),
  );
  for (const [, tag] of Object.entries(saveSections)) {
    const body = written.get(tag);
    if (body) {
      sections.push({ tag, body, optional: tag === saveSections.sources });
    }
  }
  return writeSave(header, sections);
};

export const operationRecord = (name: string, op: ValueOperation<unknown>) => {
  const args = op.args ?? [];
  let required = args.length;
  while (required > 0 && args[required - 1]!.k === 'optional') {
    required--;
  }
  return {
    name,
    mode: op.mode,
    required,
    args: args.length,
    command: op.command === true,
    labels: [...(op.labels ?? [])],
  };
};

export const grantRecord = (
  name: string,
  grant: Grant<unknown>,
  revoked: boolean,
  disabled: boolean,
) => ({
  name,
  declarations: canonicalJSON(grantData(grant)),
  capability: grant.capability.name,
  operations: [...grant.capability.operations]
    .filter(([op]) => grant.ops.has(op))
    .map(([op, decl]) => operationRecord(op, decl)),
  revoked,
  disabled,
});

export { readSave, invalid as invalidSave };
export type { SaveReader, SaveRecords };
