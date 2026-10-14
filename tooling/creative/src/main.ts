// The creative tool's page (#154): the Stack editor shell (#749) on the
// last Project used, autosaved in the browser with its Project list and
// earlier versions (#752), and authored Script windows (#784).
import { coreVersions } from '@odgn/northtalk';
import { browserChannel, browserLocks, EditLock } from './edit-lock';
import {
  mountProjects,
  openInitialProject,
  type InitialProject,
  type LockDelegate,
} from './projects';
import { mountOffline } from './offline';
import { mountStack } from './stack';
import { mountPlay } from './play-view';
import { openProjectStorage, type ProjectStorage } from './storage';

const element = (id: string) => {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`The page has no #${id}`);
  }
  return found;
};

element('core').textContent = `Core ${coreVersions.core}`;

// Opens storage and the last Project used, asks for its edit lock (another
// tab may hold it), then mounts the shell and the Project windows. When
// the browser won't keep data, editing still works in memory.
const boot = async (): Promise<void> => {
  let storage: ProjectStorage | undefined;
  let storageError: unknown;
  let initial: InitialProject;
  try {
    storage = await openProjectStorage(indexedDB);
    initial = await openInitialProject(storage);
  } catch (error) {
    storageError = error;
    storage = undefined;
    initial = await openInitialProject(undefined);
  }
  const channel = browserChannel();
  // Filled in by mountProjects once autosave exists; the lock needs its
  // hooks before the first takeover can arrive.
  const lockDelegate: LockDelegate = {
    flush: () => Promise.resolve(),
    onEditing: () => {},
  };
  const lock = new EditLock(browserLocks(), channel, {
    flush: () => lockDelegate.flush(),
    onEditing: editing => lockDelegate.onEditing(editing),
  });
  const editing = await lock.acquire(initial.id);
  const shell = mountStack(initial.project, { readOnly: !editing });
  mountPlay(shell);
  mountProjects({
    channel,
    initial,
    lock,
    lockDelegate,
    shell,
    storage,
    storageError,
  });
  // Offline use and updates (#823): an update reload flushes autosave
  // first, through the same delegate the edit lock uses.
  mountOffline({ flush: () => lockDelegate.flush() });
};
void boot();
