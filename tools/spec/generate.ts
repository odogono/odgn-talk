#!/usr/bin/env bun
// Fills the Spec's generated regions from its Data Files (ADR 0032).
//
//   bun tools/spec/generate.ts          validate, then rewrite every region
//   bun tools/spec/generate.ts --check  validate, and fail if any region is stale
//
// A region is `<!-- generated: name -->…<!-- end -->` in any Markdown file under
// spec/. Its name picks a view below. Both modes also validate each Data File
// against its schema, run the cross-file checks and check every relative link in
// the repo's Markdown files.

import Ajv2020 from "ajv/dist/2020";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SPEC = join(ROOT, "spec");
const DATA = join(SPEC, "data");
const ADRS = join(ROOT, "docs/adr");
const ISSUES = "https://github.com/odogono/odgn-talk/issues/";

const check = process.argv.includes("--check");
const problems: string[] = [];

// ---------------------------------------------------------------------------
// Data Files
// ---------------------------------------------------------------------------

const DATA_FILES = [
  "version",
  "grammar",
  "unicode",
  "units",
  "errors",
  "limits",
  "machine",
  "costs",
  "host-errors",
] as const;
type DataName = (typeof DATA_FILES)[number];
type Data = Record<DataName, any>;

async function loadData(): Promise<Data> {
  const ajv = new Ajv2020({ allErrors: true });
  const data = {} as Data;
  for (const name of DATA_FILES) {
    const file = join(DATA, `${name}.toml`);
    const schema = await Bun.file(join(DATA, "schema", `${name}.schema.json`)).json();
    let value: unknown;
    try {
      value = Bun.TOML.parse(await Bun.file(file).text());
    } catch (e) {
      problems.push(`spec/data/${name}.toml: ${(e as Error).message}`);
      value = {};
    }
    const validate = ajv.compile(schema);
    if (!validate(value)) {
      for (const err of validate.errors ?? []) {
        problems.push(`spec/data/${name}.toml${err.instancePath}: ${err.message}`);
      }
    }
    data[name] = value;
  }
  return data;
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(values.filter((v) => seen.has(v) || !seen.add(v)))];
}

const adrFiles = readdirSync(ADRS).filter((f) => /^\d{4}-.*\.md$/.test(f));
const adrFile = (n: string) => adrFiles.find((f) => f.startsWith(`${n}-`));

function crossCheck(d: Data) {
  const fail = (file: string, msg: string) => problems.push(`spec/data/${file}: ${msg}`);

  for (const [file, key] of [["errors.toml", "error"], ["host-errors.toml", "error"]] as const) {
    const codes = (d[file.replace(".toml", "") as DataName][key] ?? []).map((e: any) => e.code);
    for (const c of duplicates(codes)) fail(file, `code "${c}" is listed twice`);
  }
  const hostCodes = new Set((d["host-errors"].error ?? []).map((e: any) => e.code));
  const codes = new Set((d.errors.error ?? []).map((e: any) => e.code));
  for (const c of codes) if (hostCodes.has(c)) fail("errors.toml", `"${c}" is also a Host error code`);

  // ADR 0019 and ADR 0022: no Unit spelling may be a Reserved Word, a FOLLOW-set
  // word or a duplicate.
  const kinds = new Map<string, any>((d.units.kind ?? []).map((k: any) => [k.name, k]));
  const spellings = (d.units.unit ?? []).flatMap((u: any) => [u.name, u.plural].filter(Boolean));
  for (const s of duplicates(spellings)) fail("units.toml", `"${s}" is spelled by two Units`);
  for (const k of duplicates((d.units.kind ?? []).map((k: any) => k.name))) {
    fail("units.toml", `Unit Kind "${k}" is listed twice`);
  }
  const reserved = new Set(d.grammar.reserved ?? []);
  const follow = new Set(d.grammar.follow ?? []);
  for (const s of spellings) {
    if (reserved.has(s)) fail("units.toml", `"${s}" is a Reserved Word`);
    if (follow.has(s)) fail("units.toml", `"${s}" is in the FOLLOW set`);
  }
  for (const u of d.units.unit ?? []) {
    if (!kinds.has(u.kind)) fail("units.toml", `Unit "${u.name}" has unknown Kind "${u.kind}"`);
  }
  for (const k of kinds.values()) {
    const base = (d.units.unit ?? []).find((u: any) => u.name === k.base);
    if (!base || base.kind !== k.name) fail("units.toml", `Kind "${k.name}" has Base Unit "${k.base}", which isn't one of its Units`);
    else if (base.factor !== "1") fail("units.toml", `Base Unit "${k.base}" must have factor "1"`);
  }
  for (const w of duplicates(d.grammar.reserved ?? [])) fail("grammar.toml", `"${w}" is reserved twice`);
  for (const c of d.grammar.contextual ?? []) {
    if (reserved.has(c.word)) fail("grammar.toml", `"${c.word}" is both reserved and contextual`);
  }

  for (const f of ["name", "go", "ts"]) {
    for (const v of duplicates((d.limits.limit ?? []).map((l: any) => l[f]))) {
      fail("limits.toml", `${f} "${v}" is listed twice`);
    }
  }

  const rates = new Set((d.costs.rate ?? []).map((r: any) => r.key));
  for (const n of duplicates((d.machine.instruction ?? []).map((i: any) => i.name))) {
    fail("machine.toml", `instruction "${n}" is listed twice`);
  }
  for (const i of d.machine.instruction ?? []) {
    if (!rates.has(i.cost)) fail("machine.toml", `instruction "${i.name}" has Cost Model key "${i.cost}", which costs.toml doesn't rate`);
    for (const c of i.errors ?? []) {
      if (!codes.has(c)) fail("machine.toml", `instruction "${i.name}" raises "${c}", which isn't in errors.toml`);
    }
  }

  for (const [name, list] of [["errors.toml", d.errors.error], ["limits.toml", d.limits.limit]] as const) {
    for (const entry of list ?? []) {
      for (const s of entry.sources ?? []) {
        const m = /^ADR (\d{4})$/.exec(s);
        if (m && !adrFile(m[1]!)) fail(name, `${s} doesn't exist`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type View = (d: Data, file: string) => string;

const cell = (s: unknown) => String(s ?? "").replaceAll("|", "\\|");
const code = (s: string) => `\`${s}\``;
const todo = (chapter: string) => `_To be written in ${chapter}._`;

function table(head: string[], rows: unknown[][]): string {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

const adrLink = (n: string, file: string) =>
  `[ADR ${n}](${relative(dirname(file), join(ADRS, adrFile(n) ?? ""))})`;

// Links each bare "ADR 0030" in a Data File's prose.
const prose = (s: string, file: string) => s.replace(/\bADR (\d{4})\b/g, (_, n) => adrLink(n, file));

function sources(list: string[], file: string): string {
  return list
    .map((s) => {
      const adr = /^ADR (\d{4})$/.exec(s);
      if (adr) return adrLink(adr[1]!, file);
      return `[${s}](${ISSUES}${s.slice(1)})`;
    })
    .join(", ");
}

const VIEWS: Record<string, View> = {
  version: (d) =>
    `This is language **${d.version.language}**, with Cost Model **${d.costs.version}**.`,

  grammar: (d) => {
    if (!d.grammar.reserved?.length) return todo("chapter 2");
    const words = (ws: string[]) => ws.map(code).join(", ");
    const parts = [`**Reserved Words:** ${words(d.grammar.reserved)}.`];
    if (d.grammar.follow?.length) parts.push(`**The FOLLOW set:** ${words(d.grammar.follow)}.`);
    if (d.grammar.contextual?.length) {
      parts.push(table(["Contextual keyword", "Positions"],
        d.grammar.contextual.map((c: any) => [code(c.word), c.positions.join(", ")])));
    }
    return parts.join("\n\n");
  },

  unicode: (d) => {
    if (!d.unicode.version) return todo("chapter 1");
    return [
      `The pinned Unicode version is **${d.unicode.version}**.`,
      table(["UCD file", "SHA-256"], d.unicode.file.map((f: any) => [code(f.path), code(f.sha256)])),
    ].join("\n\n");
  },

  "units.kinds": (d) =>
    table(["Unit Kind", "Base Unit", "Dimension"],
      d.units.kind.map((k: any) => [
        k.name,
        code(k.base),
        k.calendar ? "none (Calendar Units)" : k.factor ? `${k.dimension}, with ${code(k.base)} = ${k.factor}` : k.dimension,
      ])),

  "units.units": (d) =>
    table(["Unit", "Plural", "Unit Kind", "Factor to the Base Unit"],
      d.units.unit.map((u: any) => [
        code(u.name),
        u.plural ? code(u.plural) : "",
        u.kind,
        u.ratio ? `${u.ratio[0]}/${u.ratio[1]}` : u.factor,
      ])),

  errors: (d, file) => {
    const errors = d.errors.error ?? [];
    const parts = [
      table(["Code", "Fields", "Raised when", "Sources"],
        errors.map((e: any) => [
          code(e.code),
          e.fields.map(code).join(", ") || "none",
          prose(e.raised_when, file),
          sources(e.sources, file),
        ])),
    ];
    const open = errors.filter((e: any) => e.open);
    if (open.length) {
      parts.push("Still open:", open.map((e: any) => `- ${code(e.code)}: ${prose(e.open, file)}.`).join("\n"));
    }
    return parts.join("\n\n");
  },

  limits: (d, file) =>
    table(["Limit", "Go", "TS", "Counts", "Per", "Tightened per Delivery", "Default", "Sources"],
      d.limits.limit.map((l: any) => [
        l.name,
        code(l.go),
        code(l.ts),
        l.measure,
        l.per,
        l.overridable ? "yes" : "no",
        l.default ?? "not yet set",
        sources(l.sources, file),
      ])),

  machine: (d) => {
    if (!d.machine.instruction?.length) return todo("chapter 8");
    return table(["Instruction", "Operands", "Pops", "Pushes", "Suspends", "Cost Model key", "Error Codes"],
      d.machine.instruction.map((i: any) => [
        code(i.name),
        i.operands.join(", "),
        i.pops,
        i.pushes,
        i.suspends ? "yes" : "no",
        code(i.cost),
        (i.errors ?? []).map(code).join(", "),
      ]));
  },

  costs: (d) => {
    const head = `Cost Model **${d.costs.version}**.`;
    if (!d.costs.rate?.length) return `${head} ${todo("chapter 8")}`;
    return [head, table(["Cost Model key", "Base Fuel", "Per-unit terms"],
      d.costs.rate.map((r: any) => [
        code(r.key),
        r.base,
        (r.terms ?? []).map((t: any) => `${t.fuel} per ${t.per}`).join(", "),
      ]))].join("\n\n");
  },

  "host-errors": (d, file) =>
    table(["Code", "Raised when"],
      d["host-errors"].error.map((e: any) => [code(e.code), prose(e.raised_when, file)])),

  // Appendix A: CONTEXT.md from its first section on, with its relative links
  // rebased onto the region's file.
  glossary: (_d, file) => {
    const source = join(ROOT, "CONTEXT.md");
    const text = glossarySource;
    const start = text.search(/^## /m);
    if (start < 0) {
      problems.push("CONTEXT.md: no `## ` sections to put in Appendix A");
      return "";
    }
    return rebaseLinks(text.slice(start).trim(), source, file);
  },
};

const glossarySource = await Bun.file(join(ROOT, "CONTEXT.md")).text();

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

const REGION = /^<!-- generated: ([a-z0-9.-]+) -->\n[\s\S]*?^<!-- end -->/gm;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return markdownFiles(p);
    return p.endsWith(".md") ? [p] : [];
  });
}

async function fillRegions(d: Data): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const file of markdownFiles(SPEC)) {
    const rel = relative(ROOT, file);
    const before = await Bun.file(file).text();
    const opens = before.match(/^<!-- generated:/gm)?.length ?? 0;
    const closed = before.match(REGION)?.length ?? 0;
    if (opens !== closed) problems.push(`${rel}: a generated region has no \`<!-- end -->\``);
    const after = before.replace(REGION, (whole, name: string) => {
      const view = VIEWS[name];
      if (!view) {
        problems.push(`${rel}: no view named "${name}"`);
        return whole;
      }
      used.add(name);
      return `<!-- generated: ${name} -->\n\n${view(d, file)}\n\n<!-- end -->`;
    });
    out.set(file, after);
    if (after !== before) {
      if (check) problems.push(`${rel} is out of date: run \`bun run spec:gen\``);
      else await Bun.write(file, after);
    }
  }
  for (const name of Object.keys(VIEWS)) {
    if (!used.has(name)) problems.push(`view "${name}" isn't shown in any region`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const INLINE_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const REF_LINK = /^\[[^\]]+\]:\s*(\S+)/gm;

function stripCode(text: string): string {
  return text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "").replace(/`[^`\n]*`/g, "");
}

function links(text: string): string[] {
  const t = stripCode(text);
  return [...t.matchAll(INLINE_LINK), ...t.matchAll(REF_LINK)].map((m) => m[1]!);
}

const isRelative = (href: string) => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("#");

function rebaseLinks(text: string, from: string, to: string): string {
  const rebase = (href: string) => {
    if (!isRelative(href)) return href;
    const [path, anchor] = href.split("#");
    const moved = relative(dirname(to), resolve(dirname(from), path!));
    return anchor === undefined ? moved : `${moved}#${anchor}`;
  };
  return text
    .replace(INLINE_LINK, (m, href: string) => m.replace(`(${href}`, `(${rebase(href)}`))
    .replace(REF_LINK, (m, href: string) => m.replace(href, rebase(href)));
}

// GitHub's heading anchors.
function anchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const m of stripCode(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = m[1]!
      .replace(/<[^>]+>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

async function checkLinks(regenerated: Map<string, string>) {
  const listed = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "*.md"], { cwd: ROOT });
  const files = new TextDecoder().decode(listed.stdout).split("\n").filter(Boolean).map((f) => join(ROOT, f));
  const read = async (f: string) => regenerated.get(f) ?? (await Bun.file(f).text());
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = await read(file);
    for (const href of links(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const [path, anchor] = href.split("#");
      const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
      const where = `${relative(ROOT, file)}: link \`${href}\``;
      if (!existsSync(target)) {
        problems.push(`${where} points to a missing file`);
      } else if (anchor && target.endsWith(".md") && !anchors(await read(target)).has(anchor)) {
        problems.push(`${where} points to a missing heading`);
      }
    }
  }
}

// ---------------------------------------------------------------------------

const data = await loadData();
crossCheck(data);
const regenerated = await fillRegions(data);
await checkLinks(regenerated);

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(check ? "✓ The Spec is up to date." : "✓ The Spec's regions are filled.");
