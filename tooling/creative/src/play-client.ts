// The page's handle on the worker's Play Session (#2270). It sits between
// play-view.ts's DOM code and the transport, and owns what the page knows of
// the session: its id, so word about an earlier one is dropped; the Project
// generation it loaded; the Scripts' and Libraries' text as loaded, which
// Breakpoints, Punch In and Revert are placed against; and the route a
// control's or Instrument Parameter's change takes, to the audio first and
// then to the worker to record (#1904, ADR 0167).
import { boundChange } from './bindings';
import { type CodeSelection } from './code-browser-panel';
import { type InstrumentMessage } from './instruments/session';
import { type LiveParameter } from './instruments/live';
import { type Element, type Project } from './model';
import { type PunchReply } from './play';
import {
  type BreakpointView,
  type FrameView,
  type PlayRequest,
  type PlayResponse,
  type SourcePlace,
} from './play-protocol';
import { knownOwnerId, scriptOwners } from './script-manifest';
import { type LoadedSource, type SourceBreakpoints } from './scripts';

/**
 * How the client reaches the session: the worker supervisor in the page, or
 * a `PlayHost` in-process in tests. `request` resolves with the reply;
 * `onEvent` hears every message, replies included, in order, before the
 * request it answers resolves; `end` asks for a session's Stop, and may end
 * a worker that doesn't answer in time (ADR 0107).
 */
export type PlayTransport = {
  end(request: Extract<PlayRequest, { kind: 'stop' }>): Promise<PlayResponse>;
  onEvent(listener: (response: PlayResponse) => void): void;
  request(
    request: PlayRequest,
    transfer?: Transferable[],
  ): Promise<PlayResponse>;
};

/** A request without its `session`, which the client fills in. */
export type SessionRequest =
  Extract<PlayRequest, { session: number }> extends infer R
    ? R extends unknown
      ? Omit<R, 'session'>
      : never
    : never;

/** An `open` request's fields other than its session and Project. */
export type OpenFields = Omit<
  Extract<PlayRequest, { kind: 'open' }>,
  'kind' | 'project' | 'session'
>;

/** A control's fields as the reader set them (#1902). */
export type ControlFields = Record<string, number | boolean>;

/** Where the client sends Instrument commands: the page's audio, if any. */
export type ParameterAudio = {
  send(message: InstrumentMessage): boolean;
};

export type PlayClientOptions = {
  /** The page's Instrument audio for the session, if it has one. */
  audio(): ParameterAudio | undefined;
  /** The Code Browser's Breakpoints, and where it shows what Play loaded. */
  breakpoints: {
    all(): readonly SourceBreakpoints[];
    setLoaded(loaded: LoadedSource | undefined): void;
  };
  /** Whether Breakpoints apply now: while browsing a live session. */
  browsing(): boolean;
  /** The editor's Project generation, which changes with each Project. */
  generation(): number;
};

/** What a Punch In from the page came to. */
export type PunchOutcome =
  /** The source isn't loaded in this session, as another Page's Script. */
  | { kind: 'unplaced' }
  /** Play moved on to another session before the reply. */
  | { kind: 'stale' }
  | PunchReply;

export class PlayClient {
  readonly #transport: PlayTransport;
  readonly #options: PlayClientOptions;
  #id = 0;
  #generation: number | undefined;
  // Each owner's Script and each Library's source as the session loaded
  // them, by `ownerId` and Library id; the places the worker names.
  #scripts = new Map<number, string>();
  #libraries = new Map<number, string>();
  #project: Project | undefined;
  #sentBreakpoints = '';
  // A control's changes (#1902): one at a time per control, the latest
  // merged into any still waiting, so a drag never queues a Run per frame.
  readonly #pendingControls = new Map<
    string,
    { applied: boolean; waiting?: ControlFields }
  >();

  constructor(transport: PlayTransport, options: PlayClientOptions) {
    this.#transport = transport;
    this.#options = options;
  }

  /** The current session's id; 0 before the first. */
  get session(): number {
    return this.#id;
  }

  /**
   * Whether the editor still has the Project the last session loaded, so
   * what that session names can be found in it.
   */
  projectCurrent(): boolean {
    return (
      this.#generation !== undefined &&
      this.#generation === this.#options.generation()
    );
  }

  /**
   * Hears the worker's messages, less those about an earlier session. Sound
   * commands carry no session, and always arrive.
   */
  onEvent(listener: (response: PlayResponse) => void): void {
    this.#transport.onEvent(response => {
      if (!('session' in response) || response.session === this.#id) {
        listener(response);
      }
    });
  }

  /**
   * Starts a new session of `project`, as the editor has it now. `fields`
   * gets the new session's id, for what is reset per session.
   */
  open(
    project: Project,
    fields: (session: number) => OpenFields,
    transfer: Transferable[] = [],
  ): number {
    const session = ++this.#id;
    this.#generation = this.#options.generation();
    this.#project = project;
    // The editor gives every owner and Library an id (ProjectTree).
    this.#scripts = new Map(
      scriptOwners(project).flatMap(owner => {
        const id = knownOwnerId(owner);
        return id === undefined ? [] : [[id, owner.script ?? '']];
      }),
    );
    this.#libraries = new Map(
      project.libraries.flatMap(library =>
        library.id === undefined ? [] : [[library.id, library.source]],
      ),
    );
    this.#sentBreakpoints = '';
    void this.#transport.request(
      { kind: 'open', ...fields(session), session, project },
      transfer,
    );
    return session;
  }

  /** Posts `request` to the current session, not waiting for its reply. */
  send(request: SessionRequest): void {
    void this.#transport.request(this.#sessioned(request));
  }

  /** Posts `request`, and resolves with its reply, or undefined if Play moved on. */
  async ask(request: SessionRequest): Promise<PlayResponse | undefined> {
    const asked = this.#id;
    const reply = await this.#transport.request(this.#sessioned(request));
    return asked === this.#id ? reply : undefined;
  }

  /** Tells the worker a sound it asked for ended, or failed with `error`. */
  soundEnded(voice: number, error?: string): void {
    void this.#transport.request({
      kind: 'soundEnded',
      voice,
      ...(error === undefined ? {} : { error }),
    });
  }

  /**
   * Stops the session: the Code Browser no longer shows loaded source, and
   * the transport may end a worker that doesn't answer (ADR 0107).
   */
  end(): Promise<PlayResponse> {
    this.#options.breakpoints.setLoaded(undefined);
    return this.#transport.end({ kind: 'stop', session: this.#id });
  }

  /** Where `source` is in the session, if it loaded it. Test Scripts never load. */
  placeOf = (source: CodeSelection): SourcePlace | undefined =>
    source.kind !== 'test' && this.#loaded(source.kind).has(source.id)
      ? { kind: source.kind, id: source.id }
      : undefined;

  /** `source`'s text as the session loaded it, or Punched In since. */
  loadedSource: LoadedSource = source => {
    const place = this.placeOf(source);
    return place && this.#loaded(place.kind).get(place.id);
  };

  /** Whether the session loaded the Script owned by `id`. */
  loadedScript(id: number): boolean {
    return this.#scripts.has(id);
  }

  /** Where a frame's line is in the authored Project, if it was loaded. */
  stoppedAt(
    frame: FrameView | undefined,
  ): { line: number; source: CodeSelection } | undefined {
    const place = frame?.place;
    return place && this.#loaded(place.kind).has(place.id)
      ? { line: frame.line, source: { kind: place.kind, id: place.id } }
      : undefined;
  }

  /**
   * Shows the Code Browser what the session loaded and sends its
   * Breakpoints, as a browsing session starts.
   */
  loadBreakpoints(): void {
    this.#sentBreakpoints = '';
    this.#options.breakpoints.setLoaded(this.loadedSource);
    this.sendBreakpoints();
  }

  /**
   * Sends the Breakpoints set in source as the session loaded it, while
   * browsing; those in source edited since then stay behind (ADR 0147).
   * Sends nothing when they haven't changed.
   */
  sendBreakpoints(): void {
    if (!this.#options.browsing()) {
      return;
    }
    const breakpoints: BreakpointView[] = this.#options.breakpoints
      .all()
      .flatMap(({ lines, source, text }) => {
        const place = this.placeOf(source);
        return place && this.loadedSource(source) === text
          ? lines.map(line => ({ line, place }))
          : [];
      });
    const json = JSON.stringify(breakpoints);
    if (json !== this.#sentBreakpoints) {
      this.#sentBreakpoints = json;
      this.send({ kind: 'breakpoints', breakpoints });
    }
  }

  /**
   * Punches In `text` as `source`'s new source (ADR 0157). Once the session
   * takes it, now or at a bar, it is the loaded text, and the Breakpoints
   * set in it go.
   */
  async punchIn(source: CodeSelection, text: string): Promise<PunchOutcome> {
    const place = this.placeOf(source);
    if (!place) {
      return { kind: 'unplaced' };
    }
    const response = await this.ask({ kind: 'punchIn', place, source: text });
    if (response?.kind !== 'punchIn') {
      return { kind: 'stale' };
    }
    const { reply } = response;
    if (reply.kind === 'now' || reply.kind === 'bar') {
      this.#loaded(place.kind).set(place.id, text);
      this.#options.breakpoints.setLoaded(this.loadedSource);
      this.sendBreakpoints();
    }
    return reply;
  }

  /**
   * A control's change on the Page at `pageIndex` (#1902): its bound
   * parameters go straight to the audio, and the worker is then told to
   * set the fields, only recording the parameters when every one was sent
   * (`applied`, #1904). Changes to a control whose last is still being
   * handled wait, merged, and go together once it is.
   */
  control(element: Element, fields: ControlFields, pageIndex: number): void {
    const applied = this.#applyBindings(element, fields);
    const key = `${pageIndex}/${element.name}`;
    const busy = this.#pendingControls.get(key);
    if (busy) {
      busy.waiting = { ...busy.waiting, ...fields };
      busy.applied = busy.applied && applied;
      return;
    }
    const state: { applied: boolean; waiting?: ControlFields } = {
      applied: true,
    };
    this.#pendingControls.set(key, state);
    const deliver = (next: ControlFields, nextApplied: boolean) =>
      void this.#transport
        .request(
          this.#sessioned({
            kind: 'control',
            pageIndex,
            target: element.name,
            fields: next,
            ...(nextApplied ? { applied: true } : {}),
          }),
        )
        .finally(() => {
          const waiting = state.waiting;
          const waitingApplied = state.applied;
          state.waiting = undefined;
          state.applied = true;
          if (waiting) {
            deliver(waiting, waitingApplied);
          } else {
            this.#pendingControls.delete(key);
          }
        });
    deliver(fields, applied);
  }

  /**
   * An Instrument Parameter's authored change while browsing (#2081): sent
   * to the audio as a bound control's is, then recorded by the worker.
   */
  setParameter(change: LiveParameter): void {
    const applied = this.#sendParameter(
      change.instrument,
      change.parameter,
      change.value,
    );
    this.send({
      kind: 'instrumentParameter',
      ...change,
      ...(applied ? { applied: true } : {}),
    });
  }

  /** True when every bound parameter in `fields` went, or none was bound. */
  #applyBindings(element: Element, fields: ControlFields): boolean {
    const project = this.#project;
    let all = true;
    for (const [field, value] of Object.entries(fields)) {
      const bound = project && boundChange(project, element, field, value);
      if (bound?.kind === 'parameter') {
        all =
          this.#sendParameter(bound.instrument, bound.parameter, bound.value) &&
          all;
      }
    }
    return all;
  }

  #sendParameter(
    instrument: string,
    parameter: string,
    value: LiveParameter['value'],
  ): boolean {
    return (
      this.#options.audio()?.send({
        instrument,
        commands: [{ kind: 'set', parameter, value }],
      }) ?? false
    );
  }

  #loaded(kind: SourcePlace['kind']): Map<number, string> {
    return kind === 'library' ? this.#libraries : this.#scripts;
  }

  #sessioned(request: SessionRequest): PlayRequest {
    return { ...request, session: this.#id } as PlayRequest;
  }
}
