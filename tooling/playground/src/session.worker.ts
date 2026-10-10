import { canvasCommands } from '@odgn/northtalk-tooling/canvas';
// The session worker: the Playground Host. It owns the Session Host, its
// timers and the replay debugger, and answers the page with the session's
// state after every request and every Pump it makes at a deadline.
import type { Setup } from '@odgn/northtalk/setup';
import { calendar, locale } from '@odgn/northtalk-tooling/builtins';
import {
  ReplayDebugger,
  renderDebugView,
  type ReplayResult,
} from '@odgn/northtalk-tooling/debug';
import { bool, list, nothing, text } from '@odgn/northtalk';
import { SessionDriver } from '@odgn/northtalk-tooling/session-driver';
import type {
  ConsoleLine,
  FromSession,
  Prompt,
  ReplayView,
  SessionRequest,
  SessionResponse,
  SessionState,
  ToSession,
} from './protocol';
import {
  frameViews,
  PlaygroundSession,
  type SelectionAction,
  type Tabs,
  varSources,
} from './session';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ToSession>) => void) | null;
  postMessage(message: FromSession): void;
};

const now = () => BigInt(Date.now()) * 1_000_000n;
// The page's Store slots: it sends them at `open`, and keeps each one
// `:store save` writes.
const slots = new Map<string, string>();
const env = {
  now,
  monotonic: () => performance.now(),
  builtIns: { calendar, locale },
  readStoreFile: (slot: string) => {
    const text = slots.get(slot);
    if (text === undefined) {
      throw new Error(`No Store slot ${slot}`);
    }
    return text;
  },
  writeStoreFile: (slot: string, text: string) => {
    slots.set(slot, text);
    scope.postMessage({ response: { t: 'storeSlot', slot, text } });
  },
};

// How much of the session's Transcript the page has been sent.
let sent = 0;
let notes: ConsoleLine[] = [];
// Whether a page request is being handled; its response carries the state.
let handling = false;
let replay: ReplayDebugger | null = null;
let revision = 0;
let generation = 0;
// The latest print it or inspect it, by its number in the session.
let selection: {
  how: Exclude<SelectionAction, 'do'>;
  id: number;
  source: string;
} | null = null;
let replayCanvasNames: string[] = [];
const canvasNames = () =>
  Object.entries(session.host.setup.scripts![0]!.grants!)
    .filter(([name, g]) => (g.capability ?? name) === 'canvas')
    .map(([name]) => name);

const note = (text: string, level: 'info' | 'warning' | 'error' = 'info') =>
  notes.push({ k: 'note', level, text });

const help = [
  'Enter a declaration, a statement or an expression. An unfinished one goes on',
  'at the next line until the whole Entry is complete. Cancel stops the Run the prompt',
  'waits for. Apply enters the Script tab; saving a Library tab adds or replaces it.',
];

// The session's driver: what it prints the page reads from the Transcript, so
// only its notes and the Pumps it makes at a deadline are posted from here.
const drive = (session: PlaygroundSession) =>
  new SessionDriver(session, {
    now: () => session.now(),
    help,
    noQuit:
      'A Playground session ends when you close the page, or with Restart.',
    timer: (ms, fire) => {
      const timer = setTimeout(fire, ms);
      return () => clearTimeout(timer);
    },
    emit: event => {
      if (event.k === 'note') {
        note(event.text, event.level);
      } else if (event.k === 'prompt' && !handling) {
        post({ t: 'state', state: state() });
      }
    },
  });

let session = new PlaygroundSession(env);
let driver = drive(session);

const prompt = (): Prompt => {
  const prompt = driver.prompt;
  return prompt === 'closed' ? 'entry' : prompt;
};

const state = (): SessionState => {
  // Notes say what a request did, so they come before what it printed.
  const lines: ConsoleLine[] = [
    ...notes,
    ...session.transcript
      .slice(sent)
      .map(item => ({ k: 'item' as const, item })),
  ];
  sent = session.transcript.length;
  notes = [];
  const result = session.latestCopy;
  const copy = selection ? session.copyOf(selection.id) : undefined;
  const waiting = session.host.waiting;
  return {
    ...(waiting.k === 'user'
      ? { question: { ...waiting.prompt, call: waiting.call } }
      : {}),
    lines,
    generation,
    revision: ++revision,
    canvas: canvasCommands(session.trace, canvasNames()),
    prompt: prompt(),
    started: session.started,
    source: session.host.source,
    savedLibraries: session.savedLibraries,
    ...(result === undefined ? {} : { result }),
    selection: selection && {
      ...selection,
      lines: session.printedBy(selection.id),
      ...(copy === undefined ? {} : { copy }),
    },
    setup: session.setup,
    pause: session.pauseView(),
    breakpoints: session.breakpointStatus,
    manifest: JSON.parse(session.host.exportManifest()),
  };
};

const post = (response: SessionResponse, id?: number) =>
  scope.postMessage({ ...(id === undefined ? {} : { id }), response });

const replace = (next: PlaygroundSession) => {
  generation++;
  driver.dispose();
  session = next;
  driver = drive(next);
  sent = 0;
  selection = null;
  driver.settle();
};

const replayView = (result: ReplayResult | null): ReplayView => {
  const debug = replay!;
  const pause = debug.current;
  let view: ReplayView['pause'] = null;
  if (pause) {
    const snapshot = debug.snapshot();
    const run = snapshot.scripts
      .flatMap(s => s.runs)
      .find(r => r.id === pause.run);
    view = {
      reason: pause.reason,
      run: pause.run,
      unit: pause.unit,
      line: pause.line,
      ...(pause.error ? { error: pause.error.toString() } : {}),
      ...(pause.limit ? { limit: pause.limit } : {}),
      views: {
        runs: renderDebugView(snapshot, 'runs'),
        mailbox: renderDebugView(snapshot, 'mailbox'),
        vars: renderDebugView(snapshot, 'vars'),
        sources: varSources(snapshot),
      },
      frames: frameViews(run?.frames ?? []),
    };
  }
  return {
    revision: ++revision,
    canvas: canvasCommands(debug.trace, replayCanvasNames),
    state: result?.state ?? (pause ? 'paused' : 'input'),
    hostInputIndex: debug.hostInputIndex,
    hostInputCount: debug.hostInputCount,
    pause: view,
  };
};

// A Setup's source file that no tab or pasted source supplies.
class MissingSource extends Error {
  readonly missing: string;
  constructor(file: string) {
    super(`Missing source ${file}`);
    this.missing = file;
  }
}
const missingFile = (error: unknown): string | undefined =>
  (error as Partial<MissingSource> | null)?.missing;

// A Setup's source file, from a pasted source or a tab of the same name.
const readSource =
  (tabs: Tabs, pasted: Record<string, string>) => (file: string) => {
    if (file in pasted) {
      return pasted[file]!;
    }
    const name = file.replace(/^.*\//u, '').replace(/\.talk$/u, '');
    const library = tabs.libraries.find(l => l.name === name);
    if (library) {
      return library.source;
    }
    if (name === 'session') {
      return tabs.script;
    }
    throw new MissingSource(file);
  };

const handle = (request: SessionRequest): SessionResponse => {
  switch (request.t) {
    case 'open': {
      for (const [slot, text] of Object.entries(request.slots ?? {})) {
        slots.set(slot, text);
      }
      if (request.shared?.transcript) {
        const opened = PlaygroundSession.replay(env, request.shared.transcript);
        if ('difference' in opened) {
          replace(new PlaygroundSession(env));
          replay = null;
          lastReplayed = { setup: opened.setup, trace: opened.trace };
          return {
            t: 'mismatch',
            difference: opened.difference,
            state: state(),
          };
        }
        replace(opened.session);
        lastReplayed = null;
        note('Replayed the shared session; it goes on live from here.');
      } else {
        replace(new PlaygroundSession(env));
        lastReplayed = null;
        for (const command of request.shared?.setup ?? []) {
          session.input(command);
        }
        // Grant canvas and user by default, so drawing and prompts work
        // without any Setup.
        const grants = session.host.setup.scripts![0]!.grants!;
        if (!grants.canvas) {
          session.input(':grant canvas canvas');
        }
        if (!grants.user) {
          session.input(':grant user user');
        }
      }
      return { t: 'state', state: state() };
    }
    case 'line':
      driver.input(request.text);
      break;
    case 'answer': {
      const given = request.answer;
      driver.answer(
        given === null
          ? nothing
          : typeof given === 'boolean'
            ? bool(given)
            : typeof given === 'string'
              ? text(given)
              : list(...given.map(item => text(item))),
      );
      break;
    }
    case 'exampleSetup':
      // Setup is fixed once execution starts, so the next Run fresh,
      // which starts from the setup, enters these.
      for (const command of request.setup) {
        if (!session.setup.includes(command)) {
          session.setup.push(command);
        }
      }
      break;
    case 'fresh': {
      const prepared = session.prepareFresh(request.tabs);
      if (prepared.session) {
        replace(prepared.session);
        note('Fresh session loaded.');
        if (request.launch.trim()) {
          session.input(request.launch);
        }
        driver.settle();
      }
      return { t: 'applied', result: prepared.result, state: state() };
    }
    case 'evaluate':
      if (driver.prompt !== 'entry') {
        note(
          'Finish or cancel the current Entry before evaluating.',
          'warning',
        );
      } else if (request.launch.trim()) {
        session.input(request.launch);
      }
      break;
    case 'selection': {
      if (session.paused || driver.prompt === 'sleeping' || driver.collecting) {
        note(
          'Finish or cancel the current Entry before running a selection.',
          'warning',
        );
        break;
      }
      if (session.host.waiting.k === 'read') {
        note('Answer the read at the < prompt first.', 'warning');
        break;
      }
      if (session.host.waiting.k === 'user') {
        note('Answer the prompt first.', 'warning');
        break;
      }
      const ran = session.runSelection(
        request.source,
        request.how,
        request.tab,
      );
      if ('refused' in ran) {
        note(ran.refused, 'warning');
        driver.settle();
        return { t: 'selected', id: null, state: state() };
      }
      if (request.how !== 'do') {
        selection = {
          how: request.how,
          id: ran.selection,
          source: request.source.trim(),
        };
      }
      driver.settle();
      return { t: 'selected', id: ran.selection, state: state() };
    }
    case 'cancel':
      driver.interrupt();
      break;
    case 'apply': {
      if (session.paused) {
        note('Continue the debugger before applying.', 'warning');
        break;
      }
      const result = session.apply(request.script);
      driver.settle();
      return { t: 'applied', result, state: state() };
    }
    case 'fix': {
      if (!session.pauseView()?.repeated) {
        note(
          'Fix and Continue needs a pause in a Run that can be rewound.',
          'warning',
        );
        break;
      }
      const run = session.pauseView()!.run;
      const result = session.fix(request.script);
      if (result.kind === 'fixed') {
        note(
          session.transcriptEnded
            ? `Rewound ${run}: its message runs again on the new code. The Session Transcript stops before the paused Entry.`
            : 'The Script tab has no new or changed declarations to fix.',
        );
      }
      driver.settle();
      return { t: 'applied', result, state: state() };
    }
    case 'saveLibrary':
      if (session.paused) {
        note('Continue the debugger before saving.', 'warning');
        break;
      }
      session.saveLibrary(request.library);
      break;
    case 'restart': {
      if (session.paused) {
        note('Continue the debugger before restarting.', 'warning');
        break;
      }
      const { session: next, result } = session.restart(request.tabs);
      replace(next);
      note('Restarted: a fresh session from the setup and the tabs.');
      return { t: 'applied', result, state: state() };
    }
    case 'breakpoints':
      session.setBreakpoints(request.breakpoints, request.faults, request.tabs);
      break;
    case 'debug':
      if (!session.paused) {
        note('The session is not paused.', 'warning');
        break;
      }
      session.continueDebug(request.action);
      break;
    case 'transcript':
      return {
        t: 'transcript',
        text: session.transcriptText,
        ended: session.transcriptEnded,
      };
    case 'replayLoad': {
      // A pasted Trace comes with its Setup as JSON, or is a session's. With
      // no Trace, replay the shared session that differed, or this one.
      const [setup, trace]: [Setup, string] =
        request.trace !== undefined
          ? [
              request.setup?.trim()
                ? (JSON.parse(request.setup) as Setup)
                : session.host.setup,
              request.trace,
            ]
          : lastReplayed
            ? [lastReplayed.setup, lastReplayed.trace.join('\n')]
            : [session.host.setup, session.trace.join('\n')];
      replayCanvasNames = [
        ...new Set(
          (setup.scripts ?? []).flatMap(s =>
            Object.entries(s.grants ?? {})
              .filter(
                ([name, grant]) => (grant.capability ?? name) === 'canvas',
              )
              .map(([name]) => name),
          ),
        ),
      ];
      try {
        replay = new ReplayDebugger(
          setup,
          trace,
          readSource(request.tabs, request.sources ?? {}),
        );
      } catch (error) {
        const missing = missingFile(error);
        if (missing !== undefined) {
          return { t: 'needSource', file: missing };
        }
        throw error;
      }
      return { t: 'replay', replay: replayView(null) };
    }
    case 'replay': {
      if (!replay) {
        throw new Error('Load a Trace into the replay debugger first');
      }
      const op = request.op;
      let result: ReplayResult | null;
      if (typeof op === 'string') {
        result =
          op === 'back'
            ? replay.reverseStep()
            : op === 'resume'
              ? replay.resume()
              : replay[op]();
      } else if ('input' in op) {
        result = replay.runToHostInput(op.input);
      } else {
        replay.setBreakpoints(op.breakpoints);
        replay.pauseOn(op.faults);
        result = null;
      }
      return { t: 'replay', replay: replayView(result) };
    }
  }
  driver.settle();
  return { t: 'state', state: state() };
};

// The Trace and Setup of a shared Transcript that replayed differently.
let lastReplayed: { setup: Setup; trace: string[] } | null = null;

scope.onmessage = ({ data: { id, request } }) => {
  let response: SessionResponse;
  try {
    handling = true;
    response = handle(request);
  } catch (error) {
    response = {
      t: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    handling = false;
  }
  post(response, id);
};
