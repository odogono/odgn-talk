// The Project list, earlier versions, autosave wiring and the banners
// storage failures show (#752). The IndexedDB layer is `storage.ts`, the
// scheduling is `autosave.ts`, and one-editor-per-Project is `edit-lock.ts`;
// this file connects them to the Stack shell. The lists are Preact
// components in `projects-window.tsx`, following the signals kept here.
import type { DeepReadonly } from './readonly';
import { computed, signal } from '@preact/signals';
import { Autosave, failureMessage, type AutosaveState } from './autosave';
import {
  EditLock,
  type ProjectChannel,
  type ProjectMessage,
} from './edit-lock';
import { createProject, type Project } from './model';
import {
  dropHandle,
  FileAccessError,
  fileAccessSupport,
  onLaunchFiles,
  pickOpenHandles,
  pickSaveHandle,
  saveToHandle,
  stampOfFile,
  type FileStamp,
  type ProjectFileHandle,
} from './file-access';
import { importImage, projectForExport, storageAsset } from './images';
import {
  EXAMPLE_PROJECTS,
  exampleFilePath,
  type ExampleProject,
} from './examples';
import { importSound, isSoundAsset } from './sounds';
import { fetchProjectFile, fileNameOf } from './open-url';
import { readSharedLink, sharedLinkFor } from './shared-link';
import {
  PROJECT_MIMETYPE,
  readProjectFile,
  sha256Hex,
  writeProjectFile,
} from './project-file';
import type { StackShell } from './stack';
import {
  errorNameOf,
  StorageError,
  type LoadedProject,
  type ProjectFileHandleRecord,
  type ProjectRecord,
  type ProjectStorage,
  type VersionInfo,
} from './storage';
import { byId, h } from './dom';
import { mountProjectsWindow } from './projects-window';

const when = (time: number): string => new Date(time).toLocaleString();

const byteSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const missingNote = (missingNames: string[]): string =>
  missingNames.length
    ? ` Missing assets kept as placeholders: ${missingNames.join(', ')}.`
    : '';

const fileErrorName = (error: unknown): string =>
  error instanceof FileAccessError ? error.errorName : errorNameOf(error);

/** The Project to open on start, from storage (see `openInitialProject`). */
export type InitialProject = {
  id: string;
  migrated: boolean;
  /** Said to the author when their last Project could not be opened. */
  notice?: string;
  project: Project;
  record?: ProjectRecord;
};

const UNTITLED = 'Untitled';

/**
 * Opens the last Project used, else the most recently changed, else a new
 * stored "Untitled". A Project that cannot be opened (damaged, gone, or
 * from a newer app) is never overwritten: a notice says why and a new
 * Project opens instead. Without storage the new Project is in memory only.
 */
export const openInitialProject = async (
  storage: ProjectStorage | undefined,
): Promise<InitialProject> => {
  if (!storage) {
    return {
      id: `unsaved-${crypto.randomUUID()}`,
      migrated: false,
      project: createProject(UNTITLED),
    };
  }
  const records = await storage.listProjects();
  const lastId = await storage.lastProjectId();
  const candidate = records.find(record => record.id === lastId) ?? records[0];
  if (candidate) {
    try {
      const loaded = await storage.loadProject(candidate.id);
      return {
        id: candidate.id,
        migrated: loaded.migrated,
        project: loaded.project,
        record: loaded.record,
      };
    } catch (error) {
      const notice =
        error instanceof Error
          ? error.message
          : 'The Project could not be opened.';
      const project = createProject(UNTITLED);
      const record = await storage.saveProject(undefined, project);
      await storage.setLastProjectId(record.id);
      return { id: record.id, migrated: false, notice, project, record };
    }
  }
  const project = createProject(UNTITLED);
  const record = await storage.saveProject(undefined, project);
  await storage.setLastProjectId(record.id);
  return { id: record.id, migrated: false, project, record };
};

/** Handlers the edit lock calls; filled in once the shell is mounted. */
export type LockDelegate = {
  flush: () => Promise<void>;
  onEditing: (editing: boolean) => void;
};

export type ProjectsDeps = {
  channel: ProjectChannel | undefined;
  /** The slug of an Example Project the page was opened to, if any. */
  exampleSlug?: string;
  initial: InitialProject;
  lock: EditLock;
  lockDelegate: LockDelegate;
  /** The `.folio` file URL the page's `?open=` names, if any. */
  openUrl?: string;
  /** The payload of the Shared Link the page's fragment carries, if any. */
  sharedLink?: string;
  shell: StackShell;
  storage: ProjectStorage | undefined;
  /** Why storage could not open, when there is none. */
  storageError?: unknown;
};

/** Thrown by a save that finds this tab no longer holds the edit lock. */
const LOST_EDITORSHIP = 'EditorshipLostError';

/** Mounts the Project list, versions panel, banners and autosave. */
export const mountProjects = (deps: ProjectsDeps): void => {
  const { channel, lock, shell, storage } = deps;
  const editor = shell.editor;
  let record: ProjectRecord | undefined = deps.initial.record;
  let firstSave = true;
  // What the Projects and Earlier Versions lists show (projects-window.tsx).
  const currentId = signal(deps.initial.id);
  const preview = signal<
    { latest: DeepReadonly<Project>; savedAt: number; seq: number } | undefined
  >(undefined);
  const orphaned = signal(false);
  const editing = signal(lock.editing);
  const records = signal<readonly ProjectRecord[]>([]);
  const versions = signal<readonly VersionInfo[]>([]);
  const renamingId = signal<string | undefined>(undefined);
  const confirmingDeleteId = signal<string | undefined>(undefined);
  // The current Project's file on disk, where Save writes back to it
  // (#823). `pendingDisk` carries a just-opened file's handle to the
  // Project it becomes, before that Project is the current one.
  const disk = fileAccessSupport(window);
  let diskFile: { handle: ProjectFileHandle; stamp: FileStamp } | undefined;
  let pendingDisk:
    { handle: ProjectFileHandle; id: string; stamp: FileStamp } | undefined;
  // Autosave is disabled without storage; still protect in-memory edits when
  // importing or switching Projects. An export makes that exact revision safe.
  let safeContent = editor.contentState;
  const hasUnsafeChanges = () =>
    (autosave.dirty || !storage || orphaned.value) &&
    editor.contentState !== safeContent;

  const notice = (text: string): void => {
    byId('notice-text').textContent = text;
    byId('notice-banner').hidden = false;
  };
  byId('notice-close').addEventListener('click', () => {
    byId('notice-banner').hidden = true;
  });
  if (deps.initial.notice) {
    notice(deps.initial.notice);
  }

  const drawReadonly = (): void => {
    byId('readonly-banner').hidden = lock.editing || orphaned.value;
  };

  /** Draws Save, Save As and what saving to disk means in this browser. */
  const drawFileAccess = (): void => {
    const save = byId('save-file') as HTMLButtonElement;
    const saveAs = byId('save-file-as') as HTMLButtonElement;
    save.hidden = !disk.save;
    saveAs.hidden = !disk.save;
    byId('save-file-rule').hidden = !disk.save;
    // Only the editing tab writes a Project's file; a read-only copy
    // could be older than the one being edited. Export still downloads.
    save.disabled = !lock.editing || !!preview.value;
    saveAs.disabled = save.disabled;
    save.title = diskFile
      ? `Save back to ${diskFile.stamp.name}`
      : 'Save to a file on disk';
    byId('file-access-status').textContent = !disk.save
      ? "This browser can't save back to an opened file, so Export " +
        'downloads a copy and Import opens one.'
      : diskFile
        ? `Save writes this Project back to “${diskFile.stamp.name}”.`
        : 'This browser can save back to a file on disk: use ' +
          'Save As… once, then Save.';
  };

  const asProjectHandle = (
    found: ProjectFileHandleRecord,
  ): { handle: ProjectFileHandle; stamp: FileStamp } | undefined => {
    const handle = found.handle as ProjectFileHandle | undefined;
    if (
      !handle ||
      handle.kind !== 'file' ||
      typeof handle.getFile !== 'function' ||
      typeof handle.createWritable !== 'function'
    ) {
      return undefined;
    }
    return {
      handle,
      stamp: {
        name: found.name,
        ...(found.lastModified === undefined
          ? {}
          : { lastModified: found.lastModified }),
        ...(found.size === undefined ? {} : { size: found.size }),
      },
    };
  };

  /** Keeps a Project's file handle, in storage and for the desk. */
  const rememberDiskFile = async (
    id: string,
    handle: ProjectFileHandle,
    stamp: FileStamp,
  ): Promise<void> => {
    pendingDisk = { handle, id, stamp };
    if (id === currentId.value) {
      diskFile = { handle, stamp };
      drawFileAccess();
    }
    await storage?.setFileHandle(id, { handle, ...stamp }).catch(() => {});
  };

  /** Loads the file handle of the Project going on the desk, if any. */
  const loadDiskFile = async (id: string): Promise<void> => {
    const stored = storage
      ? await storage.fileHandle(id).catch(() => undefined)
      : undefined;
    diskFile =
      (stored ? asProjectHandle(stored) : undefined) ??
      (pendingDisk?.id === id
        ? { handle: pendingDisk.handle, stamp: pendingDisk.stamp }
        : undefined);
    drawFileAccess();
  };

  const drawSaveStatus = (state: AutosaveState): void => {
    byId('save-status').textContent = !storage
      ? 'Not kept by this browser'
      : !lock.editing
        ? 'Read-only'
        : {
            saved: 'Saved',
            dirty: 'Unsaved changes',
            saving: 'Saving…',
            failed: "Couldn't save",
          }[state];
  };

  const drawStorageStatus = async (): Promise<void> => {
    const persisted =
      storage && navigator.storage?.persisted
        ? await navigator.storage.persisted().catch(() => undefined)
        : undefined;
    byId('persist-status').textContent = !storage
      ? "This browser won't keep your work here."
      : persisted === undefined
        ? ''
        : persisted
          ? 'Kept by the browser until you clear it.'
          : 'The browser may clear this. Export a copy to keep it.';
    byId('export-reminder').hidden =
      !record ||
      persisted !== false ||
      (record.exportedAt ?? 0) >= record.modifiedAt;
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage
        .estimate()
        .catch(() => undefined);
      if (estimate?.usage !== undefined) {
        byId('storage-use').textContent =
          `Using about ${byteSize(estimate.usage)}` +
          (estimate.quota ? ` of ${byteSize(estimate.quota)}` : '') +
          ' kept for this site.';
      }
    }
  };

  /** Asks the browser to keep the data, after the first saved edit. */
  const askPersist = async (): Promise<void> => {
    if (navigator.storage?.persist) {
      await navigator.storage.persist().catch(() => false);
    }
    await drawStorageStatus();
  };

  const save = async (): Promise<void> => {
    if (!storage || orphaned.value || preview.value) {
      return;
    }
    const captured = editor.capture();
    const savingId = currentId.value;
    if (!(await lock.stillEditing())) {
      lock.release();
      throw new StorageError('Another tab took over editing.', LOST_EDITORSHIP);
    }
    if (
      editor.generation !== captured.generation ||
      currentId.value !== savingId
    ) {
      return;
    }
    const saved = await storage.saveProject(savingId, captured.project, {
      assets: shell.images.forStorage(captured.project),
    });
    if (
      editor.generation === captured.generation &&
      currentId.value === savingId
    ) {
      record = saved;
    }
    channel?.post({ type: 'saved', projectId: savingId, seq: saved.seq });
  };

  const autosave = new Autosave(save, {
    onError: error => {
      const lost = errorNameOf(error) === LOST_EDITORSHIP;
      if (lost) {
        drawReadonly();
      }
      byId('save-banner-text').textContent =
        `${lost ? "Couldn't save: another tab took over editing." : failureMessage(error)} Your work is still here — export a copy to keep it.`;
      byId('save-banner-details').textContent =
        `${errorNameOf(error)}: ${error instanceof Error ? error.message : ''}`;
      byId('save-banner').hidden = false;
    },
    onSaved: () => {
      byId('save-banner').hidden = true;
      if (firstSave) {
        firstSave = false;
        void askPersist();
      } else if (!byId('projects-window').hidden) {
        void drawStorageStatus();
      }
      void drawList();
      void drawVersions();
    },
    onState: drawSaveStatus,
  });

  const applyEditing = (editingNow: boolean): void => {
    editing.value = lock.editing;
    if (!preview.value) {
      shell.setReadOnly(!editingNow);
    }
    autosave.setEnabled(
      editingNow && !!storage && !preview.value && !orphaned.value,
    );
    drawReadonly();
    drawFileAccess();
    drawSaveStatus(autosave.state);
    void drawVersions();
  };

  deps.lockDelegate.flush = () => autosave.flush();
  deps.lockDelegate.onEditing = applyEditing;

  editor.onChange = () => {
    if (!preview.value && !orphaned.value) {
      autosave.markDirty();
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void autosave.flush();
    } else if (behind) {
      void followLatest();
    }
  });

  if (!storage) {
    byId('storage-banner').hidden = false;
    byId('storage-banner-details').textContent =
      `${errorNameOf(deps.storageError)}: ` +
      (deps.storageError instanceof Error ? deps.storageError.message : '');
  }
  autosave.setEnabled(lock.editing && !!storage);
  drawReadonly();
  drawSaveStatus(autosave.state);

  /**
   * Builds the bytes of a portable Project file from the in-memory
   * Project and its asset bytes, for Export's download and for saving
   * back to a file on disk.
   */
  const buildProjectFile = async (): Promise<{
    file: Uint8Array;
    id: string;
    missingNames: string[];
    project: DeepReadonly<Project>;
    source: { contentState: number; generation: number };
  }> => {
    editor.finishPendingEdit();
    const captured = editor.capture();
    const source = {
      generation: captured.generation,
      contentState: captured.contentState,
    };
    const project = projectForExport(captured.project);
    const id = currentId.value;
    // Session bytes cover most assets; read only the rest from storage.
    const missing = [...new Set(project.assets.map(a => a.hash))].filter(
      hash => !shell.images.bytes.has(hash),
    );
    const bytes =
      storage && missing.length
        ? await storage.assetBytes(missing)
        : new Map<string, Uint8Array>();
    for (const [hash, data] of shell.images.bytes) {
      bytes.set(hash, data);
    }
    const file = await writeProjectFile(project, bytes, {
      allowMissing: true,
    });
    return {
      file,
      id,
      missingNames: project.assets
        .filter(a => !bytes.has(a.hash))
        .map(a => a.name),
      project,
      source,
    };
  };

  /** Records that this exact revision now exists as a file outside storage. */
  const markFileSaved = async (
    built: Awaited<ReturnType<typeof buildProjectFile>>,
  ): Promise<void> => {
    if (
      currentId.value === built.id &&
      editor.generation === built.source.generation &&
      editor.contentState === built.source.contentState
    ) {
      safeContent = built.source.contentState;
    }
    if (
      storage &&
      record &&
      !orphaned.value &&
      currentId.value === built.id &&
      editor.generation === built.source.generation &&
      editor.contentState === built.source.contentState
    ) {
      const now = Date.now();
      await storage.markExported(currentId.value, now).catch(() => {});
      record = { ...record, exportedAt: now };
      await drawStorageStatus();
    }
  };

  /** Downloads a stable copy of the in-memory Project and its asset bytes. */
  const exportNow = async (): Promise<void> => {
    try {
      const built = await buildProjectFile();
      const url = URL.createObjectURL(
        new Blob([built.file as Uint8Array<ArrayBuffer>], {
          type: PROJECT_MIMETYPE,
        }),
      );
      const link = h('a', {
        href: url,
        download: `${built.project.name || 'Project'}.folio`,
      });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notice(
        `Exported ${built.project.name} (${byteSize(built.file.length)}).${missingNote(built.missingNames)}`,
      );
      await markFileSaved(built);
    } catch (error) {
      notice(
        `Couldn't export: ${error instanceof Error ? error.message : ''} (${errorNameOf(error)})`,
      );
    }
  };
  for (const button of document.querySelectorAll('[data-export-now]')) {
    button.addEventListener('click', () => void exportNow());
  }

  /** Writes the current Project to a file handle and keeps the handle. */
  const saveToDisk = async (
    handle: ProjectFileHandle,
    expected?: FileStamp,
  ): Promise<void> => {
    try {
      await autosave.flush();
      const built = await buildProjectFile();
      const stamp = await saveToHandle(handle, built.file, expected);
      await rememberDiskFile(built.id, handle, stamp);
      notice(
        `Saved ${built.project.name} to ${stamp.name} (${byteSize(built.file.length)}).${missingNote(built.missingNames)}`,
      );
      await markFileSaved(built);
    } catch (error) {
      notice(
        `Couldn't save to the file: ${error instanceof Error ? error.message : ''} (${fileErrorName(error)})`,
      );
    }
  };

  /** Save As: choose the file, then save to it. Cancelling is silent. */
  const saveAsToDisk = async (): Promise<void> => {
    let handle: ProjectFileHandle | undefined;
    try {
      handle = await pickSaveHandle(
        window,
        `${editor.project.name || 'Project'}.folio`,
      );
    } catch (error) {
      notice(
        `Couldn't save to a file: ${error instanceof Error ? error.message : ''} (${fileErrorName(error)})`,
      );
      return;
    }
    if (handle) {
      await saveToDisk(handle);
    }
  };

  byId('save-file').addEventListener('click', () => {
    void (diskFile
      ? saveToDisk(diskFile.handle, diskFile.stamp)
      : saveAsToDisk());
  });
  byId('save-file-as').addEventListener('click', () => void saveAsToDisk());
  byId('free-space').addEventListener('click', () => {
    void (async () => {
      await storage?.freeSpace().catch(error => notice(String(error)));
      await autosave.flush();
    })();
  });
  byId('show-storage-use').addEventListener('click', () => {
    byId('projects-window').hidden = false;
    void drawStorageStatus();
  });

  const loadAssets = async (project: DeepReadonly<Project>): Promise<void> => {
    if (!storage) {
      return;
    }
    const assets = project.assets.filter(a => !shell.images.bytes.has(a.hash));
    if (!assets.length) {
      return;
    }
    const bytes = await storage.assetBytes(assets.map(a => a.hash));
    for (const asset of assets) {
      const data = bytes.get(asset.hash);
      if (!data || shell.images.bytes.has(asset.hash)) {
        continue;
      }
      try {
        const file = new File(
          [data as Uint8Array<ArrayBuffer>],
          asset.fileName,
        );
        const imported = isSoundAsset(asset)
          ? await importSound(file)
          : await importImage(file);
        shell.images.add(imported);
      } catch {
        /* Invalid assets stay missing: images render as placeholders, and
           playing a missing sound is a Script error. */
      }
    }
  };
  void loadAssets(editor.project)
    .then(() => shell.redraw())
    .catch(error => notice(String(error)));

  /**
   * Fully validate before saving under a fresh ID; never overwrite a
   * Project. A file opened with a handle (from the operating system, a
   * picker or a drop) keeps it, so Save can write back to it — and a
   * file this app refuses, such as a newer format, never gets a handle
   * kept, so it can never be overwritten. Gives the stored Project's id.
   */
  const importProject = async (
    file: File,
    handle?: ProjectFileHandle,
    opened?: string,
  ): Promise<string | undefined> => {
    try {
      const loaded = await readProjectFile(
        new Uint8Array(await file.arrayBuffer()),
      );
      if (!loaded.project.pages.length) {
        throw new Error('The Project is damaged: it has no Pages.');
      }
      const messages = loaded.missingAssets.map(a =>
        isSoundAsset(a)
          ? `Missing sound: ${a.name}. Scripts that play it will report an error; add the file again with Add sound… in Info.`
          : `Missing image: ${a.name}. Use Replace on the Page or in Info.`,
      );
      const accepted = [];
      for (const asset of loaded.project.assets) {
        const data = loaded.assets.get(asset.hash);
        if (!data) {
          continue;
        }
        try {
          const file = new File(
            [data as Uint8Array<ArrayBuffer>],
            asset.fileName,
          );
          const imported = isSoundAsset(asset)
            ? await importSound(file)
            : await importImage(file);
          asset.mediaType = imported.asset.mediaType;
          accepted.push(imported);
          messages.push(...imported.warnings);
        } catch (error) {
          loaded.assets.delete(asset.hash);
          messages.push(
            isSoundAsset(asset)
              ? `${asset.name}: ${String(error)} Scripts that play it will report an error.`
              : `${asset.name}: ${String(error)} Use Replace on the Page or in Info.`,
          );
        }
      }
      editor.finishPendingEdit();
      await autosave.flush();
      if (hasUnsafeChanges()) {
        throw new Error(
          "Couldn't save your latest work, so it stays on the desk. Export a copy first.",
        );
      }
      // Stage bytes separately until the new Project's transaction succeeds.
      const assets = new Map(
        accepted.map(imported => [
          imported.asset.hash,
          storageAsset(imported.bytes, imported.asset.mediaType),
        ]),
      );
      const previousId = currentId.value;
      const previousModel = editor.stamp();
      const created = storage
        ? await storage.saveProject(undefined, loaded.project, { assets })
        : undefined;
      const importedId = created?.id ?? `unsaved-${crypto.randomUUID()}`;
      if (handle) {
        await rememberDiskFile(importedId, handle, stampOfFile(file));
      }
      if (currentId.value !== previousId || !editor.isCurrent(previousModel)) {
        channel?.post({ type: 'list-changed' });
        await drawList();
        notice(
          'The imported Project is in Projects. Your current edits stay on the desk.',
        );
        return created?.id;
      }
      for (const imported of accepted) {
        shell.images.add(imported);
      }
      await showLoaded(
        { project: loaded.project, migrated: false, record: created },
        importedId,
      );
      channel?.post({ type: 'list-changed' });
      if (opened) {
        messages.unshift(opened);
      }
      if (messages.length) {
        notice(messages.join(' '));
      }
      return created?.id;
    } catch (error) {
      notice(`Couldn't import: ${String(error)}`);
      return undefined;
    }
  };
  let importing = false;
  const importFiles = async (
    entries: { file: File; handle?: ProjectFileHandle }[],
  ) => {
    if (importing) {
      return;
    }
    importing = true;
    try {
      for (const { file, handle } of entries) {
        await importProject(file, handle);
      }
    } finally {
      importing = false;
    }
  };
  const openInputPicker = (): void => {
    // No accept filter: custom Project extensions must remain pickable on iOS.
    const picker = h('input', { type: 'file' }) as HTMLInputElement;
    picker.addEventListener(
      'change',
      () => void importFiles([...(picker.files ?? [])].map(file => ({ file }))),
    );
    picker.click();
  };
  byId('import-project').addEventListener('click', () => {
    if (!disk.open) {
      openInputPicker();
      return;
    }
    // Where the browser has the file picker that returns handles, an
    // opened Project can later be saved back to the same file. Any
    // failure but a cancellation falls back to the plain picker.
    void (async () => {
      let handles: ProjectFileHandle[] | undefined;
      try {
        handles = await pickOpenHandles(window);
      } catch {
        openInputPicker();
        return;
      }
      if (!handles) {
        return;
      }
      const entries = [];
      for (const handle of handles) {
        entries.push({ file: await handle.getFile(), handle });
      }
      await importFiles(entries);
    })().catch(error => notice(`Couldn't import: ${String(error)}`));
  });
  byId('projects-window').addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
    }
  });
  byId('projects-window').addEventListener('drop', event => {
    if (!event.dataTransfer?.files.length) {
      return;
    }
    event.preventDefault();
    const transfer = event.dataTransfer;
    void (async () => {
      const entries: { file: File; handle?: ProjectFileHandle }[] = [];
      const items = [...transfer.items].filter(item => item.kind === 'file');
      if (items.length === transfer.files.length) {
        for (const [index, item] of items.entries()) {
          const handle = await dropHandle(item);
          entries.push({
            file: transfer.files[index]!,
            ...(handle ? { handle } : {}),
          });
        }
      } else {
        entries.push(...[...transfer.files].map(file => ({ file })));
      }
      await importFiles(entries);
    })();
  });

  // Project files opened from the operating system, in the installed
  // app (#823): the manifest's file handler launches or focuses this
  // page, and the files arrive here with handles for Save.
  onLaunchFiles(window, handles => {
    void (async () => {
      const entries = [];
      for (const handle of handles) {
        entries.push({ file: await handle.getFile(), handle });
      }
      await importFiles(entries);
    })().catch(error => notice(`Couldn't import: ${String(error)}`));
  });

  let switching = false;
  /** Puts a loaded Project on the desk and makes it the one being edited. */
  const showLoaded = async (
    loaded: Omit<LoadedProject, 'project' | 'record'> & {
      project: DeepReadonly<Project>;
      record?: ProjectRecord;
    },
    id: string,
  ): Promise<void> => {
    if (switching) {
      return;
    }
    switching = true;
    const before = editor.stamp();
    try {
      await loadAssets(loaded.project);
      if (!editor.isCurrent(before)) {
        notice(
          'Your current edits stay on the desk. Open the other Project from Projects when ready.',
        );
        return;
      }
      shell.setReadOnly(true);
      const editingNow = await lock.acquire(id);
      preview.value = undefined;
      byId('preview-note').hidden = true;
      orphaned.value = false;
      byId('orphan-banner').hidden = true;
      currentId.value = id;
      record = loaded.record;
      editor.replaceProject(loaded.project);
      safeContent = editor.contentState;
      shell.setReadOnly(!editingNow);
      autosave.setEnabled(editingNow && !!storage);
      shell.redraw();
      drawReadonly();
      await loadDiskFile(id);
      drawSaveStatus(autosave.state);
      await storage?.setLastProjectId(id).catch(() => {});
      if (loaded.migrated && editingNow) {
        // Keep the pre-migration record as an earlier version.
        autosave.markDirty();
        await autosave.flush();
      }
      await drawList();
      await drawVersions();
      await drawStorageStatus();
    } finally {
      switching = false;
      shell.setReadOnly(!!preview.value || !lock.editing);
    }
  };

  /** Opens a stored Project, flushing the current one first. */
  const openProject = async (id: string): Promise<void> => {
    if (!storage || id === currentId.value) {
      return;
    }
    editor.finishPendingEdit();
    await autosave.flush();
    if (hasUnsafeChanges()) {
      notice(
        "Couldn't save your latest work, so it stays on the desk. Export a copy first.",
      );
      return;
    }
    let loaded: LoadedProject;
    try {
      loaded = await storage.loadProject(id);
    } catch (error) {
      notice(
        error instanceof Error ? error.message : "Couldn't open that Project.",
      );
      return;
    }
    await showLoaded(loaded, id);
  };

  const newProject = async (): Promise<void> => {
    editor.finishPendingEdit();
    await autosave.flush();
    if (hasUnsafeChanges()) {
      notice(
        "Couldn't save your latest work, so it stays on the desk. Export a copy first.",
      );
      return;
    }
    const project = createProject(UNTITLED);
    if (!storage) {
      await showLoaded(
        { project, migrated: false },
        `unsaved-${crypto.randomUUID()}`,
      );
      return;
    }
    const created = await storage.saveProject(undefined, project);
    channel?.post({ type: 'list-changed' });
    await showLoaded({ project, migrated: false, record: created }, created.id);
  };

  /**
   * Opens a fresh copy of an Example Project (#824), like an import: it
   * never overwrites the Project on the desk, and its assets are decoded
   * before anything is saved, so a copy that cannot play is refused.
   */
  const openExample = async (example: ExampleProject): Promise<void> => {
    try {
      const content = await example.create();
      const accepted = [];
      for (const asset of content.project.assets) {
        const data = content.assets.get(asset.hash)!;
        const file = new File(
          [data as Uint8Array<ArrayBuffer>],
          asset.fileName,
        );
        accepted.push(
          isSoundAsset(asset)
            ? await importSound(file)
            : await importImage(file),
        );
      }
      editor.finishPendingEdit();
      await autosave.flush();
      if (hasUnsafeChanges()) {
        notice(
          "Couldn't save your latest work, so it stays on the desk. Export a copy first.",
        );
        return;
      }
      const assets = new Map(
        accepted.map(imported => [
          imported.asset.hash,
          storageAsset(imported.bytes, imported.asset.mediaType),
        ]),
      );
      const created = storage
        ? await storage.saveProject(undefined, content.project, { assets })
        : undefined;
      const id = created?.id ?? `unsaved-${crypto.randomUUID()}`;
      for (const imported of accepted) {
        shell.images.add(imported);
      }
      channel?.post({ type: 'list-changed' });
      await showLoaded(
        { project: content.project, migrated: false, record: created },
        id,
      );
      notice(
        `Opened a fresh copy of “${example.name}”. Choose Browse in Tools to try it, then make it your own.`,
      );
    } catch (error) {
      notice(`Couldn't open “${example.name}”: ${String(error)}`);
    }
  };

  /**
   * Opens the Example Project at `/folio/<slug>` (#1676) from the
   * `.folio` file the build wrote for it.
   */
  const openExampleFile = async (slug: string): Promise<void> => {
    const example = EXAMPLE_PROJECTS.find(e => e.slug === slug);
    if (!example) {
      notice(`There's no Example Project called “${slug}”.`);
      return;
    }
    await openSource({
      source: `example:${slug}`,
      name: `“${example.name}”`,
      fileName: `${slug}.folio`,
      load: async () => {
        const response = await fetch(exampleFilePath(slug));
        if (!response.ok) {
          throw new Error(`the server answered ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    });
  };

  /** Opens the `.folio` file at `/folio/?open=<url>` (#1677). */
  const openUrlFile = (url: string): Promise<void> =>
    openSource({
      source: `url:${url}`,
      name: `the Project at ${url}`,
      fileName: fileNameOf(url),
      load: () => fetchProjectFile(url),
    });

  /** Opens the Project a Shared Link, `#p1.<payload>`, carries (#1678). */
  const openSharedLink = async (payload: string): Promise<void> =>
    openSource({
      source: `link:${await sha256Hex(new TextEncoder().encode(payload))}`,
      name: 'the shared Project',
      fileName: 'shared.folio',
      load: async () =>
        writeProjectFile(await readSharedLink(payload), new Map()),
    });

  /** Copies the Shared Link for the Project on the desk (#1678). */
  const shareLink = async (): Promise<void> => {
    editor.finishPendingEdit();
    let link: string;
    try {
      link = await sharedLinkFor(
        projectForExport(editor.capture().project),
        location.href,
      );
    } catch (error) {
      notice(
        `Couldn't share: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      notice(
        `Copied a link to this Project. Anyone who opens it gets their own copy.`,
      );
    } catch {
      notice(`Copy this link to share the Project: ${link}`);
    }
  };
  byId('share-link').addEventListener('click', () => void shareLink());

  type CopySource = {
    fileName: string;
    load: () => Promise<Uint8Array>;
    /** How notices name what was opened. */
    name: string;
    /** The key the copy is remembered under, such as `example:tetris`. */
    source: string;
  };

  /**
   * Opens a Project from a URL (ADR 0141). When an earlier visit made a
   * copy that still exists, the copy banner offers it or a fresh one
   * (#1679); otherwise a fresh copy opens straight away.
   */
  const openSource = async (from: CopySource): Promise<void> => {
    const existing = await storage?.copyOf(from.source).catch(() => undefined);
    if (!existing) {
      await openFreshCopy(from);
      return;
    }
    byId('copy-banner-text').textContent =
      `You already have a copy of ${from.name}.`;
    byId('copy-banner').hidden = false;
    copyChoice = {
      fresh: () => openFreshCopy(from),
      mine: () => openProject(existing),
    };
  };
  let copyChoice:
    { fresh: () => Promise<void>; mine: () => Promise<void> } | undefined;
  const chooseCopy = (choice: 'fresh' | 'mine'): void => {
    byId('copy-banner').hidden = true;
    const chosen = copyChoice?.[choice];
    copyChoice = undefined;
    void chosen?.();
  };
  byId('open-my-copy').addEventListener('click', () => chooseCopy('mine'));
  byId('open-fresh-copy').addEventListener('click', () => chooseCopy('fresh'));

  /** Imports a fresh copy of a source's file and remembers it. */
  const openFreshCopy = async (from: CopySource): Promise<void> => {
    let bytes: Uint8Array;
    try {
      bytes = await from.load();
    } catch (error) {
      notice(
        `Couldn't open ${from.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const id = await importProject(
      new File([bytes as Uint8Array<ArrayBuffer>], from.fileName),
      undefined,
      `Opened a fresh copy of ${from.name}. Choose Browse in Tools to try it, then make it your own.`,
    );
    if (id) {
      await storage?.setCopyOf(from.source, id).catch(() => {});
    }
  };

  const renameProject = async (id: string, title: string): Promise<void> => {
    const name = title.trim();
    if (!name) {
      notice('A Project needs a name.');
      return;
    }
    try {
      if (id === currentId.value) {
        const edit = editor.startEdit();
        edit.change(({ tree }) => tree.setProjectName(name));
        edit.finish();
        shell.redraw();
        await autosave.flush();
      } else if (storage) {
        await storage.renameProject(id, name);
        channel?.post({ type: 'list-changed' });
      }
    } catch (error) {
      notice(
        error instanceof Error
          ? error.message
          : "Couldn't rename that Project.",
      );
    }
    await drawList();
  };

  const deleteProject = async (id: string): Promise<void> => {
    if (!storage) {
      return;
    }
    await storage.deleteProject(id);
    channel?.post({ type: 'deleted', projectId: id });
    channel?.post({ type: 'list-changed' });
    if (id !== currentId.value) {
      await drawList();
      return;
    }
    const records = await storage.listProjects();
    const [next] = records;
    await (next
      ? storage.loadProject(next.id).then(loaded => showLoaded(loaded, next.id))
      : newProject());
  };

  /** Loads the Project list; a hidden window is loaded when it opens. */
  const drawList = async (): Promise<void> => {
    if (byId('projects-window').hidden || !storage) {
      return;
    }
    records.value = await storage.listProjects().catch(() => []);
    (byId('new-project') as HTMLButtonElement).disabled = false;
  };

  const exitPreview = (project: DeepReadonly<Project>): void => {
    preview.value = undefined;
    byId('preview-note').hidden = true;
    editor.replaceProject(project);
    shell.setReadOnly(!lock.editing);
    autosave.setEnabled(lock.editing && !!storage && !orphaned.value);
    shell.redraw();
    drawFileAccess();
    void drawVersions();
  };

  /** Loads the version list; a hidden window is loaded when it opens. */
  const drawVersions = async (): Promise<void> => {
    (byId('restore-version') as HTMLButtonElement).disabled = !lock.editing;
    if (byId('versions-window').hidden || !storage || orphaned.value) {
      return;
    }
    versions.value = await storage
      .listVersions(currentId.value)
      .catch(() => []);
  };

  const previewVersion = async (
    seq: number,
    savedAt: number,
  ): Promise<void> => {
    if (!storage) {
      return;
    }
    editor.finishPendingEdit();
    const expected = editor.stamp();
    const previewId = currentId.value;
    await autosave.flush();
    if (autosave.dirty && !preview.value) {
      notice(
        "Couldn't save your latest work, so it stays on the desk. Export a copy first.",
      );
      return;
    }
    let loaded: LoadedProject;
    try {
      loaded = await storage.loadVersion(previewId, seq);
    } catch (error) {
      notice(
        error instanceof Error ? error.message : "Couldn't open that version.",
      );
      return;
    }
    await loadAssets(loaded.project);
    if (!editor.isCurrent(expected) || currentId.value !== previewId) {
      notice(
        'Your current edits stay on the desk. Open the earlier version again when ready.',
      );
      return;
    }
    preview.value = {
      seq,
      savedAt,
      latest: preview.value?.latest ?? editor.snapshot(),
    };
    autosave.setEnabled(false);
    editor.replaceProject(loaded.project);
    shell.setReadOnly(true);
    shell.redraw();
    byId('preview-text').textContent =
      `Viewing the version from ${when(savedAt)} — ` +
      'nothing you see here is being saved.';
    byId('preview-note').hidden = false;
    (byId('restore-version') as HTMLButtonElement).disabled = !lock.editing;
    drawFileAccess();
    await drawVersions();
  };

  byId('back-to-latest').addEventListener('click', () => {
    if (preview.value) {
      exitPreview(preview.value.latest);
    }
  });
  byId('restore-version').addEventListener('click', () => {
    void (async () => {
      if (!storage || !preview.value || !lock.editing) {
        return;
      }
      if (!(await lock.stillEditing())) {
        lock.release();
        return;
      }
      const restored = await storage.restoreVersion(
        currentId.value,
        preview.value.seq,
      );
      record = restored.record;
      channel?.post({
        type: 'saved',
        projectId: currentId.value,
        seq: restored.record.seq,
      });
      exitPreview(restored.project);
      await drawList();
    })().catch(error => notice(String(error)));
  });

  byId('edit-here').addEventListener('click', () => {
    void (async () => {
      if (!(await lock.takeOver()) || !storage) {
        applyEditing(lock.editing);
        return;
      }
      // The tab that gave up editing flushed first; show its latest save.
      const loaded = await storage
        .loadProject(currentId.value)
        .catch(() => undefined);
      if (loaded) {
        record = loaded.record;
        editor.replaceProject(loaded.project);
        shell.redraw();
      }
      applyEditing(true);
    })();
  });

  byId('keep-as-new').addEventListener('click', () => {
    void (async () => {
      if (!storage) {
        return;
      }
      const carried = diskFile;
      const captured = editor.capture();
      const created = await storage.saveProject(undefined, captured.project, {
        assets: shell.images.forStorage(captured.project),
      });
      channel?.post({ type: 'list-changed' });
      if (!editor.isCurrent(captured)) {
        await drawList();
        notice('The copy is in Projects. Your current edits stay on the desk.');
        return;
      }
      await showLoaded(
        {
          project: captured.project,
          migrated: false,
          record: created,
        },
        created.id,
      );
      if (carried) {
        await rememberDiskFile(created.id, carried.handle, carried.stamp);
      }
    })().catch(error => notice(String(error)));
  });

  const onChannelMessage = (message: ProjectMessage): void => {
    if (message.type === 'list-changed') {
      void drawList();
      return;
    }
    if (message.projectId !== currentId.value) {
      return;
    }
    if (message.type === 'deleted') {
      orphaned.value = true;
      autosave.setEnabled(false);
      byId('orphan-banner').hidden = false;
      byId('readonly-banner').hidden = true;
      void drawList();
      return;
    }
    // Unsaved work in this tab is never replaced; it keeps its banner.
    if (message.type === 'saved') {
      void followLatest();
    }
  };

  // A read-only tab follows the editing tab's saves: one load at a time,
  // and none while the tab is hidden; the latest is loaded when it shows.
  let behind = false;
  let following = false;
  const followLatest = async (): Promise<void> => {
    behind = true;
    if (following || document.hidden) {
      return;
    }
    following = true;
    while (behind) {
      behind = false;
      // Unsaved work in this tab is never replaced; it keeps its banner.
      if (lock.editing || preview.value || autosave.dirty || !storage) {
        break;
      }
      await storage
        .loadProject(currentId.value)
        .then(async loaded => {
          await loadAssets(loaded.project);
          record = loaded.record;
          editor.replaceProject(loaded.project);
          shell.redraw();
          return drawVersions();
        })
        .catch(() => {});
    }
    following = false;
  };
  channel?.listen(onChannelMessage);

  const toggleWindow = (id: string, draw: () => Promise<void>): void => {
    const win = byId(id);
    win.hidden = !win.hidden;
    if (!win.hidden) {
      void draw();
    }
  };
  byId('show-projects').addEventListener('click', () =>
    toggleWindow('projects-window', async () => {
      await drawList();
      await drawStorageStatus();
    }),
  );
  byId('close-projects').addEventListener('click', () => {
    byId('projects-window').hidden = true;
  });
  byId('show-versions').addEventListener('click', () =>
    toggleWindow('versions-window', drawVersions),
  );
  byId('close-versions').addEventListener('click', () => {
    byId('versions-window').hidden = true;
  });
  byId('new-project').addEventListener('click', () => void newProject());
  mountProjectsWindow(
    {
      examples: byId('example-list'),
      projects: byId('project-list'),
      versions: byId('version-list'),
    },
    {
      actions: {
        backToLatest: () => {
          if (preview.value) {
            exitPreview(preview.value.latest);
          }
        },
        cancel: () => {
          renamingId.value = undefined;
          confirmingDeleteId.value = undefined;
        },
        confirmDelete: id => {
          confirmingDeleteId.value = id;
          renamingId.value = undefined;
        },
        delete: id => {
          void deleteProject(id)
            .catch(error => notice(String(error)))
            .finally(() => {
              if (confirmingDeleteId.value === id) {
                confirmingDeleteId.value = undefined;
              }
            });
        },
        duplicate: id => {
          void storage
            ?.duplicateProject(id)
            .then(() => {
              channel?.post({ type: 'list-changed' });
              return drawList();
            })
            .catch(error => notice(String(error)));
        },
        open: id => void openProject(id),
        openExample: example => void openExample(example),
        previewVersion: version =>
          void previewVersion(version.seq, version.savedAt),
        // The field stays until the list shows the new name.
        rename: (id, title) =>
          void renameProject(id, title).finally(() => {
            if (renamingId.value === id) {
              renamingId.value = undefined;
            }
          }),
        startRename: id => {
          renamingId.value = id;
          confirmingDeleteId.value = undefined;
        },
      },
      examples: EXAMPLE_PROJECTS,
      state: {
        confirmingDeleteId,
        currentId,
        editing,
        orphaned,
        previewSeq: computed(() => preview.value?.seq),
        records,
        renamingId,
        stored: !!storage,
        versions,
      },
    },
  );

  void storage?.setLastProjectId(currentId.value).catch(() => {});
  void loadDiskFile(currentId.value);
  void drawList();
  void drawVersions();
  void drawStorageStatus();
  if (deps.exampleSlug) {
    void openExampleFile(deps.exampleSlug);
  } else if (deps.openUrl) {
    void openUrlFile(deps.openUrl);
  } else if (deps.sharedLink) {
    void openSharedLink(deps.sharedLink);
  }
  if (deps.initial.migrated && lock.editing && storage) {
    // Save the migrated model, keeping the old record as an earlier version.
    autosave.markDirty();
    void autosave.flush();
  }
};
