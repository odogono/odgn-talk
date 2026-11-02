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
import { registerAddOnKind } from '../elements/registry';
import type { AddOnKind, AddOnRef } from '../model';
import type { AddOnDataApi, AddOnKindModule, AddOnModule } from './api';
import { compareVersions } from './versions';
import { addOnChunk, BUILT_IN_ADD_ONS, type CatalogueEntry } from './catalogue';

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

/** Why an Add-on a Project lists didn't load. */
export type AddOnProblem = { id: string; message: string };

export { compareVersions } from './versions';

export type AddOnLoaderOptions = {
  catalogue?: readonly CatalogueEntry[];
  importer?: AddOnImporter;
  /** The page registers each kind's view; the worker and CLI don't. */
  onView?: (kind: AddOnKind, module: AddOnKindModule) => void;
};

export class AddOnLoader {
  readonly catalogue: readonly CatalogueEntry[];
  readonly #importer: AddOnImporter;
  readonly #onView?: AddOnLoaderOptions['onView'];
  readonly #loads = new Map<string, Promise<string | undefined>>();

  constructor(options: AddOnLoaderOptions = {}) {
    this.catalogue = options.catalogue ?? BUILT_IN_ADD_ONS;
    this.#importer = options.importer ?? chunkImporter;
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
      // Project Add-ons load after the trust prompt (#1901).
      return Promise.resolve('Add-ons carried in a Project are not loaded yet');
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
        module => this.#register(entry, module),
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

  #register(entry: CatalogueEntry, module: AddOnModule): string | undefined {
    if (module.id !== entry.id || module.version !== entry.version) {
      return `its module is ${module.id} ${module.version}`;
    }
    for (const [name, kindModule] of Object.entries(module.kinds)) {
      const kind = `${entry.id}#${name}` as AddOnKind;
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
      const problem = registerAddOnKind(kind, definition, name);
      if (problem) {
        return problem;
      }
      addElementShape(name);
      this.#onView?.(kind, kindModule);
    }
    return undefined;
  }
}
