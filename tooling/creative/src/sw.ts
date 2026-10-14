// Folio's service worker (#823; design in
// docs/research/creative-tool-project-storage.md section 8): it precaches
// the app shell the build lists, so authoring and Play work with the
// network off and no backend. Projects stay in IndexedDB and are never
// cached as responses. A new worker waits instead of taking over: the
// page flushes autosave, sends SKIP_WAITING, then reloads (offline.ts).
//
// The build replaces the two declarations below with the precache list
// and a version hashed from the shell's contents (tools/build.ts). The
// listener logic takes its scope as an argument so tests can drive it
// with a fake Cache Storage and network (tests/service-worker.test.ts).
declare const __FOLIO_PRECACHE__: string[];
declare const __FOLIO_VERSION__: string;

/** The message the page sends a waiting worker when the author reloads. */
export const SKIP_WAITING = 'SKIP_WAITING';

const CACHE_PREFIX = 'folio-';

/** The Cache Storage name holding one build of the app shell. */
export const cacheNameFor = (version: string): string =>
  `${CACHE_PREFIX}${version}`;

/** The part of a Cache this worker uses. */
export type CacheLike = {
  addAll: (urls: string[]) => Promise<void>;
  match: (url: string) => Promise<Response | undefined>;
  put: (url: string, response: Response) => Promise<void>;
};

/** The part of Cache Storage this worker uses. */
export type CacheStorageLike = {
  delete: (name: string) => Promise<boolean>;
  keys: () => Promise<string[]>;
  match: (url: string) => Promise<Response | undefined>;
  open: (name: string) => Promise<CacheLike>;
};

/** The part of the service-worker global this worker uses. */
export type ServiceWorkerScopeLike = {
  addEventListener: (type: string, listener: (event: never) => void) => void;
  caches: CacheStorageLike;
  clients: { claim: () => Promise<void> };
  fetch: (input: string) => Promise<Response>;
  skipWaiting: () => Promise<void> | void;
};

type ExtendableEventLike = { waitUntil: (pending: Promise<unknown>) => void };
type FetchEventLike = {
  request: { method: string; mode: string; url: string };
  respondWith: (pending: Promise<Response>) => void;
};
type MessageEventLike = { data?: { type?: unknown } };

/** Said when the network is off and no shell was ever kept. */
const offlinePage = (): Response =>
  new Response(
    'Folio is offline, and this page has not been kept yet. ' +
      'Open Folio once while online, then it works offline.',
    { headers: { 'content-type': 'text/plain; charset=utf-8' }, status: 503 },
  );

/** What one build of the worker precaches, and under which version. */
export type ServiceWorkerConfig = {
  /** The registration scope as an absolute URL; shell paths resolve on it. */
  base: string;
  precache: readonly string[];
  version: string;
};

/** Registers the install, activate, fetch and message listeners. */
export const installServiceWorker = (
  scope: ServiceWorkerScopeLike,
  { base, precache, version }: ServiceWorkerConfig,
): void => {
  const cacheName = cacheNameFor(version);
  const shell = precache.map(entry => new URL(entry, base).href);
  const shellUrls = new Set(shell);
  const index = new URL('./index.html', base).href;
  const origin = new URL(base).origin;

  scope.addEventListener('install', (event: ExtendableEventLike) => {
    event.waitUntil(
      scope.caches.open(cacheName).then(cache => cache.addAll(shell)),
    );
  });

  scope.addEventListener('activate', (event: ExtendableEventLike) => {
    event.waitUntil(
      (async () => {
        for (const name of await scope.caches.keys()) {
          if (name.startsWith(CACHE_PREFIX) && name !== cacheName) {
            await scope.caches.delete(name);
          }
        }
        await scope.clients.claim();
      })(),
    );
  });

  scope.addEventListener('message', (event: MessageEventLike) => {
    if (event.data?.type === SKIP_WAITING) {
      void scope.skipWaiting();
    }
  });

  const respond = async (
    request: FetchEventLike['request'],
  ): Promise<Response> => {
    const cached = await scope.caches.match(
      request.mode === 'navigate' ? index : request.url,
    );
    // The versioned cache holds exactly this build's shell, so a shell
    // URL is served from it without touching the network.
    if (cached && (request.mode === 'navigate' || shellUrls.has(request.url))) {
      return cached;
    }
    try {
      return await scope.fetch(request.url);
    } catch {
      return cached ?? offlinePage();
    }
  };

  scope.addEventListener('fetch', (event: FetchEventLike) => {
    const { request } = event;
    if (request.method !== 'GET' || new URL(request.url).origin !== origin) {
      return;
    }
    event.respondWith(respond(request));
  });
};

// In the built worker `self` is the service-worker global, the only
// global with `skipWaiting`, `clients` and a registration; under test
// the module is imported for its functions and this guard keeps it inert.
const candidate = globalThis as unknown as Partial<ServiceWorkerScopeLike> & {
  registration?: { scope: string };
};
if (
  typeof candidate.skipWaiting === 'function' &&
  candidate.clients !== undefined &&
  candidate.registration !== undefined
) {
  installServiceWorker(candidate as ServiceWorkerScopeLike, {
    base: candidate.registration.scope,
    precache: __FOLIO_PRECACHE__,
    version: __FOLIO_VERSION__,
  });
}
