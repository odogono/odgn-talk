// A prototype of chapter 8's Text Pattern programs and matcher. Not normative
// (ADR 0028): it compiles a Text Pattern's parse tree to the program chapter 8
// gives, runs it on the Pike VM chapter 8 gives, and counts its `steps`.
//
// It segments text with Intl.Segmenter and folds case with toLowerCase, so it
// can differ from a Core on text outside ASCII (the Cores use the pinned
// Unicode tables).

import type { Node } from "../grammar/parser";

export type Op =
  | { op: "char"; c: string; fold: boolean }
  | { op: "class"; k: string }
  | { op: "split"; a: number; b: number }
  | { op: "jump"; a: number }
  | { op: "save"; n: number }
  | { op: "assert"; k: string }
  | { op: "match" };

export interface Program {
  code: Op[];
  captures: string[];
}

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
export const characters = (t: string) => [...segmenter.segment(t.normalize("NFC"))].map((s) => s.segment);

const WHITE = new Set([0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
for (let c = 0x2000; c <= 0x200a; c++) WHITE.add(c);
const first = (ch: string) => ch.codePointAt(0)!;
const isWhite = (ch: string) => WHITE.has(first(ch));
const isBreak = (ch: string) => ch === "\n" || ch === "\r" || ch === "\r\n";

function inClass(k: string, ch: string): boolean {
  const s = String.fromCodePoint(first(ch));
  switch (k) {
    case "any": return true;
    case "digit": return /^[0-9]$/.test(ch);
    case "letter": return /\p{L}/u.test(s);
    case "uppercase": return /\p{Lu}/u.test(s);
    case "lowercase": return /\p{Ll}/u.test(s);
    case "punctuation": return /\p{P}/u.test(s);
    case "whitespace": return isWhite(ch);
    case "nonspace": return !isWhite(ch);
  }
  throw new Error(`class ${k}`);
}

// ---------------------------------------------------------------------------
// Compiling
// ---------------------------------------------------------------------------

const PLURAL: Record<string, string> = { characters: "any", digits: "digit", letters: "letter", words: "word", spaces: "space" };
const SINGULAR: Record<string, string> = { character: "any", digit: "digit", letter: "letter", punctuation: "punctuation", whitespace: "whitespace" };

export class PatternCompiler {
  code: Op[] = [];
  captures: string[] = [];

  constructor(private splice: (n: Node) => Node | string = () => { throw new Error("a splice needs a value"); }) {}

  emit(op: Op): number {
    this.code.push(op);
    return this.code.length - 1;
  }

  program(p: Node, fold = false): Program {
    this.seq(p.els, fold);
    this.emit({ op: "match" });
    return { code: this.code, captures: this.captures };
  }

  seq(els: Node[], fold: boolean) {
    for (const e of els) this.el(e, fold, false);
  }

  literal(t: string, fold: boolean) {
    for (const c of characters(t)) this.emit({ op: "char", c, fold });
  }

  // `e` one or more times: L: e, split L next (greedy), or split next L.
  plus(body: () => void, lazy: boolean) {
    const top = this.code.length;
    body();
    const s = this.emit({ op: "split", a: 0, b: 0 });
    const next = this.code.length;
    this.code[s] = lazy ? { op: "split", a: next, b: top } : { op: "split", a: top, b: next };
  }

  // `e` zero or more times: L: split L1 E, L1: e, jump L, E:.
  star(body: () => void, lazy: boolean) {
    const top = this.emit({ op: "split", a: 0, b: 0 });
    body();
    this.emit({ op: "jump", a: top });
    const end = this.code.length;
    this.code[top] = lazy ? { op: "split", a: end, b: top + 1 } : { op: "split", a: top + 1, b: end };
  }

  // `optional e`: split L1 E, L1: e, E:.
  opt(body: () => void, lazy: boolean) {
    const s = this.emit({ op: "split", a: 0, b: 0 });
    body();
    const end = this.code.length;
    this.code[s] = lazy ? { op: "split", a: end, b: s + 1 } : { op: "split", a: s + 1, b: end };
  }

  word(lazy: boolean) {
    this.plus(() => this.emit({ op: "class", k: "nonspace" }), lazy);
  }

  // One of a keyword's singular element.
  one(k: string) {
    if (k === "space") this.emit({ op: "char", c: " ", fold: false });
    else if (k === "word") this.word(false);
    else this.emit({ op: "class", k });
  }

  el(e: Node, fold: boolean, lazy: boolean) {
    switch (e.k) {
      case "Text": return this.literal(e.v, fold);
      case "Group": return this.seq(e.els, fold);
      case "ignoring case": return this.el(e.e, true, lazy);
      case "lazily": return this.el(e.e, fold, true);
      case "as": return this.el(e.e, fold, lazy);
      case "Capture": {
        const i = this.captures.length;
        this.captures.push(e.name);
        this.emit({ op: "save", n: 2 * i });
        this.el(e.e, fold, lazy);
        this.emit({ op: "save", n: 2 * i + 1 });
        return;
      }
      case "Anchor": return void this.emit({ op: "assert", k: e.v });
      case "Class": {
        const [c, n] = e.v.split(" ");
        const k = c === "uppercase" ? "uppercase" : "lowercase";
        if (n === "letters") return this.plus(() => this.emit({ op: "class", k }), lazy);
        return void this.emit({ op: "class", k });
      }
      case "Keyword": {
        if (e.v === "text") return this.star(() => this.emit({ op: "class", k: "any" }), lazy);
        if (e.v === "word") return this.word(lazy);
        if (e.v === "space") return void this.emit({ op: "char", c: " ", fold: false });
        if (e.v === "words") {
          this.word(lazy);
          this.star(() => {
            this.plus(() => this.emit({ op: "class", k: "whitespace" }), lazy);
            this.word(lazy);
          }, lazy);
          return;
        }
        if (PLURAL[e.v]) return this.plus(() => this.one(PLURAL[e.v]!), lazy);
        return void this.emit({ op: "class", k: SINGULAR[e.v]! });
      }
      case "Count": {
        const n = Number(e.n);
        const inner: Node = e.e.k === "Keyword" && PLURAL[e.e.v] ? { k: "Singular", v: PLURAL[e.e.v] } : e.e;
        for (let i = 0; i < n; i++) {
          if (inner.k === "Singular" && inner.v === "word" && i > 0) this.plus(() => this.emit({ op: "class", k: "whitespace" }), lazy);
          if (inner.k === "Singular") this.one(inner.v);
          else this.el(inner, fold, lazy);
        }
        return;
      }
      case "one or more of": return this.plus(() => this.el(e.e, fold, false), lazy);
      case "zero or more of": return this.star(() => this.el(e.e, fold, false), lazy);
      case "optional": return this.opt(() => this.el(e.e, fold, false), lazy);
      case "or": {
        // split La Lb, La: a, jump E, Lb: b, E:
        const s = this.emit({ op: "split", a: 0, b: 0 });
        this.el(e.l, fold, false);
        const j = this.emit({ op: "jump", a: 0 });
        const lb = this.code.length;
        this.el(e.r, fold, false);
        this.code[s] = { op: "split", a: s + 1, b: lb };
        this.code[j] = { op: "jump", a: this.code.length };
        return;
      }
      case "Typed":
        // `a number`: optional "-", digits, optional <".", digits>
        this.opt(() => this.emit({ op: "char", c: "-", fold: false }), false);
        this.plus(() => this.emit({ op: "class", k: "digit" }), false);
        this.opt(() => {
          this.emit({ op: "char", c: ".", fold: false });
          this.plus(() => this.emit({ op: "class", k: "digit" }), false);
        }, false);
        return;
      case "Splice": {
        const v = this.splice(e.e);
        if (typeof v === "string") return this.literal(v, fold);
        return this.seq(v.els, fold);
      }
    }
    throw new Error(`pattern element ${e.k}`);
  }
}

export function show(p: Program): string {
  return p.code.map((o, i) => {
    const pc = String(i).padStart(3, "0");
    switch (o.op) {
      case "char": return `${pc} char ${JSON.stringify(o.c)}${o.fold ? " fold" : ""}`;
      case "class": return `${pc} class ${o.k}`;
      case "split": return `${pc} split ${String(o.a).padStart(3, "0")} ${String(o.b).padStart(3, "0")}`;
      case "jump": return `${pc} jump ${String(o.a).padStart(3, "0")}`;
      case "save": return `${pc} save ${o.n}`;
      case "assert": return `${pc} assert ${o.k}`;
      case "match": return `${pc} match`;
    }
  }).join("\n");
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface Result {
  match: { start: number; end: number; caps: (number | null)[] } | null;
  steps: number;
}

type Mode = "whole" | "search" | "prefix" | "suffix";

const fold = (s: string) => [...s].map((c) => c.toLowerCase()).join("");

function holds(k: string, cs: string[], p: number): boolean {
  const n = cs.length;
  switch (k) {
    case "text start": return p === 0;
    case "text end": return p === n;
    case "line start": return p === 0 || isBreak(cs[p - 1]!);
    case "line end": return p === n || isBreak(cs[p]!);
    case "word break": {
      const left = p > 0 && !isWhite(cs[p - 1]!);
      const right = p < n && !isWhite(cs[p]!);
      return left !== right;
    }
  }
  throw new Error(`anchor ${k}`);
}

// Runs a program over the Characters `cs` from position `from`. `whole`
// accepts a match only at the end, and seeds only at `from`; `search` seeds at
// every position until a match; `prefix` seeds only at `from`; `suffix`
// accepts only at the end. `first` stops at the first match reached, for a
// test that only needs to know one exists.
export function run(p: Program, cs: string[], from: number, mode: Mode, first = false): Result {
  const n = cs.length;
  const slots = p.captures.length * 2;
  type Thread = { pc: number; caps: (number | null)[] };
  let steps = 0;
  let matched: Result["match"] = null;
  let clist: Thread[] = [];
  let seen = new Set<number>();
  const add = (list: Thread[], pc: number, caps: (number | null)[], pos: number, start: number) => {
    if (seen.has(pc)) return;
    seen.add(pc);
    const o = p.code[pc]!;
    switch (o.op) {
      case "jump": return add(list, o.a, caps, pos, start);
      case "split":
        add(list, o.a, caps, pos, start);
        add(list, o.b, caps, pos, start);
        return;
      case "save": {
        const c = caps.slice();
        c[o.n] = pos;
        return add(list, pc + 1, c, pos, start);
      }
      case "assert":
        if (holds(o.k, cs, pos)) add(list, pc + 1, caps, pos, start);
        return;
      default:
        list.push({ pc, caps: [...caps, start] });
    }
  };
  for (let pos = from; pos <= n; pos++) {
    const seeding = mode === "search" || mode === "suffix" ? !matched : pos === from;
    if (seeding) add(clist, 0, Array(slots).fill(null), pos, pos);
    steps += clist.length;
    const nlist: Thread[] = [];
    seen = new Set();
    for (const t of clist) {
      const o = p.code[t.pc]!;
      const start = t.caps[slots]!;
      const caps = t.caps.slice(0, slots);
      if (o.op === "match") {
        if ((mode === "whole" || mode === "suffix") && pos !== n) continue;
        matched = { start, end: pos, caps };
        if (first) return { match: matched, steps };
        break; // cut the threads it prefers less
      }
      if (pos === n) continue;
      const ch = cs[pos]!;
      const ok = o.op === "char" ? (o.fold ? fold(o.c) === fold(ch) : o.c === ch) : o.op === "class" ? inClass(o.k, ch) : false;
      if (ok) add(nlist, t.pc + 1, caps, pos + 1, start);
    }
    clist = nlist;
    if (!clist.length && (matched || !(mode === "search" || mode === "suffix"))) break;
  }
  return { match: matched, steps };
}

// The Match Search: successive searches, skipping an empty match where the
// last match ended.
export function matchAll(p: Program, cs: string[]): { matches: NonNullable<Result["match"]>[]; steps: number } {
  const out: NonNullable<Result["match"]>[] = [];
  let steps = 0;
  let from = 0;
  let lastEnd = -1;
  while (from <= cs.length) {
    const r = run(p, cs, from, "search");
    steps += r.steps;
    if (!r.match) break;
    if (r.match.start === r.match.end && r.match.start === lastEnd) {
      from = r.match.start + 1;
      lastEnd = -1;
      continue;
    }
    out.push(r.match);
    lastEnd = r.match.end;
    from = r.match.end;
  }
  return { matches: out, steps };
}
