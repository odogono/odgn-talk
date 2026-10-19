// The notification router (Store Notifications, The router; ADR 0061): it
// holds Scripts' watches on Stores, routes each commit's changed keys to
// them as ordinary Deliveries, holds what a full mailbox refuses within the
// Store's limits, and retries after each Pump. It is built only on the
// embedding interface: Calls and release contexts name a watch's owner, and
// `Script.deliver`, `Group.scriptNames`, `Group.save` and `Core.restore` are
// all it calls.
import type { Call, Grant, GrantContext } from '../capabilities';
import type { Core } from '../core';
import { sizeOf } from '../costs';
import { encodeValue } from '../encoding';
import { HostError, ScriptError } from '../errors';
import type {
  Group,
  RestoreOptions,
  RestoreResult,
  SaveOptions,
} from '../group';
import { sha256 } from '../sha256';
import { hostScriptError } from '../store-capability';
import { compareText } from '../text';
import { bool, listValues, map, text, type Value } from '../values';

/** A Store's four limits on its watches (Store Notifications, Limits). */
export type WatchLimits = {
  /** The most pending Notifications, with one marker reserved per watch. */
  pending: number;
  /** The most their payloads may total, with every marker reserved. */
  pendingSize: number;
  /** The most watches, across every Script and Group. */
  watches: number;
  /** The most their names, prefixes and effective messages may total. */
  watchSize: number;
};

export type RouterOptions = {
  /** Told after each Notification a Group admits; it mustn't call the router. */
  admitted?(group: Group): void;
  limits(store: string): WatchLimits;
  /** The Store's current revision; read under its synchronization. */
  revision(store: string): string;
};

/** Each entry is "<script>.<grant>.<watch>", in the order of watches. */
export type RoutingResult = {
  dropped: string[];
  restored: string[];
  resynced: string[];
};

export type NotificationRouter = {
  /** Applies a commit under the Store's synchronization; apply returns its changed keys. */
  commit(store: string, apply: () => readonly string[]): void;
  detach(group: Group): void;
  /** After each Pump of the Group returns. True while the Group still has pending work. */
  pumped(group: Group): boolean;
  release(context: GrantContext<string>): void;
  /** Throws HostError `invalid checkpoint`, or whatever Core.restore throws. */
  restore(
    core: Pick<Core, 'restore'>,
    checkpoint: Uint8Array,
    o: RestoreOptions,
  ): { group: Group; result: RestoreResult; routing: RoutingResult };
  /** A checkpoint; throws effects pending as Group.save does. */
  save(group: Group, options?: SaveOptions): Uint8Array;
  unwatch(call: Call<string>, name: string): void;
  /** Registers or replaces a watch; throws ScriptError `watch limit` {limit}. */
  watch(
    call: Call<string>,
    name: string,
    prefix: string,
    message: string,
  ): void;
};

/**
 * Whether a commit changed a key's value: compared by the bytes of the Value
 * Encoding, with a missing key and Nothing one state (Net changes).
 */
export const changed = (before?: Value, after?: Value): boolean =>
  encoded(before) !== encoded(after);
const encoded = (v?: Value) =>
  v === undefined || v.kind === 'nothing' ? undefined : encodeValue(v);

// A pending ordinary Notification: its changed keys and its payload's size.
type Held = { keys: readonly string[]; size: number };
type Watch = {
  readonly grant: string;
  readonly group: Group;
  /** Pending ordinary Notifications, oldest first; empty while resyncing. */
  held: Held[];
  heldSize: number;
  message: string;
  readonly name: string;
  prefix: string;
  resyncing: boolean;
  readonly script: string;
  readonly store: string;
};
// Where a retry round starts: after this watch, in the order of watches.
type Position = { grant: string; name: string; script: string };
type GroupState = {
  /** Its place among Groups, from when it last came to hold a watch. */
  rank: number;
  retry?: Position;
  watches: Set<Watch>;
};

type SavedWatch = {
  grant: string;
  held: string[][];
  message: string;
  name: string;
  prefix: string;
  resyncing: boolean;
  script: string;
  store: string;
};
type RoutingState = {
  digest: string;
  retry?: Position;
  revisions: Record<string, string>;
  watches: SavedWatch[];
};

// A checkpoint is this header, the routing state as one line of JSON, and
// the Group save's bytes.
const HEADER = 'northtalk notify checkpoint 1\n';

type Named = { grant: string; name: string; prefix: string };
const payloadOf = (w: Named, keys: readonly string[], resync: boolean) =>
  map([
    ['grant', text(w.grant)],
    ['watch', text(w.name)],
    ['prefix', text(w.prefix)],
    ['keys', listValues(keys.map(k => text(k)))],
    ['resync', bool(resync)],
  ]);
const textSize = (s: string) => sizeOf(text(s));
const watchSize = (w: { message: string; name: string; prefix: string }) =>
  textSize(w.name) + textSize(w.prefix) + textSize(w.message);
const markerSize = (w: Named) => sizeOf(payloadOf(w, [], true));
const label = (w: Watch) => `${w.script}.${w.grant}.${w.name}`;
const invalidCheckpoint = (detail: string): never => {
  throw new HostError('invalid checkpoint', detail);
};

export const createRouter = (o: RouterOptions): NotificationRouter => {
  const groups = new Map<Group, GroupState>();
  const stores = new Map<string, Set<Watch>>();
  let ranks = 0;

  const ownerOf = (w: Watch, group: Group, script: string, grant: string) =>
    w.group === group && w.script === script && w.grant === grant;
  const find = (group: Group, script: string, grant: string, name: string) => {
    for (const w of groups.get(group)?.watches ?? []) {
      if (ownerOf(w, group, script, grant) && w.name === name) {
        return w;
      }
    }
    return undefined;
  };

  // The order of watches: by Group, then Script load order, Grant and name.
  const order = (watches: Iterable<Watch>): Watch[] => {
    const loads = new Map<Group, Map<string, number>>();
    const loadIndex = (group: Group, script: string) => {
      let names = loads.get(group);
      if (!names) {
        names = new Map(group.scriptNames().map((n, i) => [n, i]));
        loads.set(group, names);
      }
      return names.get(script) ?? names.size;
    };
    return [...watches].sort(
      (a, b) =>
        groups.get(a.group)!.rank - groups.get(b.group)!.rank ||
        loadIndex(a.group, a.script) - loadIndex(b.group, b.script) ||
        compareText(a.grant, b.grant) ||
        compareText(a.name, b.name),
    );
  };
  // Whether a is after position p within one Group.
  const after = (group: Group, a: Watch, p: Position) => {
    const names = group.scriptNames();
    const index = (s: string) => {
      const i = names.indexOf(s);
      return i < 0 ? names.length : i;
    };
    return (
      (index(a.script) - index(p.script) ||
        compareText(a.grant, p.grant) ||
        compareText(a.name, p.name)) > 0
    );
  };

  const add = (w: Watch) => {
    let state = groups.get(w.group);
    if (!state) {
      state = { rank: ranks++, watches: new Set() };
      groups.set(w.group, state);
    }
    state.watches.add(w);
    let watches = stores.get(w.store);
    if (!watches) {
      watches = new Set();
      stores.set(w.store, watches);
    }
    watches.add(w);
  };
  // A Group holding no watch gives up its place and its retry position.
  const remove = (w: Watch) => {
    const state = groups.get(w.group);
    if (state?.watches.delete(w) && !state.watches.size) {
      groups.delete(w.group);
    }
    stores.get(w.store)?.delete(w);
  };

  const totals = (store: string, without?: Watch) => {
    let watches = 0;
    let size = 0;
    let pending = 0;
    let pendingSize = 0;
    for (const w of stores.get(store) ?? []) {
      if (w !== without) {
        watches++;
        size += watchSize(w);
        pending += 1 + w.held.length;
        pendingSize += markerSize(w) + w.heldSize;
      }
    }
    return { watches, size, pending, pendingSize };
  };

  // 'admitted', 'full' for MailboxFull, or 'refused' for anything else.
  const deliver = (w: Watch, payload: Value) => {
    const script = w.group.script(w.script);
    if (!script) {
      return 'refused';
    }
    try {
      script.deliver({ name: w.message, args: [payload] });
      o.admitted?.(w.group);
      return 'admitted';
    } catch (error) {
      // Matched by name, as replay.ts matches it, so a MailboxFull from any
      // copy of the Core counts.
      return (error as Error | undefined)?.name === 'MailboxFull'
        ? 'full'
        : 'refused';
    }
  };

  // Holds an ordinary Notification, or makes the watch resyncing if that
  // would pass a pending limit.
  const hold = (w: Watch, keys: readonly string[], payload: Value) => {
    const size = sizeOf(payload);
    const limits = o.limits(w.store);
    const now = totals(w.store);
    if (
      now.pending + 1 > limits.pending ||
      now.pendingSize + size > limits.pendingSize
    ) {
      w.held = [];
      w.heldSize = 0;
      w.resyncing = true;
      return;
    }
    w.held.push({ keys, size });
    w.heldSize += size;
  };

  // Delivers a watch's pending work, oldest first, until a refusal.
  const drain = (w: Watch) => {
    while (w.resyncing || w.held.length) {
      const outcome = deliver(
        w,
        payloadOf(w, w.resyncing ? [] : w.held[0]!.keys, w.resyncing),
      );
      if (outcome === 'full') {
        return;
      }
      if (outcome === 'refused') {
        remove(w);
        return;
      }
      if (w.resyncing) {
        w.resyncing = false;
      } else {
        w.heldSize -= w.held.shift()!.size;
      }
    }
  };
  const hasWork = (w: Watch) => w.resyncing || w.held.length > 0;

  return {
    watch(call, name, prefix, message) {
      const store = call.binding;
      const existing = find(call.group, call.scriptName, call.grantName, name);
      if (existing?.prefix === prefix && existing.message === message) {
        return;
      }
      const limits = o.limits(store);
      const now = totals(store, existing);
      const next = { name, prefix, message };
      const marker = markerSize({ grant: call.grantName, ...next });
      const limit =
        now.watches + 1 > limits.watches
          ? 'watches'
          : now.size + watchSize(next) > limits.watchSize
            ? 'size'
            : now.pending + 1 > limits.pending ||
                now.pendingSize + marker > limits.pendingSize
              ? 'pending'
              : undefined;
      if (limit) {
        throw watchLimit(limit);
      }
      if (existing) {
        existing.prefix = prefix;
        existing.message = message;
        existing.held = [];
        existing.heldSize = 0;
        existing.resyncing = false;
        return;
      }
      add({
        group: call.group,
        script: call.scriptName,
        grant: call.grantName,
        store,
        ...next,
        held: [],
        heldSize: 0,
        resyncing: false,
      });
    },

    unwatch(call, name) {
      const w = find(call.group, call.scriptName, call.grantName, name);
      if (w) {
        remove(w);
      }
    },

    release(context) {
      for (const w of groups.get(context.group)?.watches ?? []) {
        if (ownerOf(w, context.group, context.scriptName, context.grantName)) {
          remove(w);
        }
      }
    },

    commit(store, apply) {
      const keys = [...new Set(apply())].sort(compareText);
      if (!keys.length) {
        return;
      }
      for (const w of order(stores.get(store) ?? [])) {
        const matched = keys.filter(k => k.startsWith(w.prefix));
        if (!matched.length || w.resyncing) {
          continue;
        }
        const payload = payloadOf(w, matched, false);
        if (w.held.length) {
          hold(w, matched, payload);
          continue;
        }
        const outcome = deliver(w, payload);
        if (outcome === 'full') {
          hold(w, matched, payload);
        } else if (outcome === 'refused') {
          remove(w);
        }
      }
    },

    pumped(group) {
      const state = groups.get(group);
      if (!state) {
        return false;
      }
      const waiting = order(state.watches).filter(hasWork);
      if (!waiting.length) {
        return false;
      }
      const retry = state.retry;
      const start = retry
        ? Math.max(
            0,
            waiting.findIndex(w => after(group, w, retry)),
          )
        : 0;
      const round = [...waiting.slice(start), ...waiting.slice(0, start)];
      const first = round[0]!;
      state.retry = {
        script: first.script,
        grant: first.grant,
        name: first.name,
      };
      for (const w of round) {
        drain(w);
      }
      return [...(groups.get(group)?.watches ?? [])].some(hasWork);
    },

    detach(group) {
      for (const w of groups.get(group)?.watches ?? []) {
        remove(w);
      }
    },

    save(group, options) {
      const bytes = group.save(options);
      const state = groups.get(group);
      const watches = order(state?.watches ?? []);
      const routing: RoutingState = {
        digest: sha256(bytes),
        ...(state?.retry ? { retry: state.retry } : {}),
        revisions: Object.fromEntries(
          [...new Set(watches.map(w => w.store))]
            .sort(compareText)
            .map(store => [store, o.revision(store)]),
        ),
        watches: watches.map(w => ({
          script: w.script,
          grant: w.grant,
          name: w.name,
          store: w.store,
          prefix: w.prefix,
          message: w.message,
          resyncing: w.resyncing,
          held: w.held.map(h => [...h.keys]),
        })),
      };
      const head = new TextEncoder().encode(
        HEADER + JSON.stringify(routing) + '\n',
      );
      const checkpoint = new Uint8Array(head.length + bytes.length);
      checkpoint.set(head);
      checkpoint.set(bytes, head.length);
      return checkpoint;
    },

    restore(core, checkpoint, options) {
      const { routing, save } = readCheckpoint(checkpoint);
      const { group, result } = core.restore(save, options);
      const out: RoutingResult = { restored: [], dropped: [], resynced: [] };
      if (result.variablesOnly) {
        return { group, result, routing: out };
      }
      const restored: Watch[] = [];
      const dropped: Watch[] = [];
      for (const saved of routing.watches) {
        const w: Watch = {
          group,
          script: saved.script,
          grant: saved.grant,
          name: saved.name,
          store: saved.store,
          prefix: saved.prefix,
          message: saved.message,
          held: [],
          heldSize: 0,
          resyncing: saved.resyncing,
        };
        for (const keys of saved.held) {
          const size = sizeOf(payloadOf(w, keys, false));
          w.held.push({ keys, size });
          w.heldSize += size;
        }
        if (reboundTo(options.grants(saved.script, saved.grant), saved.store)) {
          add(w);
          restored.push(w);
        } else {
          dropped.push(w);
        }
      }
      const state = groups.get(group);
      if (state && routing.retry) {
        state.retry = routing.retry;
      }
      const resynced = order(restored).filter(
        w => o.revision(w.store) !== routing.revisions[w.store],
      );
      for (const w of resynced) {
        w.held = [];
        w.heldSize = 0;
        w.resyncing = true;
      }
      out.restored = order(restored).map(label);
      out.resynced = resynced.map(label);
      // The dropped watches' Group order is the restored Group's.
      const names = group.scriptNames();
      // A Script no longer in the Group sorts last, as in the order of watches.
      const index = (script: string) => {
        const i = names.indexOf(script);
        return i < 0 ? names.length : i;
      };
      out.dropped = dropped
        .sort(
          (a, b) =>
            index(a.script) - index(b.script) ||
            compareText(a.grant, b.grant) ||
            compareText(a.name, b.name),
        )
        .map(label);
      for (const w of resynced) {
        drain(w);
      }
      return { group, result, routing: out };
    },
  };
};

// `watch limit` {limit}, with the catalogue's message once errors.toml has
// the code (#620), and the proposal's until then.
const watchLimit = (limit: string) => {
  const error = hostScriptError('watch limit', [['limit', text(limit)]]);
  return error.message === 'watch limit'
    ? new ScriptError(
        error.code,
        `The Store's ${text(limit).toString()} limit for watches would be exceeded`,
        error.data,
      )
    : error;
};

// A Grant re-bound to a `store` Grant naming the recorded Store.
const reboundTo = (grant: Grant<unknown> | undefined, store: string) =>
  grant !== undefined &&
  grant.capability.name === 'store' &&
  grant.binding === store;

const readCheckpoint = (
  checkpoint: Uint8Array,
): { routing: RoutingState; save: Uint8Array } => {
  const header = new TextEncoder().encode(HEADER);
  if (
    checkpoint.length < header.length ||
    header.some((b, i) => checkpoint[i] !== b)
  ) {
    invalidCheckpoint('A checkpoint without routing state');
  }
  const end = checkpoint.indexOf(0x0a, header.length);
  if (end < 0) {
    invalidCheckpoint('Unreadable routing state');
  }
  let routing: RoutingState;
  try {
    routing = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        checkpoint.subarray(header.length, end),
      ),
    ) as RoutingState;
  } catch {
    return invalidCheckpoint('Unreadable routing state');
  }
  if (!wellFormed(routing)) {
    invalidCheckpoint('Unreadable routing state');
  }
  const save = checkpoint.slice(end + 1);
  if (sha256(save) !== routing.digest) {
    invalidCheckpoint('The routing state is for another Group save');
  }
  return { routing, save };
};

const isText = (v: unknown): v is string => typeof v === 'string';
const isPosition = (v: unknown): v is Position =>
  !!v &&
  typeof v === 'object' &&
  isText((v as Position).script) &&
  isText((v as Position).grant) &&
  isText((v as Position).name);
const wellFormed = (r: unknown): r is RoutingState => {
  if (!r || typeof r !== 'object') {
    return false;
  }
  const s = r as RoutingState;
  return (
    isText(s.digest) &&
    (s.retry === undefined || isPosition(s.retry)) &&
    !!s.revisions &&
    typeof s.revisions === 'object' &&
    Object.values(s.revisions).every(isText) &&
    Array.isArray(s.watches) &&
    s.watches.every(
      w =>
        isPosition(w) &&
        isText(w.store) &&
        isText(w.prefix) &&
        isText(w.message) &&
        typeof w.resyncing === 'boolean' &&
        Array.isArray(w.held) &&
        w.held.every(keys => Array.isArray(keys) && keys.every(isText)) &&
        isText(s.revisions[w.store]),
    )
  );
};
