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
import { type CanvasElement, type Element, type Project } from './model';
import { PlaySession, PUMP_FUEL, unitLabel, type PendingPrompt } from './play';
import {
  type DrawingView,
  type PlayRequest,
  type PlayResponse,
  type PlayView,
  type PromptView,
} from './play-protocol';
import { scriptOwners } from './script-manifest';
import { variablesOf } from './variables';
import { type SoundBackend } from './sounds';
import { text } from '@northtalk/ts';
import { pausableClock } from '@northtalk/tooling/pausable-clock';

const wallClock = pausableClock(
  () => BigInt(Math.floor(performance.timeOrigin + performance.now())) * 1000n,
  () => 0,
);

/**
 * An Element as the page receives it: a group without its members, a Canvas
 * without its Drawing, which travels as `DrawingView`s.
 */
// Views cross `postMessage` as copies, so the readonly live node can go as is.
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
    },
    designWidth: play.project.designWidth,
    order: elements.map(({ element }) => element.name),
    elements,
    pageHandles: {
      keyDown: play.handles(play.page, 'keyDown'),
      keyUp: play.handles(play.page, 'keyUp'),
    },
    navigating: false,
    paused: false,
    stopped: false,
    wantsFrames: false,
    prompt: undefined,
    notices: [],
    problems: [],
  };
};

/** How far a Step moves the Play clock: one frame at 60 Hz, in ms. */
const STEP = 1000 / 60;

export class PlayHost {
  #session: PlaySession | undefined;
  #paused = false;
  #pausedSince = 0;
  // Paused milliseconds so far, less the time Steps have moved on.
  #pausedTotal = 0;
  // Whether the Pumps running now belong to a Step, not the Message Box.
  #stepping = false;
  // The Play clock: Host time less paused time, never going back (ADR 0128).
  readonly #clock: () => bigint;
  #id = 0;
  #performanceTimer: ReturnType<typeof setInterval> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #owners = new Map<unknown, number>();
  // What the page last received: each Element's JSON, by name.
  #sent = new Map<string, string>();
  #sentDrawings = new Map<DeepReadonly<CanvasElement>, DrawingMark>();
  #sentPage: PlaySession['page'] | undefined;
  #sentState = '';
  #sentTargets = '';
  #pageHandles = { keyDown: false, keyUp: false };
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
  ) {
    this.#clock = pausableClock(this.now, this.#pausedTime.bind(this));
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
        if (this.#paused) {
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
        if (target) {
          session.send(
            target,
            request.message,
            (request.args ?? []).map(arg => text(arg)),
          );
        }
        break;
      }
      case 'text': {
        const element = session.elementsOf().find(e => e.name === request.name);
        if (
          !this.#paused &&
          request.pageIndex === session.pageIndex &&
          element?.kind === 'text' &&
          element.editable &&
          !session.stopped &&
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
      case 'frame': {
        if (!this.#paused) {
          session.frame(this.#clock());
        }
        break;
      }
      case 'pause': {
        if (!this.#paused) {
          this.#paused = true;
          this.#pausedSince = this.performanceNow();
        }
        break;
      }
      case 'resume': {
        this.#resumeClock();
        break;
      }
      case 'step': {
        if (!this.#paused) {
          break;
        }
        this.#pausedTotal -= STEP;
        this.#stepping = true;
        session.frame(this.#clock());
        break;
      }
      case 'inspect': {
        reply({
          kind: 'inspection',
          inspection: JSON.stringify(session.group.inspect(), (_key, value) =>
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
        const started = session.runMessage(request.text, request.target);
        if (!started.ok) {
          reply({ kind: 'message', error: started.error });
          return;
        }
        this.#schedule();
        void started.result.then(
          value =>
            reply({
              kind: 'message',
              ...(value.kind === 'nothing'
                ? {}
                : { text: value.asText() ?? String(value) }),
            }),
          (error: unknown) =>
            reply({
              kind: 'message',
              error: error instanceof Error ? error.message : String(error),
            }),
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
    // A new session starts unpaused; its paused time stays in the clock.
    this.#resumeClock();
    this.#session = new PlaySession(request.project, request.pageIndex, {
      // A different game each time (ADR 0096).
      seed: request.seed,
      // The Performance window leaves out paused time too.
      performanceNow: () => this.performanceNow() - this.#pausedTime(),
      soundBackend: this.#relaySound,
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

  #pausedTime(): number {
    return (
      this.#pausedTotal +
      (this.#paused ? this.performanceNow() - this.#pausedSince : 0)
    );
  }

  #resumeClock(): void {
    if (this.#paused) {
      this.#pausedTotal += this.performanceNow() - this.#pausedSince;
      this.#paused = false;
    }
    this.#stepping = false;
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
    clearTimeout(this.#timer);
    this.#timer = undefined;
    clearInterval(this.#performanceTimer);
    this.#performanceTimer = undefined;
  }

  #schedule(delay = 0): void {
    const session = this.#session;
    if (!session || session.stopped) {
      return;
    }
    if (this.#timer !== undefined) {
      if (delay !== 0) {
        return;
      }
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#session !== session) {
        return;
      }
      const clock = this.#clock();
      // While paused, only a Step's Pumps count as frames of work.
      const result = session.pump(clock, this.#paused && !this.#stepping);
      if (result.state === 'sliced') {
        this.#publish();
        this.#schedule();
        return;
      }
      this.#stepping = false;
      this.#publish();
      // No time passes while paused, so no deadline can come due.
      if (!this.#paused && result.nextDeadline !== undefined) {
        this.#schedule(
          Math.min(
            2_147_483_647,
            Math.max(0, Number((result.nextDeadline - clock) / 1000n)),
          ),
        );
      }
    }, delay);
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
    const state = JSON.stringify([
      this.#paused,
      session.navigating,
      session.stopped,
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
        },
        designWidth: session.project.designWidth,
        ...(orderChanged ? { order } : {}),
        elements,
        pageHandles: this.#pageHandles,
        navigating: session.navigating,
        paused: this.#paused,
        stopped: session.stopped,
        wantsFrames: session.wantsFrames,
        prompt,
        notices,
        problems,
      },
    });
  }
}
