#!/usr/bin/env bun
// Checks the Conformance Corpus's cases against chapter 11's formats.
//
//   bun tools/corpus/check.ts          check every case under corpus/
//   bun tools/corpus/check.ts DIR …    check only the cases under DIR
//
// For each Trace Case it reads case.toml against corpus.toml's [[setup]] keys
// and limits.toml's `ts` names, and checks that each file it names exists.
// Then it reads case.trace line by line: each record must be one corpus.toml
// lists, with its ids and then its keys in order, a key that isn't optional
// written, and each value readable as its key's type says, the display form
// included. A Host Input may leave out its ids and the keys marked `filled`.
// It checks the Trace ends with `> vars` and a `vars` record for each Script
// loaded, in load order, leaving out a load a `diag` rejects. It doesn't run
// anything: it isn't a Core, and a case that passes it can still be wrong
// (ADR 0028).

import corpus from "../../spec/data/corpus.toml";
import limits from "../../spec/data/limits.toml";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const problems: string[] = [];

type Key = { key: string; type: string; optional?: boolean; filled?: boolean; words?: string[] };
type Rec = { name: string; input?: boolean; ids: string[]; key?: Key[] };
// A Host Input and a Core output record may share a name, as `vars` does.
const RECORDS = new Map<string, Rec>((corpus.record as Rec[]).map((r) => [`${!!r.input} ${r.name}`, r]));
const LIMITS = new Set<string>(limits.limit.map((l: any) => l.ts));

// ---------------------------------------------------------------------------
// Reading the display form
// ---------------------------------------------------------------------------

class Bad extends Error {}

// Reads one value in the display form from `s` at `i`, and returns where it
// ends. It follows trace.ebnf's display-form grammar.
class Reader {
  constructor(readonly s: string, public i = 0) {}

  fail(what: string): never {
    throw new Bad(`${what} at column ${this.i + 1}`);
  }
  peek(t: string) {
    return this.s.startsWith(t, this.i);
  }
  eat(t: string) {
    if (!this.peek(t)) this.fail(`expected ${JSON.stringify(t)}`);
    this.i += t.length;
  }
  match(re: RegExp): string | null {
    re.lastIndex = this.i;
    const m = re.exec(this.s);
    if (!m || m.index !== this.i) return null;
    this.i += m[0].length;
    return m[0];
  }

  value(): void {
    const s = this.s;
    if (this.match(/(nothing|true|false)(?![A-Za-z0-9_])/y)) return;
    if (this.peek("<<")) return this.bytes();
    if (this.peek("<function ")) return this.fn();
    if (this.peek("<object ")) return this.object();
    if (this.peek("<")) return this.pattern();
    if (this.peek("[")) return this.list(() => this.value());
    if (this.peek("{")) return this.map();
    if (this.peek('"') || /^(quote|newline|tab|fromCodePoint\()/.test(s.slice(this.i))) return this.text();
    if (/^\d{4}-\d\d-\d\d/.test(s.slice(this.i))) return this.date();
    if (/^-?\d/.test(s.slice(this.i))) {
      this.quantity();
      if (this.peek("..")) {
        this.i += 2;
        this.quantity();
      }
      return;
    }
    this.fail("expected a value");
  }

  number() {
    const n = this.match(/-?\d+(\.\d+)?/y);
    if (!n) this.fail("expected a number");
    if (/^-?0\d/.test(n)) this.fail(`number ${n} has a leading zero`);
    if (/^-0(\.0+)?$/.test(n)) this.fail(`number ${n} is a negative zero`);
  }

  quantity() {
    this.number();
    const at = this.i;
    const unit = this.match(/ [A-Za-z0-9*/^]+/y);
    if (unit && this.peek("=")) this.i = at;
  }

  text() {
    for (;;) {
      if (this.peek('"')) {
        this.i++;
        const end = this.s.indexOf('"', this.i);
        if (end < 0) this.fail("unterminated text");
        const run = this.s.slice(this.i, end);
        if (/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/.test(run))
          this.fail("a hidden code point in quoted text");
        this.i = end + 1;
      } else if (!this.match(/(quote|newline|tab)(?![A-Za-z0-9_(])/y) && !this.match(/fromCodePoint\(\d+\)/y)) {
        this.fail("expected a text piece");
      }
      if (!this.peek(" & ")) return;
      this.i += 3;
    }
  }

  bytes() {
    this.eat("<<");
    if (this.peek(">>")) return void (this.i += 2);
    for (;;) {
      if (!this.match(/0x[0-9A-F]{2}/y)) this.fail("expected a byte");
      if (this.peek(">>")) return void (this.i += 2);
      this.eat(", ");
    }
  }

  list(item: () => void) {
    this.eat("[");
    if (this.peek("]")) return void this.i++;
    for (;;) {
      item();
      if (this.peek("]")) return void this.i++;
      this.eat(", ");
    }
  }

  map() {
    this.eat("{");
    if (this.peek("}")) return void this.i++;
    for (;;) {
      if (this.peek('"')) this.text();
      else if (!this.match(/[A-Za-z_][A-Za-z0-9_]*/y)) this.fail("expected a map key");
      this.eat(": ");
      this.value();
      if (this.peek("}")) return void this.i++;
      this.eat(", ");
    }
  }

  date() {
    if (!this.match(/\d{4}-\d\d-\d\d/y)) this.fail("expected a date");
    if (!this.peek("T")) return;
    this.i++;
    const t = this.match(/\d\d:\d\d:\d\d(\.\d{1,9})?/y);
    if (!t) this.fail("expected a time");
    if (/\.\d*0$/.test(t)) this.fail("a time's fraction ends in 0");
    if (this.peek("Z")) this.i++;
  }

  instant() {
    const at = this.i;
    this.date();
    if (this.s[this.i - 1] !== "Z" || !this.s.slice(at, this.i).includes("T")) this.fail("expected an Instant");
  }

  fn() {
    if (!this.match(/<function [A-Za-z_][A-Za-z0-9_]*(\+\d+)?:([A-Za-z_][A-Za-z0-9_]*:)?(\d+:\d+|[A-Za-z_][A-Za-z0-9_]*)/y))
      this.fail("expected a Function Value");
    if (this.peek(" {")) {
      this.i++;
      this.map();
    }
    this.eat(">");
  }

  object() {
    if (!this.match(/<object [A-Za-z_][A-Za-z0-9_]* /y)) this.fail("expected a Host Object");
    this.text();
    this.eat(">");
  }

  // A Text Pattern's canonical source: `<…>` with nested groups and quoted
  // text, read as far as its closing `>`.
  pattern() {
    let depth = 0;
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) this.fail("unterminated Text Pattern");
      if (c === '"') {
        const end = this.s.indexOf('"', this.i + 1);
        if (end < 0) this.fail("unterminated text in a Text Pattern");
        this.i = end + 1;
        continue;
      }
      this.i++;
      if (c === "<") depth++;
      else if (c === ">" && --depth === 0) return;
    }
  }

  id() {
    if (!this.match(/[A-Za-z0-9_][A-Za-z0-9_./:+-]*/y)) this.fail("expected an id");
  }

  // Reads a value of a corpus.toml key type.
  typed(k: Key) {
    switch (k.type) {
      case "value":
        return this.value();
      case "id":
        return this.id();
      case "ids":
        return this.list(() => this.id());
      case "word": {
        const w = this.match(/[a-z][a-z-]*/y);
        if (!w) this.fail("expected a word");
        if (k.words && !k.words.includes(w)) this.fail(`${w} isn't one of ${k.words.join(", ")}`);
        return;
      }
      case "count": {
        const n = this.match(/\d+/y);
        if (!n || (n.length > 1 && n[0] === "0")) this.fail("expected a count");
        return;
      }
      case "instant":
        return this.instant();
      case "target":
        if (this.peek("<object ")) return this.object();
        if (!this.match(/[A-Za-z_][A-Za-z0-9_]*/y)) this.fail("expected a target");
        return;
      case "at":
        if (!this.match(/[A-Za-z_][A-Za-z0-9_]*(\+\d+)?(:[A-Za-z_][A-Za-z0-9_]*)?:\d+/y)) this.fail("expected a code position");
        return;
      case "pos":
        if (!this.match(/[1-9]\d*:[1-9]\d*/y)) this.fail("expected a source position");
        return;
      case "hex":
        if (!this.match(/[0-9a-f]+/y)) this.fail("expected lowercase hexadecimal");
        return;
    }
    this.fail(`unknown key type ${k.type}`);
  }
}

// ---------------------------------------------------------------------------
// Checking a Trace
// ---------------------------------------------------------------------------

type Line = { input: boolean; name: string; ids: string[]; keys: Map<string, string> };

function readRecord(text: string, input: boolean): Line {
  const r = new Reader(text);
  const name = r.match(/[a-z][a-z-]*/y);
  if (!name) r.fail("expected a record name");
  const rec = RECORDS.get(`${input} ${name}`);
  if (!rec) {
    if (RECORDS.has(`${!input} ${name}`)) throw new Bad(`${name} is ${input ? "Core output, so has no `> `" : "a Host Input, so needs `> `"}`);
    throw new Bad(`unknown record ${name}`);
  }
  const ids: string[] = [];
  const keys = new Map<string, string>();
  // Ids come first: each is one token after a space, never `key=`.
  while (r.peek(" ") && !/^ [A-Za-z_][A-Za-z0-9_-]*=/.test(text.slice(r.i))) {
    r.i++;
    const at = r.i;
    r.id();
    ids.push(text.slice(at, r.i));
  }
  const required = rec.ids.filter((i) => !i.endsWith("?")).length;
  if (ids.length > rec.ids.length) throw new Bad(`${name} has ${ids.length} ids, but takes ${rec.ids.length}`);
  if (!input && ids.length < required) throw new Bad(`${name} needs its ids: ${rec.ids.join(", ")}`);
  const order = rec.key ?? [];
  let next = 0;
  while (r.i < text.length) {
    r.eat(" ");
    const key = r.match(/[A-Za-z_][A-Za-z0-9_-]*/y);
    if (!key) r.fail("expected a key");
    r.eat("=");
    const at = r.i;
    if (name === "vars") {
      r.value();
    } else {
      const k = order.findIndex((o, n) => n >= next && o.key === key);
      if (k < 0) {
        const known = order.some((o) => o.key === key);
        throw new Bad(known ? `key ${key} is out of order or repeated` : `${name} has no key ${key}`);
      }
      for (const skipped of order.slice(next, k)) {
        if (!skipped.optional && !(input && skipped.filled)) throw new Bad(`${name} needs ${skipped.key} before ${key}`);
      }
      next = k + 1;
      r.typed(order[k]!);
      if (order[k]!.type === "ids" && text.slice(at, r.i) === "[]") throw new Bad(`${key} is an empty list, so is left out`);
    }
    if (r.i < text.length && !r.peek(" ")) r.fail(`junk after ${key}`);
    keys.set(key, text.slice(at, r.i));
  }
  if (name !== "vars") {
    for (const rest of order.slice(next)) {
      if (!rest.optional && !(input && rest.filled)) throw new Bad(`${name} needs ${rest.key}`);
    }
  }
  return { input, name, ids, keys };
}

function checkTrace(dir: string, scripts: Set<string>, libraries: Set<string>) {
  const where = relative(ROOT, join(dir, "case.trace"));
  const text = readFileSync(join(dir, "case.trace"), "utf8");
  if (!text.endsWith("\n")) problems.push(`${where}: doesn't end with a line break`);
  const lines = text.split("\n");
  lines.pop();
  const records: (Line & { n: number })[] = [];
  lines.forEach((line, n) => {
    const at = `${where}:${n + 1}`;
    if (line === "" || line.startsWith("#")) return;
    if (/\s$/.test(line)) problems.push(`${at}: trailing space`);
    try {
      const input = line.startsWith("> ");
      records.push({ ...readRecord(input ? line.slice(2) : line, input), n: n + 1 });
    } catch (e) {
      if (!(e instanceof Bad)) throw e;
      problems.push(`${at}: ${e.message}: ${line}`);
    }
  });
  const loaded: string[] = [];
  records.forEach((r, n) => {
    const at = `${where}:${r.n}`;
    if (r.name === "load") {
      const s = r.ids[0];
      // A load is atomic, so one its output rejects with a `diag` adds no
      // Script to the Group.
      const output = records.slice(n + 1, records.findIndex((o, m) => m > n && o.input) >>> 0);
      if (!s) problems.push(`${at}: load names no Script`);
      else if (!scripts.has(s)) problems.push(`${at}: case.toml has no Script ${s}`);
      else if (!output.some((o) => o.name === "diag" && o.ids[0] === s)) loaded.push(s);
    }
    if (r.name === "add-library" && r.ids[0] && !libraries.has(r.ids[0])) problems.push(`${at}: case.toml has no Library ${r.ids[0]}`);
  });
  // Every Trace ends by inspecting the Group.
  const last = records.findLastIndex((r) => r.input);
  if (last < 0 || records[last]!.name !== "vars") return void problems.push(`${where}: doesn't end with \`> vars\``);
  const tail = records.slice(last + 1).map((r) => (r.name === "vars" ? r.ids[0] : `(${r.name})`));
  const loadedOnce = [...new Set(loaded)];
  if (tail.join(" ") !== loadedOnce.join(" "))
    problems.push(`${where}: ends with vars for ${tail.join(", ") || "nothing"}, not for ${loadedOnce.join(", ")} in load order`);
}

// ---------------------------------------------------------------------------
// Checking case.toml
// ---------------------------------------------------------------------------

const SETUP = new Map<string, Set<string>>();
for (const s of corpus.setup as { table: string; key: string }[]) {
  if (!SETUP.has(s.table)) SETUP.set(s.table, new Set());
  SETUP.get(s.table)!.add(s.key);
}

function checkCase(dir: string) {
  const where = relative(ROOT, join(dir, "case.toml"));
  let setup: any;
  try {
    setup = Bun.TOML.parse(readFileSync(join(dir, "case.toml"), "utf8"));
  } catch (e) {
    return void problems.push(`${where}: ${(e as Error).message}`);
  }
  for (const [table, value] of Object.entries(setup)) {
    if (!SETUP.has(table)) {
      if (!SETUP.get("")!.has(table)) problems.push(`${where}: unknown table or key ${table}`);
      continue;
    }
    const rows = Array.isArray(value) ? value : [value];
    for (const row of rows as any[]) {
      for (const key of Object.keys(row)) {
        if (!SETUP.get(table)!.has(key)) problems.push(`${where}: [${table}] has no key ${key}`);
      }
    }
  }
  if (!["trace", "disassembly", "transcript", "encoding"].includes(setup.kind)) problems.push(`${where}: unknown kind ${setup.kind}`);
  if (!setup.versions?.language || !setup.versions?.costModel) problems.push(`${where}: [versions] needs language and costModel`);
  const scripts = new Set<string>();
  const libraries = new Set<string>();
  for (const s of setup.scripts ?? []) {
    scripts.add(s.name);
    if (!existsSync(join(dir, s.source))) problems.push(`${where}: Script ${s.name}'s source ${s.source} is missing`);
    for (const l of Object.keys(s.limits ?? {})) {
      if (!LIMITS.has(l)) problems.push(`${where}: Script ${s.name} sets unknown limit ${l}`);
    }
  }
  for (const l of setup.libraries ?? []) {
    libraries.add(l.name);
    if (!existsSync(join(dir, l.source))) problems.push(`${where}: Library ${l.name}'s source ${l.source} is missing`);
  }
  for (const d of setup.disassembly ?? []) {
    if (!existsSync(join(dir, d.expected))) problems.push(`${where}: expected disassembly ${d.expected} is missing`);
  }
  if (setup.kind === "trace" || setup.kind === "transcript") {
    if (!existsSync(join(dir, "case.trace"))) problems.push(`${where}: case.trace is missing`);
    else checkTrace(dir, scripts, libraries);
  }
  if (setup.kind === "transcript" && !existsSync(join(dir, "session.transcript"))) problems.push(`${where}: session.transcript is missing`);
}

function cases(dir: string): string[] {
  if (existsSync(join(dir, "case.toml"))) return [dir];
  return readdirSync(dir).sort().flatMap((f) => (statSync(join(dir, f)).isDirectory() ? cases(join(dir, f)) : []));
}

const roots = process.argv.length > 2 ? process.argv.slice(2).map((d) => resolve(d)) : [join(ROOT, "corpus")];
const found = roots.flatMap(cases);
for (const dir of found) checkCase(dir);

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`✗ ${problems.length} problem${problems.length === 1 ? "" : "s"} in the corpus`);
  process.exit(1);
}
console.log(`✓ ${found.length} corpus case${found.length === 1 ? "" : "s"} read as chapter 11 says.`);
