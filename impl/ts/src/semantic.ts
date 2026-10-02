import type { TokType } from './lexer';
import type { SyntaxRule } from './syntax';

/** Half-open UTF-16 offsets, with a 1-based Unicode scalar start position. */
export type SourceSpan = {
  col: number;
  end: number;
  line: number;
  start: number;
};
export type BindingKind =
  | 'local'
  | 'parameter'
  | 'script variable'
  | 'constant'
  | 'function'
  | 'handler'
  | 'object'
  | 'builtin constant'
  | 'builtin function';
export type ExportKind = 'constant' | 'function' | 'handler';
/** Argument counts accepted by a statically named function. */
export type FunctionContract = {
  required: number;
  total: number;
};
export type LibraryExport =
  | ExportKind
  | { contract?: FunctionContract; kind: ExportKind; maySuspend?: boolean };
export type Binding = {
  contract?: FunctionContract;
  id: number;
  importedFrom?: { library: string; name: string };
  initial: 'nothing' | 'parameter' | 'declaration';
  kind: BindingKind;
  name: string;
  scope: number;
  span: SourceSpan | null;
};
export type SemanticScope = {
  bindings: readonly Binding[];
  captures: readonly Binding[];
  id: number;
  kind: 'unit' | 'handler' | 'function' | 'lambda';
  parent: number | null;
};
export type NameRole =
  | 'declaration'
  | 'binding'
  | 'capture'
  | 'value'
  | 'call'
  | 'write'
  | 'binary size'
  | 'command'
  | 'message'
  | 'grant'
  | 'receiver'
  | 'import'
  | 'library';
export type SemanticName = {
  binding: Binding | null;
  kind: 'name';
  role: NameRole;
  span: SourceSpan;
  text: string;
};
export type SemanticToken = {
  kind: 'token';
  raw: string;
  span: SourceSpan;
  text: string;
  type: Exclude<TokType, 'nl' | 'eof' | 'error'>;
};
/** Production/operator structure is retained for lowering; trivia is omitted. */
export type SemanticNode = {
  children: readonly SemanticElement[];
  kind: 'node';
  rule: SyntaxRule;
  scope: number;
  span: SourceSpan;
};
export type SemanticElement = SemanticNode | SemanticName | SemanticToken;
export type SemanticTree = {
  /** The unit's Handlers that may suspend (chapter 5, Suspension Points). */
  maySuspend?: readonly string[];
  root: SemanticNode;
  scopes: readonly SemanticScope[];
};
