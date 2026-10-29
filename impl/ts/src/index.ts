export {
  HostError,
  LoadError,
  MailboxFull,
  ScriptError,
  type HostErrorCode,
  type LoadDiagnostic,
  type SendFailedReason,
} from './errors';
export {
  defineObjectKind,
  type HostObject,
  type ObjectKind,
  type ObjectElements,
  type ObjectKindDef,
  type PropDef,
} from './objects';
export {
  defineCapability,
  LimitReached,
  shape,
  type Call,
  type ChargeRequest,
  type ChargeResult,
  type Metering,
  type GrantContext,
  type ReleaseHook,
  type ReleaseReason,
  type SegmentContext,
  type SegmentCoordinator,
  type SegmentGrant,
  type SegmentLifecycle,
  type CoordinatedLifecycle,
  type EffectResult,
  type CapabilityDef,
  type Cost,
  type ErrorDecl,
  type FieldShape,
  type Grant,
  type Operation,
  type Shape,
  type ScopeDecl,
  type ImmediateOp,
  type SuspendingOp,
  type FireOp,
  type CapabilityDefiner,
  type Operations,
  type PlainArg,
  type PlainResult,
} from './capabilities';
export {
  codeIdentity,
  compileLibrary,
  type Library,
  type LibraryOptions,
  type LibrarySource,
  type OperationRef,
} from './library';
export {
  TsGroup,
  TsScript,
  newGroup,
  restore,
  type RestoreOptions,
  type SaveOptions,
  type ScriptCodeRequest,
  type ScriptSources,
  type RestoreResult,
  type PendingCall,
  type Settlement,
  type GroupOptions,
  type CancellationOptions,
  type CarryOver,
  type Inspection,
  type Counters,
  type LoadOptions,
  type Message,
  type PumpOptions,
  type PumpResult,
  type Report,
  type EffectFailure,
  type Requested,
  type PumpedRequest,
  type Decided,
  type Deciding,
  type Verdict,
} from './group';
export { formatInstant, nowMicros, parseInstant } from './dates';
export { talk } from './talk';
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
} from './values';
export {
  fromValue,
  toValue,
  type FromValueOptions,
  type PlainValue,
  type ToValueOptions,
} from './plain';
export { encodeValue } from './encoding';
/** Chapter 3's kind names, as `kindOf` gives them and `is a` tests them. */
export { kindNames } from './constructs';
export { decodeJson, encodeJson } from './json';
export { coreVersions, type Versions } from './versions';
export { createCore, type TsCore } from './core';
export {
  createGroup,
  type CreateGroupOptions,
  type DrivenGroup,
} from './create-group';
export type { Core, Group, Script } from './embedding';
export { handlersOf, type Handlers, type ScriptWithHandlers } from './handlers';
export {
  inlineGrants,
  type InlineFunction,
  type InlineOperation,
} from './inline-grants';
export {
  exportManifest,
  type ManifestSpec,
  type MessageDecl,
} from './manifest';
export { readDisplay, decodeValue, type FunctionResolver } from './readers';
export { Lexer, type Mode, type Token, type TokType } from './lexer';
export {
  parseEntry,
  parseSource,
  parseSourceRecovering,
  ParseError,
  type EntryKind,
  type EntryResult,
  type ParseResult,
  type RecoveringParseResult,
  type RecoveryDiagnostic,
} from './parser';
export {
  checkSource,
  checkSyntax,
  type CheckResult,
  type SemanticResult,
  type CheckOptions,
  type Diagnostic,
  type DiagnosticCode,
} from './checker';
export {
  compileSource,
  exportsOf,
  lowerTree,
  LoweringError,
  type CompileOptions,
  type CompileResult,
} from './lowering';
export {
  callFunction,
  defaultLimits,
  deliver,
  loadScript,
  UnitLoadError,
  Run,
  Script as CompiledScript,
  type LimitName,
  type Limits,
  type Outcome,
  type RunRecord,
} from './machine';
export { canConvert, NotImplementedError, waitUs } from './operations';
export {
  disassemble,
  type Body,
  type BodyKind,
  type CodeUnit,
  type EventBranch,
  type EventEntry,
  type Instruction,
  type Operand,
  type UnwindEntry,
} from './code-unit';
export type {
  Binding,
  BindingKind,
  ExportKind,
  FunctionContract,
  LibraryExport,
  NameRole,
  SemanticElement,
  SemanticName,
  SemanticNode,
  SemanticScope,
  SemanticToken,
  SemanticTree,
  SourceSpan,
} from './semantic';
export {
  syntaxText,
  syntaxSelector,
  type SyntaxNode,
  type SyntaxElement,
  type SyntaxRule,
  type SyntaxErrorCode,
  type Trivia,
} from './syntax';

export type { GrantDecls } from './effects';
export {
  calendarCapability,
  type CalendarImpl,
  clockCapability,
  consoleCapability,
  timerCapability,
  type Costs,
  type ConsoleImpl,
  type TimerImpl,
} from './standard-capabilities';

export { localeCapability, type LocaleImpl } from './locale-capability';
export { add, storeCapability, type StoreImpl } from './store-capability';
export {
  sqliteCapability,
  type SqlParams,
  type SqlRows,
  type SqlValue,
  type SqliteBinding,
  type SqliteImpl,
} from './sqlite-capability';
export { userCapability, type UserImpl } from './user-capability';
export { httpCapability, type HttpImpl } from './http-capability';

/** Spec data for browser-safe tooling; these tables add no execution behavior. */
export { builtins, grammar, units } from './generated/syntax';
export { stdlibSources } from './generated/stdlib';
export { declarationStart } from './documentation';

export { validMessageSelector } from './selectors';

export type {
  RunAncestry,
  RunStarted,
  RunDiscarded,
  RunAccounting,
  CausalWork,
} from './run-accounting';
