// The creative tool's page (#154): the Stack editor shell (#749) on the
// last Project used, autosaved in the browser with its Project list and
// earlier versions (#752), and the Code Browser.
import { coreVersions } from '@northtalk/ts';
import { browserChannel, browserLocks, EditLock } from './edit-lock';
import {
  mountProjects,
  openInitialProject,
  type InitialProject,
  type LockDelegate,
} from './projects';
import { mountMenus } from './menus';
import { mountOffline } from './offline';
import { mountStack } from './stack';
import { mountPlay } from './play-view';
import { openProjectStorage, type ProjectStorage } from './storage';
import { EXAMPLE_META } from './examples';
import { openUrlOf, withoutOpenParam } from './open-url';
import { sharedLinkOf, withoutFragment } from './shared-link';

const element = (id: string) => {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`The page has no #${id}`);
  }
  return found;
};

// An Example Project's page, `/folio/<slug>/`, names it in a meta tag
// (ADR 0141). The address goes back to Folio's own before anything loads
// by a relative URL, so the page's workers resolve as usual, and so a
// reload opens the copy just made rather than another one.
const exampleSlug = document.querySelector<HTMLMetaElement>(
  `meta[name="${EXAMPLE_META}"]`,
)?.content;
if (exampleSlug) {
  history.replaceState(null, '', new URL('../', location.href));
}
// `?open=<url>` names any `.folio` file to open (#1677); the address
// drops it so a reload doesn't open another copy.
const openUrl = openUrlOf(location.href);
if (openUrl) {
  history.replaceState(null, '', withoutOpenParam(location.href));
}
// A Shared Link, `#p1.<payload>`, carries a whole Project (#1678); the
// address drops it for the same reason.
const sharedLink = sharedLinkOf(location.href);
if (sharedLink) {
  history.replaceState(null, '', withoutFragment(location.href));
}

element('core').textContent = `Core ${coreVersions.core}`;
mountMenus(`NorthTalk Core ${coreVersions.core}`);

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
    exampleSlug,
    openUrl,
    sharedLink,
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
