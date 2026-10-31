// Copies the listed repo files into Starlight's content collection.
// The output is generated, so it is git-ignored.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { githubBlob, rewritePage } from '../src/rewrite.ts';
import { repoRoot, sources } from '../src/sources.ts';

const out = join(import.meta.dirname, '../src/content/docs/generated');
rmSync(out, { force: true, recursive: true });

const list = sources();
const slugs = new Map(list.map(source => [source.path, source.slug]));

for (const source of list) {
  const text = readFileSync(join(repoRoot, source.path), 'utf8');
  const page = rewritePage(text, source.path, slugs, source.title);
  const file = join(out, `${source.slug}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `---\ntitle: ${JSON.stringify(page.title)}\nslug: ${source.slug}\neditUrl: ${githubBlob.replace('/blob/', '/edit/')}${source.path}\n${source.order === undefined ? '' : `sidebar:\n  order: ${source.order}\n`}---\n\n${page.body}`,
  );
}

console.log(`site: synced ${list.length} pages`);
