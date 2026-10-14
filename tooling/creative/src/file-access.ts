// Saving back to a Project file on disk, where the browser offers the
// File System Access API (#823; design in
// docs/research/creative-tool-project-storage.md section 7). Chromium
// desktop has the pickers and `launchQueue`; Firefox and Safari do not,
// and keep downloading through Export instead. Nothing here overwrites
// silently: permission is asked for at save time (it is not always kept
// between sessions), and a file changed on disk since it was opened is
// refused with a suggestion to Save As.
import { PROJECT_MIMETYPE } from './project-file';

/** What was on disk when a file was opened or last saved to. */
export type FileStamp = {
  lastModified?: number;
  name: string;
  size?: number;
};

/** The part of a `FileSystemWritableFileStream` saving uses. */
export type WritableLike = {
  close: () => Promise<void>;
  write: (data: Uint8Array) => Promise<void>;
};

type PermissionState = 'granted' | 'prompt' | 'denied';

/** The part of a `FileSystemFileHandle` Folio uses. Handles are stored
 * in IndexedDB (storage.ts), which keeps them opaque. */
export type ProjectFileHandle = {
  createWritable: () => Promise<WritableLike>;
  getFile: () => Promise<File>;
  kind: 'file';
  name: string;
  queryPermission?: (options: {
    mode: 'read' | 'readwrite';
  }) => Promise<PermissionState>;
  requestPermission?: (options: {
    mode: 'read' | 'readwrite';
  }) => Promise<PermissionState>;
};

/** A file-access failure. `errorName` keeps the browser's name. */
export class FileAccessError extends Error {
  readonly errorName: string;

  constructor(message: string, errorName = 'FileAccessError') {
    super(message);
    this.errorName = errorName;
  }
}

const asFileAccessError = (error: unknown): FileAccessError =>
  error instanceof FileAccessError
    ? error
    : new FileAccessError(
        error instanceof Error ? error.message : 'The file could not be used.',
        error instanceof Error ? error.name : 'Error',
      );

/** Whether a failure is just the author closing a picker. */
export const isPickerAbort = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

/** The picker types for a Project file: `.folio`, plus `.zip` files
 * exported before the application was named (ADR 0087). */
const PROJECT_FILE_TYPES = [
  {
    accept: { [PROJECT_MIMETYPE]: ['.folio'] },
    description: 'Folio Project',
  },
  { accept: { 'application/zip': ['.zip'] }, description: 'Project (zip)' },
];

type PickerWindow = {
  showOpenFilePicker?: (options: unknown) => Promise<ProjectFileHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<ProjectFileHandle>;
};

const pickersOf = (source: unknown): PickerWindow => source as PickerWindow;

/** Which disk pickers this browser offers. Save-in-place needs `save`;
 * opening through a picker that also hands back a handle needs `open`. */
export const fileAccessSupport = (
  source: unknown,
): { open: boolean; save: boolean } => {
  const pickers = pickersOf(source);
  return {
    open: typeof pickers.showOpenFilePicker === 'function',
    save: typeof pickers.showSaveFilePicker === 'function',
  };
};

/**
 * Asks for Project files to open, with their handles so a later Save can
 * write back to them. Returns `undefined` when the author cancels.
 */
export const pickOpenHandles = async (
  source: unknown,
): Promise<ProjectFileHandle[] | undefined> => {
  const showOpenFilePicker = pickersOf(source).showOpenFilePicker;
  if (!showOpenFilePicker) {
    throw new FileAccessError(
      "This browser can't open a file to save back to.",
      'UnsupportedError',
    );
  }
  try {
    return await showOpenFilePicker({
      multiple: true,
      types: PROJECT_FILE_TYPES,
    });
  } catch (error) {
    if (isPickerAbort(error)) {
      return undefined;
    }
    throw asFileAccessError(error);
  }
};

/**
 * Asks where to save a Project file. Returns `undefined` when the author
 * cancels.
 */
export const pickSaveHandle = async (
  source: unknown,
  suggestedName: string,
): Promise<ProjectFileHandle | undefined> => {
  const showSaveFilePicker = pickersOf(source).showSaveFilePicker;
  if (!showSaveFilePicker) {
    throw new FileAccessError(
      "This browser can't save back to a file.",
      'UnsupportedError',
    );
  }
  try {
    return await showSaveFilePicker({
      suggestedName,
      types: PROJECT_FILE_TYPES,
    });
  } catch (error) {
    if (isPickerAbort(error)) {
      return undefined;
    }
    throw asFileAccessError(error);
  }
};

/** The stamp of the file a handle currently points at. */
export const stampOf = async (
  handle: ProjectFileHandle,
): Promise<FileStamp> => {
  const file = await handle.getFile().catch(error => {
    throw asFileAccessError(error);
  });
  return { lastModified: file.lastModified, name: file.name, size: file.size };
};

/** The stamp of an opened `File`, to store beside its handle. */
export const stampOfFile = (file: File): FileStamp => ({
  lastModified: file.lastModified,
  name: file.name,
  size: file.size,
});

/**
 * Ensures writing to `handle` is allowed, asking when the browser kept
 * only a prompt. Must run from a user gesture (the Save click is one).
 */
export const ensureWritePermission = async (
  handle: ProjectFileHandle,
): Promise<void> => {
  if (!handle.queryPermission) {
    return;
  }
  let state = await handle
    .queryPermission({ mode: 'readwrite' })
    .catch(error => {
      throw asFileAccessError(error);
    });
  if (state === 'prompt' && handle.requestPermission) {
    state = await handle
      .requestPermission({ mode: 'readwrite' })
      .catch(error => {
        throw asFileAccessError(error);
      });
  }
  if (state !== 'granted') {
    throw new FileAccessError(
      `The browser won't let Folio write to “${handle.name}”. ` +
        'Export a copy instead, or use Save As to choose the file again.',
      'NotAllowedError',
    );
  }
};

/**
 * Writes `bytes` to `handle`, replacing the file on close. When
 * `expected` says what was there at open or last save, a file that has
 * changed since is refused before anything is written.
 */
export const saveToHandle = async (
  handle: ProjectFileHandle,
  bytes: Uint8Array,
  expected?: FileStamp,
): Promise<FileStamp> => {
  await ensureWritePermission(handle);
  if (expected?.lastModified !== undefined || expected?.size !== undefined) {
    const current = await stampOf(handle);
    if (
      (expected.lastModified !== undefined &&
        current.lastModified !== expected.lastModified) ||
      (expected.size !== undefined && current.size !== expected.size)
    ) {
      throw new FileAccessError(
        `“${handle.name}” changed on disk since it was opened, ` +
          'so it was not overwritten. Use Save As to write a new copy.',
        'ChangedOnDiskError',
      );
    }
  }
  try {
    const writable = await handle.createWritable();
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
    await writable.close();
  } catch (error) {
    throw asFileAccessError(error);
  }
  return stampOf(handle).catch(() => ({
    name: handle.name,
    size: bytes.length,
  }));
};

/** Files the operating system launched the installed app with. */
export type LaunchParamsLike = { files?: readonly unknown[] };

/**
 * Registers for Project files opened from the operating system (the
 * manifest's `file_handlers`, received through `launchQueue`). Returns
 * whether this browser supports it; launches before the consumer is set
 * are queued by the browser, so registering at page setup is early
 * enough.
 */
export const onLaunchFiles = (
  source: unknown,
  consumer: (handles: ProjectFileHandle[]) => void,
): boolean => {
  const queue = (
    source as {
      launchQueue?: {
        setConsumer: (callback: (params: LaunchParamsLike) => void) => void;
      };
    }
  ).launchQueue;
  if (!queue || typeof queue.setConsumer !== 'function') {
    return false;
  }
  queue.setConsumer(params => {
    const handles = (params.files ?? []).filter(
      (file): file is ProjectFileHandle =>
        typeof file === 'object' &&
        file !== null &&
        (file as { kind?: unknown }).kind === 'file',
    );
    if (handles.length) {
      consumer(handles);
    }
  });
  return true;
};

/** The file handle behind a dropped item, where the browser offers one. */
export const dropHandle = async (
  item: unknown,
): Promise<ProjectFileHandle | undefined> => {
  const get = (item as { getAsFileSystemHandle?: () => Promise<unknown> })
    .getAsFileSystemHandle;
  if (typeof get !== 'function') {
    return undefined;
  }
  const handle = await get.call(item).catch(() => undefined);
  return handle &&
    typeof handle === 'object' &&
    (handle as { kind?: unknown }).kind === 'file'
    ? (handle as ProjectFileHandle)
    : undefined;
};
