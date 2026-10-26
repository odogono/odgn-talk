// @northtalk/ts/wasm: talk.ts's embedding API over the Zig Core's
// `wasm32-wasi` reactor. Values, Shapes, errors and the Capability and Object
// Kind constructors are the TS Core's own, so Host code written against
// @northtalk/ts switches Cores by its import; README.md lists the
// differences.
export {
  createCore,
  WasmCore,
  type CoreOptions,
  type WasmSource,
} from './core';
export { WasmGroup, WasmScript } from './group';
export {
  createGroup,
  type CreateGroupOptions,
  type DrivenGroup,
} from '../group-helper';
export type { Versions } from '../versions';
export type { Core, Group, Script } from '../embedding';
export { InstanceLostError } from './reactor';

export {
  HostError,
  LoadError,
  MailboxFull,
  ScriptError,
  type HostErrorCode,
  type LoadDiagnostic,
  type SendFailedReason,
} from '../errors';
export type {
  HostObject,
  ObjectElements,
  ObjectKind,
  ObjectKindDef,
  PropDef,
} from '../objects';
export {
  LimitReached,
  shape,
  type Call,
  type CapabilityDef,
  type CapabilityDefiner,
  type CoordinatedLifecycle,
  type Cost,
  type EffectResult,
  type ErrorDecl,
  type FieldShape,
  type FireOp,
  type Grant,
  type GrantContext,
  type ImmediateOp,
  type Operation,
  type Operations,
  type PlainArg,
  type PlainResult,
  type ReleaseHook,
  type ReleaseReason,
  type ScopeDecl,
  type SegmentContext,
  type SegmentCoordinator,
  type SegmentGrant,
  type SegmentLifecycle,
  type Shape,
  type SuspendingOp,
} from '../capabilities';
export type { Library, LibrarySource, OperationRef } from '../library';
export type { GrantDecls } from '../effects';
export type {
  CancellationOptions,
  CarryOver,
  Counters,
  Decided,
  Deciding,
  EffectFailure,
  GroupOptions,
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
  Verdict,
} from '../group';
export { formatInstant, nowMicros, parseInstant } from '../dates';
export { talk } from '../talk';
export {
  fromValue,
  toValue,
  type FromValueOptions,
  type PlainValue,
  type ToValueOptions,
} from '../plain';
export type { LimitName, Limits, Outcome } from '../machine';
export type {
  CausalWork,
  RunAccounting,
  RunAncestry,
  RunDiscarded,
  RunStarted,
} from '../run-accounting';
export {
  Value,
  Decimal,
  type Kind,
  nothing,
  bool,
  text,
  num,
  dec,
  list,
  map,
  bytes,
  civilDate,
  instant,
  quantity,
  range,
  record,
} from '../values';
export { encodeValue } from '../encoding';
export { decodeJson, encodeJson } from '../json';
export { decodeValue, readDisplay } from '../readers';
export {
  exportManifest,
  type ManifestSpec,
  type MessageDecl,
} from '../manifest';
export { add } from '../store-capability';
export type {
  CalendarImpl,
  ConsoleImpl,
  Costs,
  TimerImpl,
} from '../standard-capabilities';
export type { LocaleImpl } from '../locale-capability';
export type { StoreImpl } from '../store-capability';
export type {
  SqlParams,
  SqlRows,
  SqlValue,
  SqliteBinding,
  SqliteImpl,
} from '../sqlite-capability';
export type { UserImpl } from '../user-capability';
export type { HttpImpl } from '../http-capability';

import { limitDefaults } from '../generated/machine';
/** Chapter 9's default Limits, which the reactor shares. */
export const defaultLimits = Object.freeze({ ...limitDefaults });
