// Messages between a page and its LSP worker, which runs the language server
// with its formatter and Lints.
import type {
  RpcMessage,
  WorkspaceConfiguration,
} from '@northtalk/tooling/lsp';

export type ToLsp =
  | { message: RpcMessage; t: 'rpc' }
  | { configuration: WorkspaceConfiguration; t: 'configure' };
export type FromLsp = { message: RpcMessage };
