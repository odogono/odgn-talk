// What the page and the Play worker say to each other (#1225). The page sends
// requests through the worker supervisor; the worker answers each one, and
// pushes Play State changes and sound commands unasked. Everything here is
// plain data, so it crosses `postMessage` as it is.
import type { CanvasCommand } from '@northtalk/tooling/canvas';
import { type PerformanceSnapshot } from './performance';
import { type ReaderArg } from './pointer';
import { type LoadedMessageTarget } from './message-script';
import { type Asset, type Element, type Project, type RichText } from './model';
import { type PlayMessage, type UserNotice, type UserPrompt } from './play';
import {
  type VariableScript,
  type VariableValue,
  type Watch,
  type WatchResult,
} from './variables';

/** Element messages the page sends for reader input. */
export type ReaderMessage = Extract<
  PlayMessage,
  | 'click'
  | 'pointerEnter'
  | 'pointerLeave'
  | 'pointerHeld'
  | 'keyDown'
  | 'keyUp'
>;

/** A reader's answer to a prompt; Nothing when dismissed. */
export type PromptAnswer = boolean | string | readonly string[] | undefined;

export type PlayRequest =
  | {
      kind: 'open';
      pageIndex: number;
      performanceEpoch?: number;
      project: Project;
      seed: bigint;
      session: number;
    }
  | {
      args?: ReaderArg[];
      kind: 'send';
      message: ReaderMessage;
      pageIndex: number;
      session: number;
      /** An Element's name on that Page, or absent for the Page itself. */
      target?: string;
    }
  | { kind: 'frame'; session: number }
  | { epoch: number; kind: 'performance'; session: number }
  | {
      /** The mirror's count of reader edits, which views echo back. */
      edit: number;
      kind: 'text';
      name: string;
      pageIndex: number;
      richText: RichText;
      session: number;
    }
  | {
      kind: 'answer';
      prompt: number;
      session: number;
      value: PromptAnswer;
    }
  | { kind: 'message'; session: number; target?: number; text: string }
  | { error?: string; kind: 'soundEnded'; voice: number }
  | { kind: 'inspect'; session: number }
  | { kind: 'variables'; session: number }
  /** Replaces the Watches, which are evaluated only while paused (ADR 0129). */
  | { kind: 'watches'; session: number; watches: Watch[] }
  | { kind: 'stop'; session: number }
  /**
   * A Statement Step of the Run stopped at a Breakpoint (ADR 0147). The
   * session stays paused, at the next stop or once the Run has moved on.
   */
  | { kind: 'statementStep'; session: number; step: StatementStep }
  /** Replaces the Breakpoints (ADR 0147). */
  | { breakpoints: BreakpointView[]; kind: 'breakpoints'; session: number }
  /**
   * Pause, Resume and Step act on the session's Play clock (ADR 0128).
   * Resume also continues a Run stopped at a Breakpoint; Step is refused
   * while one is stopped.
   */
  | { kind: 'pause' | 'resume' | 'step'; session: number };

/** A prompt as the page shows it; its answer names the prompt's id. */
export type PromptView = UserPrompt & { id: number };

/**
 * A Script, by its owner's place in `scriptOwners(project)`, or a Library,
 * by its place in the Project's Libraries.
 */
export type SourcePlace =
  { index: number; kind: 'library' } | { kind: 'script'; owner: number };

/** Step In, Step Over or Step Out. */
export type StatementStep = 'in' | 'over' | 'out';

/** A Breakpoint: a line, from 1, of the Script or Library at `place`. */
export type BreakpointView = { line: number; place: SourcePlace };

/** One frame of a stopped Run, innermost first. */
export type FrameView = {
  /** The Handler and the Script it is in, as the author knows them. */
  label: string;
  line: number;
  locals: [string, VariableValue][];
  /** Absent for code an author cannot open, as a Message Box line. */
  place?: SourcePlace;
};

/** A Run stopped at a Breakpoint, or partway through a Statement Step. */
export type StoppedRun = { frames: FrameView[]; run: string };

/** A Script problem, its owner given by place in `scriptOwners(project)`. */
export type ProblemView = {
  line: number;
  message: string;
  owner: number;
  target?:
    { index: number; kind: 'library' } | { kind: 'script'; owner: number };
};

/**
 * A Drawing's change: its whole list after a reset, else the commands added
 * since the last one sent. `owner` places an authored Canvas in
 * `scriptOwners(project)`, so the page can commit it on return to Edit.
 */
export type DrawingView = {
  commands: CanvasCommand[];
  name: string;
  owner?: number;
  pageIndex: number;
  reset: boolean;
};

/**
 * Play State for the page to draw. `full` views carry every Element of the
 * showing Page; others carry only the Elements that changed, and `order`
 * drops the ones that went. Groups arrive without their members, which have
 * their own entries.
 */
export type PlayView = {
  designWidth: number;
  /** Drawings arrive here, never in `elements` (ADR 0116). */
  drawings: DrawingView[];
  /** `edit` is the last reader edit the worker applied to that Element. */
  elements: { edit?: number; element: Element; shown: boolean }[];
  full: boolean;
  /** Elements a held press reports to, each frame, with `pointerHeld`. */
  heldElements: string[];
  /** Loaded Script contexts, sent only when their identities change. */
  messageTargets?: LoadedMessageTarget[];
  navigating: boolean;
  notices: UserNotice[];
  /** The showing Page's Elements by name, in draw order; absent if unchanged. */
  order?: string[];
  page: { background: string; height: number; name: string };
  /** Whether the Page's Message Path handles each key message. */
  pageHandles: { keyDown: boolean; keyUp: boolean };
  pageIndex: number;
  /** Whether the session is paused: no time passes and reader input is dropped. */
  paused: boolean;
  problems: ProblemView[];
  prompt: PromptView | undefined;
  session: number;
  stopped: boolean;
  /** The Run a Breakpoint stopped, while the session is paused there. */
  stoppedRun?: StoppedRun;
  wantsFrames: boolean;
};

export type PlayResponse =
  | { kind: 'performance'; session: number; snapshot: PerformanceSnapshot }
  | ({ kind: 'view' } & PlayView)
  | { asset: Asset; kind: 'play'; loop: boolean; voice: number }
  | { kind: 'stopSound'; voice: number }
  | { kind: 'done' }
  | {
      error?: string;
      kind: 'message';
      source?: string;
      text?: string;
      value?: VariableValue;
    }
  /** The Group's inspection as JSON, big integers as strings. */
  | { inspection: string; kind: 'inspection' }
  /** The Variables window's Scripts; absent if no Pump ran since last asked. */
  | { kind: 'variables'; scripts?: VariableScript[] }
  /**
   * Watch results that changed, pushed unasked. `pageChanged` is set when the
   * Watches' Pump changed the Page.
   */
  | {
      kind: 'watches';
      pageChanged?: boolean;
      results: WatchResult[];
      session: number;
    }
  /** What every pending request gets when the worker is ended. */
  | { kind: 'ended' };
