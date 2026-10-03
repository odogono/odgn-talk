// Chapter 12, Session Transcripts: reading and writing their lines, and
// replaying one through a fresh Session Host.
import { formatInstant, parseInstant } from '../dates';
import type { LocaleImpl } from '../locale-capability';
import { readDisplay } from '../readers';
import type { CalendarImpl } from '../standard-capabilities';
import type { Value } from '../values';
import { SessionHost, type SessionEnvironment } from './host';
import { hostFailure } from './stubs';

/** One line of a Transcript, with an Entry's further lines folded in. */
export type TranscriptItem =
  /** An Entry or a recorded Session Command, its lines joined by LF. */
  | { k: 'input'; source: string }
  /** A line the user typed for `console`'s `read`. */
  | { k: 'read'; line: string }
  /** A real Clock reading, before the Pump it was taken for. */
  | { at: bigint; k: 'clock' }
  /** A built-in Capability's answer to a call. */
  | { answer: string; call: string; k: 'answer' }
  | { k: 'comment'; text: string }
  | { k: 'output'; text: string };

// An output line that is empty or starts with one of these is written after `'`.
const MARKS = new Set(['>', '|', '<', '@', '~', '#', "'"]);

/** Read a Transcript's lines (chapter 12). */
export const parseTranscript = (source: string): TranscriptItem[] => {
  const lines = source.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const items: TranscriptItem[] = [];
  for (const [i, line] of lines.entries()) {
    const fail = (what: string): never => {
      throw new Error(`Transcript line ${i + 1}: ${what}`);
    };
    const rest = (mark: string) =>
      line === mark ? '' : line.startsWith(`${mark} `) ? line.slice(2) : null;
    const mark = line[0] ?? '';
    if (mark === '>') {
      const source = rest('>');
      if (!source) {
        fail('an Entry or Session Command after `> `');
      }
      items.push({ k: 'input', source: source! });
    } else if (mark === '|') {
      const last = items.at(-1);
      const more = rest('|');
      if (last?.k !== 'input' || more === null) {
        fail('a `|` line continues the line before it');
      }
      (last as { source: string }).source += `\n${more}`;
    } else if (mark === '<') {
      const typed = rest('<');
      if (typed === null) {
        fail('a typed line after `< `');
      }
      items.push({ k: 'read', line: typed! });
    } else if (mark === '@') {
      const at = rest('@');
      if (!at) {
        fail('an instant after `@ `');
      }
      items.push({ k: 'clock', at: parseInstant(at!) });
    } else if (mark === '~') {
      const answer = rest('~');
      const space = answer?.indexOf(' ') ?? -1;
      if (!answer || space < 1) {
        fail('a call and its answer after `~ `');
      }
      items.push({
        k: 'answer',
        call: answer!.slice(0, space),
        answer: answer!.slice(space + 1),
      });
    } else if (mark === '#') {
      items.push({ k: 'comment', text: line });
    } else if (mark === "'") {
      items.push({ k: 'output', text: line.slice(1) });
    } else if (line === '') {
      fail("an empty output line is written as `'`");
    } else {
      items.push({ k: 'output', text: line });
    }
  }
  return items;
};

/** Write a Transcript's lines, each ended by an LF. */
export const writeTranscript = (items: readonly TranscriptItem[]): string =>
  items
    .flatMap(item => {
      switch (item.k) {
        case 'input': {
          const [first, ...more] = item.source.split('\n');
          return [`> ${first}`, ...more.map(l => (l ? `| ${l}` : '|'))];
        }
        case 'read':
          return [item.line ? `< ${item.line}` : '<'];
        case 'clock':
          return [`@ ${formatInstant(item.at)}`];
        case 'answer':
          return [`~ ${item.call} ${item.answer}`];
        case 'comment':
          return [item.text];
        case 'output':
          return [
            item.text === '' || MARKS.has(item.text[0]!)
              ? `'${item.text}`
              : item.text,
          ];
      }
    })
    .map(line => `${line}\n`)
    .join('');

export type ReplayOptions = {
  capabilities?: SessionEnvironment['capabilities'];
  /**
   * Where the Session Host turns once the Transcript runs out, so a
   * Playground can go on live from a replayed session: its Clock, its
   * built-in Capabilities, and where later items are recorded.
   */
  live?: Pick<
    SessionEnvironment,
    'builtIns' | 'capabilities' | 'now' | 'record'
  >;
  /** Receives each line of the Group's Trace, without its LF. */
  trace?(line: string): void;
};
export type Replayed = {
  /** The Session Host the Transcript replayed through, as it ended. */
  host: SessionHost;
  /** The Transcript with the output lines the replay printed. */
  items: TranscriptItem[];
};

/**
 * Replay a Transcript through a fresh Session Host (chapter 12, Replaying):
 * each `@` reading is that Pump's Clock reading, and each `<` line answers
 * `read`. The result has the lines it printed in place of the recorded ones.
 */
export const replayTranscript = (
  recorded: readonly TranscriptItem[],
  options: ReplayOptions = {},
): Replayed => {
  // What the Session Host records as it replays, with the comments kept.
  const items: TranscriptItem[] = [];
  // Each built-in Capability's answers, by call, in place of the Capability.
  const answers = new Map<string, string[]>();
  for (const item of recorded) {
    if (item.k === 'answer') {
      answers.set(item.call, [...(answers.get(item.call) ?? []), item.answer]);
    }
  }
  const answer = (call: { id: string }): Value => {
    const recorded = answers.get(call.id)?.shift();
    if (recorded === undefined) {
      throw new Error(`The Transcript has no \`~\` answer for ${call.id}`);
    }
    if (!recorded.startsWith('fail ')) {
      return readDisplay(recorded);
    }
    const error = readDisplay(recorded.slice(5));
    if (!error.entries().length) {
      throw new Error(
        `${call.id} fails with an error that isn't a Script error`,
      );
    }
    throw hostFailure(error);
  };
  // Once the Transcript runs out, the live environment takes over.
  let live = false;
  const builtIn = (operations: readonly string[], impl: object | undefined) =>
    Object.fromEntries(
      operations.map(op => [
        op,
        (call: { id: string }, ...args: unknown[]): Value => {
          if (!live) {
            return answer(call);
          }
          const host = (impl as Record<string, (...a: unknown[]) => Value>)?.[
            op
          ];
          if (!host) {
            throw new Error(`No live built-in answers ${op}`);
          }
          return host.call(impl, call, ...args);
        },
      ]),
    );
  // The reading the next Pump takes, if a recorded `@` line gave one.
  let offered: bigint | null = null;
  const host = new SessionHost({
    ...((options.capabilities ?? options.live?.capabilities)
      ? { capabilities: options.capabilities ?? options.live?.capabilities }
      : {}),
    now: () => {
      if (live) {
        return options.live!.now();
      }
      if (offered === null) {
        throw new Error('The Transcript has no `@` reading for a Pump');
      }
      const at = offered;
      offered = null;
      return at;
    },
    record: item => {
      items.push(item);
      if (live) {
        options.live!.record?.(item);
      }
    },
    builtIns: {
      calendar: builtIn(
        ['today', 'now', 'toCivil', 'toInstant', 'offset', 'zone'],
        options.live?.builtIns?.calendar,
      ) as unknown as CalendarImpl,
      locale: builtIn(
        [
          'compare',
          'rank',
          'upper',
          'lower',
          'numberSymbols',
          'monthNames',
          'dayNames',
          'tag',
        ],
        options.live?.builtIns?.locale,
      ) as unknown as LocaleImpl,
    },
    ...(options.trace ? { trace: options.trace } : {}),
    // Replaying never writes a file: `:export` writes to a scratch directory.
    writeFile: () => {},
  });
  // The first `@` after a line is the reading of the Pump that line causes.
  // One the line didn't use is a Pump the Session Host made at a deadline.
  const reading = (i: number) => {
    const next = recorded[i + 1];
    offered = next?.k === 'clock' ? next.at : null;
    return offered === null ? i : i + 1;
  };
  const deadline = () => {
    if (offered !== null) {
      host.tick();
    }
  };
  for (let i = 0; i < recorded.length; i++) {
    const item = recorded[i]!;
    switch (item.k) {
      case 'input':
        i = reading(i);
        host.input(item.source);
        deadline();
        break;
      case 'read':
        i = reading(i);
        host.read(item.line);
        deadline();
        break;
      case 'clock':
        offered = item.at;
        host.tick();
        offered = null;
        break;
      case 'answer':
        // The built-in Capability's call takes it from `answers`.
        break;
      case 'comment':
        items.push(item);
        break;
      case 'output':
        break;
    }
  }
  live = options.live !== undefined;
  return { host, items };
};
