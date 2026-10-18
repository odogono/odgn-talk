#!/usr/bin/env bun
// Regenerates the issue dependency graph and writes it into the pinned
// issue's body. The `Issue graph` workflow runs this when issues change.
//
//   bun tools/issues/update.ts            # update the pinned issue
//   bun tools/issues/update.ts --print    # print the body instead
//
// Needs an authenticated `gh` (GH_TOKEN in CI).

import { execFileSync } from 'node:child_process';
import { type Issue, renderGraph } from './graph';

// The pinned "Issue dependency graph" issue; it is left out of its own graph.
const GRAPH_ISSUE = 1243;
const REPO = 'odogono/odgn-talk';

const QUERY = `query($endCursor: String) {
  repository(owner: "odogono", name: "odgn-talk") {
    issues(first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state body
        assignees(first: 5) { nodes { login } }
        labels(first: 10) { nodes { name } }
        parent { number }
        subIssues(first: 100) { nodes { number } }
        blockedBy(first: 50) { nodes { number } }
      }
    }
  }
}`;

type Node = {
  assignees: { nodes: { login: string }[] };
  blockedBy: { nodes: { number: number }[] };
  body: string | null;
  labels: { nodes: { name: string }[] };
  number: number;
  parent: { number: number } | null;
  state: 'OPEN' | 'CLOSED';
  subIssues: { nodes: { number: number }[] };
  title: string;
};

const gh = (args: string[], input?: string) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
  });

const out = gh([
  'api',
  'graphql',
  '--paginate',
  '-f',
  `query=${QUERY}`,
  '--jq',
  '.data.repository.issues.nodes[]',
]);

const issues = new Map<number, Issue>();
for (const line of out.split('\n')) {
  if (!line.trim()) {
    continue;
  }
  const n = JSON.parse(line) as Node;
  if (n.number === GRAPH_ISSUE) {
    continue;
  }
  issues.set(n.number, {
    assignees: n.assignees.nodes.map(a => a.login),
    blockedBy: n.blockedBy.nodes.map(b => b.number),
    body: n.body ?? '',
    labels: n.labels.nodes.map(l => l.name),
    number: n.number,
    parent: n.parent?.number,
    state: n.state,
    subIssues: n.subIssues.nodes.map(s => s.number),
    title: n.title,
  });
}

const generated = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const body = renderGraph(issues, generated);

// The timestamp alone changing isn't worth an edit.
const stamp = /^Generated \S+/m;
const current = JSON.parse(
  gh(['issue', 'view', String(GRAPH_ISSUE), '--repo', REPO, '--json', 'body']),
) as { body: string };

if (process.argv.includes('--print')) {
  process.stdout.write(body);
} else if (
  current.body.replaceAll('\r\n', '\n').replace(stamp, '') ===
  body.replace(stamp, '')
) {
  console.log(`#${GRAPH_ISSUE} is up to date`);
} else {
  gh(
    ['issue', 'edit', String(GRAPH_ISSUE), '--repo', REPO, '--body-file', '-'],
    body,
  );
  console.log(`Updated #${GRAPH_ISSUE} from ${issues.size} issues`);
}
