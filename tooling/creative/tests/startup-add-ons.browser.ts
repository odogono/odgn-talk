// Dedicated page without main.js: the Project the page opens with loads the
// Add-ons it lists, so a reload keeps Music's synth (#2040).
import {
  INSTRUMENTS_REF,
  synthInstrument,
} from '../src/add-ons/instruments/ids';
import { EditLock } from '../src/edit-lock';
import { INSTRUMENT_KINDS } from '../src/instruments/registry';
import { createProject } from '../src/model';
import { mountProjects } from '../src/projects';
import { mountStack } from '../src/stack';
import { openProjectStorage } from '../src/storage';

const until = async (check: () => boolean, message: string) => {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(message);
};

export const runBrowserTests = async () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const storage = await openProjectStorage(indexedDB);
  const project = createProject(`Startup Add-ons check ${Date.now()}`);
  project.addOns = [INSTRUMENTS_REF];
  const bass = synthInstrument('bass');
  project.instruments.push(bass);
  const record = await storage.saveProject(undefined, project);
  const lock = new EditLock(undefined, undefined, {
    flush: async () => {},
    onEditing: () => {},
  });
  try {
    await lock.acquire(record.id);
    const shell = mountStack(project);
    mountProjects({
      shell,
      storage,
      initial: { id: record.id, migrated: false, project, record },
      lock,
      lockDelegate: { flush: async () => {}, onEditing: () => {} },
      channel: undefined,
    });
    await until(
      () => INSTRUMENT_KINDS.has(bass.kind),
      'The synth kind did not load',
    );
    await until(
      () =>
        !document
          .getElementById('info')!
          .textContent!.includes('Add-on not loaded'),
      'Info still says the Add-on is not loaded',
    );
    if (shell.editor.canUndo) {
      throw new Error('Loading the Add-ons left an undo step');
    }
    results.push({
      name: 'the opening Project loads its Add-ons',
      passed: true,
    });
  } catch (error) {
    results.push({
      name: 'the opening Project loads its Add-ons',
      passed: false,
      error: String(error),
    });
  } finally {
    lock.release();
    await storage.deleteProject(record.id);
  }
  return results;
};
