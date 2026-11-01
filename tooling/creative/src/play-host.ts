// The Play worker's side of Browse and Present (#1225): it owns the Play
// Session and the clock that pumps it, applies the page's reader input, and
// tells the page what to draw. Nothing here touches the DOM, so tests drive
// it directly; `play.worker.ts` connects it to the worker's messages.
import type { DeepReadonly } from './readonly';
import {
  type Envelope,
  type Reply,
} from '@northtalk/tooling/worker-supervisor';
import type { DrawingMark } from './drawing';
import {
  type CanvasElement,
  type Element,
  type Page,
  type Project,
} from './model';
import { type MessageReply, valueReply } from './message';
import { PlaySession, PUMP_FUEL, unitLabel, type PendingPrompt } from './play';
import {
  type BreakpointView,
  type DrawingView,
  type PlayRequest,
  type PlayResponse,
  type PlayView,
  type PromptView,
  type SourcePlace,
  type StoppedRun,
} from './play-protocol';
import {
  runLine,
  whenReady,
  type LineEngine,
  type MeasuredReply,
} from './message-line';
import { scriptOwners } from './script-manifest';
import {
  valueEncoder,
  variablesOf,
  type Watch,
  type WatchResult,
} from './variables';
import { type Report } from '@northtalk/ts';
import { type DebugInstruction } from '@northtalk/ts/debug';
import { type SoundBackend } from './sounds';
import { text } from '@northtalk/ts';
import { pointerValue } from './pointer';
import { pausableClock } from '@northtalk/tooling/pausable-clock';
import { PlayClock } from './play-clock';

const wallClock = pausableClock(
  () => BigInt(Math.floor(performance.timeOrigin + performance.now())) * 1000n,
  () => 0,
);

/**
 * An Element as the page receives it: a group without its members, a Canvas
 * without its Drawing, which travels as `DrawingView`s.
 */
// Views cross `postMessage` as copies, so the readonly live node can go as is.
/** The Page's presented placement, omitting the center default. */
const pageAlign = ({ alignX, alignY }: DeepReadonly<Page>) => ({
  ...(alignX ? { alignX } : {}),
  ...(alignY ? { alignY } : {}),
});

const withoutMembers = (element: DeepReadonly<Element>): Element =>
  (element.kind === 'group'
    ? { ...element, members: [] }
    : element.kind === 'canvas'
      ? { ...element, drawing: [] }
      : element) as Element;

/** What changed in each Drawing since `sent` last recorded it. */
const drawingViews = (
  play: PlaySession,
  canvases: Iterable<DeepReadonly<CanvasElement>>,
  sent: Map<DeepReadonly<CanvasElement>, DrawingMark>,
): DrawingView[] => {
  const views: DrawingView[] = [];
  for (const element of canvases) {
    const change = play.drawingChangesSince(element, sent.get(element));
    if (!change) {
      continue;
    }
    sent.set(element, change.mark);
    const owner = play.authoredCanvas(element);
    views.push({
      name: element.name,
      pageIndex: play.pageIndexOf(element),
      ...(owner === undefined ? {} : { owner }),
      reset: change.reset,
      commands: change.commands,
    });
  }
  return views;
};

const canvasesOf = (elements: readonly DeepReadonly<Element>[]) =>
  elements.filter(
    (element): element is DeepReadonly<CanvasElement> =>
      element.kind === 'canvas',
  );

/**
 * The view the page draws while the worker opens its session: the showing
 * Page as authored, before any Script has run.
 */
/** The showing Page's Elements whose Message Path handles `pointerHeld`. */
const heldElements = (play: PlaySession): string[] =>
  play
    .elementsOf()
    .filter(element => play.handles(element, 'pointerHeld'))
    .map(element => element.name);

export const firstView = (
  project: Project,
  pageIndex: number,
  session: number,
): PlayView => {
  const play = new PlaySession(project, pageIndex, { events: false });
  const elements = play.elementsOf().map(element => ({
    element: withoutMembers(element),
    shown: play.isVisible(element),
  }));
  return {
    session,
    full: true,
    drawings: drawingViews(play, canvasesOf(play.elementsOf()), new Map()),
    pageIndex,
    page: {
      name: play.page.name,
      height: play.page.height,
      background: play.page.background,
      ...pageAlign(play.page),
    },
    designWidth: play.project.designWidth,
    order: elements.map(({ element }) => element.name),
    elements,
    pageHandles: {
      keyDown: play.handles(play.page, 'keyDown'),
      keyUp: play.handles(play.page, 'keyUp'),
    },
    heldElements: heldElements(play),
    navigating: false,
    paused: false,
    ended: false,
    wantsFrames: false,
    prompt: undefined,
    notices: [],
    problems: [],
  };
};

// An evaluation's failure as the Message Box shows one.
const evaluationError = (result: { error: string; line?: number }) =>
  result.line === undefined
    ? result.error
    : `line ${result.line}: ${result.error}`;

/** Runs `callback` after `delay` ms; the Play worker's only timer. */
export type Scheduler = {
  cancel(timer: unknown): void;
  schedule(callback: () => void, delay: number): unknown;
};
const timers: Scheduler = {
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class PlayHost {
  #session: PlaySession | undefined;
  readonly #play: PlayClock;
  // Watches (ADR 0129): evaluated in their own Pump, only while paused.
  #watches: Watch[] = [];
  #watchReports: Report[] = [];
  // Each running Watch's Request, and the Watches whose Run caused others.
  #watchRuns = new Map<number, string>();
  #watchEffects = new Set<number>();
  // Breakpoints (ADR 0147), and the loaded Scripts they were last placed in.
  #breakpoints: BreakpointView[] = [];
  #placedIn: string | undefined;
  // The Play clock: Host time less paused time, never going back (ADR 0128).
  readonly #clock: () => bigint;
  #id = 0;
  #performanceTimer: ReturnType<typeof setInterval> | undefined;
  #timer: unknown;
  #owners = new Map<unknown, number>();
  // What the page last received: each Element's JSON, by name.
  #sent = new Map<string, string>();
  #sentDrawings = new Map<DeepReadonly<CanvasElement>, DrawingMark>();
  #sentPage: PlaySession['page'] | undefined;
  #sentState = '';
  #sentTargets = '';
  #pageHandles = { keyDown: false, keyUp: false };
  #heldElements: string[] = [];
  #edits = new WeakMap<DeepReadonly<Element>, number>();
  #problems = 0;
  // The Pump count when the Variables window last asked.
  #variablesPumps = -1;
  #prompts = new WeakMap<PendingPrompt, number>();
  #nextPrompt = 1;
  #voices = new Map<
    number,
    { onEnded(): void; onError(message: string): void }
  >();
  #nextVoice = 1;

  constructor(
    private readonly post: (reply: Reply<PlayResponse>) => void,
    private readonly now: () => bigint = wallClock,
    private readonly performanceNow: () => number = () => performance.now(),
    private readonly scheduler: Scheduler = timers,
  ) {
    this.#play = new PlayClock(performanceNow);
    this.#clock = pausableClock(this.now, () => this.#play.pausedTime());
  }

  receive({ id, request }: Envelope<PlayRequest>): void {
    const reply = (response: PlayResponse) => this.post({ id, response });
    if (request.kind === 'soundEnded') {
      const voice = this.#voices.get(request.voice);
      this.#voices.delete(request.voice);
      if (request.error === undefined) {
        voice?.onEnded();
      } else {
        voice?.onError(request.error);
      }
      this.#schedule();
      reply({ kind: 'done' });
      return;
    }
    if (request.kind === 'open') {
      this.#open(request);
      reply({ kind: 'done' });
      return;
    }
    const session = this.#session;
    // A request for an ended session is answered and ignored.
    if (!session || request.session !== this.#id) {
      reply(
        request.kind === 'message'
          ? { kind: 'message', error: 'Play has stopped.' }
          : { kind: 'done' },
      );
      return;
    }
    switch (request.kind) {
      case 'performance': {
        this.#startPerformance(request.epoch);
        reply({ kind: 'done' });
        return;
      }
      case 'stop': {
        this.#close();
        session.stop(this.#clock());
        this.#publishPerformance();
        this.#publish();
        this.#session = undefined;
        reply({ kind: 'done' });
        return;
      }
      case 'send': {
        // Reader input while paused is dropped, not queued.
        if (this.#play.paused) {
          break;
        }
        // Only a release can name a Page left since its press; its Message
        // Path still leads to any surviving Project Handler.
        const page =
          request.pageIndex === session.pageIndex || request.message === 'keyUp'
            ? session.project.pages[request.pageIndex]
            : undefined;
        const target =
          page &&
          (request.target === undefined
            ? page
            : session.elementsOf(page).find(e => e.name === request.target));
        // A held press reports every frame, so it goes only where handled.
        if (
          target &&
          (request.message !== 'pointerHeld' ||
            session.handles(target, 'pointerHeld'))
        ) {
          session.send(
            target,
            request.message,
            (request.args ?? []).map(arg =>
              typeof arg === 'string' ? text(arg) : pointerValue(arg),
            ),
          );
        }
        break;
      }
      case 'text': {
        const element = session.elementsOf().find(e => e.name === request.name);
        if (
          !this.#play.paused &&
          request.pageIndex === session.pageIndex &&
          element?.kind === 'text' &&
          element.editable &&
          !session.ended &&
          !session.navigating &&
          session.isVisible(element)
        ) {
          session.editText(element, request.richText);
          this.#edits.set(element, request.edit);
        } else if (element) {
          // A refused edit: resend the Element so the page drops its copy.
          this.#sent.delete(element.name);
          this.#edits.set(element, request.edit);
          session.changed = true;
        }
        break;
      }
      case 'answer': {
        session.prompts
          .find(prompt => this.#prompts.get(prompt) === request.prompt)
          ?.answer(request.value);
        break;
      }
      case 'breakpoints': {
        this.#breakpoints = request.breakpoints;
        this.#placedIn = undefined;
        if (!session.debugPaused) {
          this.#placeBreakpoints(session);
        }
        break;
      }
      case 'pauseOnErrors': {
        // Made only when wanted: once made, the Group steps every instruction
        // through it.
        if (request.on || session.debugging) {
          session.debug.pauseOn({ uncaughtError: request.on });
        }
        break;
      }
      case 'selectFrame': {
        this.#play.selectFrame(request.frame);
        if (session.debugPaused) {
          this.#evaluateWatches(session);
        }
        break;
      }
      case 'statementStep': {
        if (session.debugPaused) {
          const debug = session.debug;
          this.#play.continueWith(
            request.step === 'in'
              ? () => debug.step()
              : request.step === 'over'
                ? () => debug.stepOver()
                : () => debug.stepOut(),
          );
        }
        break;
      }
      case 'frame': {
        if (!this.#play.paused) {
          session.frame(this.#clock());
        }
        break;
      }
      case 'pause': {
        this.#play.pause();
        break;
      }
      case 'watches': {
        const ids = new Set(request.watches.map(watch => watch.id));
        for (const id of this.#watchRuns.keys()) {
          if (!ids.has(id)) {
            this.#watchRuns.delete(id);
          }
        }
        this.#watches = request.watches;
        this.#play.watchesChanged();
        if (session.debugPaused) {
          this.#evaluateWatches(session);
        }
        break;
      }
      case 'resume': {
        if (session.debugPaused) {
          this.#play.continueWith(() => session.debug.resume());
        }
        this.#play.resume();
        break;
      }
      case 'step': {
        if (this.#play.frameStep(session.debugPaused)) {
          session.frame(this.#clock());
        }
        break;
      }
      case 'inspect': {
        reply({
          kind: 'inspection',
          inspection: JSON.stringify(session.inspection(), (_key, value) =>
            typeof value === 'bigint' ? String(value) : value,
          ),
        });
        return;
      }
      case 'variables': {
        const fresh = session.pumps !== this.#variablesPumps;
        this.#variablesPumps = session.pumps;
        reply({
          kind: 'variables',
          ...(fresh ? { scripts: variablesOf(session, this.#owners) } : {}),
        });
        return;
      }
      case 'message': {
        const answer = (shown: MessageReply) =>
          reply({ kind: 'message', ...shown });
        if (session.debugPaused) {
          // A Stopped Run's engine is synchronous: the reply comes first.
          answer(
            runLine(request.text, this.#stoppedEngine(session)) as MessageReply,
          );
          this.#evaluateWatches(session);
          this.#publish();
          return;
        }
        void whenReady(
          runLine(request.text, this.#runningEngine(session, request.target)),
          answer,
        );
        return;
      }
    }
    this.#schedule();
    reply({ kind: 'done' });
  }

  #open(request: Extract<PlayRequest, { kind: 'open' }>): void {
    if (this.#session) {
      this.#close();
      this.#session.stop(this.#clock());
    }
    this.#id = request.session;
    this.#owners = new Map(
      scriptOwners(request.project).map((owner, i) => [owner, i]),
    );
    this.#sent.clear();
    this.#sentDrawings.clear();
    this.#sentPage = undefined;
    this.#sentState = '';
    this.#sentTargets = '';
    this.#problems = 0;
    this.#variablesPumps = -1;
    this.#voices.clear();
    this.#watches = [];
    this.#watchReports = [];
    this.#watchRuns.clear();
    this.#watchEffects.clear();
    this.#breakpoints = [];
    this.#placedIn = undefined;
    this.#play.newSession();
    this.#session = new PlaySession(request.project, request.pageIndex, {
      // A different game each time (ADR 0096).
      seed: request.seed,
      // The Performance window leaves out paused time too.
      performanceNow: () => this.performanceNow() - this.#play.pausedTime(),
      soundBackend: this.#relaySound,
      instrumentBackend: message =>
        this.post({
          response: {
            kind: 'instrument',
            session: request.session,
            ...message,
          },
        }),
    });
    if (request.performanceEpoch !== undefined) {
      this.#startPerformance(request.performanceEpoch);
    }
    this.#publish();
    this.#schedule();
  }

  /** Plays through the page's audio, which a worker has none of. */
  #relaySound: SoundBackend = (asset, loop, onEnded, onError) => {
    const voice = this.#nextVoice++;
    this.#voices.set(voice, { onEnded, onError });
    this.post({ response: { kind: 'play', voice, asset, loop } });
    return {
      stop: () => {
        if (this.#voices.delete(voice)) {
          this.post({ response: { kind: 'stopSound', voice } });
        }
      },
    };
  };

  /** Starts each Watch not still running; whether any Run started. */
  #startWatches(session: PlaySession): boolean {
    const results: WatchResult[] = [];
    const encode = valueEncoder(session, this.#owners);
    let started = false;
    for (const { id, target, text } of this.#watches) {
      if (this.#watchRuns.has(id)) {
        continue;
      }
      if (
        target !== undefined &&
        !session.messageTargets.some(loaded => loaded.id === target)
      ) {
        results.push({ id, state: 'unavailable' });
        continue;
      }
      const outcome = session.runWatch(text, target);
      if (!outcome.ok) {
        results.push({ id, state: 'error', error: outcome.error });
        continue;
      }
      started = true;
      const { delivery } = outcome;
      this.#watchRuns.set(id, delivery);
      const settle = (result: WatchResult) => {
        if (this.#session === session && this.#watchRuns.get(id) === delivery) {
          this.#watchRuns.delete(id);
          this.#postWatches([result]);
        }
      };
      outcome.result.then(
        value =>
          settle({
            id,
            state: 'value',
            value: encode(value),
            effects: this.#watchEffects.has(id),
          }),
        (error: unknown) =>
          settle({
            id,
            state: 'error',
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    }
    this.#postWatches(results);
    return started;
  }

  /** Marks Watches still running as waiting, and notes which caused Runs. */
  #finishWatches(pageChanged: boolean): void {
    const reports = this.#watchReports;
    this.#watchReports = [];
    const results: WatchResult[] = [];
    for (const [id, delivery] of this.#watchRuns) {
      const caused = reports.some(
        report =>
          report.kind === 'run started' &&
          report.rootDelivery === delivery &&
          report.delivery !== delivery,
      );
      if (caused) {
        this.#watchEffects.add(id);
      } else {
        this.#watchEffects.delete(id);
      }
      const ended = reports.some(
        report => report.kind === 'run end' && report.delivery === delivery,
      );
      if (!ended) {
        results.push({ id, state: 'waiting' });
      }
    }
    this.#postWatches(results, pageChanged);
  }

  #postWatches(results: WatchResult[], pageChanged?: boolean): void {
    if (results.length || pageChanged !== undefined) {
      this.post({
        response: {
          kind: 'watches',
          session: this.#id,
          results,
          ...(pageChanged === undefined ? {} : { pageChanged }),
        },
      });
    }
  }

  #publishPerformance(): void {
    const session = this.#session;
    const snapshot = session?.performance.snapshot(PUMP_FUEL);
    if (!session || !snapshot) {
      return;
    }
    for (const row of snapshot.scripts) {
      const owner = session.owners.get(row.script);
      const index =
        owner && this.#owners.get(session.authored.get(owner) ?? owner);
      if (index !== undefined) {
        row.owner = index;
      }
      row.script = unitLabel(row.script);
    }
    this.post({
      response: { kind: 'performance', session: this.#id, snapshot },
    });
  }

  #startPerformance(epoch: number): void {
    this.#session!.performance.start(epoch);
    clearInterval(this.#performanceTimer);
    this.#publishPerformance();
    this.#performanceTimer = setInterval(() => this.#publishPerformance(), 250);
  }

  #close(): void {
    this.scheduler.cancel(this.#timer);
    this.#timer = undefined;
    clearInterval(this.#performanceTimer);
    this.#performanceTimer = undefined;
  }

  #schedule(delay = 0): void {
    const session = this.#session;
    if (!session || session.ended) {
      return;
    }
    if (this.#timer !== undefined) {
      if (delay !== 0) {
        return;
      }
      this.scheduler.cancel(this.#timer);
    }
    this.#timer = this.scheduler.schedule(() => {
      this.#timer = undefined;
      if (this.#session !== session) {
        return;
      }
      // A Stopped Run holds the whole session until it is continued.
      const next = this.#play.nextPump(session.debugPaused);
      if (!next) {
        return;
      }
      if (!next.advance) {
        this.#placeBreakpoints(session);
      }
      const clock = this.#clock();
      const result = session.pump(clock, next.outOfBand, next.advance);
      if (session.debugPaused) {
        this.#play.stoppedAt(session.debug.current!.run);
        this.#publish();
        this.#evaluateWatches(session);
        return;
      }
      if (this.#play.watching) {
        this.#watchReports.push(...result.reports);
      }
      const after = this.#play.afterPump(result, clock);
      if (after.sliced) {
        this.#publish();
        this.#schedule();
        return;
      }
      if (after.finishWatches) {
        this.#finishWatches(session.changed);
      }
      this.#publish();
      if (after.startWatches && this.#startWatches(session)) {
        this.#play.watchesStarted();
        this.#schedule();
        return;
      }
      if (after.delay !== undefined) {
        this.#schedule(after.delay);
      }
    }, delay);
  }

  /** Where a loaded code unit's source is in the Project, if an author can open it. */
  #placeOf(session: PlaySession, unit: string): SourcePlace | undefined {
    const library = session.libraryOf(unit);
    if (library) {
      return {
        kind: 'library',
        index: session.project.libraries.findIndex(
          l => l.name === library.name,
        ),
      };
    }
    const owner = session.owners.get(unit);
    const index =
      owner && this.#owners.get(session.authored.get(owner) ?? owner);
    return index === undefined ? undefined : { kind: 'script', owner: index };
  }

  /**
   * Places the Breakpoints in the loaded code, again whenever the loaded
   * Scripts change. A line with no code places nothing.
   */
  #placeBreakpoints(session: PlaySession): void {
    if (!this.#breakpoints.length && !session.debugging) {
      return;
    }
    const loaded = session.group.scriptNames().join('\n');
    if (loaded === this.#placedIn) {
      return;
    }
    this.#placedIn = loaded;
    const at: DebugInstruction[] = [];
    for (const { unit, script } of session.debug.sources()) {
      const place = this.#placeOf(session, unit.name);
      if (!place) {
        continue;
      }
      for (const breakpoint of this.#breakpoints) {
        if (JSON.stringify(breakpoint.place) !== JSON.stringify(place)) {
          continue;
        }
        const pc = unit.code.findIndex(i => i.line === breakpoint.line);
        if (pc >= 0) {
          at.push({ pc, unit: unit.name, ...(script ? { script } : {}) });
        }
      }
    }
    session.debug.breakAt(at);
  }

  /**
   * Runs a body in the selected frame of the stopped Run, through the Core's
   * `evaluate`, which writes no Trace (ADR 0147).
   */
  #evaluate(session: PlaySession, body: string) {
    const frames =
      session.debug
        .snapshot()
        .scripts.flatMap(s =>
          s.runs.filter(r => r.id === session.debug.current!.run),
        )[0]?.frames.length ?? 1;
    // The Core counts frames outermost first.
    const result = session.debug.evaluate(
      body,
      Math.max(0, frames - 1 - this.#play.frame),
    );
    // A Script Variable may have changed, though no Pump ran.
    this.#variablesPumps = -1;
    return result;
  }

  // A Message Box line in the selected frame: an expression, or failing
  // that a command; `:inspect` gives its value's rows.
  /** Runs Message Box lines in a running session, as a Run of their own. */
  #runningEngine(session: PlaySession, target?: number): LineEngine {
    const run = (
      text: string,
      expression: boolean,
      fuel: boolean,
    ): MeasuredReply | Promise<MeasuredReply> => {
      const started = expression
        ? session.runWatch(text, target)
        : session.runMessage(text, target);
      if (!started.ok) {
        return { reply: { error: started.error } };
      }
      if (fuel) {
        session.fuel.measure(started.delivery);
      }
      this.#play.messageSent();
      this.#schedule();
      // Reports reach the measurement before the result settles.
      const row = () =>
        fuel ? session.fuel.take(started.delivery) : undefined;
      return started.result.then(
        value => ({
          reply: expression
            ? { value: valueEncoder(session, this.#owners)(value) }
            : valueReply(value),
          row: row(),
        }),
        (error: unknown) => ({
          reply: {
            error: error instanceof Error ? error.message : String(error),
          },
          row: row(),
        }),
      );
    };
    const replyOf = (measured: ReturnType<typeof run>) =>
      whenReady(measured, m => m.reply);
    return {
      inspect: expression => replyOf(run(expression, true, false)),
      command: text => replyOf(run(text, false, false)),
      fuel: command => run(command, false, true),
    };
  }

  /** Evaluates Message Box lines in the Stopped Run's selected frame. */
  #stoppedEngine(session: PlaySession): LineEngine {
    return {
      fuelRefusal: ':fuel waits until the stopped Run finishes.',
      inspect: expression => {
        const result = this.#evaluate(session, `return ${expression}`);
        return 'value' in result
          ? { value: valueEncoder(session, this.#owners)(result.value) }
          : { error: evaluationError(result) };
      },
      command: text => {
        // An expression first: a bare name compiles as a command that sends,
        // which a Stopped Run refuses.
        let result = this.#evaluate(session, `return ${text}`);
        if ('error' in result && result.line !== undefined) {
          result = this.#evaluate(session, text);
        }
        return 'value' in result
          ? valueReply(result.value)
          : { error: evaluationError(result) };
      },
    };
  }

  // Every Watch, again, in the selected frame.
  #evaluateWatches(session: PlaySession): void {
    const encode = valueEncoder(session, this.#owners);
    this.#postWatches(
      this.#watches.map(({ id, text }): WatchResult => {
        const result = this.#evaluate(session, `return ${text}`);
        return 'value' in result
          ? { id, state: 'value', value: encode(result.value), effects: false }
          : { id, state: 'error', error: evaluationError(result) };
      }),
    );
  }

  /** The stopped Run, with its frames' locals and any error stopping it. */
  #stoppedRun(session: PlaySession): StoppedRun | undefined {
    const pause = session.debugPaused ? session.debug.current : null;
    if (!pause) {
      return undefined;
    }
    const run = session.debug
      .snapshot()
      .scripts.find(s => s.name === pause.script)
      ?.runs.find(r => r.id === pause.run);
    const encode = valueEncoder(session, this.#owners);
    const message = pause.error?.get('message');
    return {
      run: pause.run,
      ...(pause.error
        ? {
            error:
              message?.kind === 'text' && message.asText()
                ? message.asText()!
                : (pause.error.get('code').asText() ?? ''),
          }
        : {}),
      // The Core lists frames outermost first.
      frames: [...(run?.frames ?? [])].reverse().map(frame => {
        const place = this.#placeOf(session, frame.unit);
        const owner = session.owners.get(frame.unit);
        const library = session.libraryOf(frame.unit);
        const where = library
          ? `Library ${library.name}`
          : owner === session.project
            ? 'Project'
            : (owner?.name ?? unitLabel(frame.unit));
        return {
          label: `${frame.handler} in ${where}`,
          line: frame.line,
          locals: frame.locals.map(([name, value]) => [name, encode(value)]),
          ...(place ? { place } : {}),
        };
      }),
    };
  }

  /** Sends the page what changed since it last heard, if anything did. */
  #publish(): void {
    const session = this.#session!;
    const full = this.#sentPage !== session.page;
    if (full) {
      this.#sentPage = session.page;
      this.#sent.clear();
      this.#pageHandles = {
        keyDown: session.handles(session.page, 'keyDown'),
        keyUp: session.handles(session.page, 'keyUp'),
      };
    }
    if (full || session.changed) {
      this.#heldElements = heldElements(session);
    }
    const elements: PlayView['elements'] = [];
    const order: string[] = [];
    if (full || session.changed) {
      const names = new Set<string>();
      for (const element of session.elementsOf()) {
        const edit = this.#edits.get(element);
        const entry = {
          element: withoutMembers(element),
          shown: session.isVisible(element),
          ...(edit === undefined ? {} : { edit }),
        };
        const json = JSON.stringify(entry);
        names.add(element.name);
        order.push(element.name);
        if (this.#sent.get(element.name) !== json) {
          this.#sent.set(element.name, json);
          elements.push(entry);
        }
      }
      for (const name of this.#sent.keys()) {
        if (!names.has(name)) {
          this.#sent.delete(name);
        }
      }
    }
    // Every changed Drawing goes, off-Page ones too, so the page can commit
    // them on return to Edit; a new Page also sends its Canvases' Drawings.
    const drawings = drawingViews(
      session,
      new Set([
        ...session.takeDrawingChanges(),
        ...(full ? canvasesOf(session.elementsOf()) : []),
      ]),
      this.#sentDrawings,
    );
    const first = session.prompts[0];
    if (first && !this.#prompts.has(first)) {
      this.#prompts.set(first, this.#nextPrompt++);
    }
    let prompt: PromptView | undefined;
    if (first) {
      const { answer: _answer, script: _script, ...shown } = first;
      prompt = { ...shown, id: this.#prompts.get(first)! } as PromptView;
    }
    const notices = session.notices.splice(0);
    const problems = session.problems.slice(this.#problems).map(problem => {
      const target = problem.target;
      return {
        line: problem.line,
        message: problem.message,
        owner: this.#owners.get(problem.owner) ?? 0,
        ...(target?.kind === 'library'
          ? {
              target: {
                kind: 'library' as const,
                index: session.project.libraries.findIndex(
                  library => library.name === target.library.name,
                ),
              },
            }
          : {}),
      };
    });
    this.#problems = session.problems.length;
    const targets = session.messageTargets;
    const targetKey = targets.map(target => target.id).join(',');
    const targetsChanged = full || targetKey !== this.#sentTargets;
    this.#sentTargets = targetKey;
    const stoppedRun = this.#stoppedRun(session);
    const state = JSON.stringify([
      stoppedRun,
      this.#play.paused,
      session.navigating,
      session.ended,
      session.wantsFrames,
      prompt?.id,
    ]);
    const orderChanged = full || session.changed;
    session.changed = false;
    if (
      !targetsChanged &&
      !orderChanged &&
      !drawings.length &&
      state === this.#sentState &&
      !notices.length &&
      !problems.length
    ) {
      return;
    }
    this.#sentState = state;
    this.post({
      response: {
        kind: 'view',
        ...(targetsChanged ? { messageTargets: targets } : {}),
        session: this.#id,
        full,
        drawings,
        pageIndex: session.pageIndex,
        page: {
          name: session.page.name,
          height: session.page.height,
          background: session.page.background,
          ...pageAlign(session.page),
        },
        designWidth: session.project.designWidth,
        ...(orderChanged ? { order } : {}),
        elements,
        pageHandles: this.#pageHandles,
        heldElements: this.#heldElements,
        navigating: session.navigating,
        paused: this.#play.paused,
        ...(stoppedRun ? { stoppedRun } : {}),
        ended: session.ended,
        wantsFrames: session.wantsFrames,
        prompt,
        notices,
        problems,
      },
    });
  }
}
