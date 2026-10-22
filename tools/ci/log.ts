#!/usr/bin/env bun
// Prints the logs of a Woodpecker pipeline's failed steps, which `gh` cannot
// show: Woodpecker checks link to its own server, not to an Actions run.
//
//   bun run ci:log <pr-number | pipeline-url> [--step <name>] [--tail <lines>]
//
// A PR number reads its failing Woodpecker checks with `gh pr checks`; a URL is
// a check's link, https://<server>/repos/<repo>/pipeline/<number>[/<workflow>].
// --step picks a step by name whatever its state; --tail keeps the last lines
// of each log, 200 by default, or 0 for all of them.

import { execFileSync } from 'node:child_process';

type Pipeline = { number: string; origin: string; repo: string };
type Step = { id: number; name: string; state: string };
type Workflow = { children?: Step[]; name: string; state: string };

const usage =
  'usage: bun run ci:log <pr-number | pipeline-url> [--step <name>] [--tail <lines>]';

const option = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const fromUrl = (link: string): Pipeline | undefined => {
  const match = /^(https?:\/\/[^/]+)\/repos\/(\d+)\/pipeline\/(\d+)/.exec(link);
  return match
    ? { number: match[3]!, origin: match[1]!, repo: match[2]! }
    : undefined;
};

const fromPr = (pr: string): Pipeline[] => {
  const checks = JSON.parse(
    execFileSync('gh', ['pr', 'checks', pr, '--json', 'name,state,link'], {
      encoding: 'utf8',
    }),
  ) as { link: string; name: string; state: string }[];
  const failing = checks.filter(
    c => c.name.startsWith('ci/woodpecker/') && c.state === 'FAILURE',
  );
  const seen = new Map<string, Pipeline>();
  for (const check of failing) {
    const pipeline = fromUrl(check.link);
    if (pipeline) {
      seen.set(`${pipeline.origin} ${pipeline.number}`, pipeline);
    }
  }
  return [...seen.values()];
};

const json = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
};

const args = process.argv.slice(2);
const target = args[0];
if (!target || target.startsWith('--')) {
  console.error(usage);
  process.exit(2);
}
const stepName = option(args, '--step');
const tail = Number(option(args, '--tail') ?? 200);

const pipelines = /^\d+$/.test(target)
  ? fromPr(target)
  : [fromUrl(target)].filter(p => p !== undefined);
if (pipelines.length === 0) {
  console.error(
    /^\d+$/.test(target)
      ? `PR ${target} has no failing Woodpecker check`
      : usage,
  );
  process.exit(/^\d+$/.test(target) ? 0 : 2);
}

for (const { number, origin, repo } of pipelines) {
  const api = `${origin}/api/repos/${repo}`;
  const { workflows } = (await json(`${api}/pipelines/${number}`)) as {
    workflows: Workflow[];
  };
  for (const workflow of workflows) {
    for (const step of workflow.children ?? []) {
      if (stepName ? step.name !== stepName : step.state !== 'failure') {
        continue;
      }
      const lines = (await json(`${api}/logs/${number}/${step.id}`)) as {
        data?: string;
      }[];
      const text = lines
        .map(l => (l.data ? Buffer.from(l.data, 'base64').toString() : ''))
        .join('\n')
        .split('\n');
      console.log(
        `== pipeline ${number} ${workflow.name}/${step.name}: ${step.state}`,
      );
      console.log((tail > 0 ? text.slice(-tail) : text).join('\n'));
    }
  }
}
