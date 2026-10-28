// Local Project storage (#752; design in
// docs/research/creative-tool-project-storage.md sections 4-6): IndexedDB
// only. One transaction writes the model and any new assets together, so a
// save is all or nothing. Recent versions of the model are kept for
// recovery, sharing assets by hash. The in-memory Project stays the master
// copy until a write succeeds; nothing here ever mutates it.
import type { DeepReadonly } from './readonly';
import type { Project } from './model';
import {
  CURRENT_FORMAT,
  migrateProjectJson,
  ProjectFileError,
  serializeProject,
  validateProject,
  validateProjectJson,
} from './project-file';

export const DATABASE_NAME = 'northtalk-creative';

/** One Project as the Project list shows it. */
export type ProjectRecord = {
  /** When a copy was last exported, if it ever was. */
  exportedAt?: number;
  format: number;
  id: string;
  modifiedAt: number;
  /** The newest version's sequence number; versions count up from 1. */
  seq: number;
  title: string;
};

/** One earlier version, as the recovery panel lists it. */
export type VersionInfo = {
  pageCount: number;
  savedAt: number;
  seq: number;
};

/** A loaded Project with the record it came from. */
export type LoadedProject = {
  /** True when the stored model was migrated to the current format. */
  migrated: boolean;
  project: Project;
  record: ProjectRecord;
};

/** Asset bytes to write with a save, by SHA-256 hash. */
export type NewAsset = { blob: Blob; mediaType: string };

/**
 * A Project's file on disk, for Save-in-place (#823). The handle stays
 * opaque here: `file-access.ts` owns what it can do. The stamp says
 * what was on disk at open or last save, so a changed file is never
 * overwritten silently.
 */
export type ProjectFileHandleRecord = {
  handle: unknown;
  lastModified?: number;
  name: string;
  size?: number;
};

/** A storage failure. `errorName` keeps the browser's name for bug reports. */
export class StorageError extends Error {
  readonly errorName: string;

  constructor(message: string, errorName = 'StorageError') {
    super(message);
    this.errorName = errorName;
  }
}

/** The `DOMException` or `Error` name of a caught failure. */
export const errorNameOf = (error: unknown): string =>
  error instanceof Error ? error.name : 'Error';

/** Whether a failure means the browser's storage for this site is full. */
export const isQuotaError = (error: unknown): boolean =>
  errorNameOf(error) === 'QuotaExceededError';

const asStorageError = (error: unknown): StorageError =>
  error instanceof StorageError
    ? error
    : new StorageError(
        error instanceof Error ? error.message : 'Storage failed.',
        errorNameOf(error),
      );

// What each store holds. A version's `model` is the parsed form of the
// Project file's `project.json`, so loading runs the same migration and
// validation as reading a file (including refusing a newer format).
type StoredVersion = {
  model: Record<string, unknown>;
  projectId: string;
  savedAt: number;
  seq: number;
};
// A version's summary sits in its own store, under the same key, so the
// version list, trimming and asset clean-up never read whole models.
type StoredSummary = VersionInfo & {
  assetHashes: string[];
  projectId: string;
};
type StoredAsset = { blob: Blob; hash: string; mediaType: string };
type StoredMeta = { key: string; value: string };
type StoredFileHandle = ProjectFileHandleRecord & { projectId: string };

const LAST_PROJECT_KEY = 'lastProjectId';
/** Prefixes the meta key that names the copy opened from a source. */
const COPY_KEY_PREFIX = 'copyOf:';

/** How many of the newest versions a save always keeps. */
export const KEPT_RECENT_VERSIONS = 20;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The versions worth keeping: the newest 20, plus the newest in each hour
 * of the last day. Pure, so trimming is testable without IndexedDB.
 */
export const versionsToKeep = (
  versions: readonly Pick<VersionInfo, 'savedAt' | 'seq'>[],
  now: number,
): Set<number> => {
  const byNewest = [...versions].sort((a, b) => b.seq - a.seq);
  const keep = new Set(byNewest.slice(0, KEPT_RECENT_VERSIONS).map(v => v.seq));
  const hoursSeen = new Set<number>();
  for (const version of byNewest) {
    if (version.savedAt <= now - DAY) {
      continue;
    }
    const hour = Math.floor(version.savedAt / HOUR);
    if (!hoursSeen.has(hour)) {
      hoursSeen.add(hour);
      keep.add(version.seq);
    }
  }
  return keep;
};

// --- IndexedDB plumbing ------------------------------------------------------
// Requests are awaited one at a time inside a transaction. Awaiting the
// promise of the request just made keeps the transaction alive; awaiting
// unrelated work would let it commit early, so callers serialise the model
// before opening one.

const request = <T>(pending: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result);
    // No preventDefault: a failed request aborts its transaction.
    pending.onerror = () => reject(asStorageError(pending.error));
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(asStorageError(tx.error));
    tx.onerror = () => reject(asStorageError(tx.error));
  });

/** Runs `body` in one transaction; resolves only once it has committed. */
const transact = async <T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T>,
): Promise<T> => {
  const tx = db.transaction(stores, mode);
  const done = txDone(tx);
  // If `body` fails first this rejection is still the save's own; keep it
  // from surfacing as unhandled when the caller only sees `body`'s.
  done.catch(() => {});
  try {
    const result = await body(tx);
    await done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* The transaction may already have aborted on its own. */
    }
    throw asStorageError(error);
  }
};

const store = (tx: IDBTransaction, name: string): IDBObjectStore =>
  tx.objectStore(name);

/** Every key of one Project's versions. */
const versionRange = (projectId: string): IDBKeyRange =>
  IDBKeyRange.bound([projectId, 0], [projectId, Number.MAX_SAFE_INTEGER]);

const summaryOf = (version: StoredVersion): StoredSummary => ({
  projectId: version.projectId,
  seq: version.seq,
  savedAt: version.savedAt,
  pageCount: Array.isArray(version.model.pages)
    ? version.model.pages.length
    : 0,
  assetHashes: (
    (version.model.assets as { hash: string }[] | undefined) ?? []
  ).map(asset => asset.hash),
});

const openDatabase = (factory: IDBFactory): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const pending = factory.open(DATABASE_NAME, 3);
    pending.onupgradeneeded = (event?: IDBVersionChangeEvent) => {
      const db = pending.result;
      const oldVersion = event?.oldVersion ?? 0;
      if (oldVersion < 1) {
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('versions', { keyPath: ['projectId', 'seq'] });
        db.createObjectStore('assets', { keyPath: 'hash' });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        const summaries = db.createObjectStore('summaries', {
          keyPath: ['projectId', 'seq'],
        });
        // Summarise versions stored before summaries existed.
        if (oldVersion === 1) {
          const all = pending.transaction!.objectStore('versions').getAll();
          all.onsuccess = () => {
            for (const version of all.result as StoredVersion[]) {
              summaries.put(summaryOf(version));
            }
          };
        }
      }
      if (oldVersion < 3) {
        db.createObjectStore('fileHandles', { keyPath: 'projectId' });
      }
    };
    pending.onsuccess = () => {
      // A newer app version may raise the database version; step aside.
      pending.result.onversionchange = () => pending.result.close();
      resolve(pending.result);
    };
    pending.onerror = () => reject(asStorageError(pending.error));
    pending.onblocked = () =>
      reject(
        new StorageError(
          'Another tab is keeping the storage from opening.',
          'BlockedError',
        ),
      );
  });

/** Brings a stored model to a Project, or throws as reading a file would. */
const projectFromModel = (
  model: Record<string, unknown>,
): { migrated: boolean; project: Project } => {
  const migrated = model.format !== CURRENT_FORMAT;
  const result = validateProjectJson(migrateProjectJson(model));
  if ('issues' in result) {
    const [first] = result.issues;
    throw new ProjectFileError(
      `The stored Project is damaged at ${first!.path}: ${first!.message}.`,
      result.issues,
    );
  }
  return { migrated, project: result.project };
};

/** Refuses to store a Project that reading back would reject. */
const checkedModel = (
  project: DeepReadonly<Project>,
): Record<string, unknown> => {
  const issues = validateProject(project);
  if (issues.length) {
    throw new ProjectFileError(
      `This Project cannot be saved: ${issues.map(i => `${i.path}: ${i.message}`).join('; ')}.`,
      issues,
    );
  }
  return serializeProject(project);
};

/**
 * Deletes stored assets no kept version of any Project refers to. Runs
 * inside the caller's transaction, after versions have been trimmed.
 */
const collectGarbage = async (tx: IDBTransaction): Promise<void> => {
  const summaries = (await request(
    store(tx, 'summaries').getAll(),
  )) as StoredSummary[];
  const used = new Set(summaries.flatMap(summary => summary.assetHashes));
  const assets = store(tx, 'assets');
  const keys = (await request(assets.getAllKeys())) as string[];
  for (const hash of keys) {
    if (!used.has(hash)) {
      await request(assets.delete(hash));
    }
  }
};

/** Options every write shares; `now` is injectable for tests. */
export type SaveOptions = {
  /** New asset bytes to store with this save, by hash. */
  assets?: ReadonlyMap<string, NewAsset>;
  now?: number;
};

/** The IndexedDB stores behind the Project list, autosave and recovery. */
export class ProjectStorage {
  readonly #db: IDBDatabase;
  readonly #makeId: () => string;

  constructor(
    db: IDBDatabase,
    makeId: () => string = () => crypto.randomUUID(),
  ) {
    this.#db = db;
    this.#makeId = makeId;
  }

  close(): void {
    this.#db.close();
  }

  /** Every Project record, most recently changed first. */
  async listProjects(): Promise<ProjectRecord[]> {
    const records = await transact(this.#db, ['projects'], 'readonly', tx =>
      request(store(tx, 'projects').getAll()),
    );
    return (records as ProjectRecord[]).sort(
      (a, b) => b.modifiedAt - a.modifiedAt,
    );
  }

  /** One Project's record, if it is still stored. */
  async projectRecord(id: string): Promise<ProjectRecord | undefined> {
    return transact(this.#db, ['projects'], 'readonly', tx =>
      request(store(tx, 'projects').get(id)),
    ) as Promise<ProjectRecord | undefined>;
  }

  /**
   * Writes `project` as the newest version of `id` (or of a new Project
   * when `id` is `undefined`), with any new assets, in one transaction.
   * Trims old versions and drops assets no kept version refers to, in the
   * same transaction. A failure stores nothing at all.
   */
  async saveProject(
    id: string | undefined,
    project: DeepReadonly<Project>,
    { assets = new Map(), now = Date.now() }: SaveOptions = {},
  ): Promise<ProjectRecord> {
    const model = checkedModel(project);
    const projectId = id ?? this.#makeId();
    return transact(
      this.#db,
      ['projects', 'versions', 'summaries', 'assets'],
      'readwrite',
      async tx => {
        const projects = store(tx, 'projects');
        const stored = id
          ? ((await request(projects.get(id))) as ProjectRecord | undefined)
          : undefined;
        if (id && !stored) {
          throw new StorageError(
            'This Project is no longer in storage.',
            'NotFoundError',
          );
        }
        const assetStore = store(tx, 'assets');
        for (const [hash, asset] of assets) {
          await request(
            assetStore.put({
              hash,
              blob: asset.blob,
              mediaType: asset.mediaType,
            }),
          );
        }
        const record: ProjectRecord = {
          id: projectId,
          title: project.name,
          format: CURRENT_FORMAT,
          modifiedAt: now,
          seq: (stored?.seq ?? 0) + 1,
          ...(stored?.exportedAt === undefined
            ? {}
            : { exportedAt: stored.exportedAt }),
        };
        const version: StoredVersion = {
          projectId,
          seq: record.seq,
          savedAt: now,
          model,
        };
        const summaries = store(tx, 'summaries');
        await request(store(tx, 'versions').put(version));
        await request(summaries.put(summaryOf(version)));
        await request(projects.put(record));
        const all = (await request(
          summaries.getAll(versionRange(projectId)),
        )) as StoredSummary[];
        const keep = versionsToKeep(all, now);
        const trimmed = all.filter(summary => !keep.has(summary.seq));
        for (const { seq } of trimmed) {
          await request(store(tx, 'versions').delete([projectId, seq]));
          await request(summaries.delete([projectId, seq]));
        }
        // Only assets a trimmed version used, or new ones the model leaves
        // out, can be unused now, so most saves skip scanning every Project.
        const keptHashes = new Set(
          all
            .filter(summary => keep.has(summary.seq))
            .flatMap(summary => summary.assetHashes),
        );
        if (
          [
            ...trimmed.flatMap(summary => summary.assetHashes),
            ...assets.keys(),
          ].some(hash => !keptHashes.has(hash))
        ) {
          await collectGarbage(tx);
        }
        return record;
      },
    );
  }

  /** The stored version and record for a load, naming records that have gone. */
  async #loadStored(
    id: string,
    seq?: number,
  ): Promise<{ record: ProjectRecord; version: StoredVersion }> {
    const found = await transact(
      this.#db,
      ['projects', 'versions'],
      'readonly',
      async tx => {
        const record = (await request(store(tx, 'projects').get(id))) as
          ProjectRecord | undefined;
        if (!record) {
          return undefined;
        }
        const version = (await request(
          store(tx, 'versions').get([id, seq ?? record.seq]),
        )) as StoredVersion | undefined;
        return version ? { record, version } : { record };
      },
    );
    if (!found) {
      throw new StorageError(
        'This Project is no longer in storage.',
        'NotFoundError',
      );
    }
    if (!found.version) {
      throw new StorageError(
        `“${found.record.title}” is listed, but its stored Pages have gone. The browser may have cleared them.`,
        'MissingVersionError',
      );
    }
    return { record: found.record, version: found.version };
  }

  /** The newest stored version of a Project, migrated and validated. */
  loadProject(id: string): Promise<LoadedProject> {
    return this.loadVersion(id);
  }

  /** One earlier version of a Project, migrated and validated. */
  async loadVersion(id: string, seq?: number): Promise<LoadedProject> {
    const { record, version } = await this.#loadStored(id, seq);
    return { record, ...projectFromModel(version.model) };
  }

  /** Every kept version of a Project, newest first. */
  async listVersions(id: string): Promise<VersionInfo[]> {
    const summaries = await transact(this.#db, ['summaries'], 'readonly', tx =>
      request(store(tx, 'summaries').getAll(versionRange(id))),
    );
    return (summaries as StoredSummary[])
      .map(({ seq, savedAt, pageCount }) => ({ seq, savedAt, pageCount }))
      .sort((a, b) => b.seq - a.seq);
  }

  /**
   * Writes an earlier version as the newest one, so the restore itself can
   * be undone by restoring the version that was newest before it.
   */
  async restoreVersion(
    id: string,
    seq: number,
    now: number = Date.now(),
  ): Promise<LoadedProject> {
    const { project } = await this.loadVersion(id, seq);
    const record = await this.saveProject(id, project, { now });
    return { record, project, migrated: false };
  }

  /** An independent copy of a Project, sharing its assets by hash. */
  async duplicateProject(
    id: string,
    now: number = Date.now(),
  ): Promise<LoadedProject> {
    const { project } = await this.loadProject(id);
    const copy = structuredClone(project);
    copy.name = `${project.name} copy`;
    const record = await this.saveProject(undefined, copy, { now });
    return { record, project: copy, migrated: false };
  }

  /** Renames a stored Project: its newest model, saved with the new title. */
  async renameProject(
    id: string,
    title: string,
    now: number = Date.now(),
  ): Promise<ProjectRecord> {
    const { project } = await this.loadProject(id);
    project.name = title;
    return this.saveProject(id, project, { now });
  }

  /** The file on disk a Project saves back to, if it has one. */
  async fileHandle(id: string): Promise<ProjectFileHandleRecord | undefined> {
    const stored = await transact(this.#db, ['fileHandles'], 'readonly', tx =>
      request(store(tx, 'fileHandles').get(id)),
    );
    if (!stored) {
      return undefined;
    }
    const { handle, lastModified, name, size } = stored as StoredFileHandle;
    return {
      handle,
      name,
      ...(lastModified === undefined ? {} : { lastModified }),
      ...(size === undefined ? {} : { size }),
    };
  }

  /** Remembers the file on disk a Project saves back to. */
  async setFileHandle(
    id: string,
    record: ProjectFileHandleRecord,
  ): Promise<void> {
    await transact(this.#db, ['fileHandles'], 'readwrite', async tx => {
      await request(store(tx, 'fileHandles').put({ projectId: id, ...record }));
    });
  }

  /** Forgets a Project's file on disk. */
  async clearFileHandle(id: string): Promise<void> {
    await transact(this.#db, ['fileHandles'], 'readwrite', async tx => {
      await request(store(tx, 'fileHandles').delete(id));
    });
  }

  /** Deletes a Project, its versions and any assets only they used. */
  async deleteProject(id: string): Promise<void> {
    await transact(
      this.#db,
      ['projects', 'versions', 'summaries', 'assets', 'fileHandles'],
      'readwrite',
      async tx => {
        await request(store(tx, 'projects').delete(id));
        await request(store(tx, 'versions').delete(versionRange(id)));
        await request(store(tx, 'summaries').delete(versionRange(id)));
        await request(store(tx, 'fileHandles').delete(id));
        await collectGarbage(tx);
      },
    );
  }

  /** Records that a copy of a Project was exported at `now`. */
  async markExported(id: string, now: number = Date.now()): Promise<void> {
    await transact(this.#db, ['projects'], 'readwrite', async tx => {
      const projects = store(tx, 'projects');
      const record = (await request(projects.get(id))) as
        ProjectRecord | undefined;
      if (record) {
        await request(projects.put({ ...record, exportedAt: now }));
      }
    });
  }

  /**
   * Frees space after a quota failure: every Project keeps only its newest
   * version, and assets no newest version uses are dropped.
   */
  async freeSpace(): Promise<void> {
    await transact(
      this.#db,
      ['projects', 'versions', 'summaries', 'assets'],
      'readwrite',
      async tx => {
        const records = (await request(
          store(tx, 'projects').getAll(),
        )) as ProjectRecord[];
        const newest = new Map(records.map(r => [r.id, r.seq]));
        const summaries = store(tx, 'summaries');
        const all = (await request(summaries.getAll())) as StoredSummary[];
        for (const { projectId, seq } of all) {
          if (newest.get(projectId) !== seq) {
            await request(store(tx, 'versions').delete([projectId, seq]));
            await request(summaries.delete([projectId, seq]));
          }
        }
        await collectGarbage(tx);
      },
    );
  }

  /** Stored asset bytes by hash, for the hashes that are present. */
  async assetBytes(
    hashes: readonly string[],
  ): Promise<Map<string, Uint8Array>> {
    const stored = await transact(
      this.#db,
      ['assets'],
      'readonly',
      async tx => {
        const assets = store(tx, 'assets');
        const found: StoredAsset[] = [];
        for (const hash of hashes) {
          const asset = (await request(assets.get(hash))) as
            StoredAsset | undefined;
          if (asset) {
            found.push(asset);
          }
        }
        return found;
      },
    );
    const bytes = new Map<string, Uint8Array>();
    for (const asset of stored) {
      bytes.set(asset.hash, new Uint8Array(await asset.blob.arrayBuffer()));
    }
    return bytes;
  }

  /** The Project the app last opened, so it can open it again. */
  async lastProjectId(): Promise<string | undefined> {
    const meta = await transact(this.#db, ['meta'], 'readonly', tx =>
      request(store(tx, 'meta').get(LAST_PROJECT_KEY)),
    );
    return (meta as StoredMeta | undefined)?.value;
  }

  async setLastProjectId(id: string | undefined): Promise<void> {
    await transact(this.#db, ['meta'], 'readwrite', async tx => {
      const meta = store(tx, 'meta');
      if (id === undefined) {
        await request(meta.delete(LAST_PROJECT_KEY));
        return;
      }
      await request(
        meta.put({ key: LAST_PROJECT_KEY, value: id } satisfies StoredMeta),
      );
    });
  }

  /**
   * The Project last opened as a copy from `source`, such as
   * `example:tetris` (#1679), while it still exists.
   */
  async copyOf(source: string): Promise<string | undefined> {
    const meta = await transact(this.#db, ['meta'], 'readonly', tx =>
      request(store(tx, 'meta').get(`${COPY_KEY_PREFIX}${source}`)),
    );
    const id = (meta as StoredMeta | undefined)?.value;
    return id && (await this.projectRecord(id)) ? id : undefined;
  }

  async setCopyOf(source: string, id: string): Promise<void> {
    await transact(this.#db, ['meta'], 'readwrite', tx =>
      request(
        store(tx, 'meta').put({
          key: `${COPY_KEY_PREFIX}${source}`,
          value: id,
        } satisfies StoredMeta),
      ),
    );
  }
}

/**
 * Opens the local storage. `factory` is injectable for tests; in the
 * browser it is the page's `indexedDB`. Throws a StorageError when the
 * browser won't keep data, as in some private modes.
 */
export const openProjectStorage = async (
  factory: IDBFactory,
  makeId?: () => string,
): Promise<ProjectStorage> =>
  new ProjectStorage(await openDatabase(factory), makeId);
