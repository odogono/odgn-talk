// Page-side offline wiring: registration, the update prompt and install
// guidance, against fake service-worker objects. A first install is not
// an update, and applying an update reloads only once the new worker
// controls the page.
import { expect, test } from 'bun:test';
import {
  installGuidance,
  registerOffline,
  type RegistrationLike,
  type WorkerLike,
} from '../src/offline';
import { SKIP_WAITING } from '../src/sw';

type Listener = () => void;

const fakeWorker = (state = 'installed') => {
  const listeners = new Map<string, Listener>();
  const worker: WorkerLike & { messages: unknown[] } = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    messages: [],
    postMessage: message => worker.messages.push(message),
    state,
  };
  return {
    fire: (type: string) => listeners.get(type)?.(),
    worker,
  };
};

const fakeRegistration = (
  overrides: Partial<RegistrationLike> = {},
): { fire: (type: string) => void; registration: RegistrationLike } => {
  const listeners = new Map<string, Listener>();
  const registration: RegistrationLike = {
    active: undefined,
    addEventListener: (type, listener) => listeners.set(type, listener),
    installing: undefined,
    update: async () => {},
    waiting: undefined,
    ...overrides,
  };
  return {
    fire: (type: string) => listeners.get(type)?.(),
    registration,
  };
};

const fakeContainer = (
  registration: RegistrationLike,
  { controlled = true } = {},
) => {
  const listeners = new Map<string, Listener>();
  return {
    container: {
      addEventListener: (type: string, listener: Listener) =>
        listeners.set(type, listener),
      controller: controlled ? ({} as WorkerLike) : undefined,
      register: async () => registration,
    },
    fire: (type: string) => listeners.get(type)?.(),
  };
};

test('no service worker support is reported, not thrown', async () => {
  const status = await registerOffline({
    onUpdateReady: () => {},
    reload: () => {},
    serviceWorker: undefined,
  });
  expect(status).toBe('unsupported');
});

test('a waiting worker beside a controlling one is an update', async () => {
  const { worker: waiting } = fakeWorker();
  const { registration } = fakeRegistration({ waiting });
  const { container, fire } = fakeContainer(registration);
  let reloaded = 0;
  let apply: (() => Promise<void>) | undefined;
  const status = await registerOffline({
    onUpdateReady: update => {
      apply = update.applyUpdate;
    },
    reload: () => {
      reloaded += 1;
    },
    serviceWorker: container,
  });
  expect(status).toBe('registered');
  expect(apply).toBeDefined();
  await apply!();
  expect(waiting.messages).toEqual([{ type: SKIP_WAITING }]);
  expect(reloaded).toBe(0);
  fire('controllerchange');
  fire('controllerchange');
  expect(reloaded).toBe(1);
});

test('the first install is not offered as an update', async () => {
  const { worker: waiting } = fakeWorker();
  const { registration } = fakeRegistration({ waiting });
  const { container } = fakeContainer(registration, { controlled: false });
  let updates = 0;
  await registerOffline({
    onUpdateReady: () => {
      updates += 1;
    },
    reload: () => {},
    serviceWorker: container,
  });
  expect(updates).toBe(0);
});

test('an update found later is offered once it has installed', async () => {
  const { fire: fireWorker, worker: installing } = fakeWorker('installing');
  const { fire: fireRegistration, registration } = fakeRegistration();
  const { container } = fakeContainer(registration);
  let updates = 0;
  await registerOffline({
    onUpdateReady: () => {
      updates += 1;
    },
    reload: () => {},
    serviceWorker: container,
  });
  (registration as { installing?: WorkerLike }).installing = installing;
  fireRegistration('updatefound');
  expect(updates).toBe(0);
  installing.state = 'installed';
  fireWorker('statechange');
  expect(updates).toBe(1);
});

test('install guidance matches what each browser can do', () => {
  expect(
    installGuidance({ canPrompt: false, installed: true, platform: 'other' })
      .kind,
  ).toBe('installed');
  expect(
    installGuidance({ canPrompt: true, installed: false, platform: 'other' })
      .kind,
  ).toBe('prompt');
  expect(
    installGuidance({
      canPrompt: false,
      installed: false,
      platform: 'apple-touch',
    }).message,
  ).toContain('Add to Home Screen');
  expect(
    installGuidance({ canPrompt: false, installed: false, platform: 'other' })
      .message,
  ).toContain('browser');
});
