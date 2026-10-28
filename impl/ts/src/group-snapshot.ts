// The TS Core's save format: what a Group's save holds, its versions and
// checks, and the reference table its graph names objects through. The
// Group gathers its state and rebuilds from a decoded save; graph mechanics
// live in snapshot.ts, wait state in waits.ts (ADR 0105).
import type { ValueOperation } from './capabilities';
import { HostError } from './errors';
import { costModel, languageVersion } from './generated/machine';
import type {
  Decision,
  InputAction,
  Pending,
  Running,
  ScriptState,
  Timer,
  Waiter,
} from './group';
import { identityOf, type Library } from './library';
import type { Code, Limits } from './machine';
import { canonicalJSON } from './manifest';
import type { ObjectState } from './objects';
import type { AccountingState } from './run-accounting';
import { sha256 } from './sha256';
import {
  reference,
  references,
  restoreGraph,
  saveFormatVersion,
  saveGraph,
  type ChangedCode,
  type Graph,
  type References,
} from './snapshot';
import { packGraph, unpackGraph, type PackedGraph } from './snapshot-codec';
import type { Value } from './values';
import type { Waits } from './waits';

/** What a save reads from its Group. */
export type GroupSnapshot = {
  accounting: AccountingState;
  broadcasts: number;
  deliveries: number;
  discardedDecisions: Decision[];
  fingerprint: Uint8Array;
  id: string;
  inputs: readonly { action: InputAction; line: unknown; urgent?: boolean }[];
  lastClock: bigint | null;
  libraries: ReadonlyMap<string, Library>;
  name: string;
  objects: ReadonlyMap<string, ObjectState>;
  randomState: bigint;
  references: References;
  scripts: readonly ScriptState[];
  sources: 'embedded' | 'external';
  waits: Waits<Running, ScriptState>;
};

/** A Group's save bytes. */
export const encodeGroup = (g: GroupSnapshot): Uint8Array => {
  const payload = wireOf(savedGroup(g));
  return new TextEncoder().encode(
    JSON.stringify({ hash: sha256(JSON.stringify(payload)), payload }),
  );
};

/**
 * A Group's State Fingerprint: its save's payload without the Trace save id,
 * the source mode or the sources, as code counts by identity (ADR 0142).
 */
export const stateFingerprint = (g: Omit<GroupSnapshot, 'id' | 'sources'>) =>
  fingerprintOf(wireOf(savedGroup({ ...g, id: '', sources: 'external' })));

/** A save's State Fingerprint, without restoring it. */
export const saveStateFingerprint = (bytes: Uint8Array): Uint8Array => {
  const payload = readPayload(bytes);
  if (
    payload.family !== 'odgn-talk-ts' ||
    payload.format !== saveFormatVersion
  ) {
    throw new HostError('save mismatch');
  }
  // Rejects the bytes a restore can't read.
  decodeGroup(bytes);
  return fingerprintOf(payload);
};

const fingerprintOf = (payload: SavedWire): Uint8Array => {
  const { id: _id, sourceMode: _mode, scripts, ...rest } = payload;
  const hex = sha256(
    JSON.stringify({
      ...rest,
      scripts: scripts.map(({ sources: _sources, ...script }) => script),
    }),
  );
  return Uint8Array.from(hex.match(/../g)!, byte => Number.parseInt(byte, 16));
};

const savedGroup = (g: GroupSnapshot): SavedGroup => {
  const { timers, pending, timerSeq } = g.waits.exportState();
  const state = {
    scripts: g.scripts.map(s => ({
      name: s.name,
      variables: s.loaded.variables,
      variableNames: s.loaded.variableNames,
      definitions: s.loaded.units.map(unit => unit.definitions),
      live: s.loaded.live,
      debt: s.debt,
      incoming: s.incoming,
      parked: s.parked,
      queue: s.queue,
      runs: s.runs,
      fuelTotal: s.fuelTotal,
      allocTotal: s.allocTotal,
      faults: s.faults,
      stopped: s.stopped,
      stopReason: s.stopReason,
      suspended: s.suspended,
      waiters: g.waits.waitersOf(s),
      revoked: s.revoked,
      disabled: s.disabled,
    })),
    accounting: g.accounting,
    inputs: g.inputs.map(input => ({
      action: input.action,
      urgent: input.urgent,
      line: typeof input.line === 'string' ? input.line : undefined,
    })),
    timers,
    pending,
    deliveries: g.deliveries,
    broadcasts: g.broadcasts,
    timerSeq,
    lastClock: g.lastClock,
    randomState: g.randomState,
    discardedDecisions: g.discardedDecisions,
  };
  return {
    family: 'odgn-talk-ts',
    format: saveFormatVersion,
    language: languageVersion,
    costModel: costModel.version,
    fingerprint: hexOf(g.fingerprint),
    name: g.name,
    id: g.id,
    sourceMode: g.sources,
    libraries: [...g.libraries.values()].map(l => [l.name, identityOf(l)]),
    objects: [...g.objects].map(([key, o]) => ({
      key,
      kind: o.handle.kind.name,
      id: o.handle.id,
      disposed: o.disposed,
      owner: o.owner,
      parent: o.parent
        ? `${o.parent.handle.kind.name}\u0000${o.parent.handle.id}`
        : null,
    })),
    scripts: g.scripts.map(s => ({
      name: s.name,
      identities: s.units.map(unit => unit.identity),
      ...(g.sources === 'external'
        ? {}
        : { sources: s.units.map(unit => unit.source) }),
      limits: s.limits,
      grants: [...s.grants].map(([name, grant]) => ({
        name,
        capability: grant.capability.name,
        operations: [...grant.ops].sort(compareNames).map(name => ({
          name,
          declaration: savedOperation(grant.capability.operations.get(name)!),
        })),
      })),
      objects: Object.entries(s.objects).map(([name, o]) => [
        name,
        `${o.kind.name}\u0000${o.id}`,
      ]),
      owner: s.owner
        ? `${s.owner.handle.kind.name}\u0000${s.owner.handle.id}`
        : null,
    })),
    graph: saveGraph(state, g.references),
  };
};

export const snapshotReferences = (
  functionGroup: object,
  scripts: readonly ScriptState[],
  objects: ReadonlyMap<string, ObjectState>,
): References => {
  const refs = references();
  reference(refs, 'function-group', functionGroup);
  const code = (key: string, unit: Code) => {
    if (refs.byObject.has(unit)) {
      return;
    }
    reference(refs, key, unit);
    unit.unit.bodies.forEach((body, i) =>
      reference(refs, `${key}/body/${i}`, body),
    );
    unit.unit.unwind.forEach((entry, i) =>
      reference(refs, `${key}/unwind/${i}`, entry),
    );
    for (const [name, imported] of unit.libraries) {
      code(`library/${name}`, imported);
    }
  };
  for (const s of scripts) {
    reference(refs, `script/${s.name}`, s);
    s.loaded.units.forEach((unit, i) => code(`code/${s.name}/${i}`, unit));
    for (const [name, grant] of s.grants) {
      for (const op of grant.ops) {
        reference(
          refs,
          `operation/${s.name}/${name}/${op}`,
          grant.capability.operations.get(op)!,
        );
      }
    }
  }
  for (const [key, object] of objects) {
    reference(refs, `object/${key}`, object);
  }
  return refs;
};

/** Whether a save comes from other format, language or Cost Model versions. */
export const versionMismatch = (saved: SavedGroup): boolean =>
  saved.format !== saveFormatVersion ||
  saved.language !== languageVersion ||
  saved.costModel !== costModel.version;

/** Whether a save comes from other Libraries than these. */
export const libraryMismatch = (
  saved: SavedGroup,
  libraries: ReadonlyMap<string, Library>,
): boolean =>
  saved.libraries.some(
    ([name, identity]) =>
      !libraries.has(name) || identityOf(libraries.get(name)!) !== identity,
  );

/** A save's state graph, its references resolved and its accounting checked. */
export const restoreState = (
  saved: SavedGroup,
  refs: References,
  changed: ChangedCode,
): SavedState => {
  const state = restoreGraph(saved.graph, refs, changed) as SavedState;
  validateSavedAccounting(state);
  return state;
};

type SavedGrant = {
  capability: string;
  name: string;
  operations: { declaration: ValueOperation<unknown>; name: string }[];
};
export type SavedGroup = {
  costModel: number;
  family: string;
  fingerprint: string;
  format: number;
  graph: Graph;
  id: string;
  language: string;
  libraries: [string, string][];
  name: string;
  objects: {
    disposed: boolean;
    id: string;
    key: string;
    kind: string;
    owner: string | null;
    parent: string | null;
  }[];
  scripts: {
    grants: SavedGrant[];
    identities: string[];
    limits: Limits;
    name: string;
    objects: [string, string][];
    owner: string | null;
    sources?: string[];
  }[];
  sourceMode: 'embedded' | 'external';
};
export type SavedScriptState = Pick<
  ScriptState,
  | 'name'
  | 'fuelTotal'
  | 'allocTotal'
  | 'faults'
  | 'debt'
  | 'incoming'
  | 'parked'
  | 'queue'
  | 'runs'
  | 'stopped'
  | 'stopReason'
  | 'suspended'
  | 'revoked'
  | 'disabled'
> & {
  definitions: Value[][];
  live: boolean;
  variableNames: string[];
  variables: Value[];
  waiters: Waiter[];
};
export type SavedState = {
  accounting: AccountingState;
  broadcasts: number;
  deliveries: number;
  discardedDecisions: Decision[];
  inputs: { action: InputAction; line?: string; urgent?: boolean }[];
  lastClock: bigint | null;
  pending: Map<string, Pending>;
  randomState: bigint;
  scripts: SavedScriptState[];
  timers: Timer[];
  timerSeq: number;
};
const invalidAccounting = (): never => {
  throw new HostError('invalid save', 'Invalid saved Run accounting');
};
export const validateSavedAccounting = (state: SavedState) => {
  const a = state.accounting;

  if (
    !a ||
    Object.prototype.toString.call(a.runs) !== '[object Map]' ||
    Object.prototype.toString.call(a.roots) !== '[object Map]' ||
    !Number.isSafeInteger(a.next) ||
    a.next < 0
  ) {
    invalidAccounting();
  }
  const orders = new Set<number>();
  let count = 0;
  for (const s of state.scripts) {
    for (const r of savedRuns(s)) {
      count++;
      const row = a.runs.get(r.id);
      if (
        !row ||
        row.report.run !== r.id ||
        row.report.script !== s.name ||
        row.report.state !== 'live' ||
        row.report.fuel !== r.run.fuel ||
        !a.roots.has(row.report.rootDelivery) ||
        !Number.isSafeInteger(row.order) ||
        row.order <= 0 ||
        row.order > a.next ||
        orders.has(row.order)
      ) {
        invalidAccounting();
      }
      orders.add(row!.order);
    }
  }
  if (count !== a.runs.size) {
    invalidAccounting();
  }
  for (const [id, row] of a.roots) {
    const n = Number(id.slice(1));
    if (
      id !== `d${n}` ||
      !Number.isSafeInteger(n) ||
      n <= 0 ||
      n > state.deliveries ||
      !row ||
      !Number.isSafeInteger(row.discarded) ||
      row.discarded < 0
    ) {
      invalidAccounting();
    }
  }
};
export const compareNames = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;
export const hexOf = (bytes: Uint8Array) =>
  [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
export const savedRuns = (s: SavedScriptState) =>
  [
    ...s.queue.filter((q): q is Running => 'run' in q),
    ...s.suspended,
    ...s.parked,
  ].sort((a, b) => Number(a.id.split('/r')[1]) - Number(b.id.split('/r')[1]));
// Callbacks are executable and documentation is manifest-only.
const unsavedOperationKeys = new Set([
  'do',
  'fire',
  'run',
  'start',
  'description',
  'examples',
]);
const savedOperation = (op: ValueOperation<unknown>): ValueOperation<unknown> =>
  Object.fromEntries(
    Object.entries(op).filter(([key]) => !unsavedOperationKeys.has(key)),
  ) as ValueOperation<unknown>;
type SavedWire = Omit<SavedGroup, 'graph' | 'scripts'> & {
  declarations: Omit<SavedGrant, 'name'>[];
  graph: PackedGraph;
  scripts: (Omit<SavedGroup['scripts'][number], 'grants'> & {
    grants: { declaration: number; name: string }[];
  })[];
};
const wireOf = (saved: SavedGroup): SavedWire => {
  const declarations: SavedWire['declarations'] = [];
  const seen = new Map<string, number>();
  const scripts = saved.scripts.map(script => ({
    ...script,
    grants: script.grants.map(({ name, ...declaration }) => {
      const key = canonicalJSON(declaration);
      let id = seen.get(key);
      if (id === undefined) {
        id = declarations.length;
        declarations.push(declaration);
        seen.set(key, id);
      }
      return { name, declaration: id };
    }),
  }));
  return {
    ...saved,
    declarations,
    scripts,
    graph: packGraph(saved.graph),
  };
};
// A save's payload, its hash checked.
const readPayload = (bytes: Uint8Array): SavedWire => {
  try {
    const outer = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as { hash: string; payload: SavedWire };
    if (
      !outer.payload ||
      typeof outer.payload !== 'object' ||
      sha256(JSON.stringify(outer.payload)) !== outer.hash
    ) {
      throw new Error('Corrupt save');
    }
    return outer.payload;
  } catch {
    throw new HostError('invalid save');
  }
};
export const decodeGroup = (bytes: Uint8Array): SavedGroup => {
  const saved = readPayload(bytes);
  try {
    if (
      saved.family !== 'odgn-talk-ts' ||
      saved.format !== saveFormatVersion ||
      !/^s[1-9]\d*$/.test(saved.id) ||
      !Array.isArray(saved.scripts) ||
      !Array.isArray(saved.objects) ||
      !Array.isArray(saved.libraries) ||
      !Array.isArray(saved.declarations) ||
      !['embedded', 'external'].includes(saved.sourceMode) ||
      !Array.isArray(saved.graph.nodes)
    ) {
      throw new Error('Unreadable save');
    }
    const names = new Set<string>();
    const scripts = saved.scripts.map(script => {
      if (
        typeof script.name !== 'string' ||
        names.has(script.name) ||
        !Array.isArray(script.identities) ||
        !script.identities.length ||
        script.identities.some(
          id => typeof id !== 'string' || !/^[\da-f]{64}$/.test(id),
        ) ||
        (saved.sourceMode === 'embedded' &&
          (!Array.isArray(script.sources) ||
            script.sources.length !== script.identities.length ||
            script.sources.some(s => typeof s !== 'string'))) ||
        (saved.sourceMode === 'external' && script.sources !== undefined) ||
        !Array.isArray(script.grants)
      ) {
        throw new Error('Invalid saved Script');
      }
      names.add(script.name);
      const grants = new Set<string>();
      return {
        ...script,
        grants: script.grants.map(grant => {
          if (
            typeof grant.name !== 'string' ||
            grants.has(grant.name) ||
            !Number.isSafeInteger(grant.declaration) ||
            grant.declaration < 0 ||
            grant.declaration >= saved.declarations.length
          ) {
            throw new Error('Invalid saved Grant');
          }
          grants.add(grant.name);
          return {
            ...saved.declarations[grant.declaration]!,
            name: grant.name,
          };
        }),
      };
    });
    for (const declaration of saved.declarations) {
      if (
        !declaration ||
        typeof declaration.capability !== 'string' ||
        !Array.isArray(declaration.operations) ||
        declaration.operations.some(
          op =>
            typeof op.name !== 'string' ||
            !op.declaration ||
            typeof op.declaration !== 'object',
        )
      ) {
        throw new Error('Invalid saved declaration');
      }
    }
    return { ...saved, scripts, graph: unpackGraph(saved.graph) };
  } catch {
    throw new HostError('invalid save');
  }
};
