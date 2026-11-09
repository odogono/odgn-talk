// Loads the Add-ons a Project lists and registers their kinds (ADR 0162,
// #1901). The page, the Play worker and tests each have a loader; each
// Add-on loads once per loader. An Add-on that can't load leaves its
// Elements as placeholders, and the loader says why.
import { addElementShape } from '../grants/grant';
import {
  commonProperties,
  property,
  readOnly,
  scalar,
} from '../elements/definition';
import type { ElementKindDefinition } from '../elements/definition';
import { isObjectKindTaken, registerAddOnKind } from '../elements/registry';
import { NOTE_OPERATIONS, SAMPLER_OPERATIONS } from '../instruments/operations';
import {
  instrumentObjectKindNames,
  registerInstrumentKind,
} from '../instruments/registry';
import type { AddOnKind, AddOnRef } from '../model';
import type {
  AddOnDataApi,
  AddOnInstrumentApi,
  AddOnKindModule,
  AddOnModule,
} from './api';
import { registerLiteralEditor } from '../literal-editors';
import { compareVersions } from './versions';
import { addOnChunk, BUILT_IN_ADD_ONS, type CatalogueEntry } from './catalogue';

const INSTRUMENT_API: AddOnInstrumentApi = {
  operations: { note: NOTE_OPERATIONS, sampler: SAMPLER_OPERATIONS },
};

const DATA_API: AddOnDataApi = { commonProperties, property, readOnly, scalar };

/** Imports a built-in Add-on's module. */
export type AddOnImporter = (entry: CatalogueEntry) => Promise<AddOnModule>;

/** Folio's chunks sit beside the script that loads them. */
export const chunkImporter: AddOnImporter = async entry =>
  (
    (await import(new URL(`./${addOnChunk(entry)}`, import.meta.url).href)) as {
      default: AddOnModule;
    }
  ).default;

/** Imports a Project Add-on's code as a module, from a `blob:` URL. */
export type CodeImporter = (code: string) => Promise<AddOnModule>;

export const blobImporter: CodeImporter = async code => {
  const url = URL.createObjectURL(
    new Blob([code], { type: 'text/javascript' }),
  );
  try {
    return ((await import(url)) as { default: AddOnModule }).default;
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** The message for a Project Add-on the reader hasn't trusted. */
export const NOT_TRUSTED = "it carries code you haven't trusted";

/** Why an Add-on a Project lists didn't load. */
export type AddOnProblem = { id: string; message: string };

export { compareVersions } from './versions';

export type AddOnLoaderOptions = {
  catalogue?: readonly CatalogueEntry[];
  codeImporter?: CodeImporter;
  importer?: AddOnImporter;
  /** The page registers each kind's view; the worker and CLI don't. */
  onView?: (kind: AddOnKind, module: AddOnKindModule) => void;
  /**
   * Whether the reader trusts a Project Add-on, by its code's hash; none
   * runs without (ADR 0162).
   */
  trusted?: (hash: string) => boolean;
};

export class AddOnLoader {
  readonly catalogue: readonly CatalogueEntry[];
  readonly #importer: AddOnImporter;
  readonly #codeImporter: CodeImporter;
  readonly #trusted: (hash: string) => boolean;
  readonly #onView?: AddOnLoaderOptions['onView'];
  readonly #loads = new Map<string, Promise<string | undefined>>();

  constructor(options: AddOnLoaderOptions = {}) {
    this.catalogue = options.catalogue ?? BUILT_IN_ADD_ONS;
    this.#importer = options.importer ?? chunkImporter;
    this.#codeImporter = options.codeImporter ?? blobImporter;
    this.#trusted = options.trusted ?? (() => false);
    this.#onView = options.onView;
  }

  /** The built-in Add-on with `id`, when this Folio has one. */
  entry(id: string): CatalogueEntry | undefined {
    return this.catalogue.find(entry => entry.id === id);
  }

  /** Loads every Add-on in `refs` it can; the problems with the rest. */
  async load(refs: readonly AddOnRef[]): Promise<AddOnProblem[]> {
    const problems = await Promise.all(
      refs.map(async ref => {
        const message = await this.#loadOne(ref);
        return message === undefined ? [] : [{ id: ref.id, message }];
      }),
    );
    return problems.flat();
  }

  #loadOne(ref: AddOnRef): Promise<string | undefined> {
    if (ref.code !== undefined) {
      return this.#loadCode(ref, ref.code, ref.hash!);
    }
    const entry = this.entry(ref.id);
    if (!entry) {
      return Promise.resolve('this Folio has no such Add-on');
    }
    if (compareVersions(ref.version, entry.version) > 0) {
      return Promise.resolve(
        `the Project needs version ${ref.version}, and this Folio has ${entry.version}`,
      );
    }
    let load = this.#loads.get(entry.id);
    if (!load) {
      load = this.#importer(entry).then(
        module => this.#register(entry.id, entry.version, module),
        (error: unknown) =>
          `it could not be fetched${error instanceof Error ? `: ${error.message}` : ''}`,
      );
      this.#loads.set(entry.id, load);
      // A failed fetch, such as offline, is tried again next time.
      void load.then(problem => {
        if (problem?.startsWith('it could not be fetched')) {
          this.#loads.delete(entry.id);
        }
      });
    }
    return load;
  }

  /** A Project Add-on: its code runs only once the reader trusts it. */
  #loadCode(
    ref: AddOnRef,
    code: string,
    hash: string,
  ): Promise<string | undefined> {
    if (!this.#trusted(hash)) {
      return Promise.resolve(NOT_TRUSTED);
    }
    let load = this.#loads.get(hash);
    if (!load) {
      load = this.#codeImporter(code).then(
        module =>
          module?.instruments && Object.keys(module.instruments).length
            ? 'Instrument kinds in a Project Add-on are not supported yet'
            : module?.literalEditors &&
                Object.keys(module.literalEditors).length
              ? 'Literal Editors in a Project Add-on are not supported yet'
              : this.#register(ref.id, ref.version, module),
        (error: unknown) =>
          `its code failed to load${error instanceof Error ? `: ${error.message}` : ''}`,
      );
      this.#loads.set(hash, load);
    }
    return load;
  }

  /** Registers a module already in hand, such as a test's. */
  register(module: AddOnModule): string | undefined {
    return this.#register(module.id, module.version, module);
  }

  #register(
    id: string,
    version: string,
    module: AddOnModule,
  ): string | undefined {
    if (module?.id !== id || module.version !== version) {
      return `its module is ${String(module?.id)} ${String(module?.version)}`;
    }
    for (const [name, kindModule] of Object.entries(module.kinds)) {
      const kind = `${id}#${name}` as AddOnKind;
      const data = kindModule.data(DATA_API);
      // Every Element of the kind carries its full `kind`.
      const definition = {
        ...data,
        kind,
        create: base => ({ ...data.create(base), kind }),
        check: (c, raw, path, context) => {
          const element = data.check(c, raw, path, context);
          return element && { ...element, kind };
        },
      } as ElementKindDefinition<AddOnKind> as ElementKindDefinition;
      const problem = instrumentObjectKindNames().has(name)
        ? `another kind is already named ${name}`
        : registerAddOnKind(kind, definition, name);
      if (problem) {
        return problem;
      }
      addElementShape(name);
      this.#onView?.(kind, kindModule);
    }
    for (const [name, instrument] of Object.entries(module.instruments ?? {})) {
      const problem = registerInstrumentKind(
        `${id}#${name}`,
        instrument.kind(INSTRUMENT_API),
        { label: instrument.label, name: instrument.instanceName },
        { id, version },
        isObjectKindTaken,
      );
      if (problem) {
        return problem;
      }
    }
    for (const [name, editor] of Object.entries(module.literalEditors ?? {})) {
      const problem = registerLiteralEditor(id, name, editor);
      if (problem) {
        return problem;
      }
    }
    return undefined;
  }
}
