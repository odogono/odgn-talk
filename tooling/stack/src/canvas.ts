// Deterministic static graphics shared by browser and headless Session Hosts.
import {
  defineCapability,
  shape,
  ScriptError,
  nothing,
  readDisplay,
  type Operation,
  type Shape,
  type Value,
} from '@odgn/northtalk';
import { parseRecord } from '@odgn/northtalk/replay';

export const CANVAS_LIMITS = {
  dimension: 4096,
  commands: 10_000,
  text: 4096,
  coordinate: 1_000_000,
} as const;
const signatures: Record<string, Shape[]> = {
  size: [shape.number, shape.number],
  clear: [],
  background: [shape.text],
  fill: [shape.text],
  noFill: [],
  stroke: [shape.text],
  noStroke: [],
  strokeWidth: [shape.number],
  line: [shape.number, shape.number, shape.number, shape.number],
  rectangle: [shape.number, shape.number, shape.number, shape.number],
  ellipse: [shape.number, shape.number, shape.number, shape.number],
  text: [shape.text, shape.number, shape.number],
  textSize: [shape.number],
};
export type CanvasCommand = { args: string[]; op: string };
const invalid = (message: string): never => {
  throw new ScriptError('invalid canvas argument', message);
};

const validateArguments = (op: string, values: Value[]) => {
  const expected = signatures[op];
  if (
    !expected ||
    expected.length !== values.length ||
    values.some((v, i) => {
      const shape = expected[i]!;
      return shape.k !== 'kind' || v.kind !== shape.kind;
    })
  ) {
    invalid('Wrong drawing arguments');
  }
  values.forEach(value => {
    if (
      value.kind === 'number' &&
      (!Number.isFinite(Number(value.toString())) ||
        Math.abs(Number(value.toString())) > CANVAS_LIMITS.coordinate)
    ) {
      invalid('Coordinates must be finite and within ±1000000');
    }
  });
  if (
    ['fill', 'stroke', 'background'].includes(op) &&
    !/^#(?:[\da-f]{6}|[\da-f]{8})$/iu.test(values[0]!.asText()!)
  ) {
    invalid('Colors use #RRGGBB or #RRGGBBAA');
  }
  const positive = (index: number) => {
    if (Number(values[index]!.toString()) <= 0) {
      invalid('Dimensions and text sizes must be positive');
    }
  };
  if (op === 'size') {
    for (const i of [0, 1]) {
      positive(i);
      const n = Number(values[i]!.toString());
      if (!Number.isInteger(n) || n > CANVAS_LIMITS.dimension) {
        invalid('Canvas dimensions must be integers from 1 to 4096');
      }
    }
  }
  if (op === 'rectangle' || op === 'ellipse') {
    positive(2);
    positive(3);
  }
  if (op === 'textSize') {
    positive(0);
  }
  if (op === 'strokeWidth' && Number(values[0]!.toString()) < 0) {
    invalid('Stroke width must not be negative');
  }
  if (op === 'text' && values[0]!.asText()!.length > CANVAS_LIMITS.text) {
    invalid('Text is limited to 4096 UTF-16 code units');
  }
};

/** Each Host receives independent counters. No browser APIs or external effects. */
export const canvasCapabilities = () => {
  let count = 0;
  const operations: Record<string, Operation<unknown>> = {};
  for (const [op, args] of Object.entries(signatures)) {
    operations[op] = {
      mode: 'immediate',
      args,
      result: shape.nothing,
      cost: { fuel: 1 },
      errors: [{ code: 'invalid canvas argument' }, { code: 'canvas limit' }],
      do: (_call, ...values) => {
        validateArguments(op, values);
        if (count >= CANVAS_LIMITS.commands) {
          throw new ScriptError(
            'canvas limit',
            'A canvas session is limited to 10000 drawing operations; run fresh to continue',
          );
        }
        count++;
        return nothing;
      },
    };
  }
  return [defineCapability<unknown>('canvas', operations)];
};

/** Successful typed Trace calls, not console strings. Values retain decimal spelling. */
export const canvasCommands = (
  trace: readonly string[],
  names: readonly string[],
): CanvasCommand[] => {
  const grants = new Set(names);
  const commands: CanvasCommand[] = [];
  for (const line of trace) {
    if (!line.startsWith('call ')) {
      continue;
    }
    const record = parseRecord(line);
    const target = record.fields.get('op') ?? '';
    const dot = target.lastIndexOf('.');
    const op = target.slice(dot + 1);
    if (
      !grants.has(target.slice(0, dot)) ||
      !Object.hasOwn(signatures, op) ||
      !record.fields.has('result') ||
      record.fields.has('error')
    ) {
      continue;
    }
    const args: Value = readDisplay(record.fields.get('args') ?? '[]');
    const values = Array.from({ length: args.length }, (_, i) =>
      args.index(i + 1),
    );
    validateArguments(op, values);
    commands.push({ op, args: values.map(v => v.toString()) });
    if (commands.length === CANVAS_LIMITS.commands) {
      break;
    }
  }
  return commands;
};
