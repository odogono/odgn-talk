// Chapter 12, Session Transcripts: reading and writing their lines, and
// replaying one through a fresh Session Host.
import { formatInstant, parseInstant } from '../dates';
import { SessionHost } from './host';

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
  const items: TranscriptItem[] = [];
  // The reading the next Pump takes, if a recorded `@` line gave one.
  let offered: bigint | null = null;
  const host = new SessionHost({
    now: () => {
      if (offered === null) {
        throw new Error('The Transcript has no `@` reading for a Pump');
      }
      const at = offered;
      offered = null;
      items.push({ k: 'clock', at });
      return at;
    },
    ...(options.trace ? { trace: options.trace } : {}),
  });
  const print = (lines: readonly string[]) => {
    items.push(...lines.map(text => ({ k: 'output' as const, text })));
  };
  // The first `@` after a line is the reading of the Pump that line causes.
  // One the line didn't use is a Pump the Session Host made at a deadline.
  const reading = (i: number) => {
    const next = recorded[i + 1];
    offered = next?.k === 'clock' ? next.at : null;
    return offered === null ? i : i + 1;
  };
  const deadline = () => {
    if (offered !== null) {
      print(host.tick());
    }
  };
  for (let i = 0; i < recorded.length; i++) {
    const item = recorded[i]!;
    switch (item.k) {
      case 'input':
        items.push(item);
        i = reading(i);
        print(host.input(item.source));
        deadline();
        break;
      case 'read':
        items.push(item);
        i = reading(i);
        print(host.read(item.line));
        deadline();
        break;
      case 'clock':
        offered = item.at;
        print(host.tick());
        offered = null;
        break;
      case 'answer':
        throw new Error('A Transcript answer for a built-in Capability');
      case 'comment':
        items.push(item);
        break;
      case 'output':
        break;
    }
  }
  return { host, items };
};
