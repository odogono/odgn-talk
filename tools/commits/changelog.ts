#!/usr/bin/env bun
// Prints the unreleased changelog: every fragment under changelog/unreleased/,
// grouped as changelog/README.md describes.
//
//   bun tools/commits/changelog.ts

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Fragment, parseFragment } from './fragment';

const DIR = resolve(import.meta.dir, '../../changelog/unreleased');

const GROUPS: Array<[string, (fragment: Fragment) => boolean]> = [
  ['Breaking', fragment => fragment.breaking],
  ['Added', fragment => !fragment.breaking && fragment.type === 'feat'],
  ['Fixed', fragment => !fragment.breaking && fragment.type === 'fix'],
  ['Performance', fragment => !fragment.breaking && fragment.type === 'perf'],
];

const fragments: Fragment[] = [];
let failed = false;
for (const name of readdirSync(DIR)
  .filter(n => n.endsWith('.md'))
  .sort()) {
  const result = parseFragment(readFileSync(join(DIR, name), 'utf8'));
  if ('errors' in result) {
    failed = true;
    for (const error of result.errors) {
      console.error(`changelog/unreleased/${name}: ${error}`);
    }
  } else {
    fragments.push(result.fragment);
  }
}

const lines = ['## Unreleased'];
for (const [heading, belongs] of GROUPS) {
  const entries = fragments.filter(belongs);
  if (entries.length > 0) {
    lines.push('', `### ${heading}`, '');
    for (const { entry, scope } of entries) {
      const text = entry.replaceAll('\n', '\n  ');
      lines.push(`- ${scope ? `**${scope}:** ` : ''}${text}`);
    }
  }
}
console.log(lines.join('\n'));
process.exit(failed ? 1 : 0);
