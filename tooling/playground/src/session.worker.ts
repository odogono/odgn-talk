import { canvasCommands } from '@odgn/northtalk-tooling/canvas';
// The session worker: the Playground Host. It owns the Session Host, its
// timers and the replay debugger, and answers the page with the session's
// state after every request and every Pump it makes at a deadline.
import { exportManifest } from '@odgn/northtalk';
import { sessionSetup, type Setup } from '@odgn/northtalk/replay';
import { calendar, locale } from '@odgn/northtalk-tooling/builtins';
import {
  ReplayDebugger,
  renderDebugView,
  type ReplayResult,
} from '@odgn/northtalk-tooling/debug';
import commands from '../../../spec/data/session.toml';
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

let session = new PlaygroundSession(env);
// How much of the session's Transcript the page has been sent.
let sent = 0;
let notes: ConsoleLine[] = [];
let entry: string[] = [];
let sleeping: ReturnType<typeof setTimeout> | null = null;
let background: ReturnType<typeof setTimeout> | null = null;
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
  Object.entries(session.host.grants.granted)
    .filter(([, c]) => c === 'canvas')
    .map(([name]) => name);

const note = (text: string, level: 'info' | 'warning' | 'error' = 'info') =>
  notes.push({ k: 'note', level, text });

type Command = { does: string; name: string; usage: string };
const help = (name: string | undefined): string[] => {
  const all = (commands as { command: Command[] }).command;
  if (name) {
    const c = all.find(
      c => c.name === (name.startsWith(':') ? name : `:${name}`),
    );
    return c ? [c.usage, `  ${c.does}`] : [`No Session Command ${name}`];
  }
  return [
    'Enter a declaration, a statement or an expression. An unfinished one goes on',
    'at the next line until the whole Entry is complete. Cancel stops the Run the prompt',
    'waits for. Apply enters the Script tab; saving a Library tab adds or replaces it.',
    '',
    ...all.filter(c => c.name !== ':quit').map(c => `  ${c.usage}`),
  ];
};

const prompt = (): Prompt => {
  const waiting = session.host.waiting;
  if (waiting.k === 'paused') {
    return 'paused';
  }
  if (waiting.k === 'read') {
    return 'read';
  }
  if (sleeping || waiting.k === 'deadline') {
    return 'sleeping';
  }
  return entry.length ? 'continue' : 'entry';
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
  return {
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
    manifest: JSON.parse(
      exportManifest({
        kind: 'session',
        version: '1',
        grants: session.host.sessionGrants,
      }),
    ),
  };
};

const post = (response: SessionResponse, id?: number) =>
  scope.postMessage({ ...(id === undefined ? {} : { id }), response });

// After each Host call: sleep while the Foreground Run waits only for a
// deadline, and otherwise pump at the next background deadline.
const settle = () => {
  for (const timer of [sleeping, background]) {
    if (timer) {
      clearTimeout(timer);
    }
  }
  sleeping = background = null;
  if (session.paused) {
    return;
  }
  const waiting = session.host.waiting;
  const wake = (at: bigint, foreground: boolean) => {
    const timer = setTimeout(
      () => {
        if (foreground) {
          sleeping = null;
        } else {
          background = null;
        }
        session.tick();
        settle();
        post({ t: 'state', state: state() });
      },
      Math.max(0, Number((at - now()) / 1_000_000n)),
    );
    if (foreground) {
      sleeping = timer;
    } else {
      background = timer;
    }
  };
  if (waiting.k === 'deadline') {
    wake(waiting.at, true);
    return;
  }
  const next = session.host.nextDeadline;
  if (next !== undefined && !session.host.virtualClock) {
    wake(next, false);
  }
};

const replace = (next: PlaygroundSession) => {
  generation++;
  session = next;
  sent = 0;
  entry = [];
  selection = null;
  settle();
};

const line = (text: string) => {
  if (session.paused || sleeping) {
    note(
      'The session is busy: continue the debugger or cancel the Run first.',
      'warning',
    );
    return;
  }
  if (session.host.waiting.k === 'read') {
    session.read(text);
    return;
  }
  if (!entry.length) {
    const command = /^:(\S*)\s*(.*)$/su.exec(text);
    if (command?.[1] === 'help') {
      for (const l of help(command[2] || undefined)) {
        note(l);
      }
      return;
    }
    if (command?.[1] === 'quit') {
      note(
        'A Playground session ends when you close the page, or with Restart.',
      );
      return;
    }
    // `:fuel` collects a multiline Entry like any other.
    if (command && !session.incomplete(text)) {
      session.input(text);
      return;
    }
    if (!text.trim()) {
      return;
    }
  }
  entry.push(text);
  const source = entry.join('\n');
  if (session.incomplete(source)) {
    return;
  }
  entry = [];
  session.input(source);
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
      for (const timer of [sleeping, background]) {
        if (timer) {
          clearTimeout(timer);
        }
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
        // Grant canvas by default, so drawing works without any Setup.
        if (!session.host.grants.granted.canvas) {
          session.input(':grant canvas canvas');
        }
      }
      return { t: 'state', state: state() };
    }
    case 'line':
      line(request.text);
      break;
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
        settle();
      }
      return { t: 'applied', result: prepared.result, state: state() };
    }
    case 'evaluate':
      if (session.host.waiting.k !== 'prompt' || entry.length) {
        note(
          'Finish or cancel the current Entry before evaluating.',
          'warning',
        );
      } else if (request.launch.trim()) {
        session.input(request.launch);
      }
      break;
    case 'selection': {
      if (session.paused || sleeping || entry.length) {
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
      const ran = session.runSelection(
        request.source,
        request.how,
        request.tab,
      );
      if ('refused' in ran) {
        note(ran.refused, 'warning');
        settle();
        return { t: 'selected', id: null, state: state() };
      }
      if (request.how !== 'do') {
        selection = {
          how: request.how,
          id: ran.selection,
          source: request.source.trim(),
        };
      }
      settle();
      return { t: 'selected', id: ran.selection, state: state() };
    }
    case 'cancel':
      if (session.paused) {
        note('Continue the debugger first.', 'warning');
      } else if (entry.length) {
        entry = [];
        note('(Entry dropped)');
      } else if (session.host.waiting.k !== 'prompt' || sleeping) {
        session.input(':cancel');
      }
      break;
    case 'apply': {
      if (session.paused) {
        note('Continue the debugger before applying.', 'warning');
        break;
      }
      const result = session.apply(request.script);
      settle();
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
      return { t: 'transcript', text: session.transcriptText };
    case 'replayLoad': {
      // A pasted Trace comes with its Setup as JSON, or is a session's. With
      // no Trace, replay the shared session that differed, or this one.
      const [setup, trace]: [Setup, string] =
        request.trace !== undefined
          ? [
              request.setup?.trim()
                ? (JSON.parse(request.setup) as Setup)
                : sessionSetup(session.host),
              request.trace,
            ]
          : lastReplayed
            ? [lastReplayed.setup, lastReplayed.trace.join('\n')]
            : [sessionSetup(session.host), session.trace.join('\n')];
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
  settle();
  return { t: 'state', state: state() };
};

// The Trace and Setup of a shared Transcript that replayed differently.
let lastReplayed: { setup: Setup; trace: string[] } | null = null;

scope.onmessage = ({ data: { id, request } }) => {
  let response: SessionResponse;
  try {
    response = handle(request);
  } catch (error) {
    response = {
      t: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  post(response, id);
};
