#!/usr/bin/env bun
// Checks chapter 8's lowering against the instruction set.
//
//   bun tools/machine/check.ts            lower everything below and verify it
//   bun tools/machine/check.ts --dis FILE print a file's canonical disassembly
//
// It lowers the stdlib Libraries in spec/stdlib/, strictly, and the syntax
// sketch, the corpus and every `talk` block in docs/ and spec/, leniently: a
// name those don't declare is taken as a well-known object. Sources whose
// blessed load emits diagnostics have no instruction stream. Then it verifies
// every body against spec/data/machine.toml: each instruction exists, with
// the right operands, and every path through a body reaches every
// instruction with one stack depth, never underflows and ends in an
// instruction that leaves the body. Not normative (ADR 0028).

import machine from '../../spec/data/machine.toml';
import { isRejectedSource } from './rejected-sources';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parse, type Node } from '../grammar/parser';
import { CompileError, compileSource, type Instr, type Unit } from './compile';
import { characters, matchAll, PatternCompiler, run } from './pattern';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const problems: string[] = [];
const used = new Set<string>();

const SPEC = new Map<string, any>(
  machine.instruction.map((i: any) => [i.name, i]),
);
const LEAVES = new Set([
  'jump',
  'return',
  'clause-fail',
  'throw',
  'rethrow',
  'raise',
  'end-cleanup',
  'veto',
  'pass',
]);

const files = (dir: string, ext: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap(f => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) {
        return files(p, ext);
      }
      return p.endsWith(ext) ? [p] : [];
    });

// ---------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------

// The operand kinds of an instruction as emitted: an optional kind (`fold?`)
// is there only when the instruction has all its operands.
const operandKinds = (spec: any, ins: Instr): string[] | null => {
  const all: string[] = spec.operands.map((k: string) => k.replace(/\?$/, ''));
  if (ins.args.length === all.length) {
    return all;
  }
  const required = spec.operands
    .filter((k: string) => !k.endsWith('?'))
    .map((k: string) => k);
  return ins.args.length === required.length ? required : null;
};

const count = (
  unit: Unit,
  ins: Instr,
  spec: any,
  effect: number | string,
): number => {
  if (typeof effect === 'number') {
    return effect;
  }
  const [kind, plus] = effect.split(' + ');
  const at = operandKinds(spec, ins)!.indexOf(kind!);
  const v = ins.args[at];
  let n: number;
  if (kind === 'event') {
    const e = unit.events[v as number]!;
    n =
      e.branches.reduce(
        (a, b) =>
          a + (b.from ? 1 : 0) + b.captures + (b.kind === 'after' ? 1 : 0),
        0,
      ) + (e.timeout ? 1 : 0);
  } else {
    n = v as number;
  }
  return n + (plus ? Number(plus) : 0);
};

const verify = (unit: Unit, where: string) => {
  for (const b of unit.bodies) {
    const depth = new Map<number, number>();
    const work: [number, number][] = [];
    const reach = (pc: number, d: number, from: number) => {
      if (pc < b.start || pc >= b.end) {
        return void problems.push(
          `${where}: body ${b.index} (${b.name}): instruction ${from} leaves the body for ${pc}`,
        );
      }
      const had = depth.get(pc);
      if (had === undefined) {
        depth.set(pc, d);
        work.push([pc, d]);
      } else if (had !== d) {
        problems.push(
          `${where}: body ${b.index} (${b.name}): instruction ${pc} is reached with depths ${had} and ${d}`,
        );
      }
    };
    const entries = unit.unwind.filter(
      u => u.from >= b.start && u.from < b.end,
    );
    const done = new Set<(typeof entries)[number]>();
    reach(b.start, 0, b.start);
    // Walk until no path and no Unwind Table entry reaches anything new: an
    // entry's target is reached with the depth at the start of its range.
    for (;;) {
      while (work.length) {
        const [pc, d] = work.pop()!;
        const ins = unit.code[pc]!;
        const spec = SPEC.get(ins.op);
        if (!spec) {
          problems.push(`${where}: ${pc}: \`${ins.op}\` isn't in machine.toml`);
          continue;
        }
        used.add(ins.op);
        const kinds = operandKinds(spec, ins);
        if (!kinds) {
          problems.push(
            `${where}: ${pc}: \`${ins.op}\` has ${ins.args.length} operands, but machine.toml gives it ${spec.operands.join(', ')}`,
          );
          continue;
        }
        const pops = count(unit, ins, spec, spec.pops);
        const pushes = count(unit, ins, spec, spec.pushes);
        if (d < pops) {
          problems.push(
            `${where}: ${pc}: \`${ins.op}\` pops ${pops} with ${d} on the stack (line ${ins.line})`,
          );
          continue;
        }
        kinds.forEach((kind: string, i: number) => {
          if (kind === 'label') {
            reach(
              ins.args[i] as number,
              ins.op === 'jump' ? d : d - pops + (spec.jumps ?? 0),
              pc,
            );
          }
        });
        if (!LEAVES.has(ins.op)) {
          reach(pc + 1, d - pops + pushes, pc);
        }
      }
      const next = entries.find(u => !done.has(u) && depth.has(u.from));
      if (!next) {
        break;
      }
      done.add(next);
      // The lowering gives each entry its depth statically: check it.
      if (depth.get(next.from) !== next.depth) {
        problems.push(
          `${where}: body ${b.index} (${b.name}): the ${next.kind} entry at ${next.from} has depth ${next.depth}, but the stack there is ${depth.get(next.from)}`,
        );
      }
      reach(
        next.target,
        next.kind === 'catch' ? next.depth + 1 : next.depth,
        next.from,
      );
    }
    if (b.end > b.start && !LEAVES.has(unit.code[b.end - 1]!.op)) {
      problems.push(
        `${where}: body ${b.index} (${b.name}) can run off its end`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// The canonical disassembly (chapter 8)
// ---------------------------------------------------------------------------

const pad = (n: number, w = 4) => String(n).padStart(w, '0');

export const disassemble = (unit: Unit): string => {
  const out: string[] = [`unit ${unit.name} ${unit.kind}`];
  if (unit.constants.length) {
    out.push('constants');
    unit.constants.forEach((c, i) => out.push(`  ${i} ${c}`));
  }
  if (unit.definitions.length) {
    out.push('definitions');
    unit.definitions.forEach((c, i) => out.push(`  ${i} ${c}`));
  }
  if (unit.variables.length) {
    out.push('variables');
    unit.variables.forEach((c, i) => out.push(`  ${i} ${c}`));
  }
  if (unit.objects.length) {
    out.push('objects');
    unit.objects.forEach((c, i) => out.push(`  ${i} ${c}`));
  }
  out.push('bodies');
  for (const b of unit.bodies) {
    const head = [`  ${b.index} ${b.kind} ${b.name}`];
    if (b.clause) {
      head.push(`clause ${b.clause}`);
    }
    head.push(
      `(${b.params.map((p, i) => (b.defaults[i] !== null && b.defaults[i] !== undefined ? `${p} = ${b.defaults[i]}` : p)).join(', ')})`,
    );
    if (b.captures) {
      head.push(`captures ${b.captures}`);
    }
    head.push(`locals ${b.locals.length}`);
    if (b.maySuspend) {
      head.push('may suspend');
    }
    head.push(`${pad(b.start)}..${pad(b.end - 1)}`);
    out.push(head.join(' '));
  }
  out.push('code');
  let body = 0;
  unit.code.forEach((ins, pc) => {
    while (unit.bodies[body] && unit.bodies[body]!.end <= pc) {
      body++;
    }
    const spec = SPEC.get(ins.op);
    const kinds = spec ? (operandKinds(spec, ins) ?? []) : [];
    const shown = ins.args.map((a, i) =>
      kinds[i] === 'label' ? pad(a as number) : String(a),
    );
    const b = unit.bodies[body]!;
    const notes = [...ins.notes];
    if (ins.op === 'load' || ins.op === 'store') {
      notes.splice(0, notes.length, b.locals[ins.args[0] as number] ?? '');
    }
    if (ins.op === 'move') {
      notes.splice(
        0,
        notes.length,
        `${b.locals[ins.args[0] as number]} → ${b.locals[ins.args[1] as number]}`,
      );
    }
    const text = [ins.op, ...shown].join(' ');
    out.push(
      `  ${pad(pc)} ${`${ins.line}:${ins.col}`.padEnd(7)} ${notes.length && notes[0] ? `${text.padEnd(28)} ; ${notes.join(' ')}` : text}`,
    );
  });
  if (unit.unwind.length) {
    out.push('unwind');
    for (const u of unit.unwind) {
      out.push(
        `  ${pad(u.from)}..${pad(u.to - 1)} ${u.kind} -> ${pad(u.target)} depth ${u.depth}`,
      );
    }
  }
  if (unit.events.length) {
    out.push('events');
    for (const e of unit.events) {
      const parts = e.branches.map(b =>
        b.kind === 'after'
          ? 'after'
          : `when ${b.message}${b.from ? ' from' : ''}${b.body !== null ? ` body ${b.body}` : ''}${b.captures ? ` captures ${b.captures}` : ''}${b.binds.length ? ` binds ${b.binds.join(', ')}` : ''}`,
      );
      out.push(`  ${e.index} ${parts.join('; ')}${e.timeout ? '; or' : ''}`);
    }
  }
  return out.join('\n') + '\n';
};

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const STDLIB = join(ROOT, 'spec/stdlib');
const libraries = new Map<string, Node[]>();
for (const f of files(STDLIB, '.talk')) {
  libraries.set(basename(f, '.talk'), parse(readFileSync(f, 'utf8')).ast ?? []);
}

// Every Text Pattern in a source compiles to a program (chapter 8). A splice
// is compiled as the empty text, since its value is only known at run time.
let patterns = 0;
const compilePatterns = (src: string, where: string) => {
  const { ast } = parse(src);
  const walk = (x: any) => {
    if (!x || typeof x !== 'object') {
      return;
    }
    if (Array.isArray(x)) {
      return x.forEach(walk);
    }
    if (x.k === 'TextPattern') {
      try {
        new PatternCompiler(() => '').program(x);
        patterns++;
      } catch (error) {
        problems.push(
          `${where}:${x.line}:${x.col}: the pattern doesn't compile: ${(error as Error).message}`,
        );
      }
    }
    for (const [k, v] of Object.entries(x)) {
      if (k !== 'k') {
        walk(v);
      }
    }
  };
  walk(ast);
};

const lower = (
  src: string,
  name: string,
  kind: 'script' | 'library',
  where: string,
  lenient: boolean,
  lineOffset = 0,
): Unit | null => {
  compilePatterns(src, where);
  try {
    const unit = compileSource(name, kind, src, { libraries, lenient });
    verify(unit, where);
    return unit;
  } catch (error) {
    if (error instanceof CompileError) {
      problems.push(
        `${where}:${error.line + lineOffset}:${error.col}: ${error.message}`,
      );
    } else {
      problems.push(`${where}: ${(error as Error).stack}`);
    }
    return null;
  }
};

const disAt = args.indexOf('--dis');
if (disAt >= 0) {
  const file = args[disAt + 1]!;
  const isLib = resolve(file).startsWith(STDLIB);
  const unit = lower(
    readFileSync(file, 'utf8'),
    basename(file, '.talk'),
    isLib ? 'library' : 'script',
    file,
    !isLib,
  );
  if (unit) {
    process.stdout.write(disassemble(unit));
  }
  for (const p of problems) {
    console.error(`✗ ${p}`);
  }
  process.exit(problems.length ? 1 : 0);
}

for (const f of files(STDLIB, '.talk')) {
  lower(
    readFileSync(f, 'utf8'),
    basename(f, '.talk'),
    'library',
    relative(ROOT, f),
    false,
  );
}
for (const f of files(join(ROOT, 'tools/grammar/sketch'), '.talk')) {
  lower(
    readFileSync(f, 'utf8'),
    basename(f, '.talk'),
    'script',
    relative(ROOT, f),
    true,
  );
}
lower(
  readFileSync(join(import.meta.dir, 'lowering.talk'), 'utf8'),
  'lowering',
  'script',
  'tools/machine/lowering.talk',
  true,
);
for (const f of files(join(ROOT, 'corpus'), '.talk')) {
  if (isRejectedSource(f)) {
    continue;
  }
  lower(
    readFileSync(f, 'utf8'),
    basename(f, '.talk'),
    'script',
    relative(ROOT, f),
    true,
  );
}
const DECLARATION = /^(on|function|private|use|constant|script\s+variable)\b/;
for (const dir of ['docs', 'spec']) {
  for (const f of files(join(ROOT, dir), '.md')) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/^((?:> ?)?)```talk\n([\S\s]*?)^\1```/gm)) {
      const line = text.slice(0, m.index).split('\n').length;
      const prefix = m[1]!;
      const body = m[2]!
        .split('\n')
        .map(l =>
          l.startsWith(prefix) ? l.slice(prefix.length) : l.replace(/^>$/, ''),
        )
        .join('\n');
      const first =
        body
          .split('\n')
          .map(l => l.trim())
          .find(l => l && !l.startsWith('--')) ?? '';
      const src = DECLARATION.test(first)
        ? body
        : `on example\n${body}end example\n`;
      lower(
        src,
        'example',
        'script',
        relative(ROOT, f),
        true,
        DECLARATION.test(first) ? line : line - 1,
      );
    }
  }
}

// Runs whose matches and steps chapter 8's rules fix. The steps are the
// seed corpus's to confirm, once a Core exists.
const RUNS: [
  string,
  string,
  'whole' | 'search' | 'prefix' | 'suffix' | 'all',
  string,
  number,
][] = [
  [`<"$", digits>`, '$895', 'search', '$895', 10],
  [`<"$", digits lazily>`, '$895', 'search', '$8', 6],
  [`<"a" or "ab">`, 'ab', 'search', 'a', 6],
  [`<"ab" or "a">`, 'ab', 'search', 'ab', 7],
  [`<"ID-", 4 digits>`, 'ID-0042', 'whole', 'ID-0042', 8],
  [`<3 digits>`, 'a1234b', 'search', '123', 11],
  [`<word break, "cat", word break>`, 'a cat, dog', 'search', '', 8],
  [`<text, "x">`, 'aaaxbx', 'search', 'aaaxbx', 16],
  [`<text lazily, "x">`, 'aaaxbx', 'search', 'aaax', 11],
  [`<a number>`, 'is -12.5 kg', 'search', '-12.5', 20],
  [`<"WARN">`, 'ok WARN', 'suffix', 'WARN', 12],
  [`<"ok">`, 'ok WARN', 'prefix', 'ok', 3],
  [`<digits>`, 'a1 b22 c333', 'all', '1|22|333', 21],
  [`<optional "x">`, 'ab', 'all', '||', 12],
];
for (const [src, text, mode, want, steps] of RUNS) {
  const { ast } = parse(`on t\n  put ${src} into p\nend t\n`);
  const prog = new PatternCompiler().program(ast![0]!.body[0].value);
  const cs = characters(text);
  let got: string;
  let n: number;
  if (mode === 'all') {
    const r = matchAll(prog, cs);
    got = r.matches.map(m => cs.slice(m.start, m.end).join('')).join('|');
    n = r.steps;
  } else {
    const r = run(prog, cs, 0, mode);
    got = r.match ? cs.slice(r.match.start, r.match.end).join('') : '';
    n = r.steps;
  }
  if (got !== want || n !== steps) {
    problems.push(
      `tools/machine/check.ts: ${src} on ${JSON.stringify(text)} (${mode}) gives ${JSON.stringify(got)} in ${n} steps, not ${JSON.stringify(want)} in ${steps}`,
    );
  }
}

for (const i of machine.instruction) {
  if (!used.has(i.name)) {
    problems.push(
      `machine.toml: \`${i.name}\` is never emitted by anything the check lowers`,
    );
  }
}
if (problems.length) {
  for (const p of problems) {
    console.error(`✗ ${p}`);
  }
  process.exit(1);
}
console.log(
  `✓ The lowering covers the stdlib, the sketch, the docs and the corpus, and agrees with machine.toml. ${patterns} Text Patterns compile, and ${RUNS.length} runs give their matches and steps.`,
);
