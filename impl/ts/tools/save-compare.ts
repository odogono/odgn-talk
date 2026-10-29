#!/usr/bin/env bun
// Dev tool: replay Trace Cases on the TS Core and the Zig reactor, restoring
// between Pumps, and compare each hidden save the two write.
//   bun tools/save-compare.ts [--show] case …
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Setup } from '../src/replay';
import { tsCore, type CaseCore } from '../src/setup';
import { createCore } from '../src/wasm/index';
import { readRecords, rawIO } from './save-raw';
import { replayLines } from './case-checks';
import { reader } from './trace-case';
import type { TsGroup } from '../src/index';

const root = resolve(import.meta.dirname, '../../..');
const module = await WebAssembly.compile(
  readFileSync(resolve(root, '.cache/zig-wasi/bin/talk.wasm')),
);
const args = process.argv.slice(2);
const show = args.includes('--show');

const restoring = !process.argv.includes('--no-restore');
import { stateFingerprint as fingerprintOf } from '../src/save-format';
const crossNotes: string[] = [];
/** Restores each of `other`'s saves on this Core beside the replay's own, and saves it again. */
const crossing = (
  core: CaseCore,
  other: Uint8Array[] | undefined,
  label: string,
): CaseCore => {
  if (!other) {
    return core;
  }
  let n = 0;
  return {
    ...core,
    restore: (b, o) => {
      const theirs = other[n++];
      if (theirs?.length) {
        try {
          const again = core
            .restore(theirs, { ...o, trace: undefined, session: undefined })
            .group.save();
          const same =
            Buffer.compare(fingerprintOf(again), fingerprintOf(theirs)) === 0;
          if (!same) {
            const a = flat(readRecords(again, rawIO));
            const b = flat(readRecords(theirs, rawIO));
            const keys = [...new Set([...a.keys(), ...b.keys()])].filter(
              k => a.get(k) !== b.get(k),
            );
            crossNotes.push(
              `${label} restore ${n}: ${keys
                .slice(0, 6)
                .map(k => `${k} ${b.get(k)}->${a.get(k)}`)
                .join('; ')}`,
            );
          }
        } catch (error) {
          crossNotes.push(
            `${label} restore ${n}: ${String(error).split('\n')[0]}`,
          );
        }
      }
      return core.restore(b, o);
    },
  };
};
const capture = (core: CaseCore, saves: Uint8Array[]): CaseCore => {
  const wrap = (g: TsGroup): TsGroup => {
    const save = g.save.bind(g);
    g.save = (o?: Parameters<TsGroup['save']>[0]) => {
      const bytes = save(o);
      saves.push(bytes);
      return bytes;
    };
    if (!restoring) {
      const pump = g.pump.bind(g);
      g.pump = ((...a: Parameters<TsGroup['pump']>) => {
        try {
          saves.push(save());
        } catch {
          saves.push(new Uint8Array());
        }
        return pump(...a);
      }) as TsGroup['pump'];
    }
    return g;
  };
  return {
    ...core,
    newGroup: o => wrap(core.newGroup(o)),
    restore: (b, o) => {
      const r = core.restore(b, o);
      return { group: wrap(r.group), result: r.result };
    },
  };
};

const debug = Object.freeze({
  isPaused: false,
  current: undefined,
  landAt() {
    throw new Error('landing');
  },
});
const zigCore = async (): Promise<CaseCore> => {
  const core = await createCore({ wasm: module, diagnostics: () => {} });
  const declared = new Map<unknown, unknown>();
  const compileLibrary: CaseCore['compileLibrary'] = (src, imports, d) => {
    const l = core.compileLibrary(src, imports ? [...imports] : [], d);
    declared.set(l, d);
    return l;
  };
  return {
    ...tsCore,
    compileLibrary,
    replacementLibraries: (available, replacement) => {
      const affected = new Set([replacement.name]);
      for (let changed = true; changed;) {
        changed = false;
        for (const held of available.values()) {
          if (
            !affected.has(held.name) &&
            held.imports.some(i => affected.has(i.name))
          ) {
            affected.add(held.name);
            changed = true;
          }
        }
      }
      const libraries = new Map(available);
      libraries.set(replacement.name, replacement);
      const pending = [...available.values()].filter(
        l => l.name !== replacement.name && affected.has(l.name),
      );
      const rebuilt = new Set([replacement.name]);
      while (pending.length) {
        const at = pending.findIndex(l =>
          l.imports.every(d => !affected.has(d.name) || rebuilt.has(d.name)),
        );
        const old = pending.splice(at, 1)[0]!;
        libraries.set(
          old.name,
          compileLibrary(
            { name: old.name, source: old.source, version: old.version },
            [...libraries.values()],
            declared.get(old) as never,
          ),
        );
        rebuilt.add(old.name);
      }
      return libraries;
    },
    defineObjectKind: k => core.defineObjectKind(k),
    newGroup: o =>
      Object.assign(core.newGroup(o), { debug: () => debug }) as never,
    restore: (b, o) => {
      const r = core.restore(b, o);
      Object.assign(r.group, { debug: () => debug });
      return r as never;
    },
  };
};

const json = (v: unknown) =>
  JSON.stringify(
    v,
    (_k, x) =>
      typeof x === 'bigint'
        ? String(x)
        : ArrayBuffer.isView(x)
          ? Buffer.from(x as Uint8Array)
              .toString('hex')
              .slice(0, 12)
          : x,
    1,
  );

const flat = (v: unknown, path = '', out = new Map<string, string>()) => {
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
    for (const [k, x] of Object.entries(v)) {
      flat(x, path ? `${path}.${k}` : k, out);
    }
  } else if (v !== undefined) {
    out.set(
      path,
      typeof v === 'bigint'
        ? String(v)
        : ArrayBuffer.isView(v)
          ? Buffer.from(v as Uint8Array)
              .toString('hex')
              .slice(0, 16)
          : JSON.stringify(v),
    );
  }
  return out;
};
let bad = 0;
const casesUnder = (dir: string): string[] => {
  if (!statSync(dir).isDirectory()) {
    return [];
  }
  const entries = readdirSync(dir);
  if (entries.includes('case.toml')) {
    return [dir];
  }
  return entries.sort().flatMap(e => casesUnder(resolve(dir, e)));
};
const named = args.filter(a => !a.startsWith('--'));
const all = (named.length ? named : ['.'])
  .flatMap(n => casesUnder(resolve(root, 'corpus', n)))
  .map(d => d.slice(resolve(root, 'corpus').length + 1));
for (const name of all) {
  try {
    const dir = resolve(root, 'corpus', name);
    const setup = Bun.TOML.parse(
      readFileSync(resolve(dir, 'case.toml'), 'utf8'),
    ) as Setup;
    const file = readFileSync(resolve(dir, 'case.trace'), 'utf8').split('\n');
    if ((setup as { kind?: string }).kind !== 'trace') {
      continue;
    }
    const ts: Uint8Array[] = [];
    const zig: Uint8Array[] = [];
    replayLines(reader(dir), setup, file, {
      core: capture(tsCore, ts),
      restoreBetweenPumps: restoring,
    });
    replayLines(reader(dir), setup, file, {
      core: capture(
        crossing(
          await zigCore(),
          args.includes('--cross') ? ts : undefined,
          'zig<-ts',
        ),
        zig,
      ),
      restoreBetweenPumps: restoring,
    });
    if (args.includes('--cross')) {
      replayLines(reader(dir), setup, file, {
        core: crossing(tsCore, zig, 'ts<-zig'),
        restoreBetweenPumps: restoring,
      });
      for (const note of crossNotes.splice(0)) {
        console.log(`CROSS ${name}: ${note}`);
      }
    }
    const dump = args.find(a => a.startsWith('--dump='));
    if (dump) {
      const pick = process.env.SIDE === 'ts' ? ts : zig;
      console.log(json(readRecords(pick[Number(dump.slice(7)) - 1]!, rawIO)));
      continue;
    }
    let same = ts.length === zig.length;
    const n = Math.min(ts.length, zig.length);
    for (let i = 0; i < n; i++) {
      if (Buffer.compare(ts[i]!, zig[i]!) === 0) {
        continue;
      }
      if (!ts[i]!.length || !zig[i]!.length) {
        same = false;
        console.log(
          `REFUSED ${name} save ${i + 1}: ts ${ts[i]!.length} zig ${zig[i]!.length}`,
        );
        break;
      }
      same = false;
      const a = flat(readRecords(ts[i]!, rawIO));
      const b = flat(readRecords(zig[i]!, rawIO));
      const keys = [...new Set([...a.keys(), ...b.keys()])];
      const diffs = keys.filter(k => a.get(k) !== b.get(k));
      console.log(`DIFF ${name} save ${i + 1}/${n}: ${diffs.length} fields`);
      if (show) {
        for (const k of diffs.slice(0, Number(process.env.CTX ?? 20))) {
          console.log(`  ${k}: zig ${b.get(k)} ts ${a.get(k)}`);
        }
      }
      break;
    }
    if (same) {
      console.log(`SAME ${name} (${n} saves)`);
    } else {
      bad++;
      if (ts.length !== zig.length) {
        console.log(`COUNT ${name}: ts ${ts.length} zig ${zig.length}`);
      }
    }
  } catch (error) {
    bad++;
    console.log(`ERROR ${name}: ${String(error).split('\n')[0]}`);
  }
}
process.exit(bad ? 1 : 0);
