// Chapter 8's Text Pattern programs and their Pike VM. The program and the way
// the thread list evolves are normative, since matching Fuel counts `steps`.
import { numberText, patternSource } from './canonical';
import { characters } from './text';
import {
  generalCategory,
  isWhiteSpace,
  normalizeNFC,
  simpleFold,
} from './unicode';
import type { PatternElement } from './view';

export type Op =
  | { c: string; fold: string | null; op: 'char' }
  | { k: ClassName; op: 'class' }
  | { a: number; b: number; op: 'split' }
  | { a: number; op: 'jump' }
  | { n: number; op: 'save' }
  | { k: string; op: 'assert' }
  | { op: 'match' };
type ClassName =
  | 'any'
  | 'digit'
  | 'letter'
  | 'uppercase'
  | 'lowercase'
  | 'punctuation'
  | 'whitespace'
  | 'nonspace';

/** A compiled Text Pattern: its program, and each Capture with its conversion. */
export type Program = {
  captures: { name: string; number: boolean }[];
  code: Op[];
};

/** A Text Pattern value's contents: its elements, canonical source and program. */
export type PatternData = {
  els: readonly PatternElement[];
  program: Program;
  source: string;
};

export class PatternError extends Error {
  override name = 'PatternError';
}

const plural: Record<string, string> = {
  characters: 'character',
  digits: 'digit',
  letters: 'letter',
  spaces: 'space',
  words: 'word',
  'uppercase letters': 'uppercase letter',
  'lowercase letters': 'lowercase letter',
};
const classOf: Record<string, ClassName> = {
  character: 'any',
  digit: 'digit',
  letter: 'letter',
  punctuation: 'punctuation',
  whitespace: 'whitespace',
  'uppercase letter': 'uppercase',
  'lowercase letter': 'lowercase',
};

/**
 * Compile resolved elements (no splices) to a program. `fold` is the
 * use-site `ignoring case`, which applies to every text literal.
 */
export const compile = (
  els: readonly PatternElement[],
  fold = false,
): Program => {
  const code: Op[] = [];
  const captures: Program['captures'] = [];
  const emit = (op: Op) => code.push(op) - 1;
  const literal = (text: string, folding: boolean) => {
    for (const c of characters(normalizeNFC(text))) {
      emit({ op: 'char', c, fold: folding ? simpleFold(c) : null });
    }
  };
  // Repetitions take their body as a callback, and their laziness swaps the
  // targets of the split they make.
  const plus = (body: () => void, lazy: boolean) => {
    const top = code.length;
    body();
    const split = emit({ op: 'split', a: 0, b: 0 });
    const next = code.length;
    code[split] = lazy
      ? { op: 'split', a: next, b: top }
      : { op: 'split', a: top, b: next };
  };
  const star = (body: () => void, lazy: boolean) => {
    const top = emit({ op: 'split', a: 0, b: 0 });
    body();
    emit({ op: 'jump', a: top });
    const end = code.length;
    code[top] = lazy
      ? { op: 'split', a: end, b: top + 1 }
      : { op: 'split', a: top + 1, b: end };
  };
  const optional = (body: () => void, lazy: boolean) => {
    const split = emit({ op: 'split', a: 0, b: 0 });
    body();
    const end = code.length;
    code[split] = lazy
      ? { op: 'split', a: end, b: split + 1 }
      : { op: 'split', a: split + 1, b: end };
  };
  const word = (lazy: boolean) =>
    plus(() => emit({ op: 'class', k: 'nonspace' }), lazy);
  // One of a singular keyword or class.
  const singular = (w: string, lazy: boolean) => {
    if (w === 'space') {
      emit({ op: 'char', c: ' ', fold: null });
    } else if (w === 'word') {
      word(lazy);
    } else {
      emit({ op: 'class', k: classOf[w]! });
    }
  };
  // The elements nest, so they compile from an explicit stack of steps.
  type Step =
    (() => void) | { e: PatternElement; fold: boolean; lazy: boolean };
  const work: Step[] = [];
  const run = (steps: Step[]) => {
    for (let i = steps.length - 1; i >= 0; i--) {
      work.push(steps[i]!);
    }
  };
  // Repetition bodies are compiled where they are emitted, so they need a
  // nested drain of the stack; each nesting level drains its own part.
  const drain = (until: number) => {
    while (work.length > until) {
      const step = work.pop()!;
      if (typeof step === 'function') {
        step();
      } else {
        element(step.e, step.fold, step.lazy);
      }
    }
  };
  const nested = (e: PatternElement, f: boolean, lazy: boolean) => () => {
    const base = work.length;
    work.push({ e, fold: f, lazy });
    drain(base);
  };
  const element = (e: PatternElement, f: boolean, lazy: boolean) => {
    switch (e.k) {
      case 'text':
        return literal(e.value, f);
      case 'group':
        return run(e.els.map(x => ({ e: x, fold: f, lazy: false })));
      case 'splice':
        throw new PatternError('a splice must be resolved before compiling');
      case 'capture': {
        const i = captures.length;
        const inner = e.e;
        captures.push({
          name: e.name.text,
          number:
            inner.k === 'typed' ||
            (inner.k === 'suffixed' && inner.as === 'number'),
        });
        return run([
          () => emit({ op: 'save', n: 2 * i }),
          { e: inner, fold: f, lazy },
          () => emit({ op: 'save', n: 2 * i + 1 }),
        ]);
      }
      case 'words': {
        const w = e.words;
        if (w.includes(' ') && !classOf[w] && !plural[w]) {
          return void emit({ op: 'assert', k: w });
        }
        if (w === 'text') {
          return star(() => emit({ op: 'class', k: 'any' }), lazy);
        }
        if (w === 'word') {
          return word(lazy);
        }
        if (w === 'words') {
          word(lazy);
          return star(() => {
            plus(() => emit({ op: 'class', k: 'whitespace' }), lazy);
            word(lazy);
          }, lazy);
        }
        if (plural[w]) {
          return plus(() => singular(plural[w]!, lazy), lazy);
        }
        return singular(w, lazy);
      }
      case 'typed':
        optional(() => emit({ op: 'char', c: '-', fold: null }), false);
        plus(() => emit({ op: 'class', k: 'digit' }), false);
        return optional(() => {
          emit({ op: 'char', c: '.', fold: null });
          plus(() => emit({ op: 'class', k: 'digit' }), false);
        }, false);
      case 'count': {
        const n = Number(numberText(e.n));
        const inner = e.e;
        const keyword = inner.k === 'words' ? plural[inner.words] : undefined;
        const steps: Step[] = [];
        for (let i = 0; i < n; i++) {
          if (keyword === 'word' && i > 0) {
            steps.push(() =>
              plus(() => emit({ op: 'class', k: 'whitespace' }), lazy),
            );
          }
          steps.push(
            keyword
              ? () => singular(keyword, lazy)
              : { e: inner, fold: f, lazy },
          );
        }
        return run(steps);
      }
      case 'repeat': {
        const body = nested(e.e, f, false);
        return e.phrase === 'one or more of'
          ? plus(body, lazy)
          : e.phrase === 'zero or more of'
            ? star(body, lazy)
            : optional(body, lazy);
      }
      case 'alternation': {
        // (a or b) or c: each `or` is L: split L+1 M, P, jump E, M: Q, E:.
        let left = e.options[0]!;
        for (const right of e.options.slice(1)) {
          left = { k: 'alternation', options: [left, right] };
        }
        const [p, q] =
          left.k === 'alternation' && left.options.length === 2
            ? left.options
            : [left, null];
        if (!q) {
          return element(p!, f, lazy);
        }
        const split = emit({ op: 'split', a: 0, b: 0 });
        nested(p!, f, false)();
        const jump = emit({ op: 'jump', a: 0 });
        const m = code.length;
        nested(q, f, false)();
        code[split] = { op: 'split', a: split + 1, b: m };
        code[jump] = { op: 'jump', a: code.length };
        return;
      }
      case 'suffixed':
        return run([{ e: e.e, fold: f || e.fold, lazy: e.lazily }]);
    }
  };
  run(els.map(e => ({ e, fold, lazy: false })));
  drain(0);
  emit({ op: 'match' });
  return { code, captures };
};

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const firstScalar = (ch: string) => ch.codePointAt(0)!;
const isBreak = (ch: string) => ch === '\n' || ch === '\r' || ch === '\r\n';
const white = (ch: string) => isWhiteSpace(firstScalar(ch));

const inClass = (k: ClassName, ch: string): boolean => {
  switch (k) {
    case 'any':
      return true;
    case 'digit':
      return ch.length === 1 && ch >= '0' && ch <= '9';
    case 'letter':
      return generalCategory(firstScalar(ch)).startsWith('L');
    case 'uppercase':
      return generalCategory(firstScalar(ch)) === 'Lu';
    case 'lowercase':
      return generalCategory(firstScalar(ch)) === 'Ll';
    case 'punctuation':
      return generalCategory(firstScalar(ch)).startsWith('P');
    case 'whitespace':
      return white(ch);
    case 'nonspace':
      return !white(ch);
  }
};

const holds = (k: string, cs: readonly string[], p: number): boolean => {
  switch (k) {
    case 'text start':
      return p === 0;
    case 'text end':
      return p === cs.length;
    case 'line start':
      return p === 0 || isBreak(cs[p - 1]!);
    case 'line end':
      return p === cs.length || isBreak(cs[p]!);
    case 'word break': {
      const left = p > 0 && !white(cs[p - 1]!);
      const right = p < cs.length && !white(cs[p]!);
      return left !== right;
    }
  }
  throw new PatternError(`unknown anchor ${k}`);
};

export type RunKind = 'whole' | 'search' | 'prefix' | 'suffix';
export type Found = { end: number; slots: (number | null)[]; start: number };

/**
 * One run of a program over Characters from `from` (chapter 8, Running). With
 * `first`, it stops at the first match it records.
 */
export const runProgram = (
  program: Program,
  cs: readonly string[],
  from: number,
  kind: RunKind,
  first = false,
): { found: Found | null; steps: number } => {
  const { code } = program;
  const slotCount = program.captures.length * 2;
  type Thread = { pc: number; slots: (number | null)[]; start: number };
  const seeds = kind === 'search' || kind === 'suffix';
  let steps = 0;
  let found: Found | null = null;
  let list: Thread[] = [];
  let marks = new Set<number>();
  // Adding follows jumps, splits, saves and asserts in priority order.
  const add = (into: Thread[], thread: Thread, pos: number) => {
    const pending: Thread[] = [thread];
    while (pending.length) {
      const t = pending.pop()!;
      if (marks.has(t.pc)) {
        continue;
      }
      marks.add(t.pc);
      const op = code[t.pc]!;
      switch (op.op) {
        case 'jump':
          pending.push({ ...t, pc: op.a });
          break;
        case 'split':
          pending.push({ ...t, pc: op.b }, { ...t, pc: op.a });
          break;
        case 'save': {
          const slots = t.slots.slice();
          slots[op.n] = pos;
          pending.push({ ...t, pc: t.pc + 1, slots });
          break;
        }
        case 'assert':
          if (holds(op.k, cs, pos)) {
            pending.push({ ...t, pc: t.pc + 1 });
          }
          break;
        default:
          into.push(t);
      }
    }
  };
  for (let pos = from; pos <= cs.length; pos++) {
    if (seeds ? !found : pos === from) {
      add(list, { pc: 0, slots: Array(slotCount).fill(null), start: pos }, pos);
    }
    steps += list.length;
    const next: Thread[] = [];
    marks = new Set();
    for (const t of list) {
      const op = code[t.pc]!;
      if (op.op === 'match') {
        if ((kind === 'whole' || kind === 'suffix') && pos !== cs.length) {
          continue;
        }
        found = { start: t.start, end: pos, slots: t.slots };
        if (first) {
          return { found, steps };
        }
        break;
      }
      if (pos === cs.length) {
        continue;
      }
      const ch = cs[pos]!;
      const ok =
        op.op === 'char'
          ? op.fold === null
            ? op.c === ch
            : op.fold === simpleFold(ch)
          : op.op === 'class' && inClass(op.k, ch);
      if (ok) {
        add(next, { ...t, pc: t.pc + 1 }, pos + 1);
      }
    }
    list = next;
    if (!list.length && (found || !seeds)) {
      break;
    }
  }
  return { found, steps };
};

/** The Match Search: searches one after another, skipping an empty match where the last ended. */
export const matchSearch = (
  program: Program,
  cs: readonly string[],
  limit = Infinity,
): { found: Found[]; steps: number } => {
  const found: Found[] = [];
  let steps = 0;
  let from = 0;
  let lastEnd = -1;
  while (from <= cs.length && found.length < limit) {
    const run = runProgram(program, cs, from, 'search');
    steps += run.steps;
    if (!run.found) {
      break;
    }
    const { start, end } = run.found;
    if (start === end && start === lastEnd) {
      from = start + 1;
      lastEnd = -1;
      continue;
    }
    found.push(run.found);
    lastEnd = end;
    from = end;
  }
  return { found, steps };
};

/** A Text Pattern's data from resolved elements: its program and canonical source. */
export const patternData = (els: readonly PatternElement[]): PatternData => ({
  els,
  source: patternSource({ els: [...els], pos: { line: 0, col: 0 } }),
  program: compile(els),
});

/** A text needle runs as the program of a literal of it (chapter 8). */
export const literalProgram = (needle: string, fold: boolean): Program =>
  compile([{ k: 'text', value: needle }], fold);
