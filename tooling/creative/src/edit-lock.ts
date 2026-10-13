// One editor per Project (#752): an exclusive Web Lock named after the
// Project lets one tab edit it; other tabs open it read-only with "Edit
// here instead". Taking over is coordinated over a BroadcastChannel,
// because stealing a Web Lock does not tell its holder: the tab giving up
// editing flushes its autosave first, then releases and says so. The
// channel also tells every tab about new saves, deletions and list changes.
import { systemTimers, type Timers } from './autosave';

/** Messages tabs of the creative tool send each other. */
export type ProjectMessage =
  | { projectId: string; seq: number; type: 'saved' }
  | { projectId: string; type: 'taking-over' }
  | { projectId: string; type: 'released' }
  | { projectId: string; type: 'deleted' }
  | { type: 'list-changed' };

/** The slice of BroadcastChannel the tool uses; injectable for tests. */
export type ProjectChannel = {
  close(): void;
  listen(handler: (message: ProjectMessage) => void): () => void;
  post(message: ProjectMessage): void;
};

export const CHANNEL_NAME = 'northtalk-creative-projects';

/** A channel over the page's BroadcastChannel, where it exists. */
export const browserChannel = (): ProjectChannel | undefined => {
  if (typeof BroadcastChannel === 'undefined') {
    return undefined;
  }
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const handlers = new Set<(message: ProjectMessage) => void>();
  channel.onmessage = event => {
    for (const handler of handlers) {
      handler(event.data as ProjectMessage);
    }
  };
  return {
    close: () => channel.close(),
    listen: handler => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    post: message => channel.postMessage(message),
  };
};

/** The slice of `navigator.locks` the tool uses; injectable for tests. */
export type LockManagerLike = {
  query?: () => Promise<{ held?: { clientId?: string; name?: string }[] }>;
  request: <T>(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean },
    callback: (lock: { name: string } | null) => Promise<T> | T,
  ) => Promise<T>;
};

/** The page's Web Locks, where they exist. */
export const browserLocks = (): LockManagerLike | undefined =>
  typeof navigator === 'undefined' || !navigator.locks
    ? undefined
    : (navigator.locks as unknown as LockManagerLike);

export const lockNameFor = (projectId: string): string =>
  `northtalk-creative-project:${projectId}`;

export type EditLockHooks = {
  /** Writes any unsaved work before this tab gives up editing. */
  flush: () => Promise<void>;
  /** Whether this tab may now edit the Project it has open. */
  onEditing?: (editing: boolean) => void;
};

export class EditLock {
  readonly #locks: LockManagerLike | undefined;
  readonly #channel: ProjectChannel | undefined;
  readonly #hooks: EditLockHooks;
  readonly #timers: Timers;
  /** How long taking over waits for the other tab to flush and release. */
  readonly #takeoverWaitMs: number;
  #projectId: string | undefined;
  #editing = false;
  #releaseHold: (() => void) | undefined;
  /** Settles once the lock request the hold came from has finished. */
  #holdDone: Promise<void> | undefined;
  #clientId: Promise<string | undefined> | undefined;
  #releaseProbe: (() => void) | undefined;
  #releasedWaiters = new Set<() => void>();

  constructor(
    locks: LockManagerLike | undefined,
    channel: ProjectChannel | undefined,
    hooks: EditLockHooks,
    options: { takeoverWaitMs?: number; timers?: Timers } = {},
  ) {
    this.#locks = locks;
    this.#channel = channel;
    this.#hooks = hooks;
    this.#timers = options.timers ?? systemTimers;
    this.#takeoverWaitMs = options.takeoverWaitMs ?? 1000;
    channel?.listen(message => void this.#onMessage(message));
  }

  get editing(): boolean {
    return this.#editing;
  }

  get projectId(): string | undefined {
    return this.#projectId;
  }

  #setEditing(editing: boolean): void {
    if (this.#editing !== editing) {
      this.#editing = editing;
      this.#hooks.onEditing?.(editing);
    }
  }

  /**
   * Starts holding `name` whenever it is granted; resolves with whether it
   * was. The lock is held until `release`.
   */
  #hold(name: string, options: { ifAvailable?: boolean; steal?: boolean }) {
    let granted!: (held: boolean) => void;
    const result = new Promise<boolean>(resolve => {
      granted = resolve;
    });
    this.#holdDone = this.#locks!.request(name, options, async lock => {
      if (!lock) {
        granted(false);
        return;
      }
      await new Promise<void>(resolve => {
        this.#releaseHold = resolve;
        granted(true);
      });
    })
      .catch(() => granted(false))
      .then(() => {});
    return result;
  }

  /** Asks to edit a Project: granted at once, or this tab is read-only. */
  async acquire(projectId: string): Promise<boolean> {
    const previous = this.#holdDone;
    this.release();
    // A released lock frees asynchronously; asking too soon could refuse
    // a lock this same tab has just given up.
    await previous;
    this.#projectId = projectId;
    if (!this.#locks) {
      // No Web Locks: single-editor cannot be enforced; allow editing.
      this.#setEditing(true);
      return true;
    }
    const held = await this.#hold(lockNameFor(projectId), {
      ifAvailable: true,
    });
    this.#setEditing(held);
    return held;
  }

  /** Gives up editing the open Project, without flushing. */
  release(): void {
    this.#releaseHold?.();
    this.#releaseHold = undefined;
    this.#setEditing(false);
  }

  /**
   * Takes over editing from the tab that holds it: asks it to flush and
   * release, waits briefly for its answer, then steals the lock either
   * way so a frozen tab cannot block editing forever.
   */
  async takeOver(): Promise<boolean> {
    const projectId = this.#projectId;
    if (!projectId) {
      return false;
    }
    if (!this.#locks) {
      this.#setEditing(true);
      return true;
    }
    const released = new Promise<void>(resolve => {
      const done = () => {
        this.#releasedWaiters.delete(done);
        resolve();
      };
      this.#releasedWaiters.add(done);
      this.#timers.setTimeout(done, this.#takeoverWaitMs);
    });
    this.#channel?.post({ type: 'taking-over', projectId });
    await released;
    const held = await this.#hold(lockNameFor(projectId), { steal: true });
    this.#setEditing(held);
    return held;
  }

  async #onMessage(message: ProjectMessage): Promise<void> {
    if (message.type === 'released' && message.projectId === this.#projectId) {
      for (const waiter of this.#releasedWaiters) {
        waiter();
      }
    }
    if (
      message.type !== 'taking-over' ||
      message.projectId !== this.#projectId ||
      !this.#editing
    ) {
      return;
    }
    // Another tab is taking over: flush, become read-only, then say so.
    // A failed flush keeps its own banner (and Export) in this tab.
    try {
      await this.#hooks.flush();
    } catch {
      /* The save failure is already reported where the work is. */
    }
    this.release();
    this.#channel?.post({ type: 'released', projectId: message.projectId });
  }

  /** This tab's Web Locks client id, learned by holding a probe lock. */
  #ownClientId(): Promise<string | undefined> {
    this.#clientId ??= (async () => {
      const locks = this.#locks;
      if (!locks?.query) {
        return undefined;
      }
      const probe = `northtalk-creative-probe:${Math.random().toString(36).slice(2)}`;
      let found!: (id: string | undefined) => void;
      const result = new Promise<string | undefined>(resolve => {
        found = resolve;
      });
      void locks.request(probe, {}, async () => {
        const state = await locks.query!();
        found(state.held?.find(lock => lock.name === probe)?.clientId);
        await new Promise<void>(resolve => {
          this.#releaseProbe = resolve;
        });
      });
      return result;
    })();
    return this.#clientId;
  }

  /**
   * Whether this tab still holds the open Project's lock, checked against
   * the lock list so a steal this tab slept through is caught before it
   * writes. Falls back to what this tab believes.
   */
  async stillEditing(): Promise<boolean> {
    if (!this.#editing || !this.#projectId) {
      return this.#editing;
    }
    const locks = this.#locks;
    if (!locks?.query) {
      return true;
    }
    try {
      const own = await this.#ownClientId();
      if (!own) {
        return true;
      }
      const state = await locks.query();
      return (state.held ?? []).some(
        lock =>
          lock.name === lockNameFor(this.#projectId!) && lock.clientId === own,
      );
    } catch {
      return true;
    }
  }

  dispose(): void {
    this.release();
    this.#releaseProbe?.();
  }
}
