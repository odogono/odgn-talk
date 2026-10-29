// The Zig reactor behind the TS runner's case interface, through
// @northtalk/ts/wasm. The Corpus replay and the cross-Core replay share it.
import type { GrantDecls, Library, TsGroup } from '../src/index';
import type { CaseCore } from '../src/setup';
import { createCore, type WasmGroup } from '../src/wasm/index';
import { DeferredCaseError } from './trace-case';

// The replay lands early Host Inputs through the TS Core's debugger, which
// the reactor doesn't offer: a case that needs a landing is deferred.
const debug = Object.freeze({
  isPaused: false,
  current: undefined,
  landAt() {
    throw new DeferredCaseError('a debugger landing');
  },
});
const asGroup = (group: WasmGroup): TsGroup =>
  Object.assign(group, { debug: () => debug }) as unknown as TsGroup;

export const zigCaseCore = async (
  wasm: WebAssembly.Module,
  binaryCallbacks = true,
): Promise<CaseCore> => {
  const core = await createCore({
    wasm,
    diagnostics: () => {},
    binaryCallbacks,
  });
  const declared = new Map<Library, GrantDecls | undefined>();
  const compileLibrary: CaseCore['compileLibrary'] = (
    src,
    imports,
    declarations,
  ) => {
    const library = core.compileLibrary(
      src,
      imports ? [...imports] : [],
      declarations,
    );
    declared.set(library, declarations);
    return library;
  };
  return {
    compileLibrary,
    // As the TS Core's replacementLibraries: dependents recompiled in
    // import order, here by the reactor. Its import-cycle check is the guest's.
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
            declared.get(old),
          ),
        );
        rebuilt.add(old.name);
      }
      return libraries;
    },
    defineObjectKind: k => core.defineObjectKind(k),
    newGroup: o => asGroup(core.newGroup(o)),
    restore: (bytes, o) => {
      const { group, result } = core.restore(bytes, o);
      return { group: asGroup(group), result };
    },
  };
};
