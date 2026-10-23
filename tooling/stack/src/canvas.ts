// Deterministic static graphics shared by browser and headless Session Hosts.
import {
  toValue,
  defineCapability,
  list,
  shape,
  ScriptError,
  nothing,
  readDisplay,
  type Operation,
  type Shape,
  type Value,
} from '@northtalk/ts';
import { parseRecord } from '@northtalk/ts/replay';

export const CANVAS_LIMITS = {
  dimension: 4096,
  commands: 10_000,
  text: 4096,
  coordinate: 1_000_000,
  stack: 64,
  points: 1000,
} as const;
/** A `polygon` or `polyline` argument: `[x, y]` pairs (ADR 0116). */
const pointsShape = shape.listOf(shape.listOf(shape.number));
/** Each Operation's arguments, shared by the Playground and Folio. */
export const CANVAS_SIGNATURES: Readonly<Record<string, readonly Shape[]>> = {
  size: [shape.number, shape.number],
  clear: [],
  background: [shape.text],
  fill: [shape.text],
  noFill: [],
  stroke: [shape.text],
  noStroke: [],
  strokeWidth: [shape.number],
  strokeCap: [shape.text],
  strokeJoin: [shape.text],
  point: [shape.number, shape.number],
  line: [shape.number, shape.number, shape.number, shape.number],
  triangle: Array<Shape>(6).fill(shape.number),
  rectangle: [shape.number, shape.number, shape.number, shape.number],
  roundedRectangle: Array<Shape>(5).fill(shape.number),
  ellipse: [shape.number, shape.number, shape.number, shape.number],
  circle: [shape.number, shape.number, shape.number],
  arc: Array<Shape>(6).fill(shape.number),
  text: [shape.text, shape.number, shape.number],
  textSize: [shape.number],
  push: [],
  pop: [],
  translate: [shape.number, shape.number],
  rotate: [shape.number],
  scale: [shape.number, shape.number],
  polygon: [pointsShape],
  polyline: [pointsShape],
};
const signatures = CANVAS_SIGNATURES;
/** Accepted `strokeCap` and `strokeJoin` values, as Canvas 2D names them. */
export const STROKE_CAPS = ['butt', 'round', 'square'] as const;
export const STROKE_JOINS = ['miter', 'round', 'bevel'] as const;
/** An argument in display spelling, or a list of points as pairs of them. */
export type CanvasArgument = string | string[][];
/** A successful call, its arguments in display spelling. */
export type CanvasCommand = { args: CanvasArgument[]; op: string };
const invalid = (message: string): never => {
  throw new ScriptError('invalid canvas argument', message);
};

/** Drawing arguments as Values: a Host function receives text as a string and a number as a Decimal. */
export const canvasArgumentValues = (args: readonly unknown[]): Value[] =>
  args.map(arg => toValue(arg));

/** An argument as stored in a command. */
export const canvasArgument = (value: Value): CanvasArgument =>
  value.kind === 'list'
    ? Array.from({ length: value.length }, (_, i) => {
        const point = value.index(i + 1);
        return Array.from({ length: point.length }, (_, j) =>
          point.index(j + 1).toString(),
        );
      })
    : value.toString();

/** A stored argument as the Value it was made from. */
export const canvasArgumentValue = (arg: CanvasArgument): Value =>
  typeof arg === 'string'
    ? readDisplay(arg)
    : list(...arg.map(point => list(...point.map(n => readDisplay(n)))));

const elements = (value: Value): Value[] =>
  Array.from({ length: value.length }, (_, i) => value.index(i + 1));

/** Throws a catchable `invalid canvas argument` unless `values` suit `op`. */
export const validateCanvasArguments = (op: string, values: Value[]): void => {
  const expected = signatures[op];
  if (
    !expected ||
    expected.length !== values.length ||
    values.some((v, i) => {
      const shape = expected[i]!;
      return shape.k === 'list'
        ? v.kind !== 'list'
        : v.kind !== (shape.k === 'kind' && shape.kind);
    })
  ) {
    invalid('Wrong drawing arguments');
  }
  const points =
    op === 'polygon' || op === 'polyline' ? elements(values[0]!) : [];
  if (
    (op === 'polygon' || op === 'polyline') &&
    (points.length < 2 ||
      points.length > CANVAS_LIMITS.points ||
      points.some(
        p =>
          p.kind !== 'list' ||
          p.length !== 2 ||
          elements(p).some(n => n.kind !== 'number'),
      ))
  ) {
    invalid(
      `Points are a list of 2 to ${CANVAS_LIMITS.points} [x, y] number pairs`,
    );
  }
  [...values, ...points.flatMap(elements)].forEach(value => {
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
  if (['rectangle', 'roundedRectangle', 'ellipse', 'arc'].includes(op)) {
    positive(2);
    positive(3);
  }
  if (op === 'circle') {
    positive(2);
  }
  if (op === 'roundedRectangle' && Number(values[4]!.toString()) < 0) {
    invalid('Corner radius must not be negative');
  }
  if (
    op === 'strokeCap' &&
    !(STROKE_CAPS as readonly string[]).includes(values[0]!.asText()!)
  ) {
    invalid('Stroke caps are "butt", "round" or "square"');
  }
  if (
    op === 'strokeJoin' &&
    !(STROKE_JOINS as readonly string[]).includes(values[0]!.asText()!)
  ) {
    invalid('Stroke joins are "miter", "round" or "bevel"');
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

/**
 * The `push` depth after `op`, or a catchable `invalid canvas argument` for
 * an unmatched `pop` or a `push` past the limit. `size`, `clear` and
 * `background` reset the transform and empty the stack (ADR 0116).
 */
export const canvasStackDepth = (op: string, depth: number): number => {
  if (op === 'size' || op === 'clear' || op === 'background') {
    return 0;
  }
  if (op === 'pop') {
    return depth > 0 ? depth - 1 : invalid('pop needs a matching push');
  }
  if (op === 'push') {
    return depth < CANVAS_LIMITS.stack
      ? depth + 1
      : invalid(`push nests at most ${CANVAS_LIMITS.stack} deep`);
  }
  return depth;
};

/** Each Host receives independent counters. No browser APIs or external effects. */
export const canvasCapabilities = () => {
  let count = 0;
  let depth = 0;
  const operations: Record<string, Operation<unknown>> = {};
  for (const [op, args] of Object.entries(signatures)) {
    operations[op] = {
      mode: 'immediate',
      args: [...args],
      result: shape.nothing,
      cost: { fuel: 1 },
      errors: [{ code: 'invalid canvas argument' }, { code: 'canvas limit' }],
      do: (_call, ...values) => {
        validateCanvasArguments(op, canvasArgumentValues(values));
        const next = canvasStackDepth(op, depth);
        if (count >= CANVAS_LIMITS.commands) {
          throw new ScriptError(
            'canvas limit',
            'A canvas session is limited to 10000 drawing operations; run fresh to continue',
          );
        }
        count++;
        depth = next;
        return nothing;
      },
    };
  }
  return [defineCapability<unknown>()('canvas', operations)];
};

/** Why stored data is not a valid command, or undefined when it is. */
export const canvasCommandProblem = (value: unknown): string | undefined => {
  const command = value as Partial<CanvasCommand> | null;
  if (
    !command ||
    typeof command !== 'object' ||
    typeof command.op !== 'string' ||
    !Object.hasOwn(signatures, command.op) ||
    !Array.isArray(command.args) ||
    !command.args.every(
      arg =>
        typeof arg === 'string' ||
        (Array.isArray(arg) &&
          arg.every(
            point =>
              Array.isArray(point) && point.every(n => typeof n === 'string'),
          )),
    )
  ) {
    return 'expected a drawing command {op, args}';
  }
  try {
    validateCanvasArguments(
      command.op,
      command.args.map(arg => canvasArgumentValue(arg)),
    );
  } catch (error) {
    return error instanceof ScriptError ? error.message : String(error);
  }
  return undefined;
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
    validateCanvasArguments(op, values);
    commands.push({ op, args: values.map(canvasArgument) });
    if (commands.length === CANVAS_LIMITS.commands) {
      break;
    }
  }
  return commands;
};

/**
 * Paints one shape command with the current fill and stroke, from its stored
 * arguments. `stroke` is false when stroking is off or the
 * stroke width is zero. Returns false for a command that is not a shape.
 */
export const paintCanvasShape = (
  context: CanvasRenderingContext2D,
  op: string,
  args: readonly (string | readonly (readonly string[])[])[],
  fill: boolean,
  stroke: boolean,
): boolean => {
  const n = (i: number) => Number(args[i]);
  context.beginPath();
  switch (op) {
    case 'point':
      // A point is a dot in the stroke colour, as wide as the stroke.
      if (stroke) {
        context.save();
        context.fillStyle = context.strokeStyle;
        context.arc(n(0), n(1), context.lineWidth / 2, 0, 2 * Math.PI);
        context.fill();
        context.restore();
      }
      return true;
    case 'line':
      context.moveTo(n(0), n(1));
      context.lineTo(n(2), n(3));
      if (stroke) {
        context.stroke();
      }
      return true;
    case 'arc':
      // Filled as a pie slice; only the curve is stroked.
      if (fill) {
        context.moveTo(n(0), n(1));
        context.ellipse(n(0), n(1), n(2) / 2, n(3) / 2, 0, n(4), n(5));
        context.closePath();
        context.fill();
      }
      if (stroke) {
        context.beginPath();
        context.ellipse(n(0), n(1), n(2) / 2, n(3) / 2, 0, n(4), n(5));
        context.stroke();
      }
      return true;
    case 'triangle':
      context.moveTo(n(0), n(1));
      context.lineTo(n(2), n(3));
      context.lineTo(n(4), n(5));
      context.closePath();
      break;
    case 'rectangle':
      context.rect(n(0), n(1), n(2), n(3));
      break;
    case 'roundedRectangle':
      context.roundRect(n(0), n(1), n(2), n(3), n(4));
      break;
    case 'ellipse':
      context.ellipse(n(0), n(1), n(2) / 2, n(3) / 2, 0, 0, 2 * Math.PI);
      break;
    case 'circle':
      context.arc(n(0), n(1), n(2) / 2, 0, 2 * Math.PI);
      break;
    case 'polygon':
    case 'polyline':
      // An open polyline is still filled, as Canvas 2D closes it to fill.
      for (const [x, y] of args[0] as readonly (readonly string[])[]) {
        context.lineTo(Number(x), Number(y));
      }
      if (op === 'polygon') {
        context.closePath();
      }
      break;
    default:
      return false;
  }
  if (fill) {
    context.fill();
  }
  if (stroke) {
    context.stroke();
  }
  return true;
};
