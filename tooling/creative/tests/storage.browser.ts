// Run in a real browser (commands in README.md); real IndexedDB, Web Locks
// and BroadcastChannel, no emulators. The unit tests cover the same logic
// against a fake; these prove the platform pieces behave as designed.
import { Autosave, failureMessage } from '../src/autosave';
import { browserChannel, browserLocks, EditLock } from '../src/edit-lock';
import { createProject } from '../src/model';
import { openProjectStorage } from '../src/storage';

const equal = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};

export const runBrowserTests = async () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };

  const storage = await openProjectStorage(indexedDB);
  const stamp = Date.now();
  const created: string[] = [];

  await test('edits survive reopening the storage', async () => {
    const project = createProject(`Browser check ${stamp}`);
    project.pages[0]!.background = '#fedcba';
    const record = await storage.saveProject(undefined, project);
    created.push(record.id);
    const reopened = await openProjectStorage(indexedDB);
    const loaded = await reopened.loadProject(record.id);
    equal(loaded.project, project);
    reopened.close();
  });

  await test('an aborted transaction leaves the previous version intact', async () => {
    const project = createProject(`Browser abort ${stamp}`);
    const record = await storage.saveProject(undefined, project);
    created.push(record.id);
    // A crash mid-save: write a new model and record, then abort.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const pending = indexedDB.open('northtalk-creative', 1);
      pending.onsuccess = () => resolve(pending.result);
      pending.onerror = () => reject(pending.error);
    });
    await new Promise<void>(resolve => {
      const tx = db.transaction(['projects', 'versions'], 'readwrite');
      tx.onabort = () => resolve();
      tx.objectStore('versions').put({
        projectId: record.id,
        seq: 99,
        savedAt: Date.now(),
        model: { format: 1 },
      });
      tx.objectStore('projects').put({ ...record, seq: 99, title: 'Partial' });
      tx.abort();
    });
    db.close();
    const loaded = await storage.loadProject(record.id);
    equal(loaded.project.name, `Browser abort ${stamp}`);
    equal(loaded.record.seq, 1);
  });

  await test('restoring an earlier version can itself be undone', async () => {
    const project = createProject(`Browser versions ${stamp}`);
    const record = await storage.saveProject(undefined, project);
    created.push(record.id);
    project.name = `Browser versions later ${stamp}`;
    await storage.saveProject(record.id, project);
    const restored = await storage.restoreVersion(record.id, 1);
    equal(restored.project.name, `Browser versions ${stamp}`);
    const back = await storage.restoreVersion(record.id, 2);
    equal(back.project.name, `Browser versions later ${stamp}`);
  });

  await test('one editor per Project across two lock clients', async () => {
    const locks = browserLocks();
    if (!locks) {
      throw new Error('Web Locks unavailable');
    }
    const flushed: string[] = [];
    const a = new EditLock(locks, browserChannel(), {
      flush: async () => {
        flushed.push('flushed');
      },
    });
    const b = new EditLock(locks, browserChannel(), {
      flush: () => Promise.resolve(),
    });
    const id = `browser-lock-${stamp}`;
    equal(await a.acquire(id), true);
    equal(await b.acquire(id), false);
    equal(await b.takeOver(), true);
    equal(flushed, ['flushed']);
    equal(a.editing, false);
    equal(b.editing, true);
    b.dispose();
    a.dispose();
  });

  await test('a simulated quota error keeps the work and names the failure', async () => {
    let reported = '';
    const autosave = new Autosave(
      async () => {
        throw new DOMException('Full.', 'QuotaExceededError');
      },
      { onError: error => (reported = failureMessage(error)) },
    );
    autosave.markDirty();
    await autosave.flush();
    equal(autosave.state, 'failed');
    equal(autosave.dirty, true);
    equal(
      reported,
      "Couldn't save: the browser's storage for this site is full.",
    );
    autosave.dispose();
  });

  for (const id of created) {
    await storage.deleteProject(id);
  }
  storage.close();
  return results;
};
