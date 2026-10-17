#!/usr/bin/env bun
// Prints the unreleased changelog: every fragment under changelog/unreleased/,
// grouped as changelog/README.md describes.
//
//   bun tools/commits/changelog.ts

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { changelogSection, type Fragment, parseFragment } from './fragment';

const DIR = resolve(import.meta.dir, '../../changelog/unreleased');

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

console.log(changelogSection('Unreleased', fragments));
process.exit(failed ? 1 : 0);
