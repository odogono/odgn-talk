// The repo files northtalk.org publishes (ADR 0140). Each one must read well
// both on GitHub and on the site. A link between two listed files becomes a
// site link, and a link to any other repo path goes to GitHub.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export type Source = {
  // Repo-relative path of the Markdown file.
  path: string;
  // Site path without slashes, e.g. `learn/tour`.
  slug: string;
  // Replaces the file's first heading as the page title.
  title?: string;
};

export const repoRoot = join(import.meta.dirname, '../../..');

const specChapters = (): Source[] =>
  readdirSync(join(repoRoot, 'spec'))
    .filter(name => /^(\d\d|appendix)-.*\.md$/.test(name))
    .sort()
    .map(name => ({
      path: `spec/${name}`,
      slug: `reference/spec/${name.replace(/\.md$/, '')}`,
    }));

export const sources = (): Source[] => [
  { path: 'docs/tour.md', slug: 'learn/tour', title: 'Learn NorthTalk' },
  {
    path: 'docs/concepts.md',
    slug: 'learn/concepts',
    title: 'How NorthTalk runs',
  },
  {
    path: 'docs/embedding-typescript.md',
    slug: 'embed/typescript-app',
    title: 'Embed in a TypeScript app',
  },
  { path: 'impl/ts/README.md', slug: 'embed/typescript', title: 'TypeScript' },
  { path: 'impl/go/README.md', slug: 'embed/go', title: 'Go' },
  { path: 'impl/elixir/README.md', slug: 'embed/elixir', title: 'Elixir' },
  { path: 'impl/zig/README.md', slug: 'embed/zig', title: 'Zig' },
  {
    path: 'spec/README.md',
    slug: 'reference/spec',
    title: 'The Specification',
  },
  ...specChapters(),
  { path: 'GLOSSARY.md', slug: 'reference/glossary', title: 'Glossary' },
];
