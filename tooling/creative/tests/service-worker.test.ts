// The service worker's install, activate and fetch behaviour, against a
// fake Cache Storage and network. The real registration and a live cache
// are covered by tests/offline.browser.ts.
import { expect, test } from 'bun:test';
import {
  cacheNameFor,
  installServiceWorker,
  SKIP_WAITING,
  type ServiceWorkerScopeLike,
} from '../src/sw';

const BASE = 'https://folio.example/app/';
const PRECACHE = ['./', './main.js', './style.css'];

type Listener = (event: never) => void;

const makeWorld = () => {
  const cachesByName = new Map<string, Map<string, Response>>();
  const listeners = new Map<string, Listener>();
  const world = {
    cachesByName,
    claimed: false,
    listeners,
    network: new Map<string, string>(),
    offline: false,
    skipped: false,
  };
  const cacheFor = (name: string) => {
    if (!cachesByName.has(name)) {
      cachesByName.set(name, new Map());
    }
    const entries = cachesByName.get(name)!;
    return {
      addAll: async (urls: string[]) => {
        for (const url of urls) {
          const found = await worldFetch(url);
          entries.set(url, found.clone());
        }
      },
      match: async (url: string) => entries.get(url)?.clone(),
      put: async (url: string, response: Response) => {
        entries.set(url, response.clone());
      },
    };
  };
  const worldFetch = async (input: string): Promise<Response> => {
    if (world.offline) {
      throw new TypeError('NetworkError');
    }
    const body = world.network.get(input);
    return new Response(body ?? 'not found', {
      status: body === undefined ? 404 : 200,
    });
  };
  const scope: ServiceWorkerScopeLike = {
    addEventListener: (type, listener) => {
      listeners.set(type, listener as Listener);
    },
    caches: {
      delete: async (name: string) => cachesByName.delete(name),
      keys: async () => [...cachesByName.keys()],
      match: async (url: string) => {
        for (const entries of cachesByName.values()) {
          const hit = entries.get(url);
          if (hit) {
            return hit.clone();
          }
        }
        return undefined;
      },
      open: async (name: string) => cacheFor(name),
    },
    clients: {
      claim: async () => {
        world.claimed = true;
      },
    },
    fetch: worldFetch,
    skipWaiting: async () => {
      world.skipped = true;
    },
  };
  const fire = async (type: string, event: Record<string, unknown> = {}) => {
    let waited: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({
      waitUntil: (pending: Promise<unknown>) => {
        waited = pending;
      },
      ...event,
    } as never);
    await waited;
  };
  const fetchViaWorker = async (request: {
    method: string;
    mode: string;
    url: string;
  }): Promise<Response | undefined> => {
    let responded: Promise<Response> | undefined;
    listeners.get('fetch')?.({
      request,
      respondWith: (pending: Promise<Response>) => {
        responded = pending;
      },
    } as never);
    return responded;
  };
  return { fire, fetchViaWorker, scope, world };
};

const install = (scope: ServiceWorkerScopeLike, version = 'v1') =>
  installServiceWorker(scope, { base: BASE, precache: PRECACHE, version });

test('install precaches the shell without taking over at once', async () => {
  const { fire, scope, world } = makeWorld();
  for (const name of PRECACHE) {
    world.network.set(new URL(name, BASE).href, `body of ${name}`);
  }
  install(scope);
  await fire('install');
  const entries = world.cachesByName.get(cacheNameFor('v1'))!;
  expect([...entries.keys()].sort()).toEqual(
    PRECACHE.map(name => new URL(name, BASE).href).sort(),
  );
  // A new version waits for the author to reload; it never skips alone.
  expect(world.skipped).toBe(false);
});

test('activate removes older Folio caches and claims the page', async () => {
  const { fire, scope, world } = makeWorld();
  world.cachesByName.set(cacheNameFor('v0'), new Map());
  world.cachesByName.set('someone-elses-cache', new Map());
  install(scope);
  await fire('activate');
  expect([...world.cachesByName.keys()]).toEqual(['someone-elses-cache']);
  expect(world.claimed).toBe(true);
});

test('a waiting worker skips waiting only when the page asks', async () => {
  const { fire, scope, world } = makeWorld();
  install(scope);
  await fire('message', { data: { type: 'something-else' } });
  expect(world.skipped).toBe(false);
  await fire('message', { data: { type: SKIP_WAITING } });
  expect(world.skipped).toBe(true);
});

test('the shell loads from the cache with the network off', async () => {
  const { fetchViaWorker, fire, scope, world } = makeWorld();
  for (const name of PRECACHE) {
    world.network.set(new URL(name, BASE).href, `body of ${name}`);
  }
  install(scope);
  await fire('install');
  world.offline = true;
  const page = await fetchViaWorker({
    method: 'GET',
    mode: 'navigate',
    url: BASE,
  });
  expect(await page!.text()).toBe('body of ./');
  const script = await fetchViaWorker({
    method: 'GET',
    mode: 'cors',
    url: `${BASE}main.js`,
  });
  expect(await script!.text()).toBe('body of ./main.js');
});

test('other requests are left to the network', async () => {
  const { fetchViaWorker, scope } = makeWorld();
  install(scope);
  expect(
    await fetchViaWorker({
      method: 'POST',
      mode: 'cors',
      url: `${BASE}main.js`,
    }),
  ).toBeUndefined();
  expect(
    await fetchViaWorker({
      method: 'GET',
      mode: 'cors',
      url: 'https://elsewhere.example/main.js',
    }),
  ).toBeUndefined();
});

test('an uncached page says so plainly when offline', async () => {
  const { fetchViaWorker, scope, world } = makeWorld();
  install(scope);
  world.offline = true;
  const response = await fetchViaWorker({
    method: 'GET',
    mode: 'navigate',
    url: BASE,
  });
  expect(response!.status).toBe(503);
  expect(await response!.text()).toContain('offline');
});

test('a precached page under the scope loads as itself, not as the index', async () => {
  const { fetchViaWorker, fire, scope, world } = makeWorld();
  const precache = [...PRECACHE, './tetris/'];
  for (const name of precache) {
    world.network.set(new URL(name, BASE).href, `body of ${name}`);
  }
  installServiceWorker(scope, { base: BASE, precache, version: 'v1' });
  await fire('install');
  world.offline = true;
  const page = await fetchViaWorker({
    method: 'GET',
    mode: 'navigate',
    url: `${BASE}tetris/`,
  });
  expect(await page!.text()).toBe('body of ./tetris/');
  const other = await fetchViaWorker({
    method: 'GET',
    mode: 'navigate',
    url: `${BASE}somewhere`,
  });
  expect(await other!.text()).toBe('body of ./');
});
