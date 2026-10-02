#!/usr/bin/env bun
// Fills the Spec's generated regions from its Data Files (ADR 0032).
//
//   bun tools/spec/generate.ts          validate, then rewrite every region
//   bun tools/spec/generate.ts --check  validate, and fail if any region is stale
//
// A region is `<!-- generated: name -->…<!-- end -->` in any Markdown file under
// spec/. Its name picks a view below, and `ebnf.<section>` shows a section of
// grammar.ebnf or trace.ebnf. Both modes also validate each Data File against
// its schema, run the cross-file checks, check grammar.ebnf against grammar.toml
// and check relative links and script references in the repo's Markdown files.

import Ajv2020 from 'ajv/dist/2020';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { checkCommands } from './commands';

const ROOT = resolve(import.meta.dir, '../..');
const SPEC = join(ROOT, 'spec');
const DATA = join(SPEC, 'data');
const ADRS = join(ROOT, 'docs/adr');
const ISSUES = 'https://github.com/odogono/odgn-talk/issues/';

const check = process.argv.includes('--check');
const problems: string[] = [];

// ---------------------------------------------------------------------------
// Data Files
// ---------------------------------------------------------------------------

const DATA_FILES = [
  'version',
  'grammar',
  'unicode',
  'units',
  'errors',
  'diagnostics',
  'limits',
  'machine',
  'costs',
  'host-errors',
  'stdlib',
  'corpus',
  'session',
] as const;
type DataName = (typeof DATA_FILES)[number];
type Data = Record<DataName, any>;

const loadData = async (): Promise<Data> => {
  const ajv = new Ajv2020({ allErrors: true });
  const data = {} as Data;
  for (const name of DATA_FILES) {
    const file = join(DATA, `${name}.toml`);
    const schema = await Bun.file(
      join(DATA, 'schema', `${name}.schema.json`),
    ).json();
    let value: unknown;
    try {
      value = Bun.TOML.parse(await Bun.file(file).text());
    } catch (error) {
      problems.push(`spec/data/${name}.toml: ${(error as Error).message}`);
      value = {};
    }
    const validate = ajv.compile(schema);
    if (!validate(value)) {
      for (const err of validate.errors ?? []) {
        problems.push(
          `spec/data/${name}.toml${err.instancePath}: ${err.message}`,
        );
      }
    }
    data[name] = value;
  }
  return data;
};

const duplicates = (values: string[]): string[] => {
  const seen = new Set<string>();
  return [...new Set(values.filter(v => seen.has(v) || !seen.add(v)))];
};

// An EBNF Data File, split into the sections its `/* ## name */` lines start.
type Production = { name: string; rhs: string };
type Section = { name: string; productions: Production[]; text: string };

const loadEbnf = async (file = 'grammar.ebnf'): Promise<Section[]> => {
  const text = await Bun.file(join(DATA, file)).text();
  const parts = text.split(/^\/\* ## ([a-z-]+) \*\/\n/m);
  const sections: Section[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1]!.trim();
    const productions: Production[] = [];
    for (const chunk of body.split(/\n(?=[A-Za-z]\w*\s*::=)/)) {
      const m = /^([A-Za-z]\w*)\s*::=([\S\s]*)$/.exec(chunk.trim());
      if (m) {
        productions.push({ name: m[1]!, rhs: m[2]! });
      }
    }
    sections.push({ name: parts[i]!, text: body, productions });
  }
  if (!sections.length) {
    problems.push(`spec/data/${file}: no \`/* ## name */\` sections`);
  }
  return sections;
};

const adrFiles = readdirSync(ADRS).filter(f => /^\d{4}-.*\.md$/.test(f));
const adrFile = (n: string) => adrFiles.find(f => f.startsWith(`${n}-`));

// Every word or phrase that has a meaning only in some positions: the
// contextual keywords, and the entries of grammar.toml's other lists.
const contextualPhrases = (d: Data): string[] => {
  const g = d.grammar;
  return [
    ...(g.contextual ?? []).map((c: any) => c.word),
    ...(g.follow ?? []),
    ...(g.ordinals ?? []),
    ...(g.properties ?? []),
    ...(g.chunk ?? []).flatMap((c: any) => [c.singular, c.plural]),
    ...(Object.values(g.text_patterns ?? {}).flat() as string[]),
    ...(Object.values(g.binary_patterns ?? {}).flat() as string[]),
  ];
};

const contextualWords = (d: Data) =>
  new Set(contextualPhrases(d).flatMap(s => s.split(' ')));

// grammar.ebnf: every nonterminal is defined once and used, every quoted word
// is a Reserved Word or a contextual keyword, and every Reserved Word is used.
const EBNF_ROOTS = new Set(['Source', 'Entry', 'Token', 'Comment', 'Space']);
const LEXICAL_SECTIONS = new Set(['tokens', 'units']);

const ebnfCheck = (d: Data, sections: Section[]) => {
  const fail = (msg: string) => problems.push(`spec/data/grammar.ebnf: ${msg}`);
  const all = sections.flatMap(s =>
    s.productions.map(p => ({ ...p, section: s.name })),
  );
  for (const n of duplicates(all.map(p => p.name))) {
    fail(`${n} is defined twice`);
  }
  for (const s of duplicates(sections.map(s => s.name))) {
    fail(`section "${s}" appears twice`);
  }
  const defined = new Set(all.map(p => p.name));
  const used = new Set<string>();
  const quoted = new Set<string>();
  for (const p of all) {
    const rhs = p.rhs.replaceAll(/\/\*[\S\s]*?\*\//g, ' ');
    for (const m of rhs.matchAll(/'([^']*)'|"([^"]*)"/g)) {
      const w = m[1] ?? m[2]!;
      if (/^[a-z]+$/.test(w) && !LEXICAL_SECTIONS.has(p.section)) {
        quoted.add(w);
      }
    }
    const bare = rhs.replaceAll(
      /'[^']*'|"[^"]*"|\[[^\]]*]|#x[\dA-Fa-f]+/g,
      ' ',
    );
    for (const m of bare.matchAll(/\b[A-Z][A-Za-z]*\b/g)) {
      used.add(m[0]);
      if (!defined.has(m[0])) {
        fail(`${p.name} uses ${m[0]}, which isn't defined`);
      }
    }
  }
  for (const n of defined) {
    if (!used.has(n) && !EBNF_ROOTS.has(n)) {
      fail(`${n} is defined but never used`);
    }
  }
  const reserved = new Set<string>(d.grammar.reserved ?? []);
  const contextual = contextualWords(d);
  for (const w of quoted) {
    if (!reserved.has(w) && !contextual.has(w)) {
      fail(
        `'${w}' is neither a Reserved Word nor a contextual keyword in grammar.toml`,
      );
    }
  }
  for (const w of reserved) {
    if (!quoted.has(w)) {
      fail(`the Reserved Word "${w}" appears in no production`);
    }
  }
};

// trace.ebnf: every nonterminal is defined once and used, and no section
// shares a name with one of grammar.ebnf's.
const TRACE_ROOTS = new Set([
  'Value',
  'TraceFile',
  'Transcript',
  'EncodingFile',
]);

const traceEbnfCheck = (sections: Section[], grammar: Section[]) => {
  const fail = (msg: string) => problems.push(`spec/data/trace.ebnf: ${msg}`);
  const all = sections.flatMap(s => s.productions);
  for (const n of duplicates(all.map(p => p.name))) {
    fail(`${n} is defined twice`);
  }
  const taken = new Set(grammar.map(s => s.name));
  for (const s of sections) {
    if (taken.has(s.name)) {
      fail(`section "${s.name}" is also a section of grammar.ebnf`);
    }
  }
  const defined = new Set(all.map(p => p.name));
  const used = new Set<string>();
  for (const p of all) {
    const bare = p.rhs
      .replaceAll(/\/\*[\S\s]*?\*\//g, ' ')
      .replaceAll(/'[^']*'|"[^"]*"|\[[^\]]*]|#x[\dA-Fa-f]+/g, ' ');
    for (const m of bare.matchAll(/\b[A-Z][A-Za-z]*\b/g)) {
      used.add(m[0]);
      if (!defined.has(m[0])) {
        fail(`${p.name} uses ${m[0]}, which isn't defined`);
      }
    }
  }
  for (const n of defined) {
    if (!used.has(n) && !TRACE_ROOTS.has(n)) {
      fail(`${n} is defined but never used`);
    }
  }
};

// corpus.toml and session.toml (ADR 0018, ADR 0014): names are unique, every
// key has a known type, and a word-valued key lists its words.
const WORD_LISTS: Record<string, string> = {
  'seg.end': 'end',
  'note.kind': 'note',
};

const corpusCheck = (d: Data) => {
  const fail = (file: string, msg: string) =>
    problems.push(`spec/data/${file}: ${msg}`);
  const c = d.corpus;
  const types = new Set(Object.keys(c.type ?? {}));
  const records = c.record ?? [];
  for (const n of duplicates(
    records.map((r: any) => `${r.input ? '> ' : ''}${r.name}`),
  )) {
    fail('corpus.toml', `record "${n}" is listed twice`);
  }
  for (const r of records) {
    const keys = r.key ?? [];
    for (const k of duplicates(keys.map((k: any) => k.key))) {
      fail('corpus.toml', `record "${r.name}" lists the key "${k}" twice`);
    }
    for (const k of keys) {
      if (!types.has(k.type)) {
        fail(
          'corpus.toml',
          `"${r.name}.${k.key}" has the type "${k.type}", which [type] doesn't list`,
        );
      }
      const list = WORD_LISTS[`${r.name}.${k.key}`];
      if (k.type === 'word' && !k.words && !list) {
        fail(
          'corpus.toml',
          `"${r.name}.${k.key}" is a word, but lists no words`,
        );
      }
      if (k.words && k.type !== 'word') {
        fail(
          'corpus.toml',
          `"${r.name}.${k.key}" lists words, but isn't a word`,
        );
      }
      if (k.filled && !r.input) {
        fail(
          'corpus.toml',
          `"${r.name}.${k.key}" is filled, but "${r.name}" isn't a Host Input`,
        );
      }
    }
  }
  for (const list of ['end', 'note'] as const) {
    for (const w of duplicates((c[list] ?? []).map((e: any) => e.word))) {
      fail('corpus.toml', `[[${list}]] "${w}" is listed twice`);
    }
  }
  for (const k of duplicates(
    (c.setup ?? []).map((e: any) => `${e.table}.${e.key}`),
  )) {
    fail('corpus.toml', `the case.toml key "${k}" is listed twice`);
  }
  for (const n of duplicates(
    (d.session.command ?? []).map((e: any) => e.name),
  )) {
    fail('session.toml', `"${n}" is listed twice`);
  }
  if (!(d.stdlib.capabilities ?? []).includes('console')) {
    fail(
      'stdlib.toml',
      "`console`, which every session grants, isn't a Standard Capability",
    );
  }
};

const crossCheck = (d: Data) => {
  const fail = (file: string, msg: string) =>
    problems.push(`spec/data/${file}: ${msg}`);

  for (const [file, key] of [
    ['errors.toml', 'error'],
    ['host-errors.toml', 'error'],
  ] as const) {
    const codes = (d[file.replace('.toml', '') as DataName][key] ?? []).map(
      (e: any) => e.code,
    );
    for (const c of duplicates(codes)) {
      fail(file, `code "${c}" is listed twice`);
    }
  }
  const hostCodes = new Set(
    (d['host-errors'].error ?? []).map((e: any) => e.code),
  );
  const codes = new Set((d.errors.error ?? []).map((e: any) => e.code));
  for (const c of codes) {
    if (hostCodes.has(c)) {
      fail('errors.toml', `"${c}" is also a Host error code`);
    }
  }
  for (const e of d.errors.error ?? []) {
    for (const f of e.optional ?? []) {
      if (e.fields.includes(f)) {
        fail(
          'errors.toml',
          `"${e.code}" lists "${f}" as both required and optional`,
        );
      }
    }
    // A template may name only the fields every raise carries.
    for (const m of (e.message ?? '').matchAll(/{([^}]*)}/g)) {
      if (!e.fields.includes(m[1])) {
        fail(
          'errors.toml',
          `the message of "${e.code}" uses {${m[1]}}, which isn't one of its fields`,
        );
      }
    }
  }

  // ADR 0019 and ADR 0022: no Unit spelling may be a Reserved Word, a FOLLOW-set
  // word or a duplicate.
  const kinds = new Map<string, any>(
    (d.units.kind ?? []).map((k: any) => [k.name, k]),
  );
  const spellings = (d.units.unit ?? []).flatMap((u: any) =>
    [u.name, u.plural].filter(Boolean),
  );
  for (const s of duplicates(spellings)) {
    fail('units.toml', `"${s}" is spelled by two Units`);
  }
  for (const k of duplicates((d.units.kind ?? []).map((k: any) => k.name))) {
    fail('units.toml', `Unit Kind "${k}" is listed twice`);
  }
  const reserved = new Set(d.grammar.reserved ?? []);
  const follow = new Set(d.grammar.follow ?? []);
  for (const s of spellings) {
    if (reserved.has(s)) {
      fail('units.toml', `"${s}" is a Reserved Word`);
    }
    if (follow.has(s)) {
      fail('units.toml', `"${s}" is in the FOLLOW set`);
    }
  }
  for (const u of d.units.unit ?? []) {
    if (!kinds.has(u.kind)) {
      fail('units.toml', `Unit "${u.name}" has unknown Kind "${u.kind}"`);
    }
  }
  for (const k of kinds.values()) {
    const base = (d.units.unit ?? []).find((u: any) => u.name === k.base);
    if (!base || base.kind !== k.name) {
      fail(
        'units.toml',
        `Kind "${k.name}" has Base Unit "${k.base}", which isn't one of its Units`,
      );
    } else if (base.factor !== '1') {
      fail('units.toml', `Base Unit "${k.base}" must have factor "1"`);
    }
  }
  const contextual = (d.grammar.contextual ?? []).map((c: any) => c.word);
  for (const w of duplicates(contextual)) {
    fail('grammar.toml', `contextual keyword "${w}" is listed twice`);
  }
  // A phrase is decided on its first word, so only that word must not be reserved.
  for (const w of new Set(contextualPhrases(d).map(s => s.split(' ')[0]!))) {
    if (reserved.has(w)) {
      fail('grammar.toml', `"${w}" is both reserved and contextual`);
    }
  }
  for (const w of follow) {
    if (!contextual.includes(w)) {
      fail(
        'grammar.toml',
        `FOLLOW-set word "${w}" has no [[contextual]] entry`,
      );
    }
  }
  for (const [list, key] of [
    ['decision', 'name'],
    ['syntax_error', 'code'],
  ] as const) {
    for (const v of duplicates(
      (d.grammar[list] ?? []).map((e: any) => e[key]),
    )) {
      fail('grammar.toml', `${list} "${v}" is listed twice`);
    }
  }
  for (const e of d.grammar.syntax_error ?? []) {
    if (codes.has(e.code) || hostCodes.has(e.code)) {
      fail(
        'grammar.toml',
        `syntax error "${e.code}" is also in errors.toml or host-errors.toml`,
      );
    }
  }
  // A load-time diagnostic's code is its own, so a Host can tell it from a
  // syntax error, a run-time error and a Host error by the code alone.
  const syntaxCodes = new Set(
    (d.grammar.syntax_error ?? []).map((e: any) => e.code),
  );
  const diagCodes = (d.diagnostics.diagnostic ?? []).map((e: any) => e.code);
  for (const c of duplicates(diagCodes)) {
    fail('diagnostics.toml', `code "${c}" is listed twice`);
  }
  for (const c of diagCodes) {
    if (codes.has(c) || hostCodes.has(c) || syntaxCodes.has(c)) {
      fail(
        'diagnostics.toml',
        `"${c}" is also in errors.toml, host-errors.toml or grammar.toml`,
      );
    }
  }

  for (const f of ['name', 'go', 'ts']) {
    for (const v of duplicates((d.limits.limit ?? []).map((l: any) => l[f]))) {
      fail('limits.toml', `${f} "${v}" is listed twice`);
    }
  }
  for (const l of d.limits.limit ?? []) {
    if (l.default > l.minimum) {
      fail(
        'limits.toml',
        `"${l.name}" has a default above its conformance minimum`,
      );
    }
  }

  const rates = new Set((d.costs.rate ?? []).map((r: any) => r.key));
  for (const n of duplicates(
    (d.machine.instruction ?? []).map((i: any) => i.name),
  )) {
    fail('machine.toml', `instruction "${n}" is listed twice`);
  }
  for (const i of d.machine.instruction ?? []) {
    // `builtin` is rated per Built-in, as `builtin.<name>`.
    if (i.cost !== 'builtin' && !rates.has(i.cost)) {
      fail(
        'machine.toml',
        `instruction "${i.name}" has Cost Model key "${i.cost}", which costs.toml doesn't rate`,
      );
    }
    for (const o of i.operands.map((k: string) => k.replace(/\?$/, ''))) {
      if (!(o in (d.machine.operand ?? {}))) {
        fail(
          'machine.toml',
          `instruction "${i.name}" has the operand kind "${o}", which [operand] doesn't list`,
        );
      }
    }
    for (const e of [i.pops, i.pushes]) {
      if (typeof e === 'string' && !i.operands.includes(e.split(' ')[0])) {
        fail(
          'machine.toml',
          `instruction "${i.name}" counts "${e}", but has no such operand`,
        );
      }
    }
    if (i.jumps !== undefined && !i.operands.includes('label')) {
      fail(
        'machine.toml',
        `instruction "${i.name}" says what it leaves when it jumps, but has no label`,
      );
    }
    for (const c of i.errors ?? []) {
      if (!codes.has(c)) {
        fail(
          'machine.toml',
          `instruction "${i.name}" raises "${c}", which isn't in errors.toml`,
        );
      }
    }
  }

  costsCheck(d, fail);

  for (const [name, list] of [
    ['errors.toml', d.errors.error],
    ['diagnostics.toml', d.diagnostics.diagnostic],
    ['limits.toml', d.limits.limit],
  ] as const) {
    for (const entry of list ?? []) {
      for (const s of entry.sources ?? []) {
        const m = /^ADR (\d{4})$/.exec(s);
        if (m && !adrFile(m[1]!)) {
          fail(name, `${s} doesn't exist`);
        }
      }
    }
  }
};

// stdlib.toml (ADRs 0021 and 0035): every stdlib name is unique across the
// Built-ins and the seven Libraries and isn't a Reserved Word or a Built-in
// property, each function's defaults come last, and every Error Code and
// Capability it names exists.
const BUILTIN_GROUPS = [
  'values',
  'numbers',
  'floats',
  'dates',
  'constants',
] as const;
const isFunction = (e: any) => e.call.startsWith(`${e.name}(`);

const stdlibCheck = (d: Data) => {
  const fail = (msg: string) => problems.push(`spec/data/stdlib.toml: ${msg}`);
  const s = d.stdlib;
  const codes = new Set((d.errors.error ?? []).map((e: any) => e.code));
  const reserved = new Set(d.grammar.reserved ?? []);
  const properties = new Set(d.grammar.properties ?? []);
  const entries = [...(s.builtin ?? []), ...(s.export ?? [])];
  for (const n of duplicates(entries.map((e: any) => e.name))) {
    fail(`"${n}" is named twice across the Built-ins and the Libraries`);
  }
  for (const e of entries) {
    if (reserved.has(e.name)) {
      fail(`"${e.name}" is a Reserved Word`);
    }
    if (properties.has(e.name)) {
      fail(`"${e.name}" is a Built-in property`);
    }
    for (const c of e.errors ?? []) {
      if (!codes.has(c)) {
        fail(`"${e.name}" raises "${c}", which isn't in errors.toml`);
      }
    }
    const isConstant = e.group === 'constants' || (e.library && !isFunction(e));
    if (isConstant) {
      continue;
    }
    const m = new RegExp(String.raw`^${e.name}\((.*)\)$`).exec(e.call);
    if (!m) {
      fail(`the call of "${e.name}" isn't \`${e.name}(…)\``);
      continue;
    }
    let optional = false;
    for (const p of m[1]
      ? m[1].split(/, (?=[a-z]\w* = |[a-z]\w*(?:,|$))/)
      : []) {
      const pm = /^([a-z]\w*)( = .+)?$/.exec(p);
      if (!pm) {
        fail(`"${e.name}" has a malformed parameter "${p}"`);
      } else if (pm[2]) {
        optional = true;
      } else if (optional) {
        fail(
          `"${e.name}" has the parameter "${pm[1]}" without a default after one with a default`,
        );
      }
    }
  }
  for (const e of s.export ?? []) {
    if (!s.libraries.includes(e.library)) {
      fail(`"${e.name}" is in "${e.library}", which isn't a stdlib Library`);
    }
  }
  for (const lib of s.libraries) {
    if (reserved.has(lib)) {
      fail(`the Library name "${lib}" is a Reserved Word`);
    }
    if (!(s.export ?? []).some((e: any) => e.library === lib)) {
      fail(`the Library "${lib}" exports nothing`);
    }
  }
  for (const n of duplicates((s.encoding ?? []).map((e: any) => e.name))) {
    fail(`encoding "${n}" is listed twice`);
  }
  const ops = (s.operation ?? []).map((o: any) => `${o.capability} ${o.name}`);
  for (const o of duplicates(ops)) {
    fail(`Operation "${o}" is listed twice`);
  }
  for (const o of s.operation ?? []) {
    if (!s.capabilities.includes(o.capability)) {
      fail(
        `Operation "${o.name}" is on "${o.capability}", which isn't a Standard Capability`,
      );
    }
    for (const c of o.errors ?? []) {
      if (!codes.has(c)) {
        fail(
          `Operation "${o.capability} ${o.name}" names "${c}", which isn't in errors.toml`,
        );
      }
    }
  }
  for (const c of s.capabilities) {
    if (!(s.operation ?? []).some((o: any) => o.capability === c)) {
      fail(`the Standard Capability "${c}" has no Operations`);
    }
  }
};

// spec/stdlib/<library>.talk (ADR 0021): each stdlib Library's normative
// source exports exactly what stdlib.toml lists, with the same parameters and
// defaults. Private definitions are the source's own business.
const stdlibSourceCheck = async (d: Data) => {
  const s = d.stdlib;
  for (const lib of s.libraries ?? []) {
    const rel = `spec/stdlib/${lib}.talk`;
    const file = join(SPEC, 'stdlib', `${lib}.talk`);
    if (!existsSync(file)) {
      problems.push(`${rel}: missing; stdlib.toml lists the Library "${lib}"`);
      continue;
    }
    const source = await Bun.file(file).text();
    const exported = new Map<string, string>();
    for (const m of source.matchAll(
      /^(private\s+)?(function|constant)\s+(\w+)(.*)$/gm,
    )) {
      if (m[1]) {
        continue;
      }
      if (exported.has(m[3]!)) {
        problems.push(`${rel}: "${m[3]}" is defined twice`);
      }
      const rest = m[4]!.trim();
      exported.set(
        m[3]!,
        m[2] === 'function' ? `${m[3]}(${rest})` : rest.replace(/^=\s*/, ''),
      );
    }
    const listed = (s.export ?? []).filter((e: any) => e.library === lib);
    for (const e of listed) {
      const got = exported.get(e.name);
      if (got === undefined) {
        problems.push(
          `${rel}: doesn't export "${e.name}", which stdlib.toml lists`,
        );
      } else if (isFunction(e) && got !== e.call) {
        problems.push(
          `${rel}: exports \`${got}\`, but stdlib.toml lists \`${e.call}\``,
        );
      } else if (!isFunction(e) && !got.includes(e.call)) {
        problems.push(
          `${rel}: the Constant "${e.name}" is \`${got}\`, but stdlib.toml gives \`${e.call}\``,
        );
      }
    }
    for (const name of exported.keys()) {
      if (!listed.some((e: any) => e.name === name)) {
        problems.push(
          `${rel}: exports "${name}", which stdlib.toml doesn't list (make it private, or list it)`,
        );
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type View = (d: Data, file: string) => string;

const cell = (s: unknown) => String(s ?? '').replaceAll('|', String.raw`\|`);
const code = (s: string) => `\`${s}\``;
const words = (ws: string[]) => ws.map(code).join(', ');
const thousands = (n: number) => String(n).replaceAll(/\B(?=(\d{3})+$)/g, ',');
const todo = (chapter: string) => `_To be written in ${chapter}._`;

const table = (head: string[], rows: unknown[][]): string =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');

const adrLink = (n: string, file: string) =>
  `[ADR ${n}](${relative(dirname(file), join(ADRS, adrFile(n) ?? ''))})`;

// Links each bare "ADR 0030" in a Data File's prose.
const prose = (s: string, file: string) =>
  s.replaceAll(/\bADR (\d{4})\b/g, (_, n) => adrLink(n, file));

const sources = (list: string[], file: string): string =>
  list
    .map(s => {
      const adr = /^ADR (\d{4})$/.exec(s);
      if (adr) {
        return adrLink(adr[1]!, file);
      }
      return `[${s}](${ISSUES}${s.slice(1)})`;
    })
    .join(', ');

const VIEWS: Record<string, View> = {
  version: d =>
    `This is language **${d.version.language}**, with Cost Model **${d.costs.version}**.`,

  'grammar.reserved': d => words([...d.grammar.reserved].sort()),

  'grammar.contextual': d =>
    table(
      ['Contextual keyword', 'Positions'],
      [...d.grammar.contextual]
        .sort((a: any, b: any) => a.word.localeCompare(b.word))
        .map((c: any) => [code(c.word), c.positions.join('; ')]),
    ),

  'grammar.follow': d => words(d.grammar.follow),

  'grammar.chunks': d =>
    table(
      ['Chunk kind', 'Plural'],
      d.grammar.chunk.map((c: any) => [code(c.singular), code(c.plural)]),
    ),

  'grammar.ordinals': d => words(d.grammar.ordinals),

  'grammar.properties': d => words(d.grammar.properties),

  'grammar.text-patterns': d => {
    const t = d.grammar.text_patterns;
    return [
      `- **Keywords:** ${words(t.keywords)}.`,
      `- **Classes:** ${words(t.classes)}.`,
      `- **Anchors:** ${words(t.anchors)}.`,
      `- **Repetitions:** ${words(t.phrases)}.`,
    ].join('\n');
  },

  'grammar.binary-patterns': d => {
    const b = d.grammar.binary_patterns;
    return [
      `- **Integer types:** ${words(b.integer_types)}.`,
      `- **Size units:** ${words(b.size_units)}.`,
      `- **Byte orders:** ${words(b.byte_orders)}.`,
    ].join('\n');
  },

  'grammar.operators': d =>
    table(
      ['Level', 'Associativity', 'Operators'],
      d.grammar.operator.map((o: any) => [
        o.level,
        o.assoc,
        o.ops.map(code).join(', '),
      ]),
    ),

  'grammar.modifiers': d =>
    table(
      ['Modifier', 'Attaches to'],
      d.grammar.modifier.map((m: any) => [code(m.name), m.attaches]),
    ),

  'grammar.decisions': d =>
    table(
      ['Decision', 'Rule'],
      d.grammar.decision.map((x: any) => [code(x.name), x.rule]),
    ),

  'grammar.advanced': d =>
    table(
      ['Advanced Construct', 'Written', 'Beginner Surface form'],
      d.grammar.advanced.map((a: any) => [a.construct, a.written, a.beginner]),
    ),

  'grammar.syntax-errors': d =>
    table(
      ['Code', 'Raised when'],
      d.grammar.syntax_error.map((e: any) => [code(e.code), e.raised_when]),
    ),

  diagnostics: (d, file) =>
    table(
      ['Code', 'Raised when', 'Reported at', 'Sources'],
      (d.diagnostics.diagnostic ?? []).map((e: any) => [
        code(e.code),
        prose(e.raised_when, file),
        e.at,
        sources(e.sources, file),
      ]),
    ),

  unicode: d => {
    if (!d.unicode.version) {
      return todo('chapter 1');
    }
    return [
      `The pinned Unicode version is **${d.unicode.version}**.`,
      table(
        ['UCD file', 'Used for', 'SHA-256'],
        d.unicode.file.map((f: any) => [code(f.path), f.use, code(f.sha256)]),
      ),
    ].join('\n\n');
  },

  'units.kinds': d =>
    table(
      ['Unit Kind', 'Base Unit', 'Dimension'],
      d.units.kind.map((k: any) => [
        k.name,
        code(k.base),
        k.calendar
          ? 'none (Calendar Units)'
          : k.factor
            ? `${k.dimension}, with ${code(k.base)} = ${k.factor}`
            : k.dimension,
      ]),
    ),

  'units.units': d =>
    table(
      ['Unit', 'Plural', 'Unit Kind', 'Factor to the Base Unit'],
      d.units.unit.map((u: any) => [
        code(u.name),
        u.plural ? code(u.plural) : '',
        u.kind,
        u.ratio ? `${u.ratio[0]}/${u.ratio[1]}` : u.factor,
      ]),
    ),

  errors: (d, file) => {
    const errors = d.errors.error ?? [];
    const fieldList = (e: any) => {
      const req = e.fields.map(code).join(', ');
      const opt = e.optional?.length
        ? `optional: ${e.optional.map(code).join(', ')}`
        : '';
      return [req, opt].filter(Boolean).join('; ') || 'none';
    };
    const parts = [
      `**Reserved keys:** ${d.errors.reserved.map(code).join(', ')}. The Core sets them, and a Host \`Fail\`'s \`Data\` may not use them.`,
      table(
        ['Code', 'Fields', 'Raised when', 'Sources'],
        errors.map((e: any) => [
          code(e.code),
          fieldList(e),
          prose(e.raised_when, file),
          sources(e.sources, file),
        ]),
      ),
    ];
    const open = errors.filter((e: any) => e.open);
    if (open.length) {
      parts.push(
        'Still open:',
        open
          .map((e: any) => `- ${code(e.code)}: ${prose(e.open, file)}.`)
          .join('\n'),
      );
    }
    return parts.join('\n\n');
  },

  'errors.messages': d =>
    table(
      ['Code', 'Message'],
      (d.errors.error ?? []).map((e: any) => [code(e.code), e.message]),
    ),

  limits: (d, file) =>
    table(
      [
        'Limit',
        'Go',
        'TS',
        'Counts',
        'Per',
        'Tightened per Delivery',
        'Default',
        'Minimum',
        'When exceeded',
        'Sources',
      ],
      d.limits.limit.map((l: any) => [
        l.name,
        code(l.go),
        code(l.ts),
        l.measure,
        l.per,
        l.overridable ? 'yes' : 'no',
        thousands(l.default),
        thousands(l.minimum),
        l.exceeded,
        sources(l.sources, file),
      ]),
    ),

  'machine.operands': d =>
    table(
      ['Operand kind', 'Is'],
      Object.entries(d.machine.operand ?? {}).map(([k, v]) => [
        code(k),
        v as string,
      ]),
    ),

  costs: d => {
    const head = `Cost Model **${d.costs.version}**.`;
    const rows = (d.costs.rate ?? []).filter(
      (r: any) => !r.key.startsWith('builtin.'),
    );
    return [
      head,
      table(
        ['Cost Model key', 'Fuel', 'Allocation', 'Input'],
        rows.map((r: any) => [
          code(r.key),
          code(r.fuel),
          r.alloc ? code(r.alloc) : '0',
          r.input ?? '',
        ]),
      ),
    ].join('\n\n');
  },

  'costs.builtins': d =>
    table(
      ['Built-in', 'Fuel', 'Allocation', 'Input'],
      (d.costs.rate ?? [])
        .filter((r: any) => r.key.startsWith('builtin.'))
        .map((r: any) => [
          code(r.key.slice(8)),
          code(r.fuel),
          r.alloc ? code(r.alloc) : '0',
          r.input ?? '',
        ]),
    ),

  'costs.measures': d =>
    [
      table(
        ['Measure', 'Counts'],
        Object.entries(d.costs.measure ?? {}).map(([k, v]) => [
          code(k),
          v as string,
        ]),
      ),
      table(
        ['Subject', 'Is'],
        Object.entries(d.costs.subject ?? {}).map(([k, v]) => [
          code(k),
          v as string,
        ]),
      ),
    ].join('\n\n'),

  'costs.changes': (d, file) =>
    table(
      ['Issue', 'Change'],
      (d.costs.change ?? []).map((c: any) => [
        sources([c.issue], file),
        prose(c.change, file),
      ]),
    ),

  'costs.sizes': d =>
    table(
      ['Of', 'Logical size'],
      (d.costs.size ?? []).map((s: any) => [s.of, code(s.size)]),
    ),

  'host-errors': (d, file) =>
    table(
      ['Code', 'Raised when'],
      d['host-errors'].error.map((e: any) => [
        code(e.code),
        prose(e.raised_when, file),
      ]),
    ),

  'corpus.types': d =>
    table(
      ['Type', 'Written as'],
      Object.entries(d.corpus.type ?? {}).map(([k, v]) => [
        code(k),
        v as string,
      ]),
    ),

  'corpus.inputs': d => recordTable(d, true),
  'corpus.outputs': d => recordTable(d, false),
  'corpus.input-keys': d => keyTable(d, true),
  'corpus.output-keys': d => keyTable(d, false),

  'corpus.ends': d =>
    table(
      ['End reason', 'The stretch ended because'],
      (d.corpus.end ?? []).map((e: any) => [code(e.word), e.is]),
    ),

  'corpus.notes': d =>
    table(
      ['Note', 'Noted when'],
      (d.corpus.note ?? []).map((e: any) => [code(e.word), e.is]),
    ),

  'corpus.setup': d =>
    table(
      ['Table', 'Key', 'Holds', 'Case kinds'],
      (d.corpus.setup ?? []).map((e: any) => [
        e.table ? code(`[${e.table}]`) : 'top level',
        code(e.key),
        e.is,
        e.kinds.join(', '),
      ]),
    ),

  'session.commands': d =>
    table(
      ['Command', 'Written', 'Does', 'Notes'],
      (d.session.command ?? []).map((c: any) => [
        code(c.name),
        code(c.usage),
        c.does,
        [
          c.before ? 'before the session starts' : '',
          c.recorded === false ? 'not recorded' : '',
        ]
          .filter(Boolean)
          .join('; '),
      ]),
    ),

  // Appendix A: CONTEXT.md from its first section on, with its relative links
  // rebased onto the region's file.
  glossary: (_d, file) => {
    const source = join(ROOT, 'CONTEXT.md');
    const text = glossarySource;
    const start = text.search(/^## /m);
    if (start < 0) {
      problems.push('CONTEXT.md: no `## ` sections to put in Appendix A');
      return '';
    }
    return rebaseLinks(text.slice(start).trim(), source, file);
  },
};

const glossarySource = await Bun.file(join(ROOT, 'CONTEXT.md')).text();

// Chapter 11: the Trace's records, as a summary and key by key.
const recordIds = (r: any) =>
  r.ids
    .map((i: string) =>
      i.endsWith('?') ? `${code(i.slice(0, -1))} (optional)` : code(i),
    )
    .join(', ');

const recordTable = (d: Data, input: boolean): string =>
  table(
    ['Record', 'Ids', 'Keys', 'Says'],
    (d.corpus.record ?? [])
      .filter((r: any) => r.input === input)
      .map((r: any) => [
        code(r.name),
        recordIds(r),
        (r.key ?? [])
          .map(
            (k: any) =>
              code(k.key) +
              (k.optional ? '?' : '') +
              (k.filled ? String.raw`\*` : ''),
          )
          .join(', '),
        r.is,
      ]),
  );

const keyTable = (d: Data, input: boolean): string => {
  const words = (k: any) =>
    k.words ? `: ${k.words.map(code).join(', ')}` : '';
  return table(
    ['Record', 'Key', 'Type', 'Is'],
    (d.corpus.record ?? [])
      .filter((r: any) => r.input === input)
      .flatMap((r: any) =>
        (r.key ?? []).map((k: any) => [
          code(r.name),
          code(k.key),
          code(k.type),
          k.is + words(k),
        ]),
      ),
  );
};

// Chapter 7: one region per Built-in group, stdlib Library and Standard Capability.
// costs.toml (ADRs 0006 and 0010): every formula parses and uses only the
// measures and subjects it lists, where they apply; every Cost Model key in
// machine.toml, and every Built-in, has one rate; and every kind has a size.
const COST_ONLY_KEYS = new Set(['clause', 'unwind']);
const KINDS = [
  'nothing',
  'boolean',
  'number',
  'quantity',
  'text',
  'bytes',
  'list',
  'map',
  'range',
  'instant',
  'civil date',
  'pattern',
  'function',
  'object',
];
const STATE_SIZES = [
  'iterator',
  'replacement',
  'reader',
  'frame',
  'run',
  'message',
  'pending call',
];

const formulaProblems = (
  f: string,
  ok: (measure: string, subject: string | null) => string | null,
  measures: Set<string>,
  subjects: Set<string>,
): string[] => {
  const out: string[] = [];
  for (const term of f.split('+').map(t => t.trim())) {
    const m =
      /^(?:(\d+) \* )?([\da-z]+)(?:\(([\da-z]+)\))?(?: \/ (\d+))?$/.exec(term);
    if (/^\d+$/.test(term)) {
      continue;
    }
    if (!m) {
      out.push(`the term \`${term}\` isn't a number or [n *] measure [/ n]`);
      continue;
    }
    const [, , measure, subject] = m;
    if (!measures.has(measure!)) {
      out.push(`\`${measure}\` isn't a measure`);
    } else if (subject && !subjects.has(subject) && !/^x[1-9]$/.test(subject)) {
      out.push(`\`${subject}\` isn't a subject`);
    } else {
      const why = ok(measure!, subject ?? null);
      if (why) {
        out.push(why);
      }
    }
  }
  return out;
};

const costsCheck = (d: Data, fail: (file: string, msg: string) => void) => {
  const c = d.costs;
  const measures = new Set(Object.keys(c.measure ?? {}));
  const subjects = new Set(Object.keys(c.subject ?? {}));
  const BARE = new Set([
    'scanned',
    'steps',
    'frames',
    'clauses',
    'count',
    'declared',
  ]);
  const machineKeys = new Map<string, any[]>();
  for (const i of d.machine.instruction ?? []) {
    machineKeys.set(i.cost, [...(machineKeys.get(i.cost) ?? []), i]);
  }
  const builtins = new Map<string, any>(
    (d.stdlib.builtin ?? [])
      .filter((b: any) => b.group !== 'constants')
      .map((b: any) => [b.name, b]),
  );
  for (const k of duplicates((c.rate ?? []).map((r: any) => r.key))) {
    fail('costs.toml', `the key "${k}" is rated twice`);
  }
  for (const r of c.rate ?? []) {
    const isBuiltin = r.key.startsWith('builtin.');
    const name = r.key.slice('builtin.'.length);
    if (isBuiltin && !builtins.has(name)) {
      fail('costs.toml', `"${r.key}" rates no Built-in`);
    }
    if (!isBuiltin && !machineKeys.has(r.key) && !COST_ONLY_KEYS.has(r.key)) {
      fail(
        'costs.toml',
        `"${r.key}" isn't a Cost Model key of any instruction`,
      );
    }
    const args = isBuiltin
      ? (/\((.*)\)/.exec(builtins.get(name)?.call ?? '')?.[1] ?? '')
          .split(',')
          .filter((a: string) => a.trim()).length
      : 0;
    const ok = (measure: string, subject: string | null): string | null => {
      if (BARE.has(measure) === !!subject) {
        return `\`${measure}\` ${BARE.has(measure) ? 'takes no subject' : 'needs a subject'}`;
      }
      if (measure === 'declared' && r.key !== 'capability') {
        return '`declared` is only for Capability calls';
      }
      if (measure === 'frames' && r.key !== 'unwind') {
        return '`frames` is only for unwinding';
      }
      if (measure === 'clauses' && r.key !== 'clause') {
        return '`clauses` is only for dispatch';
      }
      if ((measure === 'scanned' || subject === 'input') && !r.input) {
        return `\`${subject === 'input' ? 'input' : 'scanned'}\` needs the rate to say what its input is`;
      }
      if (subject === 'v') {
        return '`v` is only for sizes';
      }
      if (
        subject &&
        /^x\d$/.test(subject) &&
        (!isBuiltin || Number(subject.slice(1)) > args)
      ) {
        return `\`${subject}\` isn't an argument of this Built-in`;
      }
      return null;
    };
    for (const f of ['fuel', 'alloc'] as const) {
      if (r[f] === undefined) {
        continue;
      }
      for (const p of formulaProblems(r[f], ok, measures, subjects)) {
        fail('costs.toml', `"${r.key}" ${f}: ${p}`);
      }
    }
  }
  const rated = new Set((c.rate ?? []).map((r: any) => r.key));
  for (const k of COST_ONLY_KEYS) {
    if (!rated.has(k)) {
      fail('costs.toml', `"${k}" has no rate`);
    }
  }
  for (const b of builtins.keys()) {
    if (!rated.has(`builtin.${b}`)) {
      fail('costs.toml', `the Built-in "${b}" has no rate`);
    }
  }
  const sized = (c.size ?? []).map((s: any) => s.of);
  for (const k of [...KINDS, ...STATE_SIZES]) {
    if (!sized.includes(k)) {
      fail('costs.toml', `"${k}" has no size`);
    }
  }
  for (const s of c.size ?? []) {
    const ok = (measure: string, subject: string | null) =>
      BARE.has(measure) || subject !== 'v'
        ? `a size is measured over \`v\``
        : null;
    for (const p of formulaProblems(s.size, ok, measures, subjects)) {
      fail('costs.toml', `the size of ${s.of}: ${p}`);
    }
  }
};

// Chapter 8: one region per group of instructions.
const MACHINE_GROUPS = [
  'values',
  'control',
  'operators',
  'access',
  'building',
  'calls',
  'patterns',
  'loops',
  'errors',
  'effects',
] as const;
const machineViews = (d: Data) => {
  for (const g of MACHINE_GROUPS) {
    VIEWS[`machine.${g}`] = () => {
      const rows = (d.machine.instruction ?? []).filter(
        (i: any) => i.group === g,
      );
      return table(
        ['Instruction', 'Operands', 'Pops', 'Pushes', 'Does', 'Raises'],
        rows.map((i: any) => [
          code(i.name) + (i.suspends ? ' (suspends)' : ''),
          i.operands
            .map((k: string) =>
              k.endsWith('?') ? `${code(k.slice(0, -1))} (optional)` : code(k),
            )
            .join(', '),
          String(i.pops),
          String(i.pushes) + (i.jumps ? `, ${i.jumps} on a jump` : ''),
          i.does,
          (i.errors ?? []).map(code).join(', '),
        ]),
      );
    };
  }
};

const stdlibViews = (d: Data) => {
  const s = d.stdlib;
  const raises = (e: any) => (e.errors ?? []).map(code).join(', ');
  for (const g of BUILTIN_GROUPS) {
    const rows = (s.builtin ?? []).filter((b: any) => b.group === g);
    VIEWS[`stdlib.builtins.${g}`] = () =>
      g === 'constants'
        ? table(
            ['Constant', 'Value', 'Is'],
            rows.map((b: any) => [code(b.name), code(b.call), b.gives]),
          )
        : table(
            ['Built-in', 'Gives', 'Also raises'],
            rows.map((b: any) => [code(b.call), b.gives, raises(b)]),
          );
  }
  for (const lib of s.libraries ?? []) {
    VIEWS[`stdlib.${lib}`] = () =>
      table(
        ['Export', 'Gives', 'Also raises'],
        (s.export ?? [])
          .filter((e: any) => e.library === lib)
          .map((e: any) => [
            isFunction(e) ? code(e.call) : `${code(e.name)} = ${code(e.call)}`,
            e.gives,
            raises(e),
          ]),
      );
  }
  VIEWS['stdlib.encodings'] = () =>
    table(
      ['Encoding', 'Bytes'],
      (s.encoding ?? []).map((e: any) => [code(`"${e.name}"`), e.bytes]),
    );
  for (const c of s.capabilities ?? []) {
    VIEWS[`stdlib.capability.${c}`] = () =>
      table(
        ['Operation', 'Mode', 'Gives', 'Errors'],
        (s.operation ?? [])
          .filter((o: any) => o.capability === c)
          .map((o: any) => [code(o.call), o.mode, o.gives, raises(o)]),
      );
  }
};

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

const REGION = /^<!-- generated: ([\d.a-z-]+) -->\n[\S\s]*?^<!-- end -->/gm;

const markdownFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      return markdownFiles(p);
    }
    return p.endsWith('.md') ? [p] : [];
  });

const fillRegions = async (d: Data): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const file of markdownFiles(SPEC)) {
    const rel = relative(ROOT, file);
    const before = await Bun.file(file).text();
    const opens = before.match(/^<!-- generated:/gm)?.length ?? 0;
    const closed = before.match(REGION)?.length ?? 0;
    if (opens !== closed) {
      problems.push(`${rel}: a generated region has no \`<!-- end -->\``);
    }
    const after = before.replaceAll(REGION, (whole, name: string) => {
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
      if (check) {
        problems.push(`${rel} is out of date: run \`bun run spec:gen\``);
      } else {
        await Bun.write(file, after);
      }
    }
  }
  for (const name of Object.keys(VIEWS)) {
    if (!used.has(name)) {
      problems.push(`view "${name}" isn't shown in any region`);
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const INLINE_LINK = /\[[^\]]*]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
const REF_LINK = /^\[[^\]]+]:\s*(\S+)/gm;

const stripCode = (text: string): string =>
  text.replaceAll(/^(```|~~~)[\S\s]*?^\1/gm, '').replaceAll(/`[^\n`]*`/g, '');

const links = (text: string): string[] => {
  const t = stripCode(text);
  return [...t.matchAll(INLINE_LINK), ...t.matchAll(REF_LINK)].map(m => m[1]!);
};

const isRelative = (href: string) =>
  !/^[a-z][\d+.a-z-]*:/i.test(href) && !href.startsWith('#');

const rebaseLinks = (text: string, from: string, to: string): string => {
  const rebase = (href: string) => {
    if (!isRelative(href)) {
      return href;
    }
    const [path, anchor] = href.split('#');
    const moved = relative(dirname(to), resolve(dirname(from), path!));
    return anchor === undefined ? moved : `${moved}#${anchor}`;
  };
  return text
    .replaceAll(INLINE_LINK, (m, href: string) =>
      m.replace(`(${href}`, `(${rebase(href)}`),
    )
    .replaceAll(REF_LINK, (m, href: string) => m.replace(href, rebase(href)));
};

// GitHub's heading anchors.
const anchors = (text: string): Set<string> => {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  // Only fenced blocks: GitHub keeps the text of inline code in an anchor.
  const unfenced = text.replaceAll(/^(```|~~~)[\S\s]*?^\1/gm, '');
  for (const m of unfenced.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = m[1]!
      .replaceAll(/<[^>]+>/g, '')
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
      .replaceAll(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
};

const packageScripts = new Map<string, Set<string>>();
const scriptsAt = (directory: string): Set<string> | undefined => {
  const path = resolve(ROOT, directory, 'package.json');
  if (!existsSync(path)) {
    return undefined;
  }
  let scripts = packageScripts.get(path);
  if (!scripts) {
    scripts = new Set(
      Object.keys(JSON.parse(readFileSync(path, 'utf8')).scripts ?? {}),
    );
    packageScripts.set(path, scripts);
  }
  return scripts;
};

const checkDocumentation = async (regenerated: Map<string, string>) => {
  const listed = Bun.spawnSync(
    ['git', 'ls-files', '-co', '--exclude-standard', '*.md'],
    { cwd: ROOT },
  );
  const files = new TextDecoder()
    .decode(listed.stdout)
    .split('\n')
    .filter(Boolean)
    .map(f => join(ROOT, f));
  const read = async (f: string) =>
    regenerated.get(f) ?? (await Bun.file(f).text());
  for (const file of files) {
    if (!existsSync(file)) {
      continue;
    }
    const text = await read(file);
    problems.push(
      ...checkCommands(text, scriptsAt).map(
        problem => `${relative(ROOT, file)}: ${problem}`,
      ),
    );
    for (const href of links(text)) {
      if (/^[a-z][\d+.a-z-]*:/i.test(href)) {
        continue;
      }
      const [path, anchor] = href.split('#');
      const target = path
        ? resolve(dirname(file), decodeURIComponent(path))
        : file;
      const where = `${relative(ROOT, file)}: link \`${href}\``;
      if (!existsSync(target)) {
        problems.push(`${where} points to a missing file`);
      } else if (
        anchor &&
        target.endsWith('.md') &&
        !anchors(await read(target)).has(anchor)
      ) {
        problems.push(`${where} points to a missing heading`);
      }
    }
  }
};

// ---------------------------------------------------------------------------

const data = await loadData();
const ebnf = await loadEbnf();
const traceEbnf = await loadEbnf('trace.ebnf');
for (const s of [...ebnf, ...traceEbnf]) {
  VIEWS[`ebnf.${s.name}`] = () => '```ebnf\n' + s.text + '\n```';
}
stdlibViews(data);
machineViews(data);
crossCheck(data);
stdlibCheck(data);
await stdlibSourceCheck(data);
ebnfCheck(data, ebnf);
traceEbnfCheck(traceEbnf, ebnf);
corpusCheck(data);
const regenerated = await fillRegions(data);
await checkDocumentation(regenerated);

if (problems.length) {
  for (const p of problems) {
    console.error(`✗ ${p}`);
  }
  process.exit(1);
}
console.log(
  check ? '✓ The Spec is up to date.' : "✓ The Spec's regions are filled.",
);
