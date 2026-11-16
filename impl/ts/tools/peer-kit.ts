// Drives the Peer Router, `@northtalk/ts/peer`, through the peer kit,
// `corpus/peer-kit/`: language-neutral sequences of exposes, unexposes,
// Remote Sends and releases, with the Deliveries and failures chapter 9's
// Peer Router obligations require. A fresh router and one stand-in Group run
// each sequence, with no link: every Remote Send is to this Host's own
// Peer Exposures. Only loading the kit needs Bun; running a sequence works
// in any runtime.
import type { Call, GrantContext } from '../src/capabilities';
import { HostError, ScriptError } from '../src/errors';
import type { TsGroup } from '../src/group';
import type { HostObject } from '../src/objects';
import { PeerRouter } from '../src/peer';
import { readDisplay } from '../src/readers';
import { list, map, text, type Value } from '../src/values';

type Delivery = {
  args: string;
  kind: 'deliver' | 'request';
  message: string;
  script?: string;
};
type Step = {
  args?: string;
  as?: string;
  deliveries?: Delivery[];
  do: string;
  error?: string;
  grant?: string;
  message?: string;
  name?: string;
  peer?: string;
  reason?: GrantContext<unknown>['reason'];
  same?: string;
  script?: string;
};
type Sequence = { name: string; scripts?: string[]; steps: Step[] };
type KitFile = { scripts: string[]; sequence: Sequence[] };

export type PeerKitSequence = {
  file: string;
  name: string;
  scripts: string[];
  steps: Step[];
};

/** Every sequence in the kit, file by file. Needs Bun to read TOML. */
export const peerKitSequences = async (
  root?: string,
): Promise<PeerKitSequence[]> => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const dir = root ?? resolve(import.meta.dir, '../../../corpus/peer-kit');
  return readdirSync(dir)
    .filter(f => f.endsWith('.toml'))
    .sort()
    .flatMap(file => {
      const kit = Bun.TOML.parse(
        readFileSync(resolve(dir, file), 'utf8'),
      ) as KitFile;
      return kit.sequence.map(s => ({
        file,
        name: s.name,
        scripts: s.scripts ?? kit.scripts,
        steps: s.steps,
      }));
    });
};

// A fixed key, so Peer ids are this Host's: 64 hex digits.
const KEY = 'ab'.repeat(32);

/**
 * A Group as the router sees it: Scripts that log each Delivery and Request
 * they accept, and Host Objects the kit can map back from the Values the
 * router answers with.
 */
class StandIn {
  readonly objects = new Map<Value, HostObject>();
  constructor(
    readonly scripts: readonly string[],
    private readonly log: string[],
  ) {}
  object(kind: HostObject['kind'], id: string, native: unknown): HostObject {
    const value = { kind: 'object', id } as unknown as Value;
    const handle = { id, kind, native, value } as HostObject;
    this.objects.set(value, handle);
    return handle;
  }
  script(name: string) {
    if (!this.scripts.includes(name)) {
      return undefined;
    }
    const line = (kind: string, m: { args?: Value[]; name: string }) => {
      this.log.push(
        `${name} ${kind} ${m.name} ${list(...(m.args ?? [])).toString()}`,
      );
      return `d${this.log.length}`;
    };
    return {
      deliver: (m: { args?: Value[]; name: string }) => line('deliver', m),
      // The kit never settles a Request: what it observes is that one arrived.
      request: (m: { args?: Value[]; name: string }) => ({
        id: line('request', m),
        result: new Promise<Value>(() => {}),
      }),
    };
  }
}

/** What one step did, or should do, in a comparable form. */
type Outcome = { deliveries: string[]; error?: string; peer?: string };

const display = (source: string) => readDisplay(source).toString();
const listOf = (source: string): Value[] => {
  const v = readDisplay(source);
  return Array.from({ length: v.length }, (_, i) => v.index(i + 1));
};

const expected = (step: Step): Outcome => ({
  deliveries: (step.deliveries ?? []).map(
    d => `${d.script ?? 'a'} ${d.kind} ${d.message} ${display(d.args)}`,
  ),
  ...(step.error !== undefined ? { error: display(step.error) } : {}),
  ...(step.do === 'expose' && step.error === undefined
    ? { peer: step.same === undefined ? 'new' : `same ${step.same}` }
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

export type PeerKitFailure = {
  actual: string;
  expected: string;
  step: number;
};

/** Runs one sequence on a fresh router; the first step that differs, if any. */
export const runPeerKitSequence = (
  sequence: PeerKitSequence,
): PeerKitFailure | undefined => {
  const log: string[] = [];
  const group = new StandIn(sequence.scripts, log);
  const router = new PeerRouter({ key: KEY });
  router.bind(group as unknown as TsGroup);
  const peers = new Map<string, HostObject>();

  const owner = (step: Step) => ({
    group: group as unknown as TsGroup,
    scriptName: step.script ?? 'a',
    grantName: step.grant ?? 'peer',
    binding: {},
  });
  const callOf = (step: Step, outcome: Outcome): Call<unknown> => ({
    ...owner(step),
    id: 'kit.c1',
    segmentId: 'kit/r1.s1',
    runId: 'kit/r1',
    automatic: false,
    now: 0n,
    signal: new AbortController().signal,
    answer: value => {
      const answered = group.objects.get(value);
      if (step.do !== 'expose' || !answered) {
        return;
      }
      const known = [...peers].find(([, p]) => p.id === answered.id);
      outcome.peer = known ? `same ${known[0]}` : 'new';
      if (step.as !== undefined) {
        peers.set(step.as, answered);
      }
    },
    charge: () => {},
    requestCharge: () => {
      throw new Error('No charge requests in the peer kit');
    },
    fail: error => {
      outcome.error = errorDisplay(error);
    },
  });
  const peerOf = (step: Step) => {
    const peer = peers.get(step.peer!);
    if (!peer) {
      throw new Error(`No Peer ${step.peer}`);
    }
    return peer;
  };

  const run = (step: Step, outcome: Outcome) => {
    const call = callOf(step, outcome);
    switch (step.do) {
      case 'expose':
        return router.impl.expose(call, step.name);
      case 'unexpose':
        return router.impl.unexpose(
          call,
          step.peer === undefined ? step.name! : peerOf(step),
        );
      case 'post':
      case 'call':
        return router.impl[step.do](
          call,
          peerOf(step),
          step.message!,
          listOf(step.args ?? '[]'),
        );
      case 'release':
        return router.impl.release!({
          ...owner(step),
          now: 0n,
          reason: step.reason!,
        });
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
    const got = JSON.stringify({
      deliveries: log.slice(start),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.peer !== undefined ? { peer: outcome.peer } : {}),
    });
    const want = JSON.stringify(expected(step));
    if (want !== got) {
      return { step: i + 1, expected: want, actual: got };
    }
  }
  return undefined;
};
