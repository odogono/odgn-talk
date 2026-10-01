// Chapter 8's code unit, and its canonical disassembly.
import { instructions } from './generated/machine';
import { textDisplay } from './canonical';
import type { PatternElement } from './view';

export type Operand = number | string;
export type Instruction = {
  col: number;
  line: number;
  op: string;
  operands: Operand[];
};
export type BodyKind = 'init' | 'function' | 'handler' | 'lambda' | 'event';
export type Body = {
  /** First body instruction after successful Handler dispatch. */
  acceptedAt?: number;
  captures: number;
  /** The slot of the first capture, for a Lambda or an event test. */
  captureStart: number;
  clause: number | null;
  deciding?: boolean;
  /** For a function, each parameter's default definition, or null. */
  defaults: (number | null)[];
  /** Local slot bound by an error Handler’s `during` suffix. */
  duringSlot?: number;
  /** One past the body's last instruction. */
  end: number;
  index: number;
  kind: BodyKind;
  /** The name of each local slot: a name, or a temp's `(slot)`. */
  locals: string[];
  maySuspend: boolean;
  name: string;
  /** Each parameter's name, or `…` for a pattern. */
  params: string[];
  start: number;
};
export type UnwindEntry = {
  depth: number;
  /** One past the range's last instruction. */
  end: number;
  kind: 'catch' | 'finally' | 'guard';
  start: number;
  target: number;
};
export type EventBranch =
  | {
      binds: number[];
      body: number | null;
      captures: number;
      from: boolean;
      kind: 'when';
      message: string;
    }
  | { kind: 'after' };
export type EventEntry = { branches: EventBranch[]; timeout: boolean };
export type CodeUnit = {
  bodies: Body[];
  code: Instruction[];
  /** Each constant's display form, in pool order. */
  constants: string[];
  definitions: string[];
  events: EventEntry[];
  kind: 'script' | 'library';
  name: string;
  objects: string[];
  /**
   * The elements of each Text Pattern constant, by its pool index, for the
   * machine that runs the unit; a template's splices stay in place.
   */
  patterns: Map<number, readonly PatternElement[]>;
  unwind: UnwindEntry[];
  variables: string[];
};

type Spec = (typeof instructions)[number];
export const instructionSpec = new Map<string, Spec>(
  instructions.map(spec => [spec.name, spec]),
);

/** The operand kinds an instruction has, its optional `fold` only when present. */
export const operandKinds = (ins: Instruction): readonly string[] => {
  const spec = instructionSpec.get(ins.op);
  if (!spec) {
    throw new Error(`\`${ins.op}\` isn't an instruction`);
  }
  const all = spec.operands.map(kind => kind.replace(/\?$/, ''));
  if (ins.operands.length === all.length) {
    return all;
  }
  const required = spec.operands.filter(kind => !kind.endsWith('?'));
  if (ins.operands.length !== required.length) {
    throw new Error(`\`${ins.op}\` has ${ins.operands.length} operands`);
  }
  return required;
};

const pad = (n: number) => String(n).padStart(4, '0');

/** Chapter 8's canonical disassembly: LF line ends, ending with one. */
export const disassemble = (unit: CodeUnit): string => {
  const out = [`unit ${unit.name} ${unit.kind}`];
  const section = (
    heading: string,
    rows: readonly string[],
    numbered = true,
  ) => {
    if (rows.length) {
      out.push(
        heading,
        ...rows.map((row, i) => (numbered ? `  ${i} ${row}` : `  ${row}`)),
      );
    }
  };
  section('constants', unit.constants);
  section('definitions', unit.definitions);
  section('variables', unit.variables);
  section('objects', unit.objects);
  out.push('bodies');
  for (const body of unit.bodies) {
    const params = body.params.map((param, i) => {
      const definition = body.defaults[i];
      return definition === null || definition === undefined
        ? param
        : `${param} = ${definition}`;
    });
    out.push(
      [
        `  ${body.index} ${body.kind} ${body.name}`,
        ...(body.clause === null ? [] : [`clause ${body.clause}`]),
        `(${params.join(', ')})`,
        ...(body.captures ? [`captures ${body.captures}`] : []),
        `locals ${body.locals.length}`,
        ...(body.maySuspend ? ['may suspend'] : []),
        `${pad(body.start)}..${pad(body.end - 1)}`,
      ].join(' '),
    );
  }
  out.push('code');
  let b = 0;
  unit.code.forEach((ins, pc) => {
    while (unit.bodies[b]!.end <= pc) {
      b++;
    }
    const body = unit.bodies[b]!;
    const kinds = operandKinds(ins);
    const notes: string[] = [];
    const shown = ins.operands.map((operand, i) => {
      switch (kinds[i]) {
        case 'label':
          return pad(operand as number);
        case 'key':
          return textDisplay(operand as string);
        case 'definition':
          return unit.definitions[operand as number]!;
        case 'object':
          return unit.objects[operand as number]!;
        case 'constant':
          notes.push(unit.constants[operand as number]!);
          break;
        case 'local':
          notes.push(body.locals[operand as number]!);
          break;
        case 'variable':
          notes.push(unit.variables[operand as number]!);
          break;
        case 'body':
          notes.push(unit.bodies[operand as number]!.name);
          break;
      }
      return String(operand);
    });
    const text = [ins.op, ...shown].join(' ');
    out.push(
      `  ${pad(pc)} ${ins.line}:${ins.col} ${text}${notes.length ? ` ; ${notes.join(', ')}` : ''}`,
    );
  });
  section(
    'unwind',
    unit.unwind.map(
      entry =>
        `${pad(entry.start)}..${pad(entry.end - 1)} ${entry.kind} -> ${pad(entry.target)} depth ${entry.depth}`,
    ),
    false,
  );
  section(
    'events',
    unit.events.map(entry =>
      [
        ...entry.branches.map(branch =>
          branch.kind === 'after'
            ? 'after'
            : [
                `when ${branch.message}`,
                ...(branch.from ? ['from'] : []),
                ...(branch.body === null ? [] : [`body ${branch.body}`]),
                ...(branch.captures ? [`captures ${branch.captures}`] : []),
                ...(branch.binds.length
                  ? [`binds ${branch.binds.join(', ')}`]
                  : []),
              ].join(' '),
        ),
        ...(entry.timeout ? ['or'] : []),
      ].join('; '),
    ),
  );
  return `${out.join('\n')}\n`;
};
