// Fails the build when a page links to a site path or fragment that the
// build does not contain.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = join(import.meta.dirname, '../dist');
// Paths served by something other than this build.
const elsewhere = ['/folio/', '/go'];

const pages = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? pages(path)
      : path.endsWith('.html')
        ? [path]
        : [];
  });

const fileFor = (path: string) => {
  const file = join(dist, decodeURIComponent(path));
  return path.endsWith('/')
    ? join(file, 'index.html')
    : existsSync(file)
      ? file
      : `${file}.html`;
};

const ids = new Map<string, Set<string>>();
const idsOf = (file: string) => {
  let set = ids.get(file);
  if (set === undefined) {
    const html = readFileSync(file, 'utf8');
    set = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]!));
    ids.set(file, set);
  }
  return set;
};

const broken: string[] = [];
for (const page of pages(dist)) {
  const html = readFileSync(page, 'utf8');
  for (const [, href] of html.matchAll(/\shref="(\/[^"/][^"]*|\/)"/g)) {
    const [path = '', fragment] = href!.replaceAll('&amp;', '&').split('#');
    if (
      elsewhere.some(prefix => path.startsWith(prefix)) ||
      /^\/_astro\//.test(path)
    ) {
      continue;
    }
    const file = fileFor(path);
    if (!existsSync(file)) {
      broken.push(`${relative(dist, page)}: ${href} (no page)`);
    } else if (
      fragment &&
      file.endsWith('.html') &&
      !idsOf(file).has(decodeURIComponent(fragment))
    ) {
      broken.push(`${relative(dist, page)}: ${href} (no anchor)`);
    }
  }
}

if (broken.length > 0) {
  console.error(`site: ${broken.length} broken links\n${broken.join('\n')}`);
  process.exit(1);
}
console.log('site: links ok');
