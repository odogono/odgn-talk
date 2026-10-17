import { expect, test } from 'bun:test';
import { createPage, createProject } from '../src/model';
import { sha256Hex } from '../src/project-file';
import { openInitialProject } from '../src/projects';
import {
  openProjectStorage,
  versionsToKeep,
  type ProjectStorage,
} from '../src/storage';
import { createFakeIdb } from './fake-indexeddb';

const quotaError = (): DOMException =>
  new DOMException('The quota has been exceeded.', 'QuotaExceededError');

const openStorage = async (
  fake = createFakeIdb(),
): Promise<{ fake: typeof fake; storage: ProjectStorage }> => ({
  fake,
  storage: await openProjectStorage(fake.factory),
});

/** A Project with one asset row and its bytes, ready to save. */
const withAsset = async (name: string) => {
  const bytes = new TextEncoder().encode(`bytes of ${name}`);
  const hash = await sha256Hex(bytes);
  const project = createProject(name);
  project.assets.push({
    name: 'picture',
    hash,
    mediaType: 'image/png',
    size: bytes.length,
    fileName: 'picture.png',
  });
  return {
    project,
    hash,
    assets: new Map([
      [hash, { blob: new Blob([bytes]), mediaType: 'image/png' }],
    ]),
  };
};

test('a saved Project loads back, and the list is newest first', async () => {
  const { storage } = await openStorage();
  const first = await storage.saveProject(undefined, createProject('First'), {
    now: 100,
  });
  const secondProject = createProject('Second');
  secondProject.pages.push(createPage('page2'));
  const second = await storage.saveProject(undefined, secondProject, {
    now: 200,
  });
  const loaded = await storage.loadProject(second.id);
  expect(loaded.project).toEqual(secondProject);
  expect(loaded.record.title).toBe('Second');
  expect((await storage.listProjects()).map(r => r.id)).toEqual([
    second.id,
    first.id,
  ]);
  await storage.setLastProjectId(first.id);
  expect(await storage.lastProjectId()).toBe(first.id);
});

test('one transaction writes the model and its new assets together', async () => {
  const { fake, storage } = await openStorage();
  const { project, hash, assets } = await withAsset('Pictured');
  const before = fake.stats.readwriteTransactions;
  await storage.saveProject(undefined, project, { assets });
  expect(fake.stats.readwriteTransactions - before).toBe(1);
  expect([...(await storage.assetBytes([hash])).keys()]).toEqual([hash]);
});

test('a failure mid-save leaves the previous version intact', async () => {
  let overQuota = false;
  const fake = createFakeIdb({
    failPuts: store =>
      overQuota && store === 'versions' ? quotaError() : undefined,
  });
  const { storage } = await openStorage(fake);
  const { project, hash, assets } = await withAsset('Kept');
  const record = await storage.saveProject(undefined, project, {
    assets,
    now: 100,
  });

  overQuota = true;
  project.name = 'Lost';
  const newHash = 'f'.repeat(64);
  await expect(
    storage.saveProject(record.id, project, {
      assets: new Map([
        [newHash, { blob: new Blob(['new']), mediaType: 'image/png' }],
      ]),
      now: 200,
    }),
  ).rejects.toMatchObject({ errorName: 'QuotaExceededError' });

  // The Project in memory is untouched, and storage still holds version 1:
  // no half-written model, record or asset from the aborted transaction.
  expect(project.name).toBe('Lost');
  const loaded = await storage.loadProject(record.id);
  expect(loaded.project.name).toBe('Kept');
  expect(loaded.record.seq).toBe(1);
  expect(await storage.listVersions(record.id)).toHaveLength(1);
  expect(await storage.assetBytes([newHash])).toEqual(new Map());
  expect([...(await storage.assetBytes([hash])).keys()]).toEqual([hash]);
});

test('storage that will not open fails with the browser error name', async () => {
  const denied = new DOMException('Denied.', 'InvalidStateError');
  await expect(
    openProjectStorage(createFakeIdb({ failOpen: denied }).factory),
  ).rejects.toMatchObject({ errorName: 'InvalidStateError' });
});

test('versions to keep: the newest twenty, plus one an hour for a day', () => {
  const hour = 3_600_000;
  const now = 100 * hour;
  const versions = Array.from({ length: 30 }, (_, i) => ({
    seq: i + 1,
    savedAt: now - (29 - i) * 60_000,
  }));
  expect(versionsToKeep(versions, now).size).toBe(20);
  expect(versionsToKeep(versions, now).has(30)).toBe(true);
  const hourly = Array.from({ length: 48 }, (_, i) => ({
    seq: i + 1,
    savedAt: now - (47 - i) * hour,
  }));
  const kept = versionsToKeep(hourly, now);
  // 20 newest plus the hourly ones from the rest of the last day.
  expect(kept.size).toBe(24);
  expect(kept.has(24)).toBe(false);
  expect(kept.has(25)).toBe(true);
});

test('saves trim old versions, keeping the newest', async () => {
  const { storage } = await openStorage();
  const project = createProject('Many');
  let record = await storage.saveProject(undefined, project, { now: 1000 });
  for (let n = 2; n <= 22; n++) {
    project.name = `Many ${n}`;
    record = await storage.saveProject(record.id, project, { now: 1000 + n });
  }
  const versions = await storage.listVersions(record.id);
  expect(versions).toHaveLength(20);
  expect(versions[0]!.seq).toBe(22);
  expect((await storage.loadProject(record.id)).project.name).toBe('Many 22');
});

test('an asset only trimmed versions used is dropped with them', async () => {
  const { storage } = await openStorage();
  const { project, hash, assets } = await withAsset('Pictured');
  let record = await storage.saveProject(undefined, project, {
    assets,
    now: 1,
  });
  project.assets = [];
  for (let n = 2; n <= 21; n++) {
    record = await storage.saveProject(record.id, project, { now: n });
    // Kept while any kept version still refers to it.
    expect((await storage.assetBytes([hash])).size).toBe(n <= 20 ? 1 : 0);
  }
  expect(await storage.listVersions(record.id)).toHaveLength(20);

  await storage.deleteProject(record.id);
  expect(await storage.listVersions(record.id)).toEqual([]);
});

test('restoring an earlier version writes a new newest, so it can be undone', async () => {
  const { storage } = await openStorage();
  const project = createProject('One');
  const first = await storage.saveProject(undefined, project, { now: 100 });
  project.name = 'Two';
  await storage.saveProject(first.id, project, { now: 200 });

  const restored = await storage.restoreVersion(first.id, 1, 300);
  expect(restored.project.name).toBe('One');
  expect(restored.record.seq).toBe(3);
  expect((await storage.loadProject(first.id)).project.name).toBe('One');

  // Restoring the version that was newest before the restore undoes it.
  const back = await storage.restoreVersion(first.id, 2, 400);
  expect(back.project.name).toBe('Two');
  expect((await storage.loadProject(first.id)).project.name).toBe('Two');
});

test('duplicate is independent and shares assets; delete frees only unused ones', async () => {
  const { storage } = await openStorage();
  const { project, hash, assets } = await withAsset('Original');
  const original = await storage.saveProject(undefined, project, { assets });
  const copy = await storage.duplicateProject(original.id);
  expect(copy.record.id).not.toBe(original.id);
  expect(copy.project.name).toBe('Original copy');

  copy.project.name = 'Edited copy';
  await storage.saveProject(copy.record.id, copy.project);
  expect((await storage.loadProject(original.id)).project.name).toBe(
    'Original',
  );

  await storage.deleteProject(original.id);
  expect(await storage.projectRecord(original.id)).toBeUndefined();
  // The copy still refers to the asset, so it stays.
  expect([...(await storage.assetBytes([hash])).keys()]).toEqual([hash]);
  await storage.deleteProject(copy.record.id);
  expect(await storage.assetBytes([hash])).toEqual(new Map());
});

test('renaming a stored Project saves its model under the new title', async () => {
  const { storage } = await openStorage();
  const record = await storage.saveProject(undefined, createProject('Old'));
  const renamed = await storage.renameProject(record.id, 'New');
  expect(renamed.title).toBe('New');
  expect((await storage.loadProject(record.id)).project.name).toBe('New');
  expect((await storage.loadVersion(record.id, 1)).project.name).toBe('Old');
});

test('freeing space keeps only the newest version of each Project', async () => {
  const { storage } = await openStorage();
  const project = createProject('Slim');
  const record = await storage.saveProject(undefined, project, { now: 1 });
  await storage.saveProject(record.id, project, { now: 2 });
  await storage.saveProject(record.id, project, { now: 3 });
  await storage.freeSpace();
  expect(await storage.listVersions(record.id)).toHaveLength(1);
  expect((await storage.loadProject(record.id)).project.name).toBe('Slim');
});

test('the first Project ever is a stored Untitled; the last used reopens', async () => {
  const { storage } = await openStorage();
  const initial = await openInitialProject(storage);
  expect(initial.project.name).toBe('Untitled');
  expect(await storage.listProjects()).toHaveLength(1);

  const other = await storage.saveProject(undefined, createProject('Other'), {
    now: Date.now() + 10_000,
  });
  await storage.setLastProjectId(initial.id);
  const reopened = await openInitialProject(storage);
  expect(reopened.id).toBe(initial.id);
  expect(reopened.id).not.toBe(other.id);
});

test('a Project from a newer app is refused and never overwritten', async () => {
  const fake = createFakeIdb();
  const { storage } = await openStorage(fake);
  // Seed a format-99 Project directly, as a newer app version would leave it.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const pending = fake.factory.open('seed', 1);
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['projects', 'versions'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    const model = { ...createProject('Future'), format: 99, app: 'future' };
    tx.objectStore('projects').put({
      id: 'future',
      title: 'Future',
      format: 99,
      modifiedAt: 1,
      seq: 1,
    });
    tx.objectStore('versions').put({
      projectId: 'future',
      seq: 1,
      savedAt: 1,
      model,
    });
  });

  await expect(storage.loadProject('future')).rejects.toThrow(/newer/u);
  await storage.setLastProjectId('future');
  const initial = await openInitialProject(storage);
  expect(initial.id).not.toBe('future');
  expect(initial.notice).toMatch(/newer/u);
  // Still exactly as the newer app left it.
  expect((await storage.projectRecord('future'))?.seq).toBe(1);
  await expect(storage.loadProject('future')).rejects.toThrow(/newer/u);
});

test('a listed Project whose version has gone says so', async () => {
  const fake = createFakeIdb();
  const { storage } = await openStorage(fake);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const pending = fake.factory.open('seed', 1);
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['projects'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.objectStore('projects').put({
      id: 'ghost',
      title: 'Ghost',
      format: 1,
      modifiedAt: 1,
      seq: 3,
    });
  });
  await expect(storage.loadProject('ghost')).rejects.toMatchObject({
    errorName: 'MissingVersionError',
  });
});

test('a Project file handle is kept, replaced and deleted with its Project', async () => {
  const { storage } = await openStorage();
  const record = await storage.saveProject(undefined, createProject('Kept'));
  expect(await storage.fileHandle(record.id)).toBeUndefined();
  const handle = { kind: 'file', name: 'Kept.folio' };
  await storage.setFileHandle(record.id, {
    handle,
    lastModified: 42,
    name: 'Kept.folio',
    size: 10,
  });
  expect(await storage.fileHandle(record.id)).toEqual({
    handle,
    lastModified: 42,
    name: 'Kept.folio',
    size: 10,
  });
  await storage.setFileHandle(record.id, {
    handle,
    lastModified: 43,
    name: 'Kept.folio',
    size: 11,
  });
  expect((await storage.fileHandle(record.id))?.lastModified).toBe(43);
  await storage.deleteProject(record.id);
  expect(await storage.fileHandle(record.id)).toBeUndefined();
});

test('stored version JSON omits session ids byte for byte', async () => {
  const { StackEditor } = await import('../src/editing');
  const { createElement } = await import('../src/model');
  const { serializeProject } = await import('../src/project-file');
  const project = createProject('Stored');
  project.pages[0]!.elements.push(createElement('button', 'button1'));
  const editor = new StackEditor(project);
  const models: string[] = [];
  const fake = createFakeIdb({
    failPuts: (store, value) => {
      if (store === 'versions') {
        models.push(JSON.stringify((value as { model: unknown }).model));
      }
      return undefined;
    },
  });
  const { storage } = await openStorage(fake);
  await storage.saveProject(undefined, editor.project);
  expect(models).toEqual([JSON.stringify(serializeProject(project))]);
  storage.close();
});
