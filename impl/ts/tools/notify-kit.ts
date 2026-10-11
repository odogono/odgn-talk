// Drives the notification router, `@odgn/northtalk/notify`, through the
// router kit, `corpus/notify-kit/`: language-neutral sequences of watches,
// commits, mailbox refusals, Pumps, releases and checkpoints with the
// Deliveries the Store Notifications proposal requires. A fresh router, an
// in-memory Store and stand-in Groups run each sequence. Only loading the
// kit needs Bun; running a sequence works in any runtime.
import type { Call, Grant, GrantContext } from '../src/capabilities';
import { HostError, MailboxFull, ScriptError } from '../src/errors';
import type { Group, Message, RestoreOptions } from '../src/group';
import {
  changed,
  createRouter,
  type NotificationRouter,
  type WatchLimits,
} from '../src/notify/index';
import { readDisplay } from '../src/readers';
import { add } from '../src/store-capability';
import { map, text, type Value } from '../src/values';

type Delivery = {
  group?: string;
  message: string;
  payload: string;
  script?: string;
};
type Step = {
  args?: string;
  as?: string;
  checkpoint?: string;
  damage?: 'missing' | 'digest';
  deliveries?: Delivery[];
  do: string;
  dropped?: string[];
  effects?: boolean;
  error?: string;
  gone?: boolean;
  grant?: string;
  grants?: Record<string, string | false>;
  group?: string;
  in?: string;
  limits?: WatchLimits;
  ops?: string;
  pending?: boolean;
  reason?: GrantContext<string>['reason'];
  restored?: string[];
  resynced?: string[];
  room?: number;
  script?: string;
  store?: string;
  variablesOnly?: boolean;
};
type Sequence = {
  groups?: Record<string, string[]>;
  limits?: WatchLimits;
  name: string;
  steps: Step[];
};
type KitFile = {
  groups: Record<string, string[]>;
  limits: WatchLimits;
  sequence: Sequence[];
};

export type NotifyKitSequence = {
  file: string;
  groups: Record<string, string[]>;
  limits: WatchLimits;
  name: string;
  steps: Step[];
};

/** Every sequence in the kit, file by file. Needs Bun to read TOML. */
export const notifyKitSequences = async (
  root?: string,
): Promise<NotifyKitSequence[]> => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const dir = root ?? resolve(import.meta.dir, '../../../corpus/notify-kit');
  return readdirSync(dir)
    .filter(f => f.endsWith('.toml'))
    .sort()
    .flatMap(file => {
      const kit = Bun.TOML.parse(
        readFileSync(resolve(dir, file), 'utf8'),
      ) as KitFile;
      return kit.sequence.map(s => ({
        file,
        groups: s.groups ?? kit.groups,
        limits: s.limits ?? kit.limits,
        name: s.name,
        steps: s.steps,
      }));
    });
};

type Mailbox = { gone?: boolean; room?: number };
type Log = string[];

const deliveryLine = (group: string, script: string, m: Message) =>
  `${group} ${script} ${m.name} ${m.args![0]!.toString()}`;

/**
 * A Group as the router sees it: Scripts in load order, mailboxes the kit
 * sets, and a save that holds its Scripts and their Grants' Stores.
 */
class StandIn {
  readonly mailboxes = new Map<string, Mailbox>();
  effects = false;
  lastSave?: Uint8Array;
  constructor(
    readonly name: string,
    readonly scripts: readonly string[],
    // The Store each "<script>.<grant>" is bound to.
    readonly bindings: Map<string, string>,
    private readonly log: Log,
  ) {}
  scriptNames(): string[] {
    return [...this.scripts];
  }
  script(name: string) {
    if (!this.scripts.includes(name) || this.mailboxes.get(name)?.gone) {
      return undefined;
    }
    return {
      deliver: (m: Message) => {
        const box = this.mailboxes.get(name);
        if (box?.room === 0) {
          throw new MailboxFull();
        }
        if (box?.room !== undefined) {
          box.room--;
        }
        this.log.push(deliveryLine(this.name, name, m));
        return `d${this.log.length}`;
      },
    };
  }
  save(): Uint8Array {
    if (this.effects) {
      this.effects = false;
      throw new HostError('effects pending');
    }
    this.lastSave = new TextEncoder().encode(
      JSON.stringify({ scripts: this.scripts, bindings: [...this.bindings] }),
    );
    return this.lastSave;
  }
}

/** What one step did, or should do, in a comparable form. */
type Outcome = {
  deliveries: string[];
  error?: string;
  pending?: boolean;
  routing?: { dropped: string[]; restored: string[]; resynced: string[] };
};

const display = (source: string) => readDisplay(source).toString();
const listOf = (source: string): Value[] => {
  const list = readDisplay(source);
  return Array.from({ length: list.length }, (_, i) => list.index(i + 1));
};

const expected = (step: Step): Outcome => ({
  deliveries: (step.deliveries ?? []).map(
    d =>
      `${d.group ?? 'g'} ${d.script ?? 'a'} ${d.message} ${display(d.payload)}`,
  ),
  ...(step.error !== undefined ? { error: display(step.error) } : {}),
  ...(step.do === 'pumped' ? { pending: step.pending ?? false } : {}),
  ...(step.do === 'restore' && step.error === undefined
    ? {
        routing: {
          dropped: step.dropped ?? [],
          restored: step.restored ?? [],
          resynced: step.resynced ?? [],
        },
      }
    : {}),
});

const errorDisplay = (error: unknown): string => {
  if (error instanceof ScriptError) {
    return map([
      ['code', text(error.code)],
      ...(error.data.kind === 'map' ? error.data.entries() : []),
    ]).toString();
  }
  if (error instanceof HostError) {
    return map([['code', text(error.code)]]).toString();
  }
  throw error;
};

export type NotifyKitFailure = {
  actual: string;
  expected: string;
  step: number;
};

/** Runs one sequence on a fresh router; the first step that differs, if any. */
export const runNotifyKitSequence = (
  sequence: NotifyKitSequence,
): NotifyKitFailure | undefined => {
  let limits = sequence.limits;
  const committed = new Map<string, Map<string, Value>>();
  const revisions = new Map<string, number>();
  const router = createRouter({
    limits: () => limits,
    revision: store => `r${revisions.get(store) ?? 0}`,
  });
  const log: Log = [];
  const groups = new Map<string, StandIn>();
  for (const [name, scripts] of Object.entries(sequence.groups)) {
    groups.set(name, new StandIn(name, scripts, new Map(), log));
  }
  const segments = new Map<string, { ops: Value[]; store: string }>();
  const checkpoints = new Map<
    string,
    { bytes: Uint8Array; from: StandIn; save: Uint8Array }
  >();

  const groupOf = (step: Step) => {
    const group = groups.get(step.group ?? 'g');
    if (!group) {
      throw new Error(`No stand-in Group ${step.group}`);
    }
    return group;
  };
  const owner = (step: Step) => {
    const group = groupOf(step);
    const scriptName = step.script ?? 'a';
    const grantName = step.grant ?? 'store';
    const binding = step.store ?? 'default';
    group.bindings.set(`${scriptName}.${grantName}`, binding);
    return { group: group as unknown as Group, scriptName, grantName, binding };
  };
  const callOf = (step: Step): Call<string> => ({
    ...owner(step),
    id: 'kit.c1',
    segmentId: 'kit/r1.s1',
    runId: 'kit/r1',
    automatic: false,
    now: 0n,
    signal: new AbortController().signal,
    answer: () => {},
    charge: () => {},
    fail: () => {},
  });

  // Applies writes to a Store; its changed keys.
  const apply = (store: string, ops: readonly Value[]): string[] => {
    const contents = committed.get(store) ?? new Map<string, Value>();
    committed.set(store, contents);
    const before = new Map<string, Value | undefined>();
    const after = new Map<string, Value | undefined>();
    for (const op of ops) {
      const [kind, keyValue, value] = [op.index(1), op.index(2), op.index(3)];
      const key = keyValue.asText()!;
      if (!before.has(key)) {
        before.set(key, contents.get(key));
        after.set(key, contents.get(key));
      }
      const current = after.get(key);
      switch (kind.asText()) {
        case 'set':
          after.set(key, value.kind === 'nothing' ? undefined : value);
          break;
        case 'delete':
          after.set(key, undefined);
          break;
        case 'increment':
          after.set(key, current ? add(current, value) : value);
          break;
        default:
          throw new Error(`Unknown write ${kind.toString()}`);
      }
    }
    const keys = [...after].flatMap(([key, value]) =>
      changed(before.get(key), value) ? [key] : [],
    );
    for (const key of keys) {
      const value = after.get(key);
      if (value === undefined) {
        contents.delete(key);
      } else {
        contents.set(key, value);
      }
    }
    if (keys.length) {
      revisions.set(store, (revisions.get(store) ?? 0) + 1);
    }
    return keys;
  };

  const restore = (step: Step) => {
    const kept = checkpoints.get(step.checkpoint!);
    if (!kept) {
      throw new Error(`No checkpoint ${step.checkpoint}`);
    }
    let bytes = kept.bytes;
    if (step.damage === 'missing') {
      bytes = kept.save;
    } else if (step.damage === 'digest') {
      // The save is last, so changing its last byte breaks the digest.
      bytes = bytes.slice();
      bytes[bytes.length - 1] = bytes.at(-1)! ^ 0xff;
    }
    const core = {
      restore: (save: Uint8Array, o: RestoreOptions) => {
        const saved = JSON.parse(new TextDecoder().decode(save)) as {
          bindings: [string, string][];
          scripts: string[];
        };
        const bindings = new Map<string, string>();
        for (const [owned] of saved.bindings) {
          const [script, grant] = owned.split('.') as [string, string];
          const g = o.grants(script, grant);
          if (g) {
            bindings.set(owned, g.binding as string);
          }
        }
        const group = new StandIn(step.as!, saved.scripts, bindings, log);
        groups.set(step.as!, group);
        return {
          group: group as unknown as Group,
          result: {
            abandonedCalls: [],
            discardedRuns: [],
            disposed: [],
            droppedMessages: [],
            pending: [],
            reports: [],
            variablesOnly: step.variablesOnly ?? false,
          },
        };
      },
    } as Parameters<NotificationRouter['restore']>[0];
    const grants = (
      script: string,
      grant: string,
    ): Grant<unknown> | undefined => {
      const owned = `${script}.${grant}`;
      const override = step.grants?.[owned];
      const binding =
        override === undefined ? kept.from.bindings.get(owned) : override;
      if (binding === undefined || binding === false) {
        return undefined;
      }
      return {
        binding,
        capability: { name: 'store' },
        ops: new Set(),
      } as unknown as Grant<unknown>;
    };
    return router.restore(core, bytes, {
      name: step.as!,
      grants,
      libraries: [],
      onMismatch: 'reject',
      resolve: () => undefined,
    } as unknown as RestoreOptions).routing;
  };

  const run = (step: Step, outcome: Outcome) => {
    switch (step.do) {
      case 'watch': {
        const [name, prefix, message] = listOf(step.args!).map(v =>
          v.asText()!,
        );
        router.watch(callOf(step), name!, prefix!, message!);
        return;
      }
      case 'unwatch':
        router.unwatch(callOf(step), listOf(step.args!)[0]!.asText()!);
        return;
      case 'write': {
        const segment = segments.get(step.in!) ?? {
          ops: [],
          store: step.store ?? 'default',
        };
        segment.ops.push(...listOf(step.ops!));
        segments.set(step.in!, segment);
        return;
      }
      case 'commit': {
        const segment = step.in ? segments.get(step.in) : undefined;
        if (step.in) {
          segments.delete(step.in);
        }
        const store = segment?.store ?? step.store ?? 'default';
        const ops = [
          ...(segment?.ops ?? []),
          ...(step.ops ? listOf(step.ops) : []),
        ];
        router.commit(store, () => apply(store, ops));
        return;
      }
      case 'mailbox':
        groupOf(step).mailboxes.set(step.script ?? 'a', {
          ...(step.gone ? { gone: true } : {}),
          ...(step.room !== undefined ? { room: step.room } : {}),
        });
        return;
      case 'pumped':
        outcome.pending = router.pumped(groupOf(step) as unknown as Group);
        return;
      case 'release':
        router.release({ ...owner(step), now: 0n, reason: step.reason! });
        return;
      case 'detach':
        router.detach(groupOf(step) as unknown as Group);
        return;
      case 'limits':
        limits = step.limits!;
        return;
      case 'checkpoint': {
        const group = groupOf(step);
        group.effects = step.effects ?? false;
        const bytes = router.save(group as unknown as Group);
        checkpoints.set(step.as!, {
          bytes,
          from: group,
          save: group.lastSave!,
        });
        return;
      }
      case 'revision':
        revisions.set(
          step.store ?? 'default',
          (revisions.get(step.store ?? 'default') ?? 0) + 1,
        );
        return;
      case 'restore': {
        const { dropped, restored, resynced } = restore(step);
        outcome.routing = { dropped, restored, resynced };
        return;
      }
    }
    throw new Error(`Unknown step ${step.do}`);
  };

  for (const [i, step] of sequence.steps.entries()) {
    const start = log.length;
    const outcome: Outcome = { deliveries: [] };
    try {
      run(step, outcome);
    } catch (error) {
      outcome.error = errorDisplay(error);
    }
    outcome.deliveries = log.slice(start);
    const want = JSON.stringify(expected(step));
    const got = JSON.stringify(outcome);
    if (want !== got) {
      return { step: i + 1, expected: want, actual: got };
    }
  }
  return undefined;
};
