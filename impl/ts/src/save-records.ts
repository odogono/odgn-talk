// The save format's records (spec/data/save-format.toml), as plain data, and
// their bytes. Each reader and writer follows the format's field order; what
// a record means to the TS Core is save-state.ts's. Values go through the
// caller's `ValueIO`, which knows the save's objects and functions.
import { invalidSave as invalid, SaveReader, SaveWriter } from './save-format';

/** How a save's values are written and read. */
export type ValueIO<V> = {
  read(r: SaveReader): V;
  write(w: SaveWriter, v: V): void;
};

export type Instant = { micros: number; seconds: bigint };
export type Issued = {
  ranges: { eligible: boolean; first: number; last: number }[];
  run: string;
};
export type LibraryRecord = {
  identity: Uint8Array;
  name: string;
  version: string;
};
export type ObjectRecord = {
  disposed: boolean;
  id: string;
  kind: string;
  ownerOf: string | undefined;
  parent: number | undefined;
};
export type Unit =
  | { k: 'own' }
  | { extension: number; k: 'extension' }
  | { k: 'library'; library: number }
  | { k: 'stdlib'; name: string };
export type CodePosition = { body: number; unit: Unit };
export type FunctionRecord = {
  body: CodePosition | undefined;
  home: string;
  name: string;
  required: number;
  total: number;
  unit: Uint8Array;
};
export type CallRecord<V> = {
  args: V[];
  atColumn: number;
  atLine: number;
  atPc: number;
  atUnit: string;
  charged: number;
  grant: string;
  id: string;
  now: Instant;
  run: string;
  script: string;
  segment: string;
  start: boolean;
};
export type OperationRecord = {
  args: number;
  command: boolean;
  labels: string[];
  mode: string;
  name: string;
  required: number;
};
export type GrantRecord = {
  capability: string;
  declarations: string;
  disabled: boolean;
  name: string;
  operations: OperationRecord[];
  revoked: boolean;
};
export type ScriptRecord<V> = {
  allocTotal: number;
  debt: number;
  definitions: V[];
  extensions: Uint8Array[];
  faults: number;
  fuelTotal: number;
  grants: GrantRecord[];
  identity: Uint8Array;
  limits: number[];
  name: string;
  objects: { name: string; object: number | undefined }[];
  owner: number | undefined;
  runs: number;
  stopped: string | undefined;
  variableNames: string[];
  variables: V[];
};
export type Override = {
  allocPerRun: number | undefined;
  fuelPerRun: number | undefined;
  maxJoin: number | undefined;
  maxWaitMs: number | undefined;
};
export type DeliveryRecord<V> = {
  args: V[];
  at: number | undefined;
  broadcast: number;
  decides: boolean;
  decision: boolean;
  during: V | undefined;
  from: string | undefined;
  function: V | undefined;
  id: number;
  internalError: boolean;
  limits: Override | undefined;
  message: string;
  passedBy: number | undefined;
  request: boolean;
  root: number;
  target: number | undefined;
  waits: boolean;
};
export type Iterator<V> = {
  left: number;
  position: number;
  subject: V | undefined;
};
export type Reader<V> = { position: number; subject: V };
export type Replacement<V> = {
  matches: V;
  next: number;
  pieces: string;
  position: number;
  spans: [number, number][];
  text: V;
};
/** A slot; a shared internal value is the same object each place it is. */
export type Slot<V> =
  | { k: 'value'; value: V }
  | { it: Iterator<V>; k: 'iterator' }
  | { it: Reader<V>; k: 'reader' }
  | { it: Replacement<V>; k: 'replacement' }
  | { at: bigint; k: 'deadline'; us: bigint };
export type FrameRecord<V> = {
  body: number;
  called: boolean;
  locals: V[];
  pc: number;
  restricted: boolean;
  stack: Slot<V>[];
  unit: Unit;
};
export type Limit = { entry: number; frame: number };
export type SearchRecord = {
  entry: number;
  frame: number;
  limit: Limit | undefined;
  position: number;
  raised: number;
  skip: Limit | undefined;
};
export type CleanupRecord = {
  depth: number;
  entry: number;
  frame: number;
  leave: boolean;
  target: number;
};
export type ThenRecord<V> =
  | { frame: number; k: 'accept'; pc: number; stack: Slot<V>[] }
  | { k: 'end' }
  | { k: 'cancel' }
  | {
      args: V[];
      attempt: number;
      frame: number;
      k: 'transfer';
      limit: Limit | undefined;
      offer: number;
      offerEntry: number;
      record: number;
    }
  | { k: 'search'; search: SearchRecord };
export type ControlRecord<V> =
  | {
      error: V;
      held: FrameRecord<V>[];
      k: 'dispatch';
      owner: number;
      ownerPc: number;
      ownerStack: Slot<V>[];
      place: number;
      search: SearchRecord;
    }
  | {
      cleanups: CleanupRecord[];
      error: V;
      failed: number;
      failedFrame: number | undefined;
      held: FrameRecord<V>[];
      k: 'cleanup';
      left: boolean;
      next: number;
      then: ThenRecord<V>;
    };
export type Failure<V> = {
  code: string;
  data: V | undefined;
  message: string | undefined;
};
export type ResumeRecord<V> =
  | { k: 'none' }
  | { fuel: number; k: 'answer'; value: V }
  | { failure: Failure<V>; k: 'failed' }
  | { detail: string | undefined; k: 'broken' }
  | { k: 'timeout' }
  | { k: 'woke' }
  | { k: 'reply'; value: V }
  | { binds: number; branch: number; k: 'event'; message: V | undefined }
  | { error: V | undefined; k: 'send failed'; reason: string }
  | { k: 'joined' }
  | { k: 'join failed'; member: number }
  | { k: 'unparked' }
  | { k: 'cancelled' }
  | { k: 'lost' }
  | { k: 'limited' }
  | { k: 'revoked' };
export type WaitedRecord = {
  after: bigint;
  block: boolean;
  call: number | undefined;
  declared: boolean;
  grant: string;
  id: string;
  operation: string;
};
export type Branch<V> =
  | { captures: V[]; from: V | undefined; k: 'when' }
  | { at: bigint; k: 'after' };
export type EventRecord<V> = {
  any: boolean;
  branches: Branch<V>[];
  entry: number;
  unit: Unit;
};
export type PendingRecord<V> = {
  after: bigint;
  block: boolean;
  branch: number;
  call: number | undefined;
  deadline: bigint | undefined;
  declared: boolean;
  event: EventRecord<V> | undefined;
  grant: string;
  id: string;
  member: number | undefined;
  operation: string;
  order: number;
};
export type MemberRecord<V> = {
  cut: boolean;
  frame: number;
  pending: PendingRecord<V> | undefined;
  start: number;
  waited: WaitedRecord;
  with: ResumeRecord<V>;
};
export type JoinRecord<V> = {
  frame: number;
  members: MemberRecord<V>[];
  start: number;
};
export type RunRecord<V> = {
  abandoned: string[];
  alloc: number;
  attempts: number;
  base: number;
  calls: number;
  clause: number;
  clauseBody: CodePosition | undefined;
  clauseFuel: number;
  clausesSeen: number;
  cleanupFrom: number | undefined;
  cleanupLimited: boolean;
  continuing: boolean;
  controls: ControlRecord<V>[];
  delivery: DeliveryRecord<V>;
  fallback: boolean;
  frames: FrameRecord<V>[];
  fuel: number;
  handler: string;
  id: string;
  join: JoinRecord<V> | undefined;
  limits: number[];
  order: number;
  parked: boolean;
  preemptedIn: { body: CodePosition; fallback: boolean } | undefined;
  raisedAt: { column: number; line: number } | undefined;
  reportedFuel: number | undefined;
  resumeWith: ResumeRecord<V>;
  segmentAlloc: number;
  segmentBase: V[] | undefined;
  segmentFuel: number;
  segments: number;
  selectAt: number | undefined;
  started: boolean;
  suspendedAt: string;
  verdict: boolean;
  waited: WaitedRecord;
  waiting: PendingRecord<V> | undefined;
};
export type Work<V> =
  { delivery: DeliveryRecord<V>; k: 'message' } | { k: 'run'; run: number };
export type Mark<V> = {
  outcome: string;
  reason: V | undefined;
  run: string;
  script: string;
};
export type Part<V> =
  | { k: 'none' }
  | { k: 'allowed' }
  | { k: 'vetoed'; mark: Mark<V> }
  | { k: 'undecided'; mark: Mark<V> };
export type OpenBroadcast<V> = {
  id: number;
  parts: { delivery: number; part: Part<V> }[];
};
export type Deferred<V> = {
  broadcast: number;
  id: number;
  mark: Mark<V> | undefined;
};
export type Input<V> =
  | { how: number; id: string; k: 'settlement'; with: ResumeRecord<V> }
  | { delivery: DeliveryRecord<V>; k: 'deliver'; script: string }
  | { k: 'set parent'; object: number | undefined; parent: number | undefined }
  | { k: 'dispose'; object: number | undefined }
  | { id: string; k: 'settle'; with: ResumeRecord<V> }
  | {
      args: V[];
      decision: boolean;
      id: number;
      k: 'broadcast';
      limits: Override | undefined;
      message: string;
    }
  | { grant: string; k: 'revoke'; script: string }
  | { k: 'cancel run'; run: string }
  | { k: 'rewind run'; run: string }
  | { k: 'stop'; reason: string; script: string }
  | { delivery: number; k: 'cancel delivery' }
  | { broadcast: number; k: 'cancel broadcast' };

export type GroupRecord = {
  broadcasts: number;
  chargeCounter: number;
  clock: Instant;
  deliveries: number;
  issued: Issued[];
  name: string;
  randomState: bigint;
  runOrder: number;
  timers: number;
};

/** Every section's records. */
export type SaveRecords<V> = {
  calls: CallRecord<V>[];
  changedRoots: number[];
  decisions: { deferred: Deferred<V>[]; open: OpenBroadcast<V>[] };
  discards: { discarded: number; root: number }[];
  functions: FunctionRecord[];
  group: GroupRecord;
  inputs: Input<V>[];
  libraries: LibraryRecord[];
  objects: ObjectRecord[];
  perScript: number[];
  runs: RunRecord<V>[];
  scripts: ScriptRecord<V>[];
  sources: { extensions: string[]; source: string }[] | undefined;
  waits: { member: number | undefined; run: number }[];
  work: Work<V>[][];
};

const resumeTags = [
  'none',
  'answer',
  'failed',
  'broken',
  'timeout',
  'woke',
  'reply',
  'event',
  'send failed',
  'joined',
  'join failed',
  'unparked',
  'cancelled',
  'lost',
  'limited',
  'revoked',
] as const;
const inputTags = [
  'settlement',
  'deliver',
  'set parent',
  'dispose',
  'settle',
  'broadcast',
  'revoke',
  'cancel run',
  'rewind run',
  'stop',
  'cancel delivery',
  'cancel broadcast',
] as const;

// ------------------------------------------------------------------ writing

/**
 * Writes records' fields. One per save: shared internal values are written
 * in full once, then by their place.
 */
const latin1 = new TextDecoder('latin1');

/** An Operation's modes, by their byte. */
const modes = ['immediate', 'suspending', 'fire-and-forget'];
/** A Mark's outcomes, by their byte. */
const outcomes = [
  'vetoed',
  'errored',
  'limit fault',
  'cancelled',
  'dropped',
  'stopped',
];
const enumByte = (vocabulary: readonly string[], s: string) => {
  const b = vocabulary.indexOf(s);
  if (b < 0) {
    throw new Error(`Not in the save format's vocabulary: ${s}`);
  }
  return b;
};
const modeByte = (mode: string) => enumByte(modes, mode);
const outcomeByte = (outcome: string) => enumByte(outcomes, outcome);

/**
 * A table of entries, each written once: an entry whose bytes equal an
 * earlier one's is that one. Returns each item's index and writes the table.
 */
const shared = <T>(
  w: SaveWriter,
  items: readonly T[],
  encode: (w: SaveWriter, item: T) => void,
): number[] => {
  const seen = new Map<string, number>();
  const entries: Uint8Array[] = [];
  const at = items.map(item => {
    const e = new SaveWriter(w.names);
    encode(e, item);
    const bytes = e.finish();
    const key = latin1.decode(bytes);
    let i = seen.get(key);
    if (i === undefined) {
      i = entries.length;
      seen.set(key, i);
      entries.push(bytes);
    }
    return i;
  });
  w.uint(entries.length);
  for (const e of entries) {
    w.raw(e);
  }
  return at;
};

export class RecordWriter<V> {
  private iterators = new Map<object, number>();
  private readers = new Map<object, number>();
  private replacements = new Map<object, number>();

  constructor(
    readonly w: SaveWriter,
    readonly values: ValueIO<V>,
  ) {}

  value(v: V) {
    this.values.write(this.w, v);
  }
  list(vs: readonly V[]) {
    this.w.list(vs, (_, v) => this.value(v));
  }
  optValue(v: V | undefined) {
    this.w.optional(v, (_, x) => this.value(x));
  }
  optName(s: string | undefined) {
    this.w.optional(s, (w, x) => w.name(x));
  }
  optText(s: string | undefined) {
    this.w.optional(s, (w, x) => w.text(x));
  }
  optUint(n: number | undefined) {
    this.w.optional(n, (w, x) => w.uint(x));
  }
  instant(t: Instant) {
    this.w.sint(t.seconds).uint(t.micros);
  }

  unit(u: Unit) {
    const w = this.w;
    switch (u.k) {
      case 'own':
        w.byte(0);
        break;
      case 'extension':
        w.byte(1).uint(u.extension);
        break;
      case 'library':
        w.byte(2).index(u.library);
        break;
      case 'stdlib':
        w.byte(3).name(u.name);
        break;
    }
  }
  position(p: CodePosition) {
    this.unit(p.unit);
    this.w.uint(p.body);
  }

  limits(l: readonly number[]) {
    this.w.list(l, (w, n) => w.uint(n));
  }

  override(o: Override | undefined) {
    this.w.optional(o, (_, x) => {
      this.optUint(x.fuelPerRun);
      this.optUint(x.allocPerRun);
      this.optUint(x.maxWaitMs);
      this.optUint(x.maxJoin);
    });
  }

  delivery(d: DeliveryRecord<V>) {
    const w = this.w;
    w.uint(d.id).uint(d.root).name(d.message);
    this.list(d.args);
    w.bool(d.request);
    this.optValue(d.during);
    this.optName(d.from);
    w.bool(d.internalError).bool(d.waits).ref(d.target).ref(d.at);
    this.optValue(d.function);
    w.bool(d.decision).bool(d.decides).uint(d.broadcast);
    this.override(d.limits);
    w.ref(d.passedBy);
  }

  slots(stack: readonly Slot<V>[]) {
    const w = this.w;
    w.uint(stack.length);
    for (const slot of stack) {
      switch (slot.k) {
        case 'value':
          w.byte(0);
          this.value(slot.value);
          break;
        case 'iterator': {
          w.byte(1);
          const at = this.iterators.get(slot.it);
          w.ref(at);
          if (at === undefined) {
            this.iterators.set(slot.it, this.iterators.size);
            this.optValue(slot.it.subject);
            w.uint(slot.it.position).uint(slot.it.left);
          }
          break;
        }
        case 'reader': {
          w.byte(2);
          const at = this.readers.get(slot.it);
          w.ref(at);
          if (at === undefined) {
            this.readers.set(slot.it, this.readers.size);
            this.value(slot.it.subject);
            w.uint(slot.it.position);
          }
          break;
        }
        case 'replacement': {
          w.byte(3);
          const at = this.replacements.get(slot.it);
          w.ref(at);
          if (at === undefined) {
            const x = slot.it;
            this.replacements.set(x, this.replacements.size);
            this.value(x.text);
            this.value(x.matches);
            w.list(x.spans, (w, [a, b]) => w.uint(a).uint(b));
            w.uint(x.next).uint(x.position).text(x.pieces);
          }
          break;
        }
        case 'deadline':
          w.byte(4).wideSint(slot.at).wideSint(slot.us);
          break;
      }
    }
  }

  frames(fs: readonly FrameRecord<V>[]) {
    this.w.uint(fs.length);
    for (const f of fs) {
      this.unit(f.unit);
      this.w.uint(f.body).uint(f.pc);
      this.list(f.locals);
      this.slots(f.stack);
      this.w.bool(f.called).bool(f.restricted);
    }
  }

  limit(l: Limit | undefined) {
    this.w.optional(l, (w, x) => w.uint(x.frame).uint(x.entry));
  }
  search(s: SearchRecord) {
    this.w.uint(s.frame).uint(s.entry).uint(s.raised);
    this.limit(s.limit);
    this.w.uint(s.position);
    this.limit(s.skip);
  }

  control(c: ControlRecord<V>) {
    const w = this.w;
    if (c.k === 'dispatch') {
      w.byte(0);
      this.value(c.error);
      w.uint(c.owner).uint(c.place);
      this.frames(c.held);
      this.slots(c.ownerStack);
      w.uint(c.ownerPc);
      this.search(c.search);
      return;
    }
    w.byte(1);
    this.value(c.error);
    w.list(c.cleanups, (w, x) =>
      w.uint(x.frame).uint(x.target).uint(x.depth).uint(x.entry).bool(x.leave),
    );
    w.uint(c.next).bool(c.left).uint(c.failed);
    this.optUint(c.failedFrame);
    this.frames(c.held);
    const t = c.then;
    switch (t.k) {
      case 'accept':
        w.byte(0).uint(t.frame).uint(t.pc);
        this.slots(t.stack);
        break;
      case 'end':
        w.byte(1);
        break;
      case 'cancel':
        w.byte(2);
        break;
      case 'transfer':
        w.byte(3).uint(t.frame).uint(t.offerEntry).uint(t.record).uint(t.offer);
        this.list(t.args);
        w.uint(t.attempt);
        this.limit(t.limit);
        break;
      case 'search':
        w.byte(4);
        this.search(t.search);
        break;
    }
  }

  resume(r: ResumeRecord<V>) {
    const w = this.w;
    w.byte(resumeTags.indexOf(r.k));
    switch (r.k) {
      case 'answer':
        this.value(r.value);
        w.uint(r.fuel);
        break;
      case 'failed':
        w.name(r.failure.code);
        this.optName(r.failure.message);
        this.optValue(r.failure.data);
        break;
      case 'broken':
        this.optText(r.detail);
        break;
      case 'reply':
        this.value(r.value);
        break;
      case 'event':
        this.optValue(r.message);
        w.uint(r.branch).uint(r.binds);
        break;
      case 'send failed':
        w.text(r.reason);
        this.optValue(r.error);
        break;
      case 'join failed':
        w.uint(r.member);
        break;
      default:
    }
  }

  waited(x: WaitedRecord) {
    this.w
      .name(x.id)
      .bool(x.block)
      .ref(x.call)
      .name(x.grant)
      .name(x.operation)
      .bool(x.declared)
      .wideSint(x.after);
  }

  pending(p: PendingRecord<V> | undefined) {
    const w = this.w;
    w.bool(p !== undefined);
    if (!p) {
      return;
    }
    w.name(p.id);
    w.optional(p.deadline, (w, d) => w.wideSint(d));
    w.uint(p.order)
      .ref(p.call)
      .name(p.grant)
      .name(p.operation)
      .bool(p.declared)
      .wideSint(p.after)
      .ref(p.member)
      .bool(p.block)
      .uint(p.branch);
    w.optional(p.event, (w, e) => {
      this.unit(e.unit);
      w.uint(e.entry).bool(e.any).uint(e.branches.length);
      for (const b of e.branches) {
        if (b.k === 'when') {
          w.byte(0);
          this.optValue(b.from);
          this.list(b.captures);
        } else {
          w.byte(1).wideSint(b.at);
        }
      }
    });
  }

  run(r: RunRecord<V>, base: number | undefined) {
    const w = this.w;
    w.name(r.id).uint(r.order);
    this.optUint(r.reportedFuel);
    w.uint(r.fuel).uint(r.alloc);
    this.delivery(r.delivery);
    w.name(r.handler).uint(r.clause);
    this.limits(r.limits);
    w.uint(r.clauseFuel);
    w.optional(r.preemptedIn, (w, p) => {
      this.position(p.body);
      w.bool(p.fallback);
    });
    w.bool(r.continuing).uint(r.clausesSeen);
    this.optUint(r.cleanupFrom);
    w.bool(r.cleanupLimited).uint(r.controls.length);
    for (const c of r.controls) {
      this.control(c);
    }
    w.uint(r.attempts)
      .uint(r.calls)
      .uint(r.segmentFuel)
      .uint(r.segmentAlloc)
      .bool(r.started);
    this.pending(r.waiting);
    this.resume(r.resumeWith);
    w.name(r.suspendedAt);
    this.waited(r.waited);
    w.optional(r.raisedAt, (w, p) => w.uint(p.line).uint(p.column));
    w.optional(r.join, (w, j) => {
      w.uint(j.frame).uint(j.start).uint(j.members.length);
      for (const m of j.members) {
        w.uint(m.frame).uint(m.start);
        this.pending(m.pending);
        this.waited(m.waited);
        this.resume(m.with);
        w.bool(m.cut);
      }
    });
    w.optional(r.clauseBody, (_, p) => this.position(p));
    w.bool(r.fallback);
    this.optUint(r.selectAt);
    w.bool(r.parked);
    w.list(r.abandoned, (w, id) => w.name(id));
    w.uint(r.base).uint(r.segments).bool(r.verdict);
    w.ref(base);
    this.frames(r.frames);
  }

  mark(m: Mark<V>) {
    this.w.name(m.script).name(m.run);
    this.optValue(m.reason);
    this.w.byte(outcomeByte(m.outcome));
  }

  input(x: Input<V>) {
    const w = this.w;
    w.byte(inputTags.indexOf(x.k));
    switch (x.k) {
      case 'settlement':
        w.name(x.id).byte(x.how);
        this.resume(x.with);
        break;
      case 'deliver':
        w.name(x.script);
        this.delivery(x.delivery);
        break;
      case 'set parent':
        w.ref(x.object).ref(x.parent);
        break;
      case 'dispose':
        w.ref(x.object);
        break;
      case 'settle':
        w.name(x.id);
        this.resume(x.with);
        break;
      case 'broadcast':
        w.uint(x.id).name(x.message);
        this.list(x.args);
        w.bool(x.decision);
        this.override(x.limits);
        break;
      case 'revoke':
        w.name(x.script).name(x.grant);
        break;
      case 'cancel run':
      case 'rewind run':
        w.name(x.run);
        break;
      case 'stop':
        w.name(x.script).name(x.reason);
        break;
      case 'cancel delivery':
        w.uint(x.delivery);
        break;
      case 'cancel broadcast':
        w.uint(x.broadcast);
        break;
    }
  }

  // ---- sections

  group(g: GroupRecord) {
    const w = this.w;
    w.text(g.name);
    this.instant(g.clock);
    w.uint(g.deliveries)
      .uint(g.broadcasts)
      .uint(g.timers)
      .uint(g.runOrder)
      .uint(g.chargeCounter)
      .uint(g.randomState);
    w.list(g.issued, (w, x) =>
      w
        .name(x.run)
        .list(x.ranges, (w, r) =>
          w.uint(r.first).uint(r.last).bool(r.eligible),
        ),
    );
  }

  libraries(ls: readonly LibraryRecord[]) {
    this.w.list(ls, (w, l) =>
      w.name(l.name).name(l.version).digest(l.identity),
    );
  }

  objects(os: readonly ObjectRecord[]) {
    this.w.list(os, (w, o) => {
      w.name(o.kind).name(o.id).ref(o.parent).bool(o.disposed);
      this.optName(o.ownerOf);
    });
  }

  functions(fs: readonly FunctionRecord[]) {
    this.w.list(fs, (w, f) => {
      w.name(f.home).name(f.name).uint(f.required).uint(f.total).digest(f.unit);
      w.optional(f.body, (_, p) => this.position(p));
    });
  }

  calls(cs: readonly CallRecord<V>[]) {
    this.w.list(cs, (w, c) => {
      w.name(c.id).name(c.script).name(c.grant).name(c.run).name(c.segment);
      this.instant(c.now);
      this.list(c.args);
      w.bool(c.start)
        .uint(c.charged)
        .name(c.atUnit)
        .uint(c.atPc)
        .uint(c.atLine)
        .uint(c.atColumn);
    });
  }

  scripts(ss: readonly ScriptRecord<V>[]) {
    const declarations = shared(
      this.w,
      ss.flatMap(s => s.grants),
      (w, g) => {
        w.text(g.declarations).name(g.capability);
        w.list(g.operations, (w, op) =>
          w
            .name(op.name)
            .byte(modeByte(op.mode))
            .uint(op.required)
            .uint(op.args)
            .bool(op.command)
            .list(op.labels, (w, l) => w.name(l)),
        );
      },
    );
    let next = 0;
    this.w.list(ss, (w, s) => {
      w.name(s.name).digest(s.identity);
      w.list(s.extensions, (w, e) => w.digest(e));
      this.limits(s.limits);
      w.list(s.grants, (w, g) => {
        w.name(g.name).index(declarations[next++]!);
        w.bool(g.revoked).bool(g.disabled);
      });
      w.ref(s.owner);
      w.list(s.objects, (w, o) => w.name(o.name).ref(o.object));
      w.list(s.variableNames, (w, n) => w.name(n));
      this.list(s.variables);
      this.list(s.definitions);
      w.uint(s.runs)
        .uint(s.fuelTotal)
        .uint(s.allocTotal)
        .uint(s.faults)
        .uint(s.debt);
      this.optName(s.stopped);
    });
  }

  runs(perScript: readonly number[], runs: readonly RunRecord<V>[]) {
    this.w.list(perScript, (w, n) => w.uint(n));
    // Writing a repeated base meets no new Function Value.
    const withBase = runs.filter(r => r.segmentBase !== undefined);
    const at = shared(this.w, withBase, (w, r) =>
      w.list(r.segmentBase!, (w, v) => this.values.write(w, v)),
    );
    const bases = new Map(withBase.map((r, i) => [r, at[i]!]));
    this.w.uint(runs.length);
    for (const r of runs) {
      this.run(r, bases.get(r));
    }
  }

  work(work: readonly Work<V>[][]) {
    this.w.list(work, (w, items) =>
      w.list(items, (w, x) => {
        if (x.k === 'message') {
          w.byte(0);
          this.delivery(x.delivery);
        } else {
          w.byte(1).index(x.run);
        }
      }),
    );
  }

  waits(ws: readonly { member: number | undefined; run: number }[]) {
    this.w.list(ws, (w, x) => w.index(x.run).ref(x.member));
  }

  inputs(xs: readonly Input<V>[]) {
    this.w.uint(xs.length);
    for (const x of xs) {
      this.input(x);
    }
  }

  decisions(d: SaveRecords<V>['decisions']) {
    const w = this.w;
    w.list(d.open, (w, o) => {
      w.uint(o.id).uint(o.parts.length);
      for (const p of o.parts) {
        w.uint(p.delivery);
        switch (p.part.k) {
          case 'none':
            w.byte(0);
            break;
          case 'allowed':
            w.byte(1);
            break;
          case 'vetoed':
            w.byte(2);
            this.mark(p.part.mark);
            break;
          case 'undecided':
            w.byte(3);
            this.mark(p.part.mark);
            break;
        }
      }
    });
    w.list(d.deferred, (w, x) => {
      w.uint(x.id).uint(x.broadcast);
      w.optional(x.mark, (_, m) => this.mark(m));
    });
  }

  accounting(
    discards: readonly { discarded: number; root: number }[],
    changed: readonly number[],
  ) {
    this.w.list(discards, (w, x) => w.uint(x.root).uint(x.discarded));
    this.w.list(changed, (w, n) => w.uint(n));
  }

  sources(ss: readonly { extensions: string[]; source: string }[]) {
    this.w.list(ss, (w, s) =>
      w.text(s.source).list(s.extensions, (w, e) => w.text(e)),
    );
  }
}

// ------------------------------------------------------------------ reading

/** The sizes a section's references are checked against. */
export type Tables = {
  calls: number;
  libraries: number;
  objects: number;
  runs: number;
};

export class RecordReader<V> {
  private iterators: Iterator<V>[] = [];
  private readers: Reader<V>[] = [];
  private replacements: Replacement<V>[] = [];

  constructor(
    public r: SaveReader,
    readonly values: ValueIO<V>,
    readonly tables: Tables,
  ) {}

  /** The `runs` section's segment bases, each read once. */
  private bases: V[][] = [];

  value(): V {
    return this.values.read(this.r);
  }
  list(): V[] {
    return this.r.list(() => this.value());
  }
  optValue(): V | undefined {
    return this.r.optional(() => this.value());
  }
  optName(): string | undefined {
    return this.r.optional(r => r.name());
  }
  optText(): string | undefined {
    return this.r.optional(r => r.text());
  }
  optUint(): number | undefined {
    return this.r.optional(r => r.uint());
  }
  instant(): Instant {
    const seconds = this.r.bigSint();
    const micros = this.r.uint();
    return micros >= 1_000_000 ? invalid() : { seconds, micros };
  }
  object(): number | undefined {
    return this.r.ref(this.tables.objects);
  }

  unit(): Unit {
    const r = this.r;
    switch (r.byte()) {
      case 0:
        return { k: 'own' };
      case 1:
        return { k: 'extension', extension: r.uint() };
      case 2:
        return { k: 'library', library: r.index(this.tables.libraries) };
      case 3:
        return { k: 'stdlib', name: r.name() };
      default:
        return invalid();
    }
  }
  position(): CodePosition {
    return { unit: this.unit(), body: this.r.uint() };
  }
  limits(): number[] {
    return this.r.list(r => r.uint());
  }
  override(): Override | undefined {
    return this.r.optional(() => ({
      fuelPerRun: this.optUint(),
      allocPerRun: this.optUint(),
      maxWaitMs: this.optUint(),
      maxJoin: this.optUint(),
    }));
  }

  delivery(): DeliveryRecord<V> {
    const r = this.r;
    return {
      id: r.uint(),
      root: r.uint(),
      message: r.name(),
      args: this.list(),
      request: r.bool(),
      during: this.optValue(),
      from: this.optName(),
      internalError: r.bool(),
      waits: r.bool(),
      target: this.object(),
      at: this.object(),
      function: this.optValue(),
      decision: r.bool(),
      decides: r.bool(),
      broadcast: r.uint(),
      limits: this.override(),
      passedBy: this.object(),
    };
  }

  slots(): Slot<V>[] {
    const r = this.r;
    return r.list(() => {
      switch (r.byte()) {
        case 0:
          return { k: 'value', value: this.value() } as const;
        case 1: {
          const at = r.ref(this.iterators.length);
          if (at !== undefined) {
            return { k: 'iterator', it: this.iterators[at]! } as const;
          }
          const it = {
            subject: this.optValue(),
            position: r.uint(),
            left: r.uint(),
          };
          this.iterators.push(it);
          return { k: 'iterator', it } as const;
        }
        case 2: {
          const at = r.ref(this.readers.length);
          if (at !== undefined) {
            return { k: 'reader', it: this.readers[at]! } as const;
          }
          const it = { subject: this.value(), position: r.uint() };
          this.readers.push(it);
          return { k: 'reader', it } as const;
        }
        case 3: {
          const at = r.ref(this.replacements.length);
          if (at !== undefined) {
            return { k: 'replacement', it: this.replacements[at]! } as const;
          }
          const it = {
            text: this.value(),
            matches: this.value(),
            spans: r.list(r => [r.uint(), r.uint()] as [number, number]),
            next: r.uint(),
            position: r.uint(),
            pieces: r.text(),
          };
          this.replacements.push(it);
          return { k: 'replacement', it } as const;
        }
        case 4:
          return {
            k: 'deadline',
            at: r.wideSint(140),
            us: r.wideSint(140),
          } as const;
        default:
          return invalid();
      }
    });
  }

  frames(): FrameRecord<V>[] {
    const r = this.r;
    return r.list(() => ({
      unit: this.unit(),
      body: r.uint(),
      pc: r.uint(),
      locals: this.list(),
      stack: this.slots(),
      called: r.bool(),
      restricted: r.bool(),
    }));
  }

  limit(): Limit | undefined {
    return this.r.optional(r => ({ frame: r.uint(), entry: r.uint() }));
  }
  search(): SearchRecord {
    const r = this.r;
    return {
      frame: r.uint(),
      entry: r.uint(),
      raised: r.uint(),
      limit: this.limit(),
      position: r.uint(),
      skip: this.limit(),
    };
  }

  control(): ControlRecord<V> {
    const r = this.r;
    switch (r.byte()) {
      case 0:
        return {
          k: 'dispatch',
          error: this.value(),
          owner: r.uint(),
          place: r.uint(),
          held: this.frames(),
          ownerStack: this.slots(),
          ownerPc: r.uint(),
          search: this.search(),
        };
      case 1: {
        const error = this.value();
        const cleanups = r.list(r => ({
          frame: r.uint(),
          target: r.uint(),
          depth: r.uint(),
          entry: r.uint(),
          leave: r.bool(),
        }));
        const next = r.uint();
        if (next > cleanups.length) {
          invalid();
        }
        const left = r.bool();
        const failed = r.uint();
        const failedFrame = this.optUint();
        const held = this.frames();
        let then: ThenRecord<V>;
        switch (r.byte()) {
          case 0:
            then = {
              k: 'accept',
              frame: r.uint(),
              pc: r.uint(),
              stack: this.slots(),
            };
            break;
          case 1:
            then = { k: 'end' };
            break;
          case 2:
            then = { k: 'cancel' };
            break;
          case 3:
            then = {
              k: 'transfer',
              frame: r.uint(),
              offerEntry: r.uint(),
              record: r.uint(),
              offer: r.uint(),
              args: this.list(),
              attempt: r.uint(),
              limit: this.limit(),
            };
            break;
          case 4:
            then = { k: 'search', search: this.search() };
            break;
          default:
            return invalid();
        }
        return {
          k: 'cleanup',
          error,
          cleanups,
          next,
          left,
          failed,
          failedFrame,
          held,
          then,
        };
      }
      default:
        return invalid();
    }
  }

  resume(): ResumeRecord<V> {
    const r = this.r;
    const k = resumeTags[r.byte()] ?? invalid();
    switch (k) {
      case 'answer':
        return { k, value: this.value(), fuel: r.uint() };
      case 'failed':
        return {
          k,
          failure: {
            code: r.name(),
            message: this.optName(),
            data: this.optValue(),
          },
        };
      case 'broken':
        return { k, detail: this.optText() };
      case 'reply':
        return { k, value: this.value() };
      case 'event':
        return {
          k,
          message: this.optValue(),
          branch: r.uint(),
          binds: r.uint(),
        };
      case 'send failed':
        return { k, reason: r.text(), error: this.optValue() };
      case 'join failed':
        return { k, member: r.uint() };
      default:
        return { k };
    }
  }

  waited(): WaitedRecord {
    const r = this.r;
    return {
      id: r.name(),
      block: r.bool(),
      call: r.ref(this.tables.calls),
      grant: r.name(),
      operation: r.name(),
      declared: r.bool(),
      after: r.wideSint(140),
    };
  }

  pending(): PendingRecord<V> | undefined {
    const r = this.r;
    if (!r.bool()) {
      return undefined;
    }
    return {
      id: r.name(),
      deadline: r.optional(r => r.wideSint(140)),
      order: r.uint(),
      call: r.ref(this.tables.calls),
      grant: r.name(),
      operation: r.name(),
      declared: r.bool(),
      after: r.wideSint(140),
      member: r.ref(Number.MAX_SAFE_INTEGER),
      block: r.bool(),
      branch: r.uint(),
      event: r.optional(() => ({
        unit: this.unit(),
        entry: r.uint(),
        any: r.bool(),
        branches: r.list((): Branch<V> => {
          switch (r.byte()) {
            case 0:
              return {
                k: 'when',
                from: this.optValue(),
                captures: this.list(),
              };
            case 1:
              return { k: 'after', at: r.wideSint(140) };
            default:
              return invalid();
          }
        }),
      })),
    };
  }

  run(): RunRecord<V> {
    const r = this.r;
    const id = r.name();
    const order = r.uint();
    const reportedFuel = this.optUint();
    const fuel = r.uint();
    const alloc = r.uint();
    const delivery = this.delivery();
    const handler = r.name();
    const clause = r.uint();
    const limits = this.limits();
    const clauseFuel = r.uint();
    const preemptedIn = r.optional(() => ({
      body: this.position(),
      fallback: r.bool(),
    }));
    const continuing = r.bool();
    const clausesSeen = r.uint();
    const cleanupFrom = this.optUint();
    const cleanupLimited = r.bool();
    const controls = r.list(() => this.control());
    const attempts = r.uint();
    const calls = r.uint();
    const segmentFuel = r.uint();
    const segmentAlloc = r.uint();
    const started = r.bool();
    const waiting = this.pending();
    const resumeWith = this.resume();
    const suspendedAt = r.name();
    const waited = this.waited();
    const raisedAt = r.optional(r => ({ line: r.uint(), column: r.uint() }));
    const join = r.optional(() => ({
      frame: r.uint(),
      start: r.uint(),
      members: r.list(() => ({
        frame: r.uint(),
        start: r.uint(),
        pending: this.pending(),
        waited: this.waited(),
        with: this.resume(),
        cut: r.bool(),
      })),
    }));
    const clauseBody = r.optional(() => this.position());
    const fallback = r.bool();
    const selectAt = this.optUint();
    const parked = r.bool();
    const abandoned = r.list(r => r.name());
    const base = r.uint();
    const segments = r.uint();
    const verdict = r.bool();
    const at = r.ref(this.bases.length);
    const segmentBase = at === undefined ? undefined : this.bases[at];
    const frames = this.frames();
    return {
      id,
      order,
      reportedFuel,
      fuel,
      alloc,
      delivery,
      handler,
      clause,
      limits,
      clauseFuel,
      preemptedIn,
      continuing,
      clausesSeen,
      cleanupFrom,
      cleanupLimited,
      controls,
      attempts,
      calls,
      segmentFuel,
      segmentAlloc,
      started,
      waiting,
      resumeWith,
      suspendedAt,
      waited,
      raisedAt,
      join,
      clauseBody,
      fallback,
      selectAt,
      parked,
      abandoned,
      base,
      segments,
      verdict,
      segmentBase,
      frames,
    };
  }

  mark(): Mark<V> {
    const r = this.r;
    return {
      script: r.name(),
      run: r.name(),
      reason: this.optValue(),
      outcome: outcomes[r.enumByte(outcomes.length)]!,
    };
  }

  input(): Input<V> {
    const r = this.r;
    const k = inputTags[r.byte()] ?? invalid();
    switch (k) {
      case 'settlement': {
        const id = r.name();
        const how = r.byte();
        return how > 3 ? invalid() : { k, id, how, with: this.resume() };
      }
      case 'deliver':
        return { k, script: r.name(), delivery: this.delivery() };
      case 'set parent':
        return { k, object: this.object(), parent: this.object() };
      case 'dispose':
        return { k, object: this.object() };
      case 'settle':
        return { k, id: r.name(), with: this.resume() };
      case 'broadcast':
        return {
          k,
          id: r.uint(),
          message: r.name(),
          args: this.list(),
          decision: r.bool(),
          limits: this.override(),
        };
      case 'revoke':
        return { k, script: r.name(), grant: r.name() };
      case 'cancel run':
      case 'rewind run':
        return { k, run: r.name() };
      case 'stop':
        return { k, script: r.name(), reason: r.name() };
      case 'cancel delivery':
        return { k, delivery: r.uint() };
      case 'cancel broadcast':
        return { k, broadcast: r.uint() };
    }
  }

  // ---- sections

  group(): GroupRecord {
    const r = this.r;
    return {
      name: r.text(),
      clock: this.instant(),
      deliveries: r.uint(),
      broadcasts: r.uint(),
      timers: r.uint(),
      runOrder: r.uint(),
      chargeCounter: r.uint(),
      randomState: r.bigUint(),
      issued: r.list(r => ({
        run: r.name(),
        ranges: r.list(r => ({
          first: r.uint(),
          last: r.uint(),
          eligible: r.bool(),
        })),
      })),
    };
  }

  libraries(): LibraryRecord[] {
    return this.r.list(r => ({
      name: r.name(),
      version: r.name(),
      identity: r.digest(),
    }));
  }

  /** Objects, each parent an object before or after it. */
  objects(): ObjectRecord[] {
    const r = this.r;
    const n = r.count();
    const out: ObjectRecord[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        kind: r.name(),
        id: r.name(),
        parent: r.ref(n),
        disposed: r.bool(),
        ownerOf: this.optName(),
      });
    }
    return out;
  }

  functions(): FunctionRecord[] {
    return this.r.list(r => ({
      home: r.name(),
      name: r.name(),
      required: r.uint(),
      total: r.uint(),
      unit: r.digest(),
      body: r.optional(() => this.position()),
    }));
  }

  calls(): CallRecord<V>[] {
    return this.r.list(r => ({
      id: r.name(),
      script: r.name(),
      grant: r.name(),
      run: r.name(),
      segment: r.name(),
      now: this.instant(),
      args: this.list(),
      start: r.bool(),
      charged: r.uint(),
      atUnit: r.name(),
      atPc: r.uint(),
      atLine: r.uint(),
      atColumn: r.uint(),
    }));
  }

  scripts(): ScriptRecord<V>[] {
    const declarations = this.r.list(r => ({
      declarations: r.text(),
      capability: r.name(),
      operations: r.list(r => ({
        name: r.name(),
        mode: modes[r.enumByte(modes.length)]!,
        required: r.uint(),
        args: r.uint(),
        command: r.bool(),
        labels: r.list(r => r.name()),
      })),
    }));
    return this.r.list(r => ({
      name: r.name(),
      identity: r.digest(),
      extensions: r.list(r => r.digest()),
      limits: this.limits(),
      grants: r.list(r => ({
        name: r.name(),
        ...declarations[r.index(declarations.length)]!,
        revoked: r.bool(),
        disabled: r.bool(),
      })),
      owner: this.object(),
      objects: r.list(r => ({ name: r.name(), object: this.object() })),
      variableNames: r.list(r => r.name()),
      variables: this.list(),
      definitions: this.list(),
      runs: r.uint(),
      fuelTotal: r.uint(),
      allocTotal: r.uint(),
      faults: r.uint(),
      debt: r.uint(),
      stopped: this.optName(),
    }));
  }

  runs(): { perScript: number[]; runs: RunRecord<V>[] } {
    const perScript = this.r.list(r => r.uint());
    this.bases = this.r.list(() => this.list());
    const runs = this.r.list(() => this.run());
    return { perScript, runs };
  }

  work(): Work<V>[][] {
    return this.r.list(r =>
      r.list((): Work<V> => {
        switch (r.byte()) {
          case 0:
            return { k: 'message', delivery: this.delivery() };
          case 1:
            return { k: 'run', run: r.index(this.tables.runs) };
          default:
            return invalid();
        }
      }),
    );
  }

  waits(): { member: number | undefined; run: number }[] {
    return this.r.list(r => ({
      run: r.index(this.tables.runs),
      member: r.ref(Number.MAX_SAFE_INTEGER),
    }));
  }

  inputs(): Input<V>[] {
    return this.r.list(() => this.input());
  }

  decisions(): SaveRecords<V>['decisions'] {
    const r = this.r;
    const open = r.list(r => ({
      id: r.uint(),
      parts: r.list(r => {
        const delivery = r.uint();
        let part: Part<V>;
        switch (r.byte()) {
          case 0:
            part = { k: 'none' };
            break;
          case 1:
            part = { k: 'allowed' };
            break;
          case 2:
            part = { k: 'vetoed', mark: this.mark() };
            break;
          case 3:
            part = { k: 'undecided', mark: this.mark() };
            break;
          default:
            return invalid();
        }
        return { delivery, part };
      }),
    }));
    const deferred = r.list(r => ({
      id: r.uint(),
      broadcast: r.uint(),
      mark: r.optional(() => this.mark()),
    }));
    return { open, deferred };
  }

  accounting(): Pick<SaveRecords<V>, 'changedRoots' | 'discards'> {
    const discards = this.r.list(r => ({
      root: r.uint(),
      discarded: r.uint(),
    }));
    const changedRoots = this.r.list(r => r.uint());
    return { discards, changedRoots };
  }

  sources(): { extensions: string[]; source: string }[] {
    return this.r.list(r => ({
      source: r.text(),
      extensions: r.list(r => r.text()),
    }));
  }
}
