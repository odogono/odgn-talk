// talk.ts's Core over the Zig reactor. Definitions stay on the Host, checked
// by the TS Core's own constructors, and are declared in each guest that a
// Group's Grants or Libraries need. createCore is the one asynchronous call:
// compiling the module. Everything after it is synchronous, as in the TS Core.
import { defineCapability, type CapabilityDef } from '../capabilities';
import type { Core } from '../embedding';
import type { GrantDecls } from '../effects';
import { HostError } from '../errors';
import type { GroupOptions, RestoreOptions, RestoreResult } from '../group';
import type { Library, LibrarySource, OperationRef } from '../library';
import { localeCapability } from '../locale-capability';
import { shapeData } from '../manifest';
import {
  defineObjectKind,
  type ObjectKind,
  type ObjectKindDef,
} from '../objects';
import {
  calendarCapability,
  clockCapability,
  consoleCapability,
  timerCapability,
} from '../standard-capabilities';
import { sqliteCapability } from '../sqlite-capability';
import { storeCapability } from '../store-capability';
import { userCapability } from '../user-capability';
import { httpCapability } from '../http-capability';
import { WasmGroup, bytesFrame, bytesOfFrame, type GroupCore } from './group';
import type { Versions } from '../versions';
import { Session } from './session';
import { field, listOf, plain, type Frame } from './wire';

/** Where `talk.wasm` comes from. A URL or path is fetched; `file:` URLs are read. */
export type WasmSource =
  | WebAssembly.Module
  | BufferSource
  | Response
  | PromiseLike<Response>
  | URL
  | string;

export type CoreOptions = {
  /** Request binary callbacks when offered. False keeps JSON for compatibility checks. */
  binaryCallbacks?: boolean;
  /** Lines the reactor writes to stdout or stderr. Defaults to console.warn. */
  diagnostics?: (line: string) => void;
  /** The reactor. Defaults to `talk.wasm` beside this module. */
  wasm?: WasmSource;
};

const readFileURL = async (url: URL): Promise<Uint8Array> => {
  // Kept out of browser bundles: only `file:` URLs, under Bun or Node, reach it.
  const fs = 'node:fs/promises';
  const { readFile } = (await import(/* @vite-ignore */ fs)) as {
    readFile(u: URL): Promise<Uint8Array>;
  };
  return readFile(url);
};

const compile = async (source: WasmSource): Promise<WebAssembly.Module> => {
  // eslint-disable-next-line @nkzw/no-instanceof -- WebAssembly.Module has no other test.
  if (source instanceof WebAssembly.Module) {
    return source;
  }
  // eslint-disable-next-line @nkzw/no-instanceof -- a URL, not just any object with an href.
  if (typeof source === 'string' || source instanceof URL) {
    const base =
      (globalThis as { location?: { href: string } }).location?.href ??
      import.meta.url;
    const url = new URL(source, base);
    if (url.protocol === 'file:') {
      return WebAssembly.compile((await readFileURL(url)) as BufferSource);
    }
    source = fetch(url);
  }
  const resolved = await source;
  // eslint-disable-next-line @nkzw/no-instanceof -- a fetch Response, not the module's bytes.
  if (resolved instanceof Response) {
    if (!resolved.ok) {
      throw new Error(`talk.wasm: ${resolved.status} ${resolved.statusText}`);
    }
    return WebAssembly.compile(await resolved.arrayBuffer());
  }
  return WebAssembly.compile(resolved as BufferSource);
};

const hex = (b: Uint8Array) =>
  [...b].map(x => x.toString(16).padStart(2, '0')).join('');

export class WasmCore implements Core {
  /** The reactor's `hello`: its Core, language, Cost Model, Unicode and save format. */
  readonly versions: Versions;
  readonly #module: WebAssembly.Module;
  readonly #diagnostics: (line: string) => void;
  readonly #handles = new Map<CapabilityDef<unknown>, string>();
  readonly #named = new Map<string, number>();
  readonly #kinds: ObjectKind[] = [];
  readonly #declarations = new WeakMap<Library, GrantDecls | undefined>();
  readonly #libraries: Session;
  readonly #groupCore: GroupCore;

  /** @internal Use createCore. */
  constructor(
    module: WebAssembly.Module,
    diagnostics: (line: string) => void,
    private readonly binaryCallbacks = true,
  ) {
    this.#module = module;
    this.#diagnostics = diagnostics;
    this.#libraries = this.#session();
    this.versions = this.#libraries.versions;
    this.#groupCore = {
      session: () => this.#session(),
      install: (session, library) => this.#install(session, library),
      kind: name => this.#kinds.find(k => k.name === name),
    };
  }

  #session(): Session {
    return new Session(
      this.#module,
      this.#diagnostics,
      {
        handleOf: def => {
          let handle = this.#handles.get(def);
          if (handle === undefined) {
            const n = this.#named.get(def.name) ?? 0;
            this.#named.set(def.name, n + 1);
            handle = n ? `${def.name}#${n + 1}` : def.name;
            this.#handles.set(def, handle);
          }
          return handle;
        },
        kinds: this.#kinds,
      },
      this.binaryCallbacks,
    );
  }

  defineCapability = defineCapability;
  clockCapability = clockCapability;
  calendarCapability = calendarCapability;
  localeCapability = localeCapability;
  timerCapability = timerCapability;
  consoleCapability = consoleCapability;
  storeCapability = storeCapability;
  sqliteCapability = sqliteCapability;
  userCapability = userCapability;
  httpCapability = httpCapability;

  defineObjectKind<N>(k: ObjectKindDef<N>): ObjectKind<N> {
    const kind = defineObjectKind(k);
    const at = this.#kinds.findIndex(known => known.name === kind.name);
    if (at >= 0) {
      this.#kinds[at] = kind as ObjectKind;
    } else {
      this.#kinds.push(kind as ObjectKind);
    }
    return kind;
  }

  /** Checked in a guest the Core keeps; each Group's guest compiles it again when added. */
  compileLibrary(
    src: LibrarySource,
    imports: Library[] = [],
    declarations?: GrantDecls,
  ): Library {
    for (const l of imports) {
      this.#install(this.#libraries, l);
    }
    const ok = this.#libraries.exchange(
      'compile-library',
      this.#libraryFields(src, imports, declarations),
    );
    const identity = bytesOfFrame(field(ok, 'identity'));
    const library: Library = Object.freeze({
      name: src.name,
      version: src.version,
      source: src.source,
      identity,
      imports: Object.freeze([...imports]),
      needs: Object.freeze(
        listOf(field(ok, 'needs')).map(n => plain(n) as OperationRef),
      ),
    });
    this.#declarations.set(library, declarations);
    this.#libraries.addedLibrary(hex(identity));
    return library;
  }

  #libraryFields(
    src: LibrarySource,
    imports: readonly Library[],
    declarations?: GrantDecls,
  ): Record<string, Frame> {
    return {
      name: src.name,
      version: src.version,
      source: src.source,
      imports: imports.map(l => bytesFrame(l.identity)),
      declarations: Object.fromEntries(
        Object.entries(declarations ?? {}).map(([grant, ops]) => [
          grant,
          Object.fromEntries(
            Object.entries(ops).map(([op, d]) => [
              op,
              {
                mode: d.mode,
                args: d.args.map(a => shapeData(a) as Frame),
                ...(d.labels?.length ? { labels: [...d.labels] } : {}),
                command: d.command,
              },
            ]),
          ),
        ]),
      ),
    };
  }

  #install(session: Session, library: Library) {
    const id = hex(library.identity);
    if (session.hasLibrary(id)) {
      return;
    }
    if (!this.#declarations.has(library)) {
      throw new HostError(
        'invalid value',
        `${library.name} wasn't compiled by this Core`,
      );
    }
    for (const l of library.imports) {
      this.#install(session, l);
    }
    const ok = session.exchange(
      'compile-library',
      this.#libraryFields(
        library,
        library.imports,
        this.#declarations.get(library),
      ),
    );
    if (hex(bytesOfFrame(field(ok, 'identity'))) !== id) {
      throw new HostError(
        'library mismatch',
        `${library.name} compiled differently`,
      );
    }
    session.addedLibrary(id);
  }

  newGroup(o: GroupOptions): WasmGroup {
    return new WasmGroup(this.#groupCore, o);
  }

  /** A save's State Fingerprint, without restoring it (ADR 0142). */
  stateFingerprint(save: Uint8Array): Uint8Array {
    const ok = this.#libraries.exchange('save-state-fingerprint', {
      save: bytesFrame(save),
    });
    return bytesOfFrame(field(ok, 'stateFingerprint'));
  }

  restore(
    save: Uint8Array,
    o: RestoreOptions,
  ): { group: WasmGroup; result: RestoreResult } {
    const group = new WasmGroup(this.#groupCore, o, { save, options: o });
    const result = group.restore(save, o);
    return { group, result };
  }
}

/**
 * Compiles `talk.wasm` once and returns a Core over it. The one asynchronous
 * call: `await createCore()` also works with the TS Core's synchronous one.
 */
export const createCore = async (o: CoreOptions = {}): Promise<WasmCore> =>
  new WasmCore(
    await compile(o.wasm ?? new URL('./talk.wasm', import.meta.url)),
    // eslint-disable-next-line no-console -- the reactor's own fatal errors, unless the Host takes them.
    o.diagnostics ?? (line => console.warn(`talk.wasm: ${line}`)),
    o.binaryCallbacks,
  );
