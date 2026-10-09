// Messages between the page and its workers. The session worker runs the
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
  SelectionAction,
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
  canvas: import('@odgn/northtalk-tooling/canvas').CanvasCommand[];
  hostInputCount: number;
  hostInputIndex: number;
  pause: Omit<PauseView, 'tab'> | null;
  revision: number;
  state: 'paused' | 'input' | 'ended';
};

export type SessionState = {
  breakpoints: { line: number; tab: string; verified: boolean }[];
  canvas: import('@odgn/northtalk-tooling/canvas').CanvasCommand[];
  generation: number;
  lines: ConsoleLine[];
  manifest: unknown;
  pause: PauseView | null;
  prompt: Prompt;
  /**
   * The latest value an Entry echoed in source form, for copying; null when
   * it is not readable as source. Absent until an Entry echoes one.
   */
  result?: string | null;
  revision: number;
  savedLibraries: Library[];
  /** The latest print it or inspect it, with what its Entry has printed so far. */
  selection: {
    /** Its value in source form, as for {@link SessionState.result}. */
    copy?: string | null;
    how: Exclude<SelectionAction, 'do'>;
    id: number;
    lines: string[];
    source: string;
  } | null;
  setup: string[];
  /** The session source, for keeping the Script tab in sync. */
  source: string;
  started: boolean;
};

export type SessionRequest =
  | {
      shared?: Shared;
      /** The Store slots the page keeps, for `:store load`. */
      slots?: Record<string, string>;
      t: 'open';
    }
  | { t: 'line'; text: string }
  | { t: 'cancel' }
  /** Setup commands an example needs, for the next Run fresh. */
  | { setup: string[]; t: 'exampleSetup' }
  | { launch: string; t: 'fresh'; tabs: Tabs }
  | { launch: string; t: 'evaluate' }
  /** Do it, print it or inspect it: a tab's selection, run as an Entry. */
  | { how: SelectionAction; source: string; t: 'selection'; tab: string }
  | { script: string; t: 'apply' }
  /** Fix and Continue at a pause, with the Script tab (ADR 0072). */
  | { script: string; t: 'fix' }
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
  /** The selection's id in `state.selection`, or null if it was refused. */
  | { id: number | null; state: SessionState; t: 'selected' }
  | {
      difference: { actual: string; expected: string; line: number };
      state: SessionState;
      t: 'mismatch';
    }
  /** ended: a Fix and Continue at a pause stopped it (ADR 0072). */
  | { ended: boolean; t: 'transcript'; text: string }
  | { replay: ReplayView; t: 'replay' }
  | { file: string; t: 'needSource' }
  /** `:store save` wrote a slot, for the page to keep. */
  | { slot: string; t: 'storeSlot'; text: string }
  | { message: string; t: 'error' };

/** A message to the page: a reply to request `id`, or an unprompted state. */
export type FromSession = { id?: number; response: SessionResponse };
export type ToSession = { id: number; request: SessionRequest };

export type ToLsp =
  | { message: RpcMessage; t: 'rpc' }
  | { configuration: WorkspaceConfiguration; t: 'configure' };
export type FromLsp = { message: RpcMessage };

export type SyntaxRequest = { revision: number; source: string };
export type SyntaxResponse = { revision: number } & (
  { tree: import('./syntax').SyntaxView } | { error: string }
);
