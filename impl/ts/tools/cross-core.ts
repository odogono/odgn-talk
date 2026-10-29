#!/usr/bin/env bun
// The cross-Core replay (chapter 11, Cross-Core replays): each Trace Case on
// a runner that hosts both the TS Core and the Zig reactor, every save
// restored on each Core. Four replays per case:
//   ts, zig    each save restored on the Core that took it;
//   ts>zig, zig>ts  starting on one Core, each save restored on the other,
//              so saves alternate between them.
// Each must give the case's Trace. Each restore is also checked: a save of
// the restored Group equals the save apart from its Trace save id counter,
// with the same State Fingerprint. And the two Cores' own replays must save
// byte-identical states.
//
//   bun tools/cross-core.ts [--wasm path/to/talk.wasm] [--quiet] [case …]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { GrantDecls, Library, TsGroup } from '../src/index';
import type { Setup } from '../src/replay';
import { readSave, writeSave } from '../src/save-format';
import { tsCore, type CaseCore } from '../src/setup';
import { checkTraceCase } from './case-checks';
import { DeferredCaseError, reader } from './trace-case';
import { zigCaseCore } from './zig-case-core';

type Side = 'ts' | 'zig';

const root = resolve(import.meta.dirname, '../../..');
const corpusRoot = resolve(root, 'corpus');
const args = process.argv.slice(2);
const at = args.indexOf('--wasm');
const module = await WebAssembly.compile(
  readFileSync(
    at >= 0 ? args[at + 1]! : resolve(root, '.cache/zig-wasi/bin/talk.wasm'),
  ),
);
const quiet = args.includes('--quiet');
const paths = args.filter(
  (arg, i) => !arg.startsWith('--') && (at < 0 || i !== at + 1),
);

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

/** `bytes` with its Trace save id counter set to `counter`. */
const withCounter = (bytes: Uint8Array, counter: number): Uint8Array => {
  const save = readSave(bytes);
  return writeSave(
    { ...save, saveIdCounter: counter },
    save.sections.map(({ body, optional, tag }) => ({ body, optional, tag })),
  );
};

/**
 * Both Cores behind one case interface. Libraries compile on both, and the
 * replay holds the TS Core's; a Zig Group gets the reactor's with the same
 * identity. A save restores on the Core `restoreOn` picks for it.
 */
const dualCore = async (
  start: Side,
  restoreOn: (savedOn: Side) => Side,
  notes: string[],
  saves: Uint8Array[],
): Promise<CaseCore> => {
  const zig = await zigCaseCore(module);
  const cores = { ts: tsCore, zig };
  const zigOf = new Map<string, Library>();
  const declared = new Map<Library, GrantDecls | undefined>();
  const onZig = (l: Library): Library => {
    const found = zigOf.get(hex(l.identity));
    if (!found) {
      throw new Error(`${l.name} has no reactor compilation`);
    }
    return found;
  };
  const savedOn = new WeakMap<Uint8Array, Side>();
  let restores = 0;

  const wrap = (group: TsGroup, side: Side): TsGroup => {
    const save = group.save.bind(group);
    group.save = (o?: Parameters<TsGroup['save']>[0]) => {
      const bytes = save(o);
      savedOn.set(bytes, side);
      saves.push(bytes);
      return bytes;
    };
    if (side === 'zig') {
      const add = group.addLibrary.bind(group);
      const replace = group.replaceLibrary.bind(group);
      group.addLibrary = l => add(onZig(l));
      group.replaceLibrary = (l, carry) => replace(onZig(l), carry);
    }
    return group;
  };

  const compileLibrary: CaseCore['compileLibrary'] = (
    src,
    imports,
    declarations,
  ) => {
    const library = tsCore.compileLibrary(src, imports, declarations);
    const reactor = zig.compileLibrary(
      src,
      (imports ?? []).map(onZig),
      declarations,
    );
    if (!same(library.identity, reactor.identity)) {
      notes.push(`${src.name}: the Cores give different Library identities`);
    }
    zigOf.set(hex(library.identity), reactor);
    declared.set(library, declarations);
    return library;
  };

  return {
    compileLibrary,
    replacementLibraries: (available, replacement) => {
      const replaced = tsCore.replacementLibraries(available, replacement);
      for (const l of replaced.values()) {
        if (!zigOf.has(hex(l.identity))) {
          compileLibrary(
            { name: l.name, source: l.source, version: l.version },
            [...l.imports],
            declared.get(available.get(l.name)!),
          );
        }
      }
      return replaced;
    },
    defineObjectKind: k => {
      zig.defineObjectKind(k);
      return tsCore.defineObjectKind(k);
    },
    newGroup: o => wrap(cores[start].newGroup(o), start),
    restore: (bytes, o) => {
      const from = savedOn.get(bytes) ?? start;
      const to = restoreOn(from);
      const n = ++restores;
      const options = (extra = {}) => ({
        ...o,
        ...(to === 'zig' ? { libraries: o.libraries.map(onZig) } : {}),
        ...extra,
      });
      const restored = cores[to].restore(bytes, options());
      // The same save restored again, off the Trace, and saved at once,
      // unless this restore changed the state (chapter 10, Restoring).
      const r = restored.result;
      const kept =
        !r.variablesOnly &&
        ![
          r.abandonedCalls,
          r.discardedRuns,
          r.disposed,
          r.droppedMessages,
          r.reloaded,
        ].some(changed => changed.length);
      if (kept) {
        try {
          const again = cores[to]
            .restore(bytes, options({ trace: undefined, session: undefined }))
            .group.save();
          const counter = readSave(bytes).saveIdCounter;
          if (!same(withCounter(again, counter), bytes)) {
            notes.push(
              `restore ${n} (${from} to ${to}): its save differs from the restored save`,
            );
          }
          if (
            !same(
              readSave(again).stateFingerprint,
              readSave(bytes).stateFingerprint,
            )
          ) {
            notes.push(
              `restore ${n} (${from} to ${to}): its State Fingerprint differs`,
            );
          }
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes('effects pending')
          ) {
            notes.push(
              `restore ${n} (${from} to ${to}): saving again: ${error instanceof Error ? error.message.split('\n')[0] : error}`,
            );
          }
        }
      }
      return { group: wrap(restored.group, to), result: restored.result };
    },
  };
};

const casesUnder = (path: string): string[] => {
  if (statSync(path).isFile()) {
    return [];
  }
  const entries = readdirSync(path);
  if (entries.includes('case.toml')) {
    return [path];
  }
  return entries.sort().flatMap(entry => casesUnder(resolve(path, entry)));
};

const replays: { name: string; on: (s: Side) => Side; start: Side }[] = [
  { name: 'ts', start: 'ts', on: s => s },
  { name: 'zig', start: 'zig', on: s => s },
  { name: 'ts>zig', start: 'ts', on: s => (s === 'ts' ? 'zig' : 'ts') },
  { name: 'zig>ts', start: 'zig', on: s => (s === 'ts' ? 'zig' : 'ts') },
];

let passed = 0;
const failed: string[] = [];
const beyond: string[] = [];
const deferred: string[] = [];
for (const dir of (paths.length ? paths : ['.']).flatMap(p =>
  casesUnder(resolve(corpusRoot, p)),
)) {
  const name = relative(corpusRoot, dir);
  const setup = Bun.TOML.parse(
    readFileSync(resolve(dir, 'case.toml'), 'utf8'),
  ) as Setup & { kind: string };
  if (setup.kind !== 'trace') {
    continue;
  }
  const problems: string[] = [];
  const saved: Partial<Record<string, Uint8Array[]>> = {};
  try {
    for (const replay of replays) {
      const notes: string[] = [];
      const saves: Uint8Array[] = [];
      saved[replay.name] = saves;
      const result = checkTraceCase(
        reader(dir),
        setup,
        await dualCore(replay.start, replay.on, notes, saves),
      );
      if (result.divergence) {
        const d = result.divergence;
        notes.push(
          `case.trace:${d.line}: expected ${d.expected}, actual ${d.actual}`,
        );
      }
      problems.push(...notes.map(n => `${replay.name}: ${n}`));
    }
    // Both Cores' own replays reach the same states, so save the same bytes.
    const [ts, zig] = [saved.ts!, saved.zig!];
    if (ts.length !== zig.length) {
      problems.push(`ts takes ${ts.length} saves, zig ${zig.length}`);
    }
    const first = ts.findIndex((b, i) => zig[i] && !same(b, zig[i]!));
    if (first >= 0) {
      problems.push(`save ${first + 1}: the Cores' bytes differ`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'FrameRefusedError') {
      beyond.push(name);
      if (!quiet) {
        console.log(`FRAME LIMIT ${name}: ${error.message}`);
      }
      continue;
    }
    if (error instanceof DeferredCaseError) {
      deferred.push(name);
      if (!quiet) {
        console.log(`DEFERRED ${name}: ${error.message}`);
      }
      continue;
    }
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length) {
    failed.push(name);
    console.error([`FAIL ${name}`, ...problems.map(p => `  ${p}`)].join('\n'));
  } else {
    passed++;
    if (!quiet) {
      console.log(`PASS ${name}`);
    }
  }
}
console.log(
  [
    `${passed} passed`,
    `${failed.length} failed`,
    `${beyond.length} past the frame limit`,
    `${deferred.length} deferred`,
  ].join(', '),
);
if (failed.length) {
  console.log(`failed: ${failed.join(' ')}`);
}
process.exitCode = failed.length ? 1 : 0;
