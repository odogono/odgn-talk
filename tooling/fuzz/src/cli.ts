import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Worker, campaign, evaluate } from './controller';
import { minimize } from './minimize';
import { features, readCase, type Feature } from './model';

const usage = `Usage:
  northtalk-fuzz smoke [--seed <n>] [--count <n>] [--output <dir>] [--budget-ms <n>] [--profile <features>] [--go-runner <path>]
  northtalk-fuzz campaign [--seed <n>] [--output <dir>] [--budget-ms <n>] [--search-ms <n>] [--reduction-ms <n>] [--profile <features>] [--go-runner <path>]
  northtalk-fuzz reproduce <case.json> [--go-runner <path>]
  northtalk-fuzz minimize <case.json> [--output <file>] [--budget-ms <n>] [--go-runner <path>]`;

class UsageError extends Error {}

const integer = (
  value: string | undefined,
  name: string,
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`--${name} must be a non-negative integer`);
  }
  return Number(value);
};

const profile = (value: string | undefined): Feature[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const names = value.split(',').filter(Boolean);
  for (const name of names) {
    if (!(features as readonly string[]).includes(name)) {
      throw new UsageError(
        `Unknown feature '${name}'; expected one of ${features.join(', ')}`,
      );
    }
  }
  return names as Feature[];
};

const loadCase = async (path: string | undefined) => {
  if (!path) {
    throw new UsageError('Expected a case.json path');
  }
  return readCase(JSON.parse(await readFile(path, 'utf8')));
};

const main = async (argv: string[]): Promise<number> => {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      seed: { type: 'string' },
      count: { type: 'string' },
      output: { type: 'string' },
      'budget-ms': { type: 'string' },
      'search-ms': { type: 'string' },
      'reduction-ms': { type: 'string' },
      profile: { type: 'string' },
      'go-runner': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const [command, path] = positionals;
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const goRunner = values['go-runner'];
  const go = () =>
    goRunner ? new Worker({ entrypoint: goRunner, native: true }) : undefined;
  switch (command) {
    case 'smoke':
    case 'campaign': {
      const summary = await campaign({
        mode: command,
        seed: values.seed ?? String(Date.now()),
        output: values.output ?? 'fuzz-findings',
        count: integer(values.count, 'count'),
        budgetMs: integer(values['budget-ms'], 'budget-ms'),
        searchMs: integer(values['search-ms'], 'search-ms'),
        reductionMs: integer(values['reduction-ms'], 'reduction-ms'),
        profile: profile(values.profile),
        goRunner,
        commit: process.env.GITHUB_SHA,
      });
      console.log(JSON.stringify(summary, null, 2));
      return summary.findings ? 1 : 0;
    }
    case 'reproduce': {
      const c = await loadCase(path);
      const ts = new Worker();
      const other = go();
      try {
        const result = await evaluate(c, ts, other);
        console.log(JSON.stringify(result.findings, null, 2));
        return result.findings.length ? 1 : 0;
      } finally {
        ts.close();
        other?.close();
      }
    }
    case 'minimize': {
      const c = await loadCase(path);
      const ts = new Worker();
      const other = go();
      try {
        const [first] = (await evaluate(c, ts, other)).findings;
        if (!first) {
          console.error('The case has no finding to minimize');
          return 1;
        }
        const reduction = await minimize(
          c,
          first.signature,
          async (candidate, remainingMs) =>
            (
              await evaluate(
                candidate,
                ts,
                other,
                Math.min(10_000, remainingMs),
              )
            ).findings,
          { budgetMs: integer(values['budget-ms'], 'budget-ms') },
        );
        const output = values.output ?? 'minimized.json';
        await writeFile(output, JSON.stringify(reduction.case, null, 2) + '\n');
        console.log(
          JSON.stringify(
            {
              output,
              signature: first.signature,
              exhausted: reduction.exhausted,
              attempts: reduction.attempts,
              stages: reduction.stages,
            },
            null,
            2,
          ),
        );
        return 0;
      } finally {
        ts.close();
        other?.close();
      }
    }
    default:
      throw new UsageError(
        command ? `Unknown command '${command}'` : 'Expected a command',
      );
  }
};

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (
    error instanceof UsageError ||
    (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
  ) {
    console.error(`${(error as Error).message}\n${usage}`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
