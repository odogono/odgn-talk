// Messages between the page and its two workers. The session worker runs the
// Core, the Session Host and the debuggers; the LSP worker runs the language
// server, the formatter and the Lints.
import type { DebugAction, TranscriptItem } from '@odgn/northtalk/session';
import type {
  RpcMessage,
  WorkspaceConfiguration,
} from '@odgn/northtalk-tooling/lsp';
import type { Shared } from './link';
import type {
  ApplyResult,
  Faults,
  Library,
  PauseView,
  TabBreakpoint,
  Tabs,
} from './session';

export type Prompt =
  /** Ready for an Entry or a Session Command. */
  | 'entry'
  /** An unfinished Entry goes on. */
  | 'continue'
  /** The Foreground Run waits on `console`'s `read`. */
  | 'read'
  /** The Host sleeps until a deadline the Foreground Run waits for. */
  | 'sleeping'
  /** A debugger paused the session. */
  | 'paused';

/** A line for the console: a Transcript item, or a Playground note. */
export type ConsoleLine =
  | { item: TranscriptItem; k: 'item' }
  | { k: 'note'; level: 'info' | 'warning' | 'error'; text: string };

export type ReplayView = {
  hostInputCount: number;
  hostInputIndex: number;
  pause: Omit<PauseView, 'tab'> | null;
  state: 'paused' | 'input' | 'ended';
};

export type SessionState = {
  breakpoints: { line: number; tab: string; verified: boolean }[];
  lines: ConsoleLine[];
  manifest: unknown;
  pause: PauseView | null;
  prompt: Prompt;
  savedLibraries: Library[];
  setup: string[];
  /** The session source, for keeping the Script tab in sync. */
  source: string;
  started: boolean;
};

export type SessionRequest =
  | { shared?: Shared; t: 'open' }
  | { t: 'line'; text: string }
  | { t: 'cancel' }
  | { script: string; t: 'apply' }
  | { library: Library; t: 'saveLibrary' }
  | { t: 'restart'; tabs: Tabs }
  | {
      breakpoints: TabBreakpoint[];
      faults: Faults;
      t: 'breakpoints';
      tabs: Tabs;
    }
  | { action: DebugAction; t: 'debug' }
  | { t: 'transcript' }
  | {
      setup?: string;
      sources?: Record<string, string>;
      t: 'replayLoad';
      tabs: Tabs;
      trace?: string;
    }
  | {
      op:
        | DebugAction
        | 'back'
        | { input: number }
        | { breakpoints: { line: number; unit: string }[]; faults: Faults };
      t: 'replay';
    };

export type SessionResponse =
  | { state: SessionState; t: 'state' }
  | { result: ApplyResult; state: SessionState; t: 'applied' }
  | {
      difference: { actual: string; expected: string; line: number };
      state: SessionState;
      t: 'mismatch';
    }
  | { t: 'transcript'; text: string }
  | { replay: ReplayView; t: 'replay' }
  | { file: string; t: 'needSource' }
  | { message: string; t: 'error' };

/** A message to the page: a reply to request `id`, or an unprompted state. */
export type FromSession = { id?: number; response: SessionResponse };
export type ToSession = { id: number; request: SessionRequest };

export type ToLsp =
  | { message: RpcMessage; t: 'rpc' }
  | { configuration: WorkspaceConfiguration; t: 'configure' };
export type FromLsp = { message: RpcMessage };
