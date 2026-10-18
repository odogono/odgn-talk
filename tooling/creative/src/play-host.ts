// The Play worker's side of Browse and Present (#1225): it owns the Play
// Session and the clock that pumps it, applies the page's reader input, and
// tells the page what to draw. Nothing here touches the DOM, so tests drive
// it directly; `play.worker.ts` connects it to the worker's messages.
import type { DeepReadonly } from './readonly';
import {
  type Envelope,
  type Reply,
} from '@northtalk/tooling/worker-supervisor';
import { type Element, type Project } from './model';
import { PlaySession, type PendingPrompt } from './play';
import {
  type PlayRequest,
  type PlayResponse,
  type PlayView,
  type PromptView,
} from './play-protocol';
import { scriptOwners } from './script-manifest';
import { type SoundBackend } from './sounds';
import { text } from '@northtalk/ts';

const wallClock = () =>
  BigInt(Math.floor(performance.timeOrigin + performance.now())) * 1000n;

/** An Element as the page receives it: a group without its members. */
// Views cross `postMessage` as copies, so the readonly live node can go as is.
const withoutMembers = (element: DeepReadonly<Element>): Element =>
  (element.kind === 'group' ? { ...element, members: [] } : element) as Element;

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
    stopped: false,
    wantsFrames: false,
    prompt: undefined,
    notices: [],
    problems: [],
  };
};

export class PlayHost {
  #session: PlaySession | undefined;
  #id = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #owners = new Map<unknown, number>();
  // What the page last received: each Element's JSON, by name.
  #sent = new Map<string, string>();
  #sentPage: PlaySession['page'] | undefined;
  #sentState = '';
  #sentTargets = '';
  #pageHandles = { keyDown: false, keyUp: false };
  #edits = new WeakMap<DeepReadonly<Element>, number>();
  #problems = 0;
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
  ) {}

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
      case 'stop': {
        this.#close();
        session.stop(this.now());
        this.#publish();
        this.#session = undefined;
        reply({ kind: 'done' });
        return;
      }
      case 'send': {
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
        session.frame(this.now());
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
      this.#session.stop(this.now());
    }
    this.#id = request.session;
    this.#owners = new Map(
      scriptOwners(request.project).map((owner, i) => [owner, i]),
    );
    this.#sent.clear();
    this.#sentPage = undefined;
    this.#sentState = '';
    this.#sentTargets = '';
    this.#problems = 0;
    this.#voices.clear();
    this.#session = new PlaySession(request.project, request.pageIndex, {
      // A different game each time (ADR 0096).
      seed: request.seed,
      soundBackend: this.#relaySound,
    });
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

  #close(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
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
      const clock = this.now();
      const result = session.pump(clock);
      this.#publish();
      if (result.state === 'sliced') {
        this.#schedule();
      } else if (result.nextDeadline !== undefined) {
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
    const problems = session.problems.slice(this.#problems).map(problem => ({
      line: problem.line,
      message: problem.message,
      owner: this.#owners.get(problem.owner) ?? 0,
    }));
    this.#problems = session.problems.length;
    const targets = session.messageTargets;
    const targetKey = targets.map(target => target.id).join(',');
    const targetsChanged = full || targetKey !== this.#sentTargets;
    this.#sentTargets = targetKey;
    const state = JSON.stringify([
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
        stopped: session.stopped,
        wantsFrames: session.wantsFrames,
        prompt,
        notices,
        problems,
      },
    });
  }
}
