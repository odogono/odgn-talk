// Every blessed corpus Run checks the Fuel estimate (#1606): a completed Run
// of a Handler is charged at least its cheapest path and one dispatch; when
// nothing in the Handler depends on values, loops or uncounted calls, it is
// charged at most its dearest path and a dispatch per clause.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Glob } from 'bun';
import { loadScript, lowerTree } from '@northtalk/ts';
import {
  compileLibrary,
  linksOf,
  prepare,
  type Library,
} from '../../../impl/ts/src/library';
import {
  shapeOf,
  type OperationSpec,
  type Setup,
} from '../../../impl/ts/src/setup';
import { estimateFuel, type FuelEstimate } from '../src/fuel';

type Case = Setup & {
  kind: string;
  libraries?: { name: string; source: string; version: string }[];
};
const corpus = join(import.meta.dir, '../../../corpus');
const completed =
  /^run (\S+)\/\S+ outcome=completed .*?handler=(\S+) .*?fuel=(\d+)/;

/** Each Script's estimates, or null if this loader can't load it. */
const estimatesOf = (dir: string, spec: Case) => {
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  const available = new Map<string, Library>();
  try {
    for (const l of spec.libraries ?? []) {
      available.set(
        l.name,
        compileLibrary({ ...l, source: read(l.source) }, [
          ...available.values(),
        ]),
      );
    }
  } catch {
    return null;
  }
  const out = new Map<string, FuelEstimate[]>();
  for (const s of spec.scripts ?? []) {
    // The case's own Operations, by Grant; a Standard Capability's are left
    // out, so a Script calling one may lower differently and is skipped below.
    const granted = new Map<string, OperationSpec[]>(
      Object.entries(s.grants ?? {}).map(([grant, g]) => [
        grant,
        (spec.operations ?? []).filter(
          op =>
            op.capability === (g.capability ?? grant) &&
            (g.ops === 'all' || g.ops.includes(op.name)),
        ),
      ]),
    );
    const grants = Object.fromEntries(
      [...granted].map(([grant, ops]) => [
        grant,
        Object.fromEntries(
          ops.map(op => [
            op.name,
            {
              args: (op.args ?? []).map(shapeOf),
              mode: op.mode,
              ...(op.command ? { command: true } : {}),
              ...(op.labels ? { labels: op.labels } : {}),
            },
          ]),
        ),
      ]),
    );
    const { checked, imports } = prepare(
      'script',
      s.name,
      read(s.source),
      available,
      undefined,
      grants,
    );
    if (!checked.ok || !checked.tree) {
      continue;
    }
    try {
      const unit = lowerTree(checked.tree, { name: s.name });
      out.set(
        s.name,
        estimateFuel(
          loadScript(unit, {}, linksOf(imports)) as never,
          (grant, op) =>
            granted.get(grant)?.find(o => o.name === op)?.cost?.fuel,
        ),
      );
    } catch {
      continue;
    }
  }
  return out;
};

test('blessed corpus Runs fall within their Handlers’ Fuel estimates', async () => {
  let lower = 0;
  let exact = 0;
  const wrong: string[] = [];
  for await (const path of new Glob('**/case.toml').scan(corpus)) {
    const dir = dirname(join(corpus, path));
    const spec = Bun.TOML.parse(
      readFileSync(join(corpus, path), 'utf8'),
    ) as Case;
    const trace = join(dir, 'case.trace');
    // A reload or extend replaces the source the estimate was made from.
    if (spec.kind !== 'trace' || !(await Bun.file(trace).exists())) {
      continue;
    }
    const lines = readFileSync(trace, 'utf8').split('\n');
    if (lines.some(l => /^> (reload|extend|restore)/.test(l))) {
      continue;
    }
    const estimates = estimatesOf(dir, spec);
    if (!estimates) {
      continue;
    }
    for (const line of lines) {
      const m = completed.exec(line);
      const clauses = m
        ? estimates
            .get(m[1]!)
            ?.filter(e => e.kind === 'handler' && e.name === m[2])
        : undefined;
      if (!m || !clauses?.length) {
        continue;
      }
      const fuel = Number(m[3]);
      const where = `${relative(corpus, dir)} ${m[1]}.${m[2]}`;
      const min = Math.min(...clauses.map(c => c.min)) + clauses[0]!.clause;
      lower++;
      if (fuel < min) {
        wrong.push(`${where}: ${fuel} < ${min}`);
      }
      if (clauses.every(c => !c.loops.length && !c.terms.length)) {
        const max = Math.max(
          ...clauses.map((c, i) => c.max + c.clause * (i + 1)),
        );
        exact++;
        if (fuel > max) {
          wrong.push(`${where}: ${fuel} > ${max}`);
        }
      }
    }
  }
  expect(wrong).toEqual([]);
  // Guards the loader: of 956 completed corpus Runs, 528 were checked and 64
  // exactly when this was written (#1606).
  expect(lower).toBeGreaterThanOrEqual(500);
  expect(exact).toBeGreaterThanOrEqual(60);
});
