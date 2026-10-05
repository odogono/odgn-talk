#!/usr/bin/env bun
// Checks that the grammar stays predictive, the way the #38 prototype did.
//
//   bun tools/grammar/check.ts               parse everything below and fail on any surprise
//   bun tools/grammar/check.ts --report      also list the two-token decisions, by count
//   bun tools/grammar/check.ts --tree FILE   print the parse tree of one file
//
// It parses the syntax sketch in sketch/, every `talk` code block in docs/ and
// spec/, the stdlib Libraries in spec/stdlib/, and every .talk file in corpus/, all of which must parse. Then it
// parses each case in broken.talk, whose first syntax error must be the one
// the case expects. The parser has no backtracking, throws on a third token
// of lookahead, and records a relex whenever a buffered token lexed in the
// wrong mode, so all of those fail the check too.

import grammar from '../../spec/data/grammar.toml';
import { isRejectedSource } from '../machine/rejected-sources';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { newStats, parse, type Node, type Stats } from './parser';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const problems: string[] = [];
const total: Stats = newStats();

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

const merge = (stats: Stats, where: string) => {
  for (const [s, n] of stats.sites) {
    total.sites.set(s, (total.sites.get(s) ?? 0) + n);
  }
  for (const r of stats.relexes) {
    total.relexes.push({ ...r, site: `${where} ${r.site}` });
  }
};

const mustParse = (src: string, where: string, lineOffset = 0) => {
  const stats = newStats();
  let result;
  try {
    result = parse(src, stats);
  } catch (error) {
    problems.push(`${where}: ${(error as Error).message}`);
    return;
  }
  merge(stats, where);
  const e = result.error;
  if (e) {
    problems.push(
      `${where}:${e.tok.line + lineOffset}:${e.tok.col}: ${e.code}: ${e.message}`,
    );
  }
};

// A `talk` block is a whole source if it starts with a declaration, and
// otherwise a Handler body.
const DECLARATION = /^(on|function|private|use|constant|script\s+variable)\b/;

const codeBlocks = (file: string) => {
  const text = readFileSync(file, 'utf8');
  const where = relative(ROOT, file);
  // A block may sit in a blockquote, as the Spec's examples do.
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
    if (DECLARATION.test(first)) {
      mustParse(body, where, line);
    } else {
      mustParse(`on example\n${body}end example\n`, where, line - 1);
    }
  }
};

// broken.talk: cases separated by `-- case: <label>` lines, each followed by
// `-- expect: <code> at <line>:<col>` or `-- expect: parses`. Lines count from
// the line after the expectation.
const broken = (file = join(import.meta.dir, 'broken.talk')) => {
  const src = readFileSync(file, 'utf8');
  const parts = src.split(/^-- case: /m);
  let line = parts[0]!.split('\n').length;
  for (const part of parts.slice(1)) {
    const [label, expect, ...rest] = part.split('\n');
    const body = rest.join('\n');
    const where = `${relative(ROOT, file)}:${line}`;
    line += part.split('\n').length - 1;
    const m = /^-- expect: (?:(parses)|([ a-z]+) at (\d+):(\d+))$/.exec(
      expect ?? '',
    );
    if (!m) {
      problems.push(`${where}: case "${label}" has no \`-- expect:\` line`);
      continue;
    }
    const stats = newStats();
    let result;
    try {
      result = parse(body, stats);
    } catch (error) {
      problems.push(`${where}: ${(error as Error).message}`);
      continue;
    }
    merge(stats, where);
    const e = result.error;
    const got = e ? `${e.code} at ${e.tok.line}:${e.tok.col}` : 'parses';
    const want = m[1] ? 'parses' : `${m[2]} at ${m[3]}:${m[4]}`;
    if (got !== want) {
      problems.push(
        `${where}: case "${label}": expected ${want}, got ${got}${e ? ` (${e.message})` : ''}`,
      );
    }
  }
};

const tree = (n: any, depth = 0): string => {
  if (n === null || n === undefined) {
    return '';
  }
  if (typeof n !== 'object') {
    return String(n);
  }
  if (Array.isArray(n)) {
    return n.map(x => tree(x, depth)).join('\n');
  }
  const pad = '  '.repeat(depth);
  const fields = Object.entries(n).filter(
    ([k, v]) =>
      k !== 'k' &&
      v !== null &&
      v !== false &&
      !(Array.isArray(v) && !v.length),
  );
  const flat = fields
    .filter(([, v]) => typeof v !== 'object')
    .map(([k, v]) => (v === true ? k : `${k}=${JSON.stringify(v)}`));
  const nested = fields.filter(
    ([, v]) => typeof v === 'object' && !(v as any).t,
  );
  const lines = [`${pad}${n.k}${flat.length ? ' ' + flat.join(' ') : ''}`];
  for (const [k, v] of nested) {
    lines.push(`${pad}  ${k}:`, tree(v, depth + 2));
  }
  return lines.join('\n');
};

const treeAt = args.indexOf('--tree');
if (treeAt >= 0) {
  const file = args[treeAt + 1]!;
  const { ast, error } = parse(readFileSync(file, 'utf8'));
  if (error) {
    console.log(
      `${file}:${error.tok.line}:${error.tok.col}: ${error.code}: ${error.message}`,
    );
  } else {
    console.log((ast as Node[]).map(n => tree(n)).join('\n'));
  }
  process.exit(error ? 1 : 0);
}

for (const f of files(join(import.meta.dir, 'sketch'), '.talk')) {
  mustParse(readFileSync(f, 'utf8'), relative(ROOT, f));
}
for (const f of files(join(ROOT, 'corpus'), '.talk')) {
  const setupFile = join(dirname(f), 'case.toml');
  const traceFile = join(dirname(f), 'case.trace');
  let expected: RegExpExecArray | undefined;
  if (isRejectedSource(f) && existsSync(setupFile) && existsSync(traceFile)) {
    const setup = Bun.TOML.parse(readFileSync(setupFile, 'utf8')) as {
      scripts?: { name: string; source: string }[];
    };
    const names = new Set(
      setup.scripts?.filter(s => s.source === basename(f)).map(s => s.name),
    );
    expected = [
      ...readFileSync(traceFile, 'utf8').matchAll(
        /^diag (\S+) code="([^"]+)" pos=(\d+):(\d+)$/gm,
      ),
    ].find(
      m => names.has(m[1]!) && grammar.syntax_error.some(e => e.code === m[2]),
    );
  }
  if (expected) {
    const { error } = parse(readFileSync(f, 'utf8'));
    if (
      !error ||
      error.code !== expected[2] ||
      error.tok.line !== Number(expected[3]) ||
      error.tok.col !== Number(expected[4])
    ) {
      problems.push(
        `${relative(ROOT, f)}: expected ${expected[2]} at ${expected[3]}:${expected[4]}`,
      );
    }
  } else {
    mustParse(readFileSync(f, 'utf8'), relative(ROOT, f));
  }
}
for (const f of files(join(ROOT, 'spec/stdlib'), '.talk')) {
  mustParse(readFileSync(f, 'utf8'), relative(ROOT, f));
}
for (const dir of ['docs', 'spec']) {
  for (const f of files(join(ROOT, dir), '.md')) {
    codeBlocks(f);
  }
}
broken();
for (const r of total.relexes) {
  problems.push(`${r.site} ${r.line}:${r.col}: relexed ${r.was} as ${r.now}`);
}
for (const d of grammar.decision) {
  if (!total.sites.has(d.name)) {
    problems.push(
      `grammar.toml: decision "${d.name}" is never taken by anything the check parses`,
    );
  }
}

if (args.includes('--report')) {
  console.log('Decisions that read the second token, by count:');
  for (const [s, n] of [...total.sites].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(18)} ${String(n).padStart(5)}`);
  }
  console.log(
    `Relexes: ${total.relexes.length}. Lookahead past two tokens: none (it would throw).`,
  );
}
if (problems.length) {
  for (const p of problems) {
    console.error(`✗ ${p}`);
  }
  process.exit(1);
}
console.log(
  '✓ The grammar parses the sketch, the docs and the corpus predictively, and broken.talk fails where it should.',
);
