// Offline use and installation, page side (#823; design in
// docs/research/creative-tool-project-storage.md section 8). The service
// worker itself is `sw.ts`; this file registers it, offers its updates
// only once autosave has flushed, says when the app is offline, and
// explains installing — which in Safari is also what exempts the app's
// storage from the seven-day deletion of uninstalled sites. The
// registration and guidance logic takes its browser objects as
// arguments so tests can drive it with fakes (tests/offline.test.ts).
import { byId } from './dom';
import { SKIP_WAITING } from './sw';

/** The part of a service `Worker` the update flow uses. */
export type WorkerLike = {
  addEventListener: (type: string, listener: () => void) => void;
  postMessage: (message: unknown) => void;
  state: string;
};

/** The part of a `ServiceWorkerRegistration` the update flow uses. */
export type RegistrationLike = {
  active?: WorkerLike;
  addEventListener: (type: string, listener: () => void) => void;
  installing?: WorkerLike;
  update: () => Promise<void>;
  waiting?: WorkerLike;
};

/** The part of `navigator.serviceWorker` registration uses. */
export type ServiceWorkerContainerLike = {
  addEventListener: (type: string, listener: () => void) => void;
  controller?: WorkerLike;
  register: (scriptUrl: string) => Promise<RegistrationLike>;
};

/** A ready update: applying it activates the waiting worker and reloads. */
export type PendingUpdate = { applyUpdate: () => Promise<void> };

/**
 * Registers the service worker. When a newer worker is waiting beside
 * the one controlling the page, `onUpdateReady` hears about it; a first
 * install, with nothing controlling the page yet, is not an update.
 * Applying an update asks the waiting worker to take over and reloads
 * once it controls the page.
 */
export const registerOffline = async ({
  onRegistered,
  onUpdateReady,
  reload,
  scriptUrl = './sw.js',
  serviceWorker,
}: {
  onRegistered?: (registration: RegistrationLike) => void;
  onUpdateReady: (update: PendingUpdate) => void;
  reload: () => void;
  scriptUrl?: string;
  serviceWorker: ServiceWorkerContainerLike | undefined;
}): Promise<'registered' | 'unsupported' | 'failed'> => {
  if (!serviceWorker) {
    return 'unsupported';
  }
  let registration: RegistrationLike;
  try {
    registration = await serviceWorker.register(scriptUrl);
  } catch {
    return 'failed';
  }
  onRegistered?.(registration);
  let offered = false;
  let reloading = false;
  const offer = (waiting: WorkerLike | undefined): void => {
    if (offered || !waiting || !serviceWorker.controller) {
      return;
    }
    offered = true;
    onUpdateReady({
      applyUpdate: async () => {
        serviceWorker.addEventListener('controllerchange', () => {
          if (!reloading) {
            reloading = true;
            reload();
          }
        });
        (registration.waiting ?? waiting).postMessage({
          type: SKIP_WAITING,
        });
      },
    });
  };
  offer(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) {
      return;
    }
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') {
        offer(installing);
      }
    });
  });
  return 'registered';
};

/** What installing means in this browser, in words for the author. */
export type InstallGuidance = {
  kind: 'installed' | 'prompt' | 'apple' | 'browser-menu';
  message: string;
};

/** The install guidance for the browser at hand. Pure, for tests. */
export const installGuidance = ({
  canPrompt,
  installed,
  platform,
}: {
  canPrompt: boolean;
  installed: boolean;
  platform: 'apple-touch' | 'other';
}): InstallGuidance => {
  if (installed) {
    return {
      kind: 'installed',
      message:
        'Folio is installed on this device, so it opens offline and ' +
        'the browser keeps its Projects here.',
    };
  }
  if (canPrompt) {
    return {
      kind: 'prompt',
      message:
        'Install Folio on this device to use it offline and to keep ' +
        'its Projects safe from the browser clearing them.',
    };
  }
  if (platform === 'apple-touch') {
    return {
      kind: 'apple',
      message:
        'To install Folio here, use Share, then Add to Home Screen. ' +
        'Installed, it opens offline and its Projects are kept; ' +
        'uninstalled, Safari may delete them after a week away.',
    };
  }
  return {
    kind: 'browser-menu',
    message:
      'This browser may offer Install in its menu or address bar. ' +
      'Installed, Folio opens offline; either way it works here, ' +
      'and Export always makes a copy you keep.',
  };
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

const isAppleTouch = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isInstalled = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true;

/**
 * Wires the update and offline banners and the install guidance in the
 * Projects window. `flush` saves the current Project before an update
 * reloads the page.
 */
export const mountOffline = ({
  flush,
}: {
  flush: () => Promise<void>;
}): void => {
  const drawOnline = (): void => {
    byId('offline-banner').hidden = navigator.onLine;
  };
  drawOnline();
  window.addEventListener('online', drawOnline);
  window.addEventListener('offline', drawOnline);

  let installPrompt: InstallPromptEvent | undefined;
  const drawInstall = (): void => {
    const guidance = installGuidance({
      canPrompt: installPrompt !== undefined,
      installed: isInstalled(),
      platform: isAppleTouch() ? 'apple-touch' : 'other',
    });
    byId('install-status').textContent = guidance.message;
    byId('install-app').hidden = guidance.kind !== 'prompt';
  };
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    drawInstall();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = undefined;
    drawInstall();
  });
  byId('install-app').addEventListener('click', () => {
    void (async () => {
      if (!installPrompt) {
        return;
      }
      await installPrompt.prompt().catch(() => {});
      await installPrompt.userChoice.catch(() => undefined);
      installPrompt = undefined;
      drawInstall();
    })();
  });
  drawInstall();

  let applyUpdate: (() => Promise<void>) | undefined;
  byId('update-now').addEventListener('click', () => {
    void (async () => {
      (byId('update-now') as HTMLButtonElement).disabled = true;
      await flush().catch(() => {});
      await applyUpdate?.();
    })();
  });

  let registration: RegistrationLike | undefined;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void registration?.update().catch(() => {});
    }
  });
  const serviceWorker =
    'serviceWorker' in navigator
      ? (navigator.serviceWorker as unknown as ServiceWorkerContainerLike)
      : undefined;
  void registerOffline({
    onRegistered: found => {
      registration = found;
    },
    onUpdateReady: update => {
      applyUpdate = update.applyUpdate;
      byId('update-banner').hidden = false;
    },
    reload: () => window.location.reload(),
    serviceWorker,
  });
};
