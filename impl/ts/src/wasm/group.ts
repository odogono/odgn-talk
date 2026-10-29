// A Group on its own guest, behind talk.ts's Group and Script interfaces.
// The guest owns scheduling, Runs, Fuel and the Trace; Grant bindings, Host
// Objects' natives, Operation functions, lifecycle hooks and futures stay
// here, as chapter 9's message layer rules say.
import {
  type Call,
  type ChargeRequest,
  type ChargeResult,
  type EffectResult,
  type Grant,
  type ValueOperation,
  type ReleaseReason,
  type SegmentLifecycle,
} from '../capabilities';
import { fromBase64, toBase64 } from '../base64';
import { CallMeter } from '../call-meter';
import { invoke, type Group, type Script } from '../embedding';
import { trackOperation } from '../operation-promises';
import { formatInstant, parseInstant } from '../dates';
import {
  HostError,
  ScriptError,
  sendFailed,
  type HostErrorCode,
} from '../errors';
import { limitDefaults } from '../generated/machine';
import type {
  CancellationOptions,
  CarryOver,
  Counters,
  Decided,
  Deciding,
  EffectFailure,
  Inspection,
  LoadOptions,
  Message,
  PendingCall,
  PumpOptions,
  PumpResult,
  Report,
  Requested,
  PumpedRequest,
  RestoreOptions,
  RestoreResult,
  Settlement,
} from '../group';
import type { Library } from '../library';
import {
  makeObject,
  rebindObject,
  type HostObject,
  type ObjectKind,
  type ObjectState,
} from '../objects';
import { map, nothing, requireArgs, Value } from '../values';
import { binaryValues, decode, encode, encodeAll, type Codec } from './codec';
import { InstanceLostError } from './reactor';
import { Session } from './session';
import {
  boolOf,
  entriesOf,
  Raw,
  field,
  has,
  intOf,
  listOf,
  plain,
  textOf,
  textsOf,
  type Frame,
  type Json,
} from './wire';

/** What a Group needs of the Core that made it. */
export type GroupCore = {
  /** Compiles a Library and its imports into a guest, once each. */
  install(session: Session, library: Library): void;
  kind(name: string): ObjectKind | undefined;
  /** A guest with every definition the Core knows available to declare. */
  session(): Session;
};

export type GroupOptions = {
  name: string;
  onReady?(): void;
  /** The `random` generator's seed, 0 to 2⁶⁴ − 1; 0 when omitted. */
  seed?: bigint;
  trace?: (line: string) => void;
};

type Waiting = {
  reject(e: unknown): void;
  resolve(v: Value): void;
};
type Deciding_ = {
  resolve(d: Decided): void;
  sealed: boolean;
};
type Pending = {
  abort: AbortController;
  // Answering after abandonment, or once the Run ends, does nothing.
  live: boolean;
  queued?: boolean;
  starting?: boolean;
};

const key = (kind: string, id: string) => `${kind}\u0000${id}`;
// LimitReached is the TS Core's class; its name is checked, as instanceof
// is kept to Error classes here.
const isLimitReached = (error: unknown) =>
  error instanceof Error && error.name === 'LimitReached';
const propertyFailure = (details: string[], detail: string) => {
  details.push(detail);
  return { hostError: detail };
};
const bytesFrame = (b: Uint8Array): Frame => ({ $bytes: toBase64(b) });
const bytesOfFrame = (j: Json | undefined): Uint8Array =>
  fromBase64(textOf(field(j, '$bytes')) ?? '') ?? new Uint8Array();
// As the TS Core words a Host function's failure (machine.ts hostDetail).
const detailOf = (e: unknown): string =>
  e instanceof Error
    ? `${e.name}: ${e.message}`
    : `the Host threw ${typeof e === 'symbol' ? e.toString() : String(e)}`;

// A Run's error map as the Host reads it (TS Core: group.ts hostError).
const scriptError = (error: Value): ScriptError => {
  const message = error.get('message');
  const textMessage = message.kind === 'text';
  return new ScriptError(
    error.get('code').asText() ?? '',
    textMessage ? message.asText()! : '',
    map(
      error
        .entries()
        .filter(([k]) => k !== 'code' && !(k === 'message' && textMessage)),
    ),
  );
};

/** A handle for calls addressed to one Script. */
export class WasmScript implements Script {
  constructor(
    private readonly group: WasmGroup,
    readonly name: string,
  ) {}
  grants(): Record<string, string[]> {
    const ok = this.group.worker('grants', { script: this.name });
    return Object.fromEntries(
      entriesOf(ok).map(([name, ops]) => [name, textsOf(ops)]),
    );
  }
  counters(): Counters {
    return plain(
      this.group.worker('counters', { script: this.name }),
    ) as Counters;
  }
  deliver(m: Message): string {
    return this.group.queue('deliver', { to: { script: this.name } }, m);
  }
  request(m: Message, o?: CancellationOptions): Requested {
    return this.group.ask({ to: { script: this.name } }, m, o);
  }
  requestPump(
    m: Message,
    now: bigint,
    o?: PumpOptions & CancellationOptions,
  ): PumpedRequest {
    return this.group.combined(
      'request-pump',
      () => ({
        to: { script: this.name },
        message: this.group.messageFrame(m, 'requestPump'),
      }),
      now,
      o,
    );
  }
  /** Queued. A Request for the answer only; use `request` for its id or a signal. */
  invoke(name: string, ...args: Value[]): Promise<Value> {
    return invoke(this, name, args);
  }
  decide(m: Message, o?: CancellationOptions): Deciding {
    return this.group.decision({ to: { script: this.name } }, m, o);
  }
  reload(
    source: string,
    carry: CarryOver,
    o?: { keepMailbox?: boolean },
  ): Report[] {
    return this.group.lifecycle('reload', {
      script: this.name,
      source,
      carry,
      keepMailbox: o?.keepMailbox,
    });
  }
  extend(source: string): void {
    this.group.worker('extend', { script: this.name, source });
  }
  stop(reason: string): void {
    this.group.control('stop', { script: this.name, reason });
  }
  cancelRun(runId: string): void {
    this.group.control('cancel-run', { script: this.name, run: runId });
  }
  rewindRun(runId: string): void {
    this.group.control('rewind-run', { script: this.name, run: runId });
  }
  revoke(grantName: string): void {
    this.group.control('revoke', { script: this.name, grant: grantName });
  }
}

export class WasmGroup implements Group {
  readonly name: string;
  readonly #core: GroupCore;
  readonly #session: Session;
  readonly #trace?: (line: string) => void;
  readonly #onReady?: () => void;
  readonly #scripts = new Map<string, WasmScript>();
  /** Each Script's Grants, by the name it uses. */
  readonly #bindings = new Map<string, Map<string, Grant<unknown>>>();
  readonly #objects = new Map<string, ObjectState>();
  readonly #requests = new Map<string, Waiting>();
  readonly #decisions = new Map<string, Deciding_>();
  readonly #runs = new Map<string, string>();
  readonly #calls = new Map<string, Pending>();
  /** Each queued charge request's future, until a Pump reports it. */
  readonly #charges = new Map<string, (result: ChargeResult) => void>();
  // Host-side detail the guest doesn't carry, for the reports it writes.
  readonly #failureDetails = new Map<string, string>();
  #propertyDetails: string[] = [];
  readonly #effectDetails = new Map<string, string>();
  /** Calls a restore left pending, until the first Pump. */
  readonly #restored = new Map<string, Json>();
  #restoring: RestoreOptions | null = null;
  #exchanging = 0;
  #combining = false;
  /** Answers given while their call was starting, sent once the exchange ends. */
  #deferred: (() => void)[] = [];
  readonly #codec: Codec;

  /** @internal Made by WasmCore. */
  constructor(
    core: GroupCore,
    o: GroupOptions,
    restoring?: { options: RestoreOptions; save: Uint8Array },
  ) {
    this.#core = core;
    this.name = o.name;
    this.#trace = o.trace;
    this.#onReady = o.onReady;
    this.#session = core.session();
    const objects = this.#objects;
    this.#codec = {
      identity: this,
      object: (kind, id) => objects.get(key(kind, id))?.handle,
    };
    this.#session.bind(binaryValues(this.#codec));
    if (!restoring) {
      this.#session.exchange('new-group', {
        group: this.name,
        name: this.name,
        trace: !!o.trace,
        // Integers at or past 2⁵³ cross as decimal text.
        seed:
          o.seed === undefined
            ? undefined
            : o.seed < 2n ** 53n && o.seed >= 0n
              ? Number(o.seed)
              : o.seed.toString(),
      });
    }
  }

  // ---------------------------------------------------------------------
  // The conversation
  // ---------------------------------------------------------------------

  /** @internal One exchange for this Group, its needs answered here. */
  send(
    m: string,
    fields: Record<string, Frame | undefined> = {},
    receive?: (packet: Json) => void,
  ): Json {
    this.#exchanging++;
    try {
      return this.#session.exchange(
        m,
        { group: this.name, ...fields },
        (need, packet) => this.#need(need, packet),
        (packet, sent) => {
          receive?.(packet);
          this.#observe(packet, sent);
        },
      );
    } finally {
      this.#exchanging--;
      if (!this.#exchanging && this.#deferred.length) {
        const deferred = this.#deferred;
        this.#deferred = [];
        for (const settle of deferred) {
          settle();
        }
      }
    }
  }

  /**
   * A worker call. Made from a callback, the guest refuses it as
   * `reentrant call`, with its refusal record, as the in-process Core does.
   */
  worker(m: string, fields: Record<string, Frame | undefined> = {}): Json {
    if (this.#combining) {
      throw new HostError('reentrant call');
    }
    this.#session.syncKinds();
    return this.send(m, fields);
  }

  #observe(packet: Json, m: string) {
    // `abandoned` beside an interim need, with abandoned-before-needs-v1,
    // or in the final reply of a Pump, Reload or Library replacement.
    this.#abandon(textsOf(field(packet, 'abandoned')));
    const ok = field(packet, 'ok');
    if (
      m === 'pump' ||
      m === 'request-pump' ||
      m === 'call-pump' ||
      m === 'reload' ||
      m === 'replace-library'
    ) {
      this.#abandon(textsOf(field(ok, 'abandoned')));
    }
    if (!this.#trace) {
      return;
    }
    const lines = [...textsOf(field(packet, 'trace'))];
    // A Grants reply is a name-to-Operations map, and `trace` a legal name.
    if (m !== 'grants') {
      lines.push(...textsOf(field(ok, 'trace')));
    }
    for (const line of lines) {
      this.#trace(line);
    }
  }

  #abandon(ids: string[]) {
    for (const id of ids) {
      const pending = this.#calls.get(id);
      if (pending) {
        this.#calls.delete(id);
        pending.live = false;
        pending.abort.abort();
      }
    }
  }

  #ready() {
    if (!this.#onReady) {
      return;
    }
    // As in the TS Core, inputs queued during a Pump notify after it returns.
    if (this.#exchanging || this.#combining) {
      queueMicrotask(this.#onReady);
    } else {
      this.#onReady();
    }
  }

  // ---------------------------------------------------------------------
  // Needs
  // ---------------------------------------------------------------------

  #need(need: Json, _packet: Json): Record<string, Frame> {
    switch (textOf(field(need, 'm'))) {
      case 'op':
        return this.#operation(need);
      case 'prop':
        return this.#property(need);
      case 'effect':
        return this.#effect(need);
      case 'release':
        this.#release(need);
        return {};
      case 'resolve':
        return this.#resolve(need);
      // crossing-trace-v1: the records came beside this need, and are out.
      case 'trace':
        return {};
      default:
        throw new InstanceLostError(
          `Unsupported need ${textOf(field(need, 'm')) ?? ''}`,
        );
    }
  }

  #grantOf(script: string, name: string) {
    return this.#bindings.get(script)?.get(name);
  }

  #failure(e: ScriptError): Frame {
    return {
      code: e.code,
      message: e.message || undefined,
      data:
        Value.isValue(e.data) && e.data.kind === 'map'
          ? encode(this.#codec, e.data)
          : undefined,
    };
  }

  #callOf(
    need: Json,
    grant: Grant<unknown>,
    pending: Pending,
    charge: (fuel: number) => void,
  ): Call<unknown> {
    const id = textOf(field(need, 'call'))!;
    const scope = textOf(field(need, 'scope'));
    const delivery = textOf(field(need, 'delivery'));
    return Object.freeze({
      group: this,
      id,
      scriptName: textOf(field(need, 'script'))!,
      runId: textOf(field(need, 'run'))!,
      grantName: textOf(field(need, 'grant'))!,
      segmentId: textOf(field(need, 'segment'))!,
      ...(scope ? { scopeName: scope } : {}),
      automatic: boolOf(field(need, 'automatic')) ?? false,
      ...(delivery ? { delivery } : {}),
      binding: grant.binding,
      now: parseInstant(textOf(field(need, 'now'))!),
      signal: pending.abort.signal,
      charge,
      requestCharge: (fuel: number) => this.#requestCharge(id, fuel),
      answer: (v: Value, late?: { fuel: number }) =>
        this.#settleCall(id, pending, 'answer', {
          value: encode(this.#codec, v),
          fuel: late?.fuel,
        }),
      // Anything but a ScriptError fails as `host error`, with no error map.
      fail: (e: ScriptError) =>
        this.#settleCall(id, pending, 'fail', {
          error: e instanceof ScriptError ? this.#failure(e) : undefined,
        }),
    });
  }

  // The guest validates and records the request; an amount that isn't a
  // whole number reaches it as the `invalid` sentinel, as natively.
  #requestCharge(call: string, fuel: number): ChargeRequest {
    const ok = this.send('request-charge', {
      call,
      fuel: Number.isSafeInteger(fuel) ? fuel : 'invalid',
    });
    const id = textOf(field(ok, 'request'))!;
    const result = new Promise<ChargeResult>(resolve => {
      this.#charges.set(id, resolve);
    });
    this.#ready();
    return { id, result };
  }

  #settleCall(
    id: string,
    pending: Pending,
    m: 'answer' | 'fail',
    fields: Record<string, Frame | undefined>,
  ) {
    // The guest learns the call started only from this callback's result.
    if (pending.starting) {
      if (!pending.queued) {
        pending.queued = true;
        this.#deferred.push(() => this.#settleCall(id, pending, m, fields));
      }
      return;
    }
    // Once the call isn't pending, the guest records the answer as late
    // and ignores it, as the TS Core does.
    pending.live = false;
    this.#calls.delete(id);
    try {
      this.send(m, { call: id, ...fields });
    } catch (error) {
      // A late answer is recorded and ignored, as natively.
      if (!(error instanceof HostError)) {
        throw error;
      }
    }
    this.#ready();
  }

  #operation(need: Json): Record<string, Frame> {
    const id = textOf(field(need, 'call'))!;
    const grant = this.#grantOf(
      textOf(field(need, 'script'))!,
      textOf(field(need, 'grant'))!,
    );
    const name = textOf(field(need, 'operation'))!;
    const op = grant?.capability.operations.get(name);
    if (!grant || !op || !grant.ops.has(name)) {
      const detail = `No Operation ${name} for ${textOf(field(need, 'grant'))}`;
      this.#failureDetails.set(id, detail);
      return { hostError: detail, charged: 0 };
    }
    let args: Value[];
    try {
      args = listOf(field(need, 'args')).map(a => decode(this.#codec, a));
    } catch (error) {
      this.#failureDetails.set(id, detailOf(error));
      return { hostError: detailOf(error), charged: 0 };
    }
    const automatic = boolOf(field(need, 'automatic')) ?? false;
    const left = intOf(field(need, 'fuelLeft'));
    // The Zig Core said how much Fuel is left; it spends what was charged.
    const meter = new CallMeter(
      (fuel, charged) => left === undefined || charged + fuel <= left,
    );
    const pending: Pending = {
      abort: new AbortController(),
      live: true,
      starting: true,
    };
    const call = this.#callOf(need, grant, pending, meter.charge);
    const out: Record<string, Frame> = {};
    try {
      out.charged = 0;
      const invoke = () =>
        this.#invoke(op as ValueOperation<unknown>, call, args, pending);
      // Automatic abandonment can't charge: its window never opens.
      const result = automatic ? invoke() : meter.starting(invoke);
      if (meter.refused) {
        out.limit = true;
      } else if (op.mode === 'suspending') {
        out.started = true;
      } else if (op.mode === 'fire-and-forget') {
        out.done = true;
      } else {
        try {
          out.result = encode(this.#codec, result!);
        } catch (error) {
          out.hostError = detailOf(error);
        }
      }
    } catch (error) {
      if (meter.refused || isLimitReached(error)) {
        out.limit = true;
      } else if (error instanceof ScriptError) {
        try {
          out.fail = this.#failure(error);
        } catch (encodeError) {
          out.hostError = detailOf(encodeError);
        }
      } else {
        out.hostError = detailOf(error);
      }
    } finally {
      pending.starting = false;
    }
    out.charged = meter.charged;
    if (typeof out.hostError === 'string') {
      this.#failureDetails.set(id, out.hostError);
    }
    if (op.mode === 'suspending' && out.started) {
      if (pending.live) {
        this.#calls.set(id, pending);
      }
    } else {
      pending.live = false;
    }
    return out;
  }

  #invoke(
    op: ValueOperation<unknown>,
    call: Call<unknown>,
    args: Value[],
    pending: Pending,
  ): Value | undefined {
    switch (op.mode) {
      case 'immediate':
        return op.do(call, ...args);
      case 'fire-and-forget':
        op.fire(call, ...args);
        return undefined;
      case 'suspending':
        if (op.start) {
          op.start(call, ...args);
          return undefined;
        }
        // An answer the Host can't send, such as another Group's Value,
        // fails the call instead.
        // Tracked as the TS Core tracks it, so a driver's close waits for it.
        trackOperation(
          this,
          call,
          op.run!(call, ...args)
            .then(v => call.answer(v))
            .catch((error: unknown) => call.fail(error as ScriptError)),
        );
        return undefined;
    }
  }

  #property(need: Json): Record<string, Frame> {
    const ref = field(field(need, 'object'), '$object');
    const [kind, id] = textsOf(ref);
    const object = this.#objects.get(key(kind!, id!))?.handle;
    const name = textOf(field(need, 'prop'))!;
    const details = this.#propertyDetails;
    if (has(need, 'op')) {
      return this.#collection(need, object, kind!, id!);
    }
    const prop = object?.kind.props.get(name);
    if (!object || !prop) {
      return propertyFailure(details, `No property ${name} on ${kind} ${id}`);
    }
    try {
      if (has(need, 'value')) {
        if (!prop.set) {
          return propertyFailure(details, `${name} is read-only`);
        }
        prop.set(object, decode(this.#codec, field(need, 'value')));
        return { ok: true };
      }
      return { value: encode(this.#codec, prop.get(object)) };
    } catch (error) {
      if (error instanceof ScriptError) {
        return { fail: this.#failure(error) };
      }
      return propertyFailure(details, detailOf(error));
    }
  }

  // An Object Collection callback: the `prop` need named `elements`, with
  // its `op` and, for `at` and `find`, its `selector` (#1143).
  #collection(
    need: Json,
    object: HostObject | undefined,
    kind: string,
    id: string,
  ): Record<string, Frame> {
    const details = this.#propertyDetails;
    const elements = object?.kind.elements;
    if (!object || !elements) {
      return propertyFailure(details, `No collection on ${kind} ${id}`);
    }
    const op = textOf(field(need, 'op'));
    try {
      const selector = has(need, 'selector')
        ? decode(this.#codec, field(need, 'selector'))
        : null;
      const result =
        op === 'count'
          ? elements.count(object)
          : op === 'at' && selector?.kind === 'number'
            ? elements.at(object, Number(selector.asDecimal()!.toString()))
            : op === 'find' && selector?.kind === 'text'
              ? elements.find(object, selector.asText()!)
              : undefined;
      if (result === undefined) {
        return propertyFailure(details, `Malformed collection need ${op}`);
      }
      return { value: encode(this.#codec, result) };
    } catch (error) {
      if (error instanceof ScriptError) {
        return { fail: this.#failure(error) };
      }
      return propertyFailure(details, detailOf(error));
    }
  }

  #effect(need: Json): Record<string, Frame> {
    const script = textOf(field(need, 'script'))!;
    const name = textOf(field(need, 'grant'))!;
    const phase = textOf(
      field(need, 'phase'),
    ) as keyof SegmentLifecycle<unknown>;
    const grant = this.#grantOf(script, name);
    const named = textOf(field(need, 'coordinator'));
    const hooks =
      (named ? this.#session.coordinator(named) : undefined) ??
      grant?.coordinator ??
      grant?.capability.lifecycle;
    const segment = textOf(field(need, 'segment'))!;
    let result: EffectResult;
    if (!grant || !hooks) {
      result = { status: 'unknown', detail: `No lifecycle hooks for ${name}` };
    } else {
      try {
        result = hooks[phase]({
          group: this,
          scriptName: script,
          runId: textOf(field(need, 'run'))!,
          grantName: name,
          segmentId: segment,
          binding: grant.binding,
          now: parseInstant(textOf(field(need, 'now'))!),
          grants: textsOf(field(need, 'grants')).map(g => ({
            grantName: g,
            binding: this.#grantOf(script, g)?.binding,
          })),
        });
        if (!['ok', 'failed', 'unknown'].includes(result?.status)) {
          result = { status: 'unknown', detail: 'not an EffectResult' };
        }
      } catch (error) {
        result = { status: 'unknown', detail: detailOf(error) };
      }
    }
    if (result.status !== 'ok' && result.detail !== undefined) {
      this.#effectDetails.set(`${segment}/${phase}`, result.detail);
    }
    return { status: result.status };
  }

  #release(need: Json) {
    const script = textOf(field(need, 'script'))!;
    const name = textOf(field(need, 'grant'))!;
    const grant = this.#grantOf(script, name);
    try {
      grant?.capability.release?.({
        group: this,
        scriptName: script,
        grantName: name,
        binding: grant.binding,
        now: parseInstant(textOf(field(need, 'now'))!),
        reason: textOf(field(need, 'reason')) as ReleaseReason,
      });
    } catch {
      // Exceptions cannot refuse release.
    }
  }

  // Restore asks for each saved Grant and Host Object once; registering a
  // Grant's declaration meanwhile is what restore-bindings-v1 allows.
  #resolve(need: Json): Record<string, Frame> {
    const o = this.#restoring!;
    const grants = listOf(field(need, 'grants')).map(pair => {
      const [script, name] = textsOf(pair);
      const grant = o.grants(script!, name!);
      if (!grant) {
        return null;
      }
      let scripts = this.#bindings.get(script!);
      if (!scripts) {
        scripts = new Map();
        this.#bindings.set(script!, scripts);
      }
      scripts.set(name!, grant);
      return this.#session.grant(grant);
    });
    const objects = listOf(field(need, 'objects')).map(pair => {
      const [kind, id] = textsOf(pair);
      const resolved = o.resolve(kind!, id!);
      const k = this.#core.kind(kind!);
      if (!resolved || !k) {
        return false;
      }
      this.#objects.set(key(kind!, id!), makeObject(k, id!, resolved.native));
      return true;
    });
    return { grants, objects };
  }

  // ---------------------------------------------------------------------
  // Reports and the futures they settle
  // ---------------------------------------------------------------------

  #report(j: Json): Report & { climbed?: boolean } {
    const r = plain(j) as Record<string, unknown> & { kind: string };
    const value = (name: string) => decode(this.#codec, field(j, name));
    switch (r.kind) {
      case 'run end': {
        if (has(j, 'result')) {
          r.result = value('result');
        }
        if (has(j, 'error')) {
          r.error = scriptError(value('error'));
        }
        const effect = r.effect as EffectFailure | undefined;
        if (effect) {
          const detail = this.#effectDetails.get(
            `${effect.segment}/${effect.phase}`,
          );
          if (detail !== undefined) {
            effect.detail = detail;
          }
        }
        break;
      }
      case 'effect failure': {
        const detail = this.#effectDetails.get(
          `${String(r.segment)}/${String(r.phase)}`,
        );
        if (detail !== undefined) {
          r.detail = detail;
        }
        break;
      }
      case 'unhandled': {
        const message = field(j, 'message');
        r.message = {
          name: textOf(field(message, 'name')),
          args: listOf(field(message, 'args')).map(a => decode(this.#codec, a)),
        };
        if (has(j, 'target')) {
          r.target = value('target').asObject();
        }
        break;
      }
      case 'run started':
        r.args = listOf(field(j, 'args')).map(a => decode(this.#codec, a));
        if (has(j, 'fn')) {
          r.fn = value('fn');
        }
        break;
      case 'decided':
        r.vetoes = listOf(field(j, 'vetoes')).map(v => ({
          script: textOf(field(v, 'script')),
          run: textOf(field(v, 'run')),
          reason: decode(this.#codec, field(v, 'reason')),
        }));
        r.undecided = (r.undecided as { run: string }[]).map(u =>
          u.run ? u : (({ run: _, ...rest }) => rest)(u),
        );
        break;
      case 'call failed': {
        const operation = r.operation as { capability: string };
        operation.capability =
          this.#session.capabilityName(operation.capability) ??
          operation.capability;
        const call = String(r.call);
        const detail = call
          ? this.#failureDetails.get(call)
          : this.#propertyDetails.shift();
        r.detail =
          detail ??
          ((r.detail as string) || 'Host result rejected by the Core');
        break;
      }
      case 'host error':
        r.code = r.code as HostErrorCode;
        break;
    }
    return r as unknown as Report & { climbed?: boolean };
  }

  /** The reports of a final reply, with the futures they settle. */
  #reports(ok: Json): Report[] {
    const rows = listOf(field(ok, 'reports')).map(j => this.#report(j));
    for (const id of textsOf(field(ok, 'gone'))) {
      this.#settle(id, undefined, sendFailed('function gone'));
    }
    const unhandled = new Set(
      rows.flatMap(r => (r.kind === 'unhandled' ? [r.delivery] : [])),
    );
    for (const r of rows) {
      switch (r.kind) {
        case 'charge result':
          this.#charges.get(r.request)?.(r);
          this.#charges.delete(r.request);
          break;
        case 'run started':
          if (r.delivery) {
            this.#runs.set(r.run, r.delivery);
          }
          break;
        case 'run end': {
          if (r.run) {
            this.#runs.delete(r.run);
          }
          // Its message went on up the Message Path: the asker still waits.
          if (r.climbed || !r.delivery) {
            break;
          }
          if (unhandled.has(r.delivery)) {
            this.#settle(r.delivery, undefined, sendFailed('unhandled'));
          } else if (r.outcome === 'completed') {
            this.#settle(r.delivery, r.result ?? nothing);
          } else {
            this.#settle(r.delivery, undefined, sendFailed(r.outcome));
          }
          break;
        }
        case 'run discarded':
          if (r.reason !== 'rewind') {
            const delivery = this.#runs.get(r.run);
            if (delivery) {
              this.#settle(delivery, undefined, sendFailed('stopped'));
            }
          }
          this.#runs.delete(r.run);
          break;
        case 'unhandled':
          this.#settle(r.delivery, undefined, sendFailed('unhandled'));
          break;
        case 'stop':
          for (const id of r.droppedMessages) {
            this.#settle(id, undefined, sendFailed('stopped'));
          }
          for (const run of r.discardedRuns) {
            const delivery = this.#runs.get(run);
            if (delivery) {
              this.#settle(delivery, undefined, sendFailed('stopped'));
            }
            this.#runs.delete(run);
          }
          break;
        case 'decided': {
          const id = r.broadcast ?? r.delivery!;
          const d = this.#decisions.get(id);
          if (d) {
            this.#decisions.delete(id);
            d.sealed = true;
            const { kind: _, ...decided } = r;
            d.resolve(decided);
          }
          break;
        }
      }
      delete (r as { climbed?: boolean }).climbed;
    }
    this.#failureDetails.clear();
    this.#effectDetails.clear();
    this.#propertyDetails = [];
    return rows;
  }

  #settle(delivery: string, value?: Value, failure?: ScriptError) {
    const waiting = this.#requests.get(delivery);
    if (!waiting) {
      return;
    }
    this.#requests.delete(delivery);
    if (failure) {
      waiting.reject(failure);
    } else {
      waiting.resolve(value!);
    }
  }

  // ---------------------------------------------------------------------
  // Queued calls
  // ---------------------------------------------------------------------

  /** @internal Message data shared with the Script combined operation. */
  messageFrame(m: Message, call: string): Frame {
    requireArgs(m.args ?? [], `${call}('${m.name}')`, m.name);
    return {
      name: m.name,
      args: encodeAll(this.#codec, m.args ?? []),
      limits: m.limits ? { ...m.limits } : undefined,
    };
  }

  #target(to: HostObject): Frame {
    return { object: this.#held(to) };
  }

  // As the TS Core's held(): another Group's handle is refused here.
  #held(o: HostObject): Frame {
    if (this.#objects.get(key(o.kind.name, o.id))?.handle !== o) {
      throw new HostError('wrong group', `${o.value} isn't this Group's`);
    }
    return { $object: [o.kind.name, o.id] };
  }

  // Another Group's handle crosses as a placeholder the guest refuses as
  // `wrong group`, with its own refusal record.
  #objectRef(o: HostObject): Frame {
    const own = this.#objects.get(key(o.kind.name, o.id));
    return own?.handle === o
      ? { $object: [o.kind.name, o.id] }
      : { $object: ['', ''] };
  }

  /** @internal */
  queue(
    m: string,
    fields: Record<string, Frame | undefined>,
    message?: Message,
  ): string {
    const ok = this.send(m, {
      ...fields,
      ...(message ? { message: this.messageFrame(message, m) } : {}),
    });
    this.#ready();
    return textOf(field(ok, 'delivery')) ?? textOf(field(ok, 'broadcast'))!;
  }

  #cancellable(
    id: string,
    signal: AbortSignal | undefined,
    live: () => boolean,
  ) {
    if (!signal) {
      return;
    }
    const cancel = () => {
      if (live()) {
        this.control('cancel-delivery', { delivery: id });
      }
    };
    if (signal.aborted) {
      cancel();
    } else {
      signal.addEventListener('abort', cancel, { once: true });
    }
  }

  #waiting(id: string, signal?: AbortSignal): Requested {
    let waiting!: Waiting;
    const result = new Promise<Value>((resolve, reject) => {
      waiting = { resolve, reject };
    });
    // The Host may never read a failed result.
    result.catch(() => {});
    this.#requests.set(id, waiting);
    this.#cancellable(id, signal, () => this.#requests.has(id));
    return { id, result };
  }

  /** @internal */
  ask(
    to: Record<string, Frame>,
    m: Message,
    o?: CancellationOptions,
  ): Requested {
    return this.#waiting(this.queue('request', to, m), o?.signal);
  }

  /** @internal */
  decision(
    fields: Record<string, Frame>,
    m: Message,
    o?: CancellationOptions,
  ): Deciding {
    const id = this.queue('decide', fields, m);
    let deciding!: Deciding_;
    const decided = new Promise<Decided>(resolve => {
      deciding = { resolve, sealed: false };
    });
    this.#decisions.set(id, deciding);
    // A sealed Verdict ignores its deadline.
    this.#cancellable(id, o?.signal, () => !deciding.sealed);
    return { id, decided };
  }

  /** @internal Queued controls, which make the Group runnable. */
  control(m: string, fields: Record<string, Frame | undefined>): void {
    this.send(m, fields);
    this.#ready();
  }

  // ---------------------------------------------------------------------
  // talk.ts's Group
  // ---------------------------------------------------------------------

  script(name: string): WasmScript | undefined {
    return this.#scripts.get(name);
  }

  scriptNames(): string[] {
    return [...this.#scripts.keys()];
  }

  #grantHandles(grants: Readonly<Record<string, Grant<unknown>>>) {
    return Object.fromEntries(
      Object.entries(grants).map(([name, g]) => [name, this.#session.grant(g)]),
    );
  }

  load(o: LoadOptions): WasmScript {
    this.#session.syncKinds();
    const grants = (o.grants ?? {}) as Record<string, Grant<unknown>>;
    const ok = this.worker('load', {
      name: o.name,
      source: o.source,
      grants: this.#grantHandles(grants),
      grantsAsUsed: o.grantsAsUsed,
      owner: o.owner ? this.#objectRef(o.owner) : undefined,
      objects: o.objects
        ? Object.fromEntries(
            Object.entries(o.objects).map(([n, h]) => [n, this.#objectRef(h)]),
          )
        : undefined,
      limits: { ...limitDefaults, ...o.limits },
    });
    const name = textOf(field(ok, 'script')) ?? o.name;
    this.#bindings.set(name, new Map(Object.entries(grants)));
    const script = new WasmScript(this, name);
    this.#scripts.set(name, script);
    return script;
  }

  addLibrary(l: Library): void {
    this.#core.install(this.#session, l);
    this.worker('add-library', { identity: bytesFrame(l.identity) });
  }

  replaceLibrary(l: Library, carry: CarryOver): Report[] {
    this.#core.install(this.#session, l);
    return this.lifecycle('replace-library', {
      identity: bytesFrame(l.identity),
      carry,
    });
  }

  /** @internal Reload and Library replacement end Runs and settle their futures. */
  lifecycle(m: string, fields: Record<string, Frame | undefined>): Report[] {
    const reports = this.#reports(this.worker(m, fields) ?? null);
    this.#ready();
    return reports;
  }

  object<N>(kind: ObjectKind<N>, id: string, native: N): HostObject<N> {
    if (this.#objects.has(key(kind.name, id))) {
      throw new HostError('duplicate object id', `${kind.name} ${id}`);
    }
    this.#session.syncKinds();
    this.send('object', { kind: kind.name, id });
    const state = makeObject(kind, id, native);
    this.#objects.set(key(kind.name, id), state);
    return state.handle as HostObject<N>;
  }

  objectById(kind: string, id: string): HostObject | undefined {
    return this.#objects.get(key(kind, id))?.handle;
  }

  setParent(o: HostObject, parent: HostObject | undefined): void {
    this.control('set-parent', {
      object: this.#held(o),
      parent: parent ? this.#held(parent) : null,
    });
  }

  dispose(o: HostObject): void {
    this.control('dispose', { object: this.#held(o) });
  }

  deliver(to: HostObject, m: Message): string {
    return this.queue('deliver', { to: this.#target(to) }, m);
  }

  request(to: HostObject, m: Message, o?: CancellationOptions): Requested {
    return this.ask({ to: this.#target(to) }, m, o);
  }

  requestPump(
    to: HostObject,
    m: Message,
    now: bigint,
    o?: PumpOptions & CancellationOptions,
  ): PumpedRequest {
    return this.combined(
      'request-pump',
      () => ({
        to: this.#target(to),
        message: this.messageFrame(m, 'requestPump'),
      }),
      now,
      o,
    );
  }

  callPump(
    fn: Value,
    args: Value[],
    now: bigint,
    o?: PumpOptions & CancellationOptions & { limits?: Message['limits'] },
  ): PumpedRequest {
    return this.combined(
      'call-pump',
      () => {
        requireArgs(args, 'callPump');
        return {
          fn: encode(this.#codec, fn),
          args: encodeAll(this.#codec, args),
          limits: o?.limits ? { ...o.limits } : undefined,
        };
      },
      now,
      o,
    );
  }

  /** @internal Shared by Script and Object targets. No fallback on old guests. */
  combined(
    m: string,
    fields: () => Record<string, Frame | undefined>,
    now: bigint,
    o?: PumpOptions & CancellationOptions,
  ): PumpedRequest {
    if (this.#combining) {
      return { admitted: false, error: new HostError('reentrant call') };
    }
    if (!this.#session.requestPump) {
      return {
        admitted: false,
        error: new HostError(
          'invalid value',
          'talk.wasm lacks request-pump-fields-v1',
        ),
      };
    }
    this.#combining = true;
    let requested: Requested | undefined;
    let waiting!: Waiting;
    const result = new Promise<Value>((resolve, reject) => {
      waiting = { resolve, reject };
    });
    result.catch(() => {});
    let sent = false;
    let refused = false;
    let cancelled = o?.signal?.aborted ?? false;
    let token: Raw;
    const cancel = () => {
      if (!sent) {
        cancelled = true;
        return;
      }
      if (refused) {
        return;
      }
      if (requested) {
        if (this.#requests.has(requested.id)) {
          this.control('cancel-delivery', { delivery: requested.id });
        }
      } else {
        this.control('cancel-correlated', { token });
      }
    };
    o?.signal?.addEventListener('abort', cancel, { once: true });
    try {
      this.#session.syncKinds();
      if (o?.signal?.aborted) {
        // In a synchronous reactor an already-aborted signal must land before
        // execution, rather than waiting for the first guest callback. This
        // still admits once and Pumps once, on a negotiated guest only.
        const ok = this.send(
          m === 'request-pump' ? 'request' : 'call',
          fields(),
        );
        const id = textOf(field(ok, 'delivery'))!;
        requested = this.#waiting(id, o.signal);
        const pumped = this.send('pump', {
          now: formatInstant(now),
          fuelSlice: o.fuelSlice,
          fuelCap: o.fuelCap,
        });
        return {
          admitted: true,
          requested,
          pump: { ok: true, result: this.#pumpResult(pumped) },
        };
      }
      token = this.#session.nextToken();
      const ok = this.send(
        m,
        {
          ...fields(),
          token,
          now: formatInstant(now),
          fuelSlice: o?.fuelSlice,
          fuelCap: o?.fuelCap,
        },
        packet => {
          sent = true;
          const id = textOf(field(packet, 'delivery'));
          if (id) {
            const replyToken = field(packet, 'token');
            if (
              !replyToken ||
              typeof replyToken !== 'object' ||
              Array.isArray(replyToken) ||
              replyToken.kind !== 'number' ||
              replyToken.source !== token.json
            ) {
              throw new HostError(
                'invalid value',
                'The reply names another correlation token',
              );
            }
            requested = { id, result };
            this.#requests.set(id, waiting);
          } else if (field(packet, 'need') === undefined) {
            refused = true;
          }
          if (cancelled && !refused) {
            cancelled = false;
            cancel();
          }
        },
      );
      if (!requested) {
        throw new HostError(
          'invalid value',
          'The combined reply omitted its delivery',
        );
      }
      return {
        admitted: true,
        requested,
        pump: { ok: true, result: this.#pumpResult(ok) },
      };
    } catch (error) {
      if (!requested) {
        return { admitted: false, error };
      }
      this.#ready();
      return { admitted: true, requested, pump: { ok: false, error } };
    } finally {
      this.#combining = false;
      if (!requested) {
        o?.signal?.removeEventListener('abort', cancel);
      } else {
        requested.result.then(
          () => o?.signal?.removeEventListener('abort', cancel),
          () => o?.signal?.removeEventListener('abort', cancel),
        );
      }
    }
  }

  broadcast(m: Message): string {
    return this.queue('broadcast', {}, m);
  }

  decide(to: HostObject, m: Message, o?: CancellationOptions): Deciding {
    return this.decision({ to: this.#target(to) }, m, o);
  }

  decideBroadcast(m: Message, o?: CancellationOptions): Deciding {
    return this.decision({ broadcast: true }, m, o);
  }

  call(
    fn: Value,
    args: Value[],
    o?: CancellationOptions & { limits?: Message['limits'] },
  ): Requested {
    requireArgs(args, 'call');
    const id = this.queue('call', {
      fn: encode(this.#codec, fn),
      args: encodeAll(this.#codec, args),
      limits: o?.limits ? { ...o.limits } : undefined,
    });
    return this.#waiting(id, o?.signal);
  }

  pump(now: bigint, o?: PumpOptions): PumpResult {
    const ok = this.worker('pump', {
      now: formatInstant(now),
      fuelSlice: o?.fuelSlice,
      fuelCap: o?.fuelCap,
    });
    return this.#pumpResult(ok);
  }

  #pumpResult(ok: Json): PumpResult {
    this.#restored.clear();
    const deadline = textOf(field(ok, 'nextDeadline'));
    return {
      state: textOf(field(ok, 'state')) as PumpResult['state'],
      ...(deadline ? { nextDeadline: parseInstant(deadline) } : {}),
      fuelUsed: intOf(field(ok, 'fuelUsed')) ?? 0,
      reports: this.#reports(ok),
    };
  }

  save(): Uint8Array {
    return bytesOfFrame(field(this.worker('save'), 'save'));
  }

  fingerprint(): Uint8Array {
    return bytesOfFrame(field(this.worker('fingerprint'), 'fingerprint'));
  }

  /** The State Fingerprint (ADR 0142): the Group's save without its save id. */
  stateFingerprint(): Uint8Array {
    return bytesOfFrame(
      field(this.worker('state-fingerprint'), 'stateFingerprint'),
    );
  }

  inspect(): Inspection {
    const ok = this.worker('inspect');
    return {
      scripts: listOf(field(ok, 'scripts')).map(s => {
        const disabled = textsOf(field(s, 'disabledGrants'));
        return {
          name: textOf(field(s, 'name'))!,
          ...(disabled.length ? { disabledGrants: disabled } : {}),
          vars: listOf(field(s, 'vars')).map(pair => {
            const [name, v] = listOf(pair);
            return [textOf(name)!, decode(this.#codec, v)] as [string, Value];
          }),
          runs: listOf(field(s, 'runs')).map(r => {
            const run = plain(
              r,
            ) as Inspection['scripts'][number]['runs'][number] & {
              until?: unknown;
            };
            if (typeof run.until === 'string') {
              run.until = parseInstant(run.until);
            }
            return run;
          }),
          mailbox: listOf(field(s, 'mailbox')).map(item => {
            const message = field(item, 'message');
            const limits = plain(field(message, 'limits'));
            return {
              ...(has(item, 'delivery')
                ? { delivery: textOf(field(item, 'delivery')) }
                : {}),
              ...(has(item, 'from')
                ? { from: textOf(field(item, 'from')) }
                : {}),
              message: {
                name: textOf(field(message, 'name'))!,
                args: listOf(field(message, 'args')).map(a =>
                  decode(this.#codec, a),
                ),
                ...(limits ? { limits } : {}),
              },
            };
          }),
        };
      }),
    };
  }

  settle(callId: string, s: Settlement): Call<unknown> | undefined {
    const pending = this.#restored.get(callId);
    const adopt = 'adopt' in s;
    if (adopt && pending) {
      const grant = this.#grantOf(
        textOf(field(pending, 'script'))!,
        textOf(field(pending, 'grant'))!,
      );
      const op = grant?.capability.operations.get(
        textOf(field(pending, 'operation'))!,
      );
      if (op?.mode === 'suspending' && op.run) {
        throw new HostError('not adoptable', `${callId} runs a Promise`);
      }
    }
    this.send('settle', {
      call: callId,
      settlement:
        'answer' in s
          ? { answer: encode(this.#codec, s.answer) }
          : 'fail' in s
            ? { fail: this.#failure(s.fail) }
            : 'reissue' in s
              ? { reissue: true }
              : { adopt: true },
    });
    this.#restored.delete(callId);
    this.#ready();
    if (!adopt || !pending) {
      return undefined;
    }
    const grant = this.#grantOf(
      textOf(field(pending, 'script'))!,
      textOf(field(pending, 'grant'))!,
    )!;
    const live: Pending = { abort: new AbortController(), live: true };
    this.#calls.set(callId, live);
    return this.#callOf(pending, grant, live, () => {
      throw new HostError('invalid value', 'Charge only while starting');
    });
  }

  // ---------------------------------------------------------------------
  // Restore
  // ---------------------------------------------------------------------

  /** @internal */
  restore(save: Uint8Array, o: RestoreOptions): RestoreResult {
    for (const l of o.libraries) {
      this.#core.install(this.#session, l);
    }
    this.#session.syncKinds();
    this.#restoring = o;
    let ok: Json;
    try {
      ok = this.send('restore', {
        name: o.name,
        save: bytesFrame(save),
        libraries: o.libraries.map(l => bytesFrame(l.identity)),
        mismatch: o.onMismatch,
        trace: !!o.trace,
      });
    } finally {
      this.#restoring = null;
    }
    for (const name of textsOf(field(ok, 'scripts'))) {
      this.#scripts.set(name, new WasmScript(this, name));
      if (!this.#bindings.has(name)) {
        this.#bindings.set(name, new Map());
      }
    }
    // Disposed Host Objects need handles too, as restored natives.
    for (const pair of listOf(field(ok, 'objects'))) {
      const [kind, id] = textsOf(pair);
      const k = this.#core.kind(kind!);
      if (k && !this.#objects.has(key(kind!, id!))) {
        this.#objects.set(key(kind!, id!), makeObject(k, id!, undefined));
      }
    }
    const pending: PendingCall[] = listOf(field(ok, 'pending')).map(p => {
      const id = textOf(field(p, 'call'))!;
      this.#restored.set(id, p);
      const script = textOf(field(p, 'script'))!;
      const grant = textOf(field(p, 'grant'))!;
      return {
        id,
        script,
        grant,
        operation: {
          capability:
            this.#grantOf(script, grant)?.capability.name ??
            textOf(field(p, 'capability')) ??
            '',
          operation: textOf(field(p, 'operation'))!,
        },
        args: listOf(field(p, 'args')).map(a => decode(this.#codec, a)),
      };
    });
    return {
      reports: this.#reports(ok),
      variablesOnly: boolOf(field(ok, 'variablesOnly')) ?? false,
      reloaded: textsOf(field(ok, 'reloaded')),
      pending,
      discardedRuns: textsOf(field(ok, 'discardedRuns')),
      disposed: listOf(field(ok, 'disposed')).map(
        d => textsOf(d) as [string, string],
      ),
      droppedMessages: textsOf(field(ok, 'droppedMessages')),
      abandonedCalls: textsOf(field(ok, 'abandonedCalls')),
    };
  }

  // ---------------------------------------------------------------------
  // Facade-only
  // ---------------------------------------------------------------------

  /** This Group's guest linear memory, in bytes. */
  memoryBytes(): number {
    return this.#session.reactor.memoryBytes();
  }

  /** @internal Rebinds a restored handle's native, as the TS Core does. */
  rebind(o: HostObject, native: unknown): void {
    const state = this.#objects.get(key(o.kind.name, o.id));
    if (state) {
      rebindObject(state, native);
    }
  }
}

export { bytesFrame, bytesOfFrame };
