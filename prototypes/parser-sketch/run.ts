// PROTOTYPE (throwaway, issues #38, #54 and #48). Usage, from the repo root:
//
//   bun prototypes/parser-sketch/run.ts                 parse the sketch files, print the report
//   bun prototypes/parser-sketch/run.ts --tree [file]   also print a parse tree per file
//   bun prototypes/parser-sketch/run.ts --broken        first-error positions for broken.talk
//   bun prototypes/parser-sketch/run.ts --check-table   the checks a spec generator would run on grammar.toml

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import g from "./grammar.toml";
import { check } from "./check";
import { newStats, parse, type Node, type Stats } from "./parser";

const here = import.meta.dir;
const sketchDir = join(here, "..", "syntax-sketch");
const args = process.argv.slice(2);

// ---------------------------------------------------------------- tree printing

const LABELLED = new Set(["delimiter", "guard", "where", "sort", "timeout", "from", "init", "type"]);

function expr(n: any): string {
  if (n === null || n === undefined) return "·";
  if (typeof n !== "object") return String(n);
  if (Array.isArray(n)) return `[${n.map(expr).join(" ")}]`;
  switch (n.k) {
    case "Name": return n.name;
    case "Bind": return n.name;
    case "Num": return n.v;
    case "Str": return JSON.stringify(n.v);
    case "Const": return n.v;
    case "Quantity": return `(${n.n} ${n.unit})`;
  }
  const parts = Object.entries(n)
    .filter(([k, v]) => k !== "k" && k !== "tok" && v !== null && v !== false && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => (v === true ? `:${k}` : typeof v === "string" ? `${k}=${v}` : LABELLED.has(k) ? `${k}=${expr(v)}` : expr(v)));
  return `(${n.k}${parts.length ? " " + parts.join(" ") : ""})`;
}

const BLOCK_KEYS = new Set(["body", "then", "else", "finally"]);

function stmt(n: Node, depth: number, out: string[]) {
  const pad = "  ".repeat(depth);
  const blocks = Object.entries(n).filter(([k, v]) => BLOCK_KEYS.has(k) && Array.isArray(v));
  const nested = n.k === "Match" || n.k === "WaitForBlock" || n.k === "Try" || n.k === "Join";
  if (!blocks.length && !nested) {
    out.push(pad + expr(n));
    return;
  }
  const head: any = { ...n };
  for (const [k] of blocks) delete head[k];
  delete head.branches;
  delete head.catches;
  out.push(pad + expr(head));
  for (const b of n.branches ?? []) stmt(b, depth + 1, out);
  for (const [k, v] of blocks) {
    if (k !== "body") out.push(`${pad}  ${k}:`);
    for (const s of v as Node[]) stmt(s, depth + (k === "body" ? 1 : 2), out);
  }
  for (const c of n.catches ?? []) stmt(c, depth + 1, out);
}

function tree(ast: Node[]): string {
  const out: string[] = [];
  for (const n of ast) stmt(n, 0, out);
  return out.join("\n");
}

// ---------------------------------------------------------------- reports

function sketchFiles(): string[] {
  return readdirSync(sketchDir).filter((f) => f.endsWith(".talk")).sort().map((f) => join(sketchDir, f));
}

function report(files: string[], showTree: boolean) {
  const total: Stats = newStats();
  const perFile = new Map<string, Map<string, number>>();
  let ok = 0;
  for (const f of files) {
    const stats = newStats();
    const { ast, error } = parse(readFileSync(f, "utf8"), stats);
    const name = basename(f);
    const diags = ast ? check(ast) : [];
    if (error) console.log(`✗ ${name}  ${error.tok.line}:${error.tok.col}  ${error.message}`);
    else if (diags.length) {
      console.log(`✗ ${name}  parses, but the checker (#48) reports:`);
      for (const d of diags) console.log(`    ${d.line}:${d.col}  ${d.msg}`);
    } else {
      ok++;
      console.log(`✓ ${name}  ${ast!.length} top-level definitions`);
    }
    if (showTree && ast) console.log("\n" + tree(ast) + "\n");
    perFile.set(name, stats.sites);
    for (const [s, n] of stats.sites) total.sites.set(s, (total.sites.get(s) ?? 0) + n);
    for (const r of stats.relexes) total.relexes.push({ ...r, site: `${name} ${r.site}` });
    for (const n of stats.notes) total.notes.push({ ...n, msg: `${name}:${n.line}:${n.col}  ${n.msg}` });
  }
  console.log(`\n${ok}/${files.length} files parse and pass the Join checks.\n`);

  console.log("Decisions that needed the second token (LL(2) sites), by count:");
  for (const [s, n] of [...total.sites].sort((a, b) => b[1] - a[1])) {
    const where = [...perFile].filter(([, m]) => m.has(s)).map(([f]) => f.slice(0, 2)).join(",");
    console.log(`  ${s.padEnd(20)} ${String(n).padStart(4)}   in ${where}`);
  }
  console.log("\nLookahead beyond two tokens: none (peek(2) throws, and no file threw).");
  console.log(`\nRelexes (a buffered token lexed in the wrong mode, then changed): ${total.relexes.length}`);
  for (const r of total.relexes) console.log(`  ${r.site} ${r.line}:${r.col}  ${r.was} → ${r.now}`);
  console.log(`\nNotes (parsed, but worth a look): ${total.notes.length}`);
  for (const n of total.notes) console.log(`  ${n.msg}`);
}

// broken.talk holds cases separated by `-- case: <label>` lines. Each case is
// parsed on its own, and the first error is printed with the source line.
function broken() {
  const src = readFileSync(join(here, "broken.talk"), "utf8");
  const cases = src.split(/^-- case: /m).slice(1);
  for (const c of cases) {
    const nl = c.indexOf("\n");
    const label = c.slice(0, nl);
    const body = c.slice(nl + 1);
    const { ast, error, stats } = parse(body);
    console.log(`── ${label}`);
    const lines = body.replace(/\n+$/, "").split("\n");
    const diags = ast ? check(ast) : [];
    if (!error && diags.length) {
      // #48: parses, but a checker diagnostic (a load error) applies.
      lines.forEach((l, i) => {
        console.log("   " + l);
        for (const d of diags) if (d.line === i + 1) console.log("   " + " ".repeat(d.col - 1) + "^ " + `${d.line}:${d.col} load error: ${d.msg}`);
      });
      continue;
    }
    if (!error) {
      console.log(lines.map((l) => "   " + l).join("\n"));
      console.log("   → parses (no syntax error)" + (stats.notes.length ? `; note: ${stats.notes.map((n) => n.msg).join("; ")}` : ""));
      continue;
    }
    const { line, col } = error.tok;
    lines.forEach((l, i) => {
      console.log("   " + l);
      if (i + 1 === line) console.log("   " + " ".repeat(col - 1) + "^ " + `${line}:${col} ${error.message}`);
    });
    if (line > lines.length) console.log(`   ${line}:${col} ${error.message}`);
  }
}

// What the spec generator would check before emitting the table into a Core.
function checkTable() {
  const reserved = new Set<string>(Object.values(g.reserved).flat() as string[]);
  const problems: string[] = [];
  for (const u of g.units.catalogue) if (reserved.has(u)) problems.push(`Unit \`${u}\` is a Reserved Word`);
  for (const [group, v] of Object.entries(g.contextual) as [string, any][])
    for (const w of v.words) if (reserved.has(w)) problems.push(`contextual word \`${w}\` (${group}) is also reserved`);
  for (const w of g.properties.builtin) if (reserved.has(w)) problems.push(`built-in property \`${w}\` is a Reserved Word`);
  const words = new Set(g.units.catalogue);
  for (const w of [...g.text_patterns.keywords, ...g.binary_patterns.size_units, "times", "places"])
    if (words.has(w)) problems.push(`\`${w}\` is a Unit, so \`4 ${w}\` would be a Quantity`);
  console.log(`${reserved.size} Reserved Words: ${[...reserved].sort().join(" ")}`);
  console.log(problems.length ? problems.join("\n") : "table checks: ok");
}

if (args.includes("--check-table")) checkTable();
else if (args.includes("--broken")) broken();
else {
  const files = args.filter((a) => !a.startsWith("--"));
  report(files.length ? files : sketchFiles(), args.includes("--tree"));
}
