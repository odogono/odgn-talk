// The embedding interface both Cores implement: the TS Core (TsGroup,
// TsScript) and the Zig Host Adapter (WasmCore, WasmGroup, WasmScript), so
// Host code typed against these switches Cores by its import (ADR 0121). Each
// declaration is the two Cores' intersection, and mirrors spec/embedding/talk.ts;
// tests/embedding-api.test.ts compares them.
import type { Call, defineCapability } from './capabilities';
import type { HostObject, ObjectKind, ObjectKindDef } from './objects';
import type { GrantDecls } from './effects';
import type {
  CancellationOptions,
  CarryOver,
  Counters,
  Deciding,
  GroupOptions,
  Inspection,
  LimitOverride,
  LoadOptions,
  Message,
  PumpedRequest,
  PumpOptions,
  PumpResult,
  Report,
  Requested,
  RestoreOptions,
  RestoreResult,
  Settlement,
} from './group';
import type { Library, LibrarySource } from './library';
import type {
  calendarCapability,
  clockCapability,
  consoleCapability,
  timerCapability,
} from './standard-capabilities';
import type { localeCapability } from './locale-capability';
import type { sqliteCapability } from './sqlite-capability';
import type { storeCapability } from './store-capability';
import type { userCapability } from './user-capability';
import type { httpCapability } from './http-capability';
import { requireArgs, type Value } from './values';
import type { Versions } from './versions';

/**
 * Process-wide: the compile cache, and Capability and Object Kind definitions.
 * `createCore` is each entry point's own: synchronous on the TS Core,
 * asynchronous on the Zig Host Adapter.
 */
export type Core = {
  calendarCapability: typeof calendarCapability;
  clockCapability: typeof clockCapability;
  /** Throws LoadError. `imports` holds every Library its `use` lines name. */
  compileLibrary(
    src: LibrarySource,
    imports?: Library[],
    declarations?: GrantDecls,
  ): Library;
  consoleCapability: typeof consoleCapability;
  defineCapability: typeof defineCapability;
  defineObjectKind<N>(k: ObjectKindDef<N>): ObjectKind<N>;
  httpCapability: typeof httpCapability;
  localeCapability: typeof localeCapability;
  newGroup(o: GroupOptions): Group;
  restore(
    save: Uint8Array,
    o: RestoreOptions,
  ): { group: Group; result: RestoreResult };
  sqliteCapability: typeof sqliteCapability;
  storeCapability: typeof storeCapability;
  timerCapability: typeof timerCapability;
  userCapability: typeof userCapability;
  readonly versions: Versions;
};

/**
 * A Script Group. The TS Core's Group adds `save(options)` and the debugger
 * hooks; the Zig Host Adapter's adds `memoryBytes()`, `rebind()` and `restore()`.
 */
export type Group = {
  addLibrary(l: Library): void;
  broadcast(m: Message): string;
  call(
    fn: Value,
    args: Value[],
    o?: CancellationOptions & { limits?: LimitOverride },
  ): Requested;
  callPump(
    fn: Value,
    args: Value[],
    now: bigint,
    o?: PumpOptions & CancellationOptions & { limits?: LimitOverride },
  ): PumpedRequest;
  decide(to: HostObject, m: Message, o?: CancellationOptions): Deciding;
  decideBroadcast(m: Message, o?: CancellationOptions): Deciding;
  deliver(to: HostObject, m: Message): string;
  dispose(o: HostObject): void;
  fingerprint(): Uint8Array;
  inspect(): Inspection;
  load(o: LoadOptions): Script;
  readonly name: string;
  object<N>(kind: ObjectKind<N>, id: string, native: N): HostObject<N>;
  objectById(kind: string, id: string): HostObject | undefined;
  pump(now: bigint, o?: PumpOptions): PumpResult;
  replaceLibrary(l: Library, carry: CarryOver): Report[];
  request(to: HostObject, m: Message, o?: CancellationOptions): Requested;
  requestPump(
    to: HostObject,
    m: Message,
    now: bigint,
    o?: PumpOptions & CancellationOptions,
  ): PumpedRequest;
  save(): Uint8Array;
  script(name: string): Script | undefined;
  scriptNames(): string[];
  setParent(o: HostObject, parent: HostObject | undefined): void;
  settle(callId: string, s: Settlement): Call<unknown> | undefined;
};

/** A loaded Script's handle. */
export type Script = {
  cancelRun(runId: string): void;
  counters(): Counters;
  decide(m: Message, o?: CancellationOptions): Deciding;
  deliver(m: Message): string;
  extend(source: string): void;
  grants(): Record<string, string[]>;
  invoke(name: string, ...args: Value[]): Promise<Value>;
  readonly name: string;
  reload(
    source: string,
    carry: CarryOver,
    o?: { keepMailbox?: boolean },
  ): Report[];
  request(m: Message, o?: CancellationOptions): Requested;
  requestPump(
    m: Message,
    now: bigint,
    o?: PumpOptions & CancellationOptions,
  ): PumpedRequest;
  revoke(grantName: string): void;
  rewindRun(runId: string): void;
  stop(reason: string): void;
};

/** request({ name, args }).result, for either Core's Script. */
export const invoke = (
  script: Pick<Script, 'request'>,
  name: string,
  args: Value[],
): Promise<Value> => {
  requireArgs(args, `invoke('${name}')`, name);
  return script.request({ name, args }).result;
};
