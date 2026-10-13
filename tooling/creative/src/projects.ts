// The Project list, earlier versions, autosave wiring and the banners
// storage failures show (#752). The IndexedDB layer is `storage.ts`, the
// scheduling is `autosave.ts`, and one-editor-per-Project is `edit-lock.ts`;
// this file draws them and connects them to the Stack shell.
import { Autosave, failureMessage, type AutosaveState } from './autosave';
import {
  EditLock,
  type ProjectChannel,
  type ProjectMessage,
} from './edit-lock';
import { createProject, type Project } from './model';
import { PROJECT_MIMETYPE, writeProjectFile } from './project-file';
import type { StackShell } from './stack';
import {
  errorNameOf,
  StorageError,
  type LoadedProject,
  type ProjectRecord,
  type ProjectStorage,
} from './storage';
import { byId, h } from './dom';

const when = (time: number): string => new Date(time).toLocaleString();

const byteSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

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
  initial: InitialProject;
  lock: EditLock;
  lockDelegate: LockDelegate;
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
  let currentId = deps.initial.id;
  let record: ProjectRecord | undefined = deps.initial.record;
  let preview: { latest: Project; savedAt: number; seq: number } | undefined;
  let orphaned = false;
  let firstSave = true;
  let renamingId: string | undefined;
  let confirmingDeleteId: string | undefined;

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
    byId('readonly-banner').hidden = lock.editing || orphaned;
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
    if (!storage || orphaned || preview) {
      return;
    }
    if (!(await lock.stillEditing())) {
      lock.release();
      throw new StorageError('Another tab took over editing.', LOST_EDITORSHIP);
    }
    // Asset bytes arrive with image assets (#753); the model and any new
    // assets are already written together in one transaction.
    record = await storage.saveProject(currentId, editor.project);
    channel?.post({ type: 'saved', projectId: currentId, seq: record.seq });
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
      } else {
        void drawStorageStatus();
      }
      void drawList();
      void drawVersions();
    },
    onState: drawSaveStatus,
  });

  const applyEditing = (editingNow: boolean): void => {
    if (!preview) {
      shell.setReadOnly(!editingNow);
    }
    autosave.setEnabled(editingNow && !!storage && !preview && !orphaned);
    drawReadonly();
    drawSaveStatus(autosave.state);
    void drawVersions();
  };

  deps.lockDelegate.flush = () => autosave.flush();
  deps.lockDelegate.onEditing = applyEditing;

  editor.onChange = () => {
    if (!preview && !orphaned) {
      autosave.markDirty();
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void autosave.flush();
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

  /** Downloads the in-memory Project as a Project file (#753 settles import). */
  const exportNow = async (): Promise<void> => {
    try {
      const hashes = [...new Set(editor.project.assets.map(a => a.hash))];
      const bytes = storage
        ? await storage.assetBytes(hashes)
        : new Map<string, Uint8Array>();
      const file = await writeProjectFile(editor.project, bytes);
      const url = URL.createObjectURL(
        new Blob([file as Uint8Array<ArrayBuffer>], { type: PROJECT_MIMETYPE }),
      );
      const link = h('a', {
        href: url,
        download: `${editor.project.name || 'Project'}.zip`,
      });
      link.click();
      URL.revokeObjectURL(url);
      if (storage && record && !orphaned) {
        const now = Date.now();
        await storage.markExported(currentId, now);
        record = { ...record, exportedAt: now };
        await drawStorageStatus();
      }
    } catch (error) {
      notice(
        `Couldn't export: ${error instanceof Error ? error.message : ''} (${errorNameOf(error)})`,
      );
    }
  };
  for (const button of document.querySelectorAll('[data-export-now]')) {
    button.addEventListener('click', () => void exportNow());
  }
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

  /** Puts a loaded Project on the desk and makes it the one being edited. */
  const showLoaded = async (
    loaded: Omit<LoadedProject, 'record'> & { record?: ProjectRecord },
    id: string,
  ): Promise<void> => {
    preview = undefined;
    byId('preview-note').hidden = true;
    orphaned = false;
    byId('orphan-banner').hidden = true;
    currentId = id;
    record = loaded.record;
    const editingNow = await lock.acquire(id);
    editor.replaceProject(loaded.project);
    shell.setReadOnly(!editingNow);
    autosave.setEnabled(editingNow && !!storage);
    shell.redraw();
    drawReadonly();
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
  };

  /** Opens a stored Project, flushing the current one first. */
  const openProject = async (id: string): Promise<void> => {
    if (!storage || id === currentId) {
      return;
    }
    editor.finishPendingEdit();
    await autosave.flush();
    if (autosave.dirty) {
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
    if (autosave.dirty) {
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

  const renameProject = async (id: string, title: string): Promise<void> => {
    const name = title.trim();
    if (!name) {
      notice('A Project needs a name.');
      return;
    }
    try {
      if (id === currentId) {
        const edit = editor.startEdit();
        edit.change(() => {
          editor.project.name = name;
        });
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
    if (id !== currentId) {
      await drawList();
      return;
    }
    const records = await storage.listProjects();
    const [next] = records;
    await (next
      ? storage.loadProject(next.id).then(loaded => showLoaded(loaded, next.id))
      : newProject());
  };

  const drawList = async (): Promise<void> => {
    const list = byId('project-list');
    if (!storage) {
      list.replaceChildren(
        h('li', {}, "Projects can't be kept in this browser."),
      );
      return;
    }
    const records = await storage.listProjects().catch(() => []);
    list.replaceChildren(
      ...records.map(item => {
        const current = item.id === currentId;
        const lockedHere = current && !lock.editing;
        if (renamingId === item.id) {
          const input = h('input', {
            value: item.title,
            'aria-label': 'Project name',
          }) as HTMLInputElement;
          const save = h('button', { type: 'button' }, 'Save');
          save.addEventListener('click', () => {
            renamingId = undefined;
            void renameProject(item.id, input.value);
          });
          const cancel = h('button', { type: 'button' }, 'Cancel');
          cancel.addEventListener('click', () => {
            renamingId = undefined;
            void drawList();
          });
          return h('li', {}, input, save, cancel);
        }
        const parts: (Node | string)[] = [
          h(
            'span',
            { class: current ? 'title current' : 'title' },
            `${item.title} `,
            h('span', { class: 'muted' }, when(item.modifiedAt)),
          ),
        ];
        const button = (
          label: string,
          action: () => void,
          disabled = false,
        ): HTMLButtonElement => {
          const node = h(
            'button',
            { type: 'button', disabled },
            label,
          ) as HTMLButtonElement;
          node.addEventListener('click', action);
          return node;
        };
        if (!current) {
          parts.push(button('Open', () => void openProject(item.id)));
        }
        parts.push(
          button(
            'Rename',
            () => {
              renamingId = item.id;
              confirmingDeleteId = undefined;
              void drawList();
            },
            lockedHere,
          ),
          button('Duplicate', () => {
            void storage
              .duplicateProject(item.id)
              .then(() => {
                channel?.post({ type: 'list-changed' });
                return drawList();
              })
              .catch(error => notice(String(error)));
          }),
        );
        if (confirmingDeleteId === item.id) {
          parts.push(
            button('Delete this Project?', () => {
              confirmingDeleteId = undefined;
              void deleteProject(item.id).catch(error => notice(String(error)));
            }),
            button('Keep', () => {
              confirmingDeleteId = undefined;
              void drawList();
            }),
          );
        } else {
          parts.push(
            button(
              'Delete',
              () => {
                confirmingDeleteId = item.id;
                renamingId = undefined;
                void drawList();
              },
              lockedHere,
            ),
          );
        }
        return h('li', {}, ...parts);
      }),
    );
    (byId('new-project') as HTMLButtonElement).disabled = false;
  };

  const exitPreview = (project: Project): void => {
    preview = undefined;
    byId('preview-note').hidden = true;
    editor.replaceProject(project);
    shell.setReadOnly(!lock.editing);
    autosave.setEnabled(lock.editing && !!storage && !orphaned);
    shell.redraw();
    void drawVersions();
  };

  const drawVersions = async (): Promise<void> => {
    const list = byId('version-list');
    if (!storage || orphaned) {
      list.replaceChildren(h('li', {}, 'No earlier versions are kept.'));
      return;
    }
    const versions = await storage.listVersions(currentId).catch(() => []);
    list.replaceChildren(
      ...versions.map((version, index) => {
        const viewing = preview?.seq === version.seq;
        const node = h(
          'button',
          { type: 'button', disabled: viewing || (index === 0 && !preview) },
          viewing ? 'Viewing' : 'Preview',
        ) as HTMLButtonElement;
        node.addEventListener('click', () => {
          if (index === 0 && preview) {
            exitPreview(preview.latest);
          } else {
            void previewVersion(version.seq, version.savedAt);
          }
        });
        return h(
          'li',
          {},
          h(
            'span',
            { class: 'when' },
            `${when(version.savedAt)} `,
            h(
              'span',
              { class: 'muted' },
              `${version.pageCount} Page${version.pageCount === 1 ? '' : 's'}${index === 0 ? ' · latest' : ''}`,
            ),
          ),
          node,
        );
      }),
    );
    (byId('restore-version') as HTMLButtonElement).disabled = !lock.editing;
  };

  const previewVersion = async (
    seq: number,
    savedAt: number,
  ): Promise<void> => {
    if (!storage) {
      return;
    }
    editor.finishPendingEdit();
    await autosave.flush();
    if (autosave.dirty && !preview) {
      notice(
        "Couldn't save your latest work, so it stays on the desk. Export a copy first.",
      );
      return;
    }
    let loaded: LoadedProject;
    try {
      loaded = await storage.loadVersion(currentId, seq);
    } catch (error) {
      notice(
        error instanceof Error ? error.message : "Couldn't open that version.",
      );
      return;
    }
    preview = {
      seq,
      savedAt,
      latest: preview?.latest ?? structuredClone(editor.project),
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
    await drawVersions();
  };

  byId('back-to-latest').addEventListener('click', () => {
    if (preview) {
      exitPreview(preview.latest);
    }
  });
  byId('restore-version').addEventListener('click', () => {
    void (async () => {
      if (!storage || !preview || !lock.editing) {
        return;
      }
      if (!(await lock.stillEditing())) {
        lock.release();
        return;
      }
      const restored = await storage.restoreVersion(currentId, preview.seq);
      record = restored.record;
      channel?.post({
        type: 'saved',
        projectId: currentId,
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
        .loadProject(currentId)
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
      const created = await storage.saveProject(undefined, editor.project);
      channel?.post({ type: 'list-changed' });
      await showLoaded(
        { project: editor.project, migrated: false, record: created },
        created.id,
      );
    })().catch(error => notice(String(error)));
  });

  const onChannelMessage = (message: ProjectMessage): void => {
    if (message.type === 'list-changed') {
      void drawList();
      return;
    }
    if (message.projectId !== currentId) {
      return;
    }
    if (message.type === 'deleted') {
      orphaned = true;
      autosave.setEnabled(false);
      byId('orphan-banner').hidden = false;
      byId('readonly-banner').hidden = true;
      void drawList();
      return;
    }
    // Unsaved work in this tab is never replaced; it keeps its banner.
    if (
      message.type === 'saved' &&
      !lock.editing &&
      !preview &&
      !autosave.dirty &&
      storage
    ) {
      void storage
        .loadProject(currentId)
        .then(loaded => {
          record = loaded.record;
          editor.replaceProject(loaded.project);
          shell.redraw();
          return drawVersions();
        })
        .catch(() => {});
    }
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

  void storage?.setLastProjectId(currentId).catch(() => {});
  void drawList();
  void drawVersions();
  void drawStorageStatus();
  if (deps.initial.migrated && lock.editing && storage) {
    // Save the migrated model, keeping the old record as an earlier version.
    autosave.markDirty();
    void autosave.flush();
  }
};
