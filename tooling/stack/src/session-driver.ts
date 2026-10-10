// The Session Driver: the loop that feeds a Session Host from a REPL or the
// Playground (chapter 12). It collects multiline Entries, routes `:help` and
// `:quit`, queues lines typed while the session sleeps, refuses them while a
// debugger holds it paused, and wakes it at its deadlines. It is not
// normative: everything a session prints and records comes from the Session
// Host. The caller supplies the Clock and the timers, and reads its events.
import type { Waiting } from '@odgn/northtalk/session';
import { sessionCommands } from './generated/session';

/** What the driver needs of a Session Host, or of a Host wrapped by Tooling. */
export type DrivenSession = {
  incomplete(source: string): boolean;
  input(source: string): string[];
  readonly nextDeadline: bigint | undefined;
  read(line: string): string[];
  tick(): string[];
  readonly virtualClock: boolean;
  readonly waiting: Waiting;
};

/** What the prompt waits for. */
export type DriverPrompt =
  /** A new Entry. */
  | 'entry'
  /** The next line of an unfinished Entry. */
  | 'continue'
  /** A line for the Foreground Run's `read`. */
  | 'read'
  /** The Foreground Run waits for a deadline; typed lines wait their turn. */
  | 'sleeping'
  /** A debugger holds the session; typed lines are refused. */
  | 'paused'
  /** The session has ended. */
  | 'closed';

export type DriverEvent =
  /** Lines the Session Host printed. */
  | { k: 'output'; lines: string[] }
  /** The driver's own message, such as `:help` or a refused line. */
  | { k: 'note'; level: 'info' | 'warning'; text: string }
  /** The prompt after the driver settles; `closed` comes once. */
  | { k: 'prompt'; prompt: DriverPrompt };

/** Starts a timer, and returns what cancels it. */
export type DriverTimer = (ms: number, fire: () => void) => () => void;

export type SessionDriverOptions = {
  /** Receives every event, in order. */
  emit(event: DriverEvent): void;
  /** What `:help` prints before the Session Commands. */
  help: readonly string[];
  /**
   * Why `:quit` doesn't end this session, for a caller whose session ends some
   * other way. `:help` leaves `:quit` out.
   */
  noQuit?: string;
  /** The Host's Clock reading, in epoch nanoseconds. */
  now(): bigint;
  /** Timers for the sleeping Foreground Run and for background deadlines. */
  timer: DriverTimer;
};

/** Why the debugger refuses a line. */
const PAUSED = 'The session is paused: continue the debugger first.';

/** What `:help` prints: one Session Command's usage, or every command's. */
export const sessionHelp = (
  name: string | undefined,
  intro: readonly string[],
  omit: readonly string[] = [],
): string[] => {
  if (name) {
    const c = sessionCommands.find(
      c => c.name === (name.startsWith(':') ? name : `:${name}`),
    );
    return c ? [c.usage, `  ${c.does}`] : [`No Session Command ${name}`];
  }
  return [
    ...intro,
    '',
    ...sessionCommands
      .filter(c => !omit.includes(c.name))
      .map(c => `  ${c.usage}`),
  ];
};

export class SessionDriver {
  private entry: string[] = [];
  // Lines typed while the session sleeps, in order.
  private readonly queued: string[] = [];
  private sleeping: (() => void) | null = null;
  private background: (() => void) | null = null;
  private closing = false;
  private closed = false;

  constructor(
    private readonly session: DrivenSession,
    private readonly options: SessionDriverOptions,
  ) {}

  /** What the prompt waits for now. */
  get prompt(): DriverPrompt {
    if (this.closed) {
      return 'closed';
    }
    const waiting = this.session.waiting.k;
    if (waiting === 'paused') {
      return 'paused';
    }
    if (waiting === 'read') {
      return 'read';
    }
    if (this.sleeping || waiting === 'deadline') {
      return 'sleeping';
    }
    return this.entry.length ? 'continue' : 'entry';
  }

  /** Whether an unfinished Entry is being collected. */
  get collecting(): boolean {
    return this.entry.length > 0;
  }

  /**
   * One typed line: queued while the session sleeps, refused while a debugger
   * holds it, and otherwise answered, collected or run.
   */
  input(line: string): void {
    if (this.closed) {
      return;
    }
    if (this.session.waiting.k === 'paused') {
      this.note(PAUSED, 'warning');
      this.settle();
      return;
    }
    if (this.sleeping || this.queued.length) {
      this.queued.push(line);
      return;
    }
    this.handle(line);
  }

  /**
   * Cancels the Run the prompt waits for, or else drops an unfinished Entry.
   * Returns false when there is neither.
   */
  interrupt(): boolean {
    if (this.closed) {
      return false;
    }
    if (this.session.waiting.k === 'paused') {
      this.note(PAUSED, 'warning');
      this.settle();
      return true;
    }
    if (this.session.waiting.k !== 'prompt' || this.sleeping) {
      this.submit(':cancel');
      return true;
    }
    if (this.entry.length) {
      this.entry = [];
      this.note('(Entry dropped)');
      this.settle();
      return true;
    }
    return false;
  }

  /**
   * The end of input: once the session wakes and the queued lines have run,
   * enters an unfinished Entry and closes.
   */
  end(): void {
    this.closing = true;
    if (!this.sleeping && !this.queued.length) {
      this.close();
    }
  }

  /** Stops the timers for good, without entering anything. */
  dispose(): void {
    this.stop();
    this.closed = true;
  }

  /**
   * Schedules the next wake after a Host call: sleeps while the Foreground Run
   * waits only for a deadline, and otherwise runs a queued line or pumps at the
   * next background deadline. The driver calls it after its own Host calls; a
   * caller calls it after any other.
   */
  settle(): void {
    if (this.closed) {
      return;
    }
    this.stop();
    const waiting = this.session.waiting;
    if (waiting.k === 'paused') {
      this.emit({ k: 'prompt', prompt: 'paused' });
      return;
    }
    if (waiting.k === 'deadline') {
      this.sleeping = this.wake(waiting.at, () => {
        this.sleeping = null;
      });
      this.emit({ k: 'prompt', prompt: 'sleeping' });
      return;
    }
    if (this.queued.length) {
      this.handle(this.queued.shift()!);
      return;
    }
    if (this.closing) {
      this.close();
      return;
    }
    const next = this.session.nextDeadline;
    if (next !== undefined && !this.session.virtualClock) {
      this.background = this.wake(next, () => {
        this.background = null;
      });
    }
    this.emit({ k: 'prompt', prompt: this.prompt });
  }

  private handle(line: string) {
    if (this.closed) {
      return;
    }
    if (this.session.waiting.k === 'read') {
      this.output(this.session.read(line));
      this.settle();
      return;
    }
    if (!this.entry.length) {
      const command = /^:(\S*)\s*(.*)$/su.exec(line);
      if (command?.[1] === 'quit') {
        if (this.options.noQuit === undefined) {
          this.close();
        } else {
          this.note(this.options.noQuit);
          this.settle();
        }
        return;
      }
      if (command?.[1] === 'help') {
        const omit = this.options.noQuit === undefined ? [] : [':quit'];
        for (const text of sessionHelp(
          command[2] || undefined,
          this.options.help,
          omit,
        )) {
          this.note(text);
        }
        this.settle();
        return;
      }
      // `:fuel` collects a multiline Entry like any other.
      if (command && !this.session.incomplete(line)) {
        this.submit(line);
        return;
      }
      if (!line.trim()) {
        this.settle();
        return;
      }
    }
    this.entry.push(line);
    const source = this.entry.join('\n');
    if (this.session.incomplete(source)) {
      this.settle();
      return;
    }
    this.submit(source);
  }

  private submit(source: string) {
    this.entry = [];
    this.output(this.session.input(source));
    this.settle();
  }

  private wake(at: bigint, fired: () => void): () => void {
    const ms = Math.max(0, Number((at - this.options.now()) / 1_000_000n));
    return this.options.timer(ms, () => {
      fired();
      this.output(this.session.tick());
      this.settle();
    });
  }

  private stop() {
    this.sleeping?.();
    this.background?.();
    this.sleeping = this.background = null;
  }

  private close() {
    if (this.closed) {
      return;
    }
    if (this.entry.length) {
      const source = this.entry.join('\n');
      this.entry = [];
      this.output(this.session.input(source));
    }
    this.dispose();
    this.emit({ k: 'prompt', prompt: 'closed' });
  }

  private output(lines: string[]) {
    if (lines.length) {
      this.emit({ k: 'output', lines });
    }
  }

  private note(text: string, level: 'info' | 'warning' = 'info') {
    this.emit({ k: 'note', level, text });
  }

  private emit(event: DriverEvent) {
    this.options.emit(event);
  }
}
