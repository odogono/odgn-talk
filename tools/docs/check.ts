#!/usr/bin/env bun
// Checks the repository's Markdown links, so docs that agents navigate by
// cannot point at a moved file or a renamed heading.
//
//   bun tools/docs/check.ts
//
// Every relative link in a tracked .md file must reach a file or directory,
// and a #fragment on a Markdown target must name one of its headings, by
// GitHub's slug rules. Links inside code are ignored. Each task map,
// impl/*/NAVIGATION.md or tooling/*/NAVIGATION.md, must also be linked from
// AGENTS.md and README.md. No two ADRs share a number.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

const blank = (s: string): string => s.replaceAll(/[^\n]/g, ' ');

/** The text with fenced code blocks blanked, keeping line numbers. */
const withoutFences = (text: string): string =>
  text.replaceAll(
    /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\S\s]*?(?:^\1\2[^\n]*$|(?![\S\s]))/gm,
    blank,
  );

/** The text with fenced code blocks and code spans blanked, keeping line numbers. */
export const withoutCode = (text: string): string =>
  withoutFences(text).replaceAll(/(`+)(?!`)[\S\s]*?(?<!`)\1(?!`)/g, blank);

/** GitHub's heading anchors: lowercased, punctuation dropped, spaces as hyphens, repeats numbered. */
export const anchors = (text: string): Set<string> => {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const [, heading] of withoutFences(text).matchAll(
    /^ {0,3}#{1,6}[\t ]+(.+?)[\t #]*$/gm,
  )) {
    const base = heading!
      .replaceAll(/<[^>]+>/g, '')
      .replaceAll(/\[([^\]]*)]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, '')
      .replaceAll(' ', '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const [, id] of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) {
    out.add(id!);
  }
  return out;
};

const anchorCache = new Map<string, Set<string>>();
const anchorsOf = (path: string): Set<string> => {
  let found = anchorCache.get(path);
  if (!found) {
    found = anchors(readFileSync(path, 'utf8'));
    anchorCache.set(path, found);
  }
  return found;
};

/** The relative link targets in a Markdown file, with their line numbers. */
export const links = (text: string): { line: number; target: string }[] => {
  const prose = withoutCode(text);
  const out: { line: number; target: string }[] = [];
  const add = (target: string, index: number) =>
    out.push({ target, line: prose.slice(0, index).split('\n').length });
  for (const m of prose.matchAll(/]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    add(m[1]!, m.index!);
  }
  for (const m of prose.matchAll(
    /^ {0,3}\[[^\]]+]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm,
  )) {
    add(m[1]!, m.index!);
  }
  return out.filter(({ target }) => !/^[a-z][\d+.a-z-]*:/i.test(target));
};

/** Each ADR number that more than one of the file names claims, with its files. */
export const adrClashes = (names: string[]): string[] => {
  const byNumber = new Map<string, string[]>();
  for (const name of names) {
    const number = /^(\d{4})-/.exec(name)?.[1];
    if (number) {
      byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
    }
  }
  return [...byNumber]
    .filter(([, files]) => files.length > 1)
    .map(
      ([number, files]) => `ADR ${number} is claimed by ${files.join(' and ')}`,
    );
};

/** Every broken link in the tracked Markdown files, every task map AGENTS.md or README.md misses, and every ADR number clash. */
export const check = (): { files: number; problems: string[] } => {
  const problems: string[] = [];
  const tracked = execFileSync('git', ['ls-files', '-z', '*.md'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  for (const file of tracked) {
    const path = join(ROOT, file);
    if (!existsSync(path)) {
      continue;
    }
    for (const { target, line } of links(readFileSync(path, 'utf8'))) {
      const hash = target.indexOf('#');
      const pathPart = decodeURIComponent(
        hash < 0 ? target : target.slice(0, hash),
      );
      const fragment =
        hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
      const dest = pathPart === '' ? path : resolve(dirname(path), pathPart);
      const where = `${file}:${line}`;
      if (!existsSync(dest)) {
        problems.push(`${where}: ${target} does not exist`);
      } else if (
        fragment &&
        dest.endsWith('.md') &&
        !/^L\d+/.test(fragment) &&
        !anchorsOf(dest).has(fragment)
      ) {
        problems.push(
          `${where}: ${relative(ROOT, dest)} has no heading #${fragment}`,
        );
      }
    }
  }
  const maps = ['impl', 'tooling'].flatMap(area =>
    readdirSync(join(ROOT, area))
      .sort()
      .map(dir => `${area}/${dir}/NAVIGATION.md`),
  );
  for (const name of maps) {
    const map = join(ROOT, name);
    if (!existsSync(map) || !statSync(map).isFile()) {
      continue;
    }
    for (const index of ['AGENTS.md', 'README.md']) {
      const reached = links(readFileSync(join(ROOT, index), 'utf8')).some(
        ({ target }) => resolve(ROOT, target.split('#')[0]!) === map,
      );
      if (!reached) {
        problems.push(`${index}: does not link the task map ${name}`);
      }
    }
  }
  for (const clash of adrClashes(readdirSync(join(ROOT, 'docs/adr')).sort())) {
    problems.push(
      `docs/adr: ${clash}; renumber yours from origin/main (docs/agents/domain.md)`,
    );
  }
  return { files: tracked.length, problems };
};

if (import.meta.main) {
  const { files, problems } = check();
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error(
      `✗ ${problems.length} Markdown problem${problems.length === 1 ? '' : 's'}.`,
    );
    process.exit(1);
  }
  console.log(`✓ Links in ${files} Markdown files resolve.`);
}
