// Save-in-place and the file pickers, against fake File System Access
// handles. The point is that work is never overwritten silently: a denied
// permission or a file changed on disk stops the save before any write.
import { expect, test } from 'bun:test';
import {
  FileAccessError,
  fileAccessSupport,
  pickSaveHandle,
  saveToHandle,
  type ProjectFileHandle,
} from '../src/file-access';

const abortError = () => {
  const error = new Error('The user aborted a request.');
  error.name = 'AbortError';
  return error;
};

type FakeFile = {
  bytes: Uint8Array;
  lastModified: number;
  name: string;
  permission: 'granted' | 'prompt' | 'denied';
  requested: boolean;
  written: Uint8Array | undefined;
};

const fakeHandle = (file: FakeFile): ProjectFileHandle => ({
  createWritable: async () => {
    let staged: Uint8Array | undefined;
    return {
      close: async () => {
        file.written = staged;
        file.bytes = staged!;
        file.lastModified += 1000;
      },
      write: async (data: Uint8Array) => {
        staged = data;
      },
    };
  },
  getFile: async () =>
    ({
      lastModified: file.lastModified,
      name: file.name,
      size: file.bytes.length,
      arrayBuffer: async () =>
        file.bytes.buffer.slice(
          file.bytes.byteOffset,
          file.bytes.byteOffset + file.bytes.byteLength,
        ) as ArrayBuffer,
    }) as File,
  kind: 'file',
  name: file.name,
  queryPermission: async () => file.permission,
  requestPermission: async () => {
    file.requested = true;
    return file.permission === 'prompt' ? 'granted' : file.permission;
  },
});

const newFile = (overrides: Partial<FakeFile> = {}): FakeFile => ({
  bytes: new Uint8Array([1, 2, 3]),
  lastModified: 5000,
  name: 'Story.folio',
  permission: 'granted',
  requested: false,
  written: undefined,
  ...overrides,
});

test('support is reported per picker, not guessed from the browser', () => {
  expect(fileAccessSupport({})).toEqual({ open: false, save: false });
  expect(
    fileAccessSupport({ showSaveFilePicker: () => Promise.resolve() }),
  ).toEqual({ open: false, save: true });
  expect(
    fileAccessSupport({
      showOpenFilePicker: () => Promise.resolve([]),
      showSaveFilePicker: () => Promise.resolve(),
    }),
  ).toEqual({ open: true, save: true });
});

test('save writes the exact bytes and reports the new stamp', async () => {
  const file = newFile();
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const stamp = await saveToHandle(fakeHandle(file), bytes, {
    lastModified: 5000,
    name: 'Story.folio',
    size: 3,
  });
  expect(file.written).toEqual(bytes);
  expect(stamp).toEqual({ lastModified: 6000, name: 'Story.folio', size: 4 });
});

test('a prompt permission is requested before writing', async () => {
  const file = newFile({ permission: 'prompt' });
  await saveToHandle(fakeHandle(file), new Uint8Array([1]));
  expect(file.requested).toBe(true);
  expect(file.written).toEqual(new Uint8Array([1]));
});

test('a denied permission writes nothing and keeps the browser name', async () => {
  const file = newFile({ permission: 'denied' });
  const attempt = saveToHandle(fakeHandle(file), new Uint8Array([1]));
  await expect(attempt).rejects.toBeInstanceOf(FileAccessError);
  await expect(attempt).rejects.toMatchObject({
    errorName: 'NotAllowedError',
  });
  expect(file.written).toBeUndefined();
});

test('a file changed on disk is never overwritten', async () => {
  const file = newFile({ lastModified: 9000 });
  const attempt = saveToHandle(fakeHandle(file), new Uint8Array([1]), {
    lastModified: 5000,
    name: 'Story.folio',
    size: 3,
  });
  await expect(attempt).rejects.toMatchObject({
    errorName: 'ChangedOnDiskError',
  });
  expect(file.written).toBeUndefined();
});

test('cancelling the save picker is not an error', async () => {
  const picked = await pickSaveHandle(
    {
      showSaveFilePicker: async () => {
        throw abortError();
      },
    },
    'Story.folio',
  );
  expect(picked).toBeUndefined();
});

test('the save picker suggests the Project name and .folio type', async () => {
  const file = newFile();
  let options: unknown;
  const handle = await pickSaveHandle(
    {
      showSaveFilePicker: async (given: unknown) => {
        options = given;
        return fakeHandle(file);
      },
    },
    'Story.folio',
  );
  expect(handle?.name).toBe('Story.folio');
  expect(JSON.stringify(options)).toContain('Story.folio');
  expect(JSON.stringify(options)).toContain('.folio');
  expect(JSON.stringify(options)).toContain(
    'application/vnd.odgn.northtalk-project+zip',
  );
});
