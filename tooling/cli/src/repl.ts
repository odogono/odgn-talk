import { canvasCapabilities } from '@odgn/northtalk-tooling/canvas';
// The TS REPL: a line-at-a-time interface over the Session Host. Its prompt,
// line editing, `:help`, `:quit` and how it is told where to write a
// Transcript are outside parity (chapter 12); everything it prints and
// records comes from the Session Host.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { SessionHost, writeTranscript } from '@odgn/northtalk/session';
import { calendar, locale } from '@odgn/northtalk-tooling/builtins';
import { SessionDriver } from '@odgn/northtalk-tooling/session-driver';
import { promptAnswer, promptLines } from './prompts';

const help = [
  'Enter a declaration, a statement or an expression. An unfinished one',
  'goes on at the next line until the whole Entry is complete.',
  'Ctrl-C cancels the',
  'Run waiting at the prompt, and Ctrl-D or :quit ends the session.',
];

// A real Clock reading, in epoch nanoseconds.
const now = () => BigInt(Date.now()) * 1_000_000n;

export const repl = ({
  transcript,
}: {
  transcript?: string | undefined;
}): Promise<number> => {
  const tty = Boolean(process.stdin.isTTY);
  if (transcript) {
    writeFileSync(transcript, '');
  }
  const host = new SessionHost({
    now,
    capabilities: canvasCapabilities,
    builtIns: { calendar, locale },
    readFile: path => readFileSync(path, 'utf8'),
    writeFile: (directory, file, text) => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, file), text);
    },
    readStoreFile: path => readFileSync(path, 'utf8'),
    writeStoreFile: (path, text) => writeFileSync(path, text),
    ...(transcript
      ? {
          record: item => appendFileSync(transcript, writeTranscript([item])),
        }
      : {}),
  });
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: tty,
  });
  let done!: (code: number) => void;
  const finished = new Promise<number>(resolve => {
    done = resolve;
  });

  const print = (lines: readonly string[]) => {
    if (!lines.length) {
      return;
    }
    if (tty) {
      process.stdout.write('\r\u001B[K');
    }
    for (const line of lines) {
      process.stdout.write(`${line}\n`);
    }
  };
  // A question isn't Session output: on a terminal it shows with the rest,
  // and otherwise it goes to stderr, leaving stdout as the session printed it.
  const ask = (lines: readonly string[]) => {
    for (const line of lines) {
      (tty ? process.stdout : process.stderr).write(`${line}\n`);
    }
  };
  const driver = new SessionDriver(host, {
    now,
    help,
    answerLine: promptAnswer,
    timer: (ms, fire) => {
      const timer = setTimeout(fire, ms);
      return () => clearTimeout(timer);
    },
    emit: event => {
      if (event.k === 'output') {
        print(event.lines);
      } else if (event.k === 'note') {
        print([event.text]);
      } else if (event.k === 'question') {
        ask(promptLines(event.prompt));
      } else if (event.prompt === 'closed') {
        rl.close();
        done(0);
      } else if (tty && event.prompt !== 'sleeping') {
        rl.setPrompt(
          event.prompt === 'read' || event.prompt === 'user'
            ? ''
            : event.prompt === 'continue'
              ? '| '
              : '> ',
        );
        rl.prompt(true);
      }
    },
  });

  rl.on('line', line => driver.input(line));
  // Ctrl-C cancels the Run the prompt waits for, or else drops an unfinished
  // Entry.
  const interrupt = () => {
    if (!driver.interrupt()) {
      print(['(:quit or Ctrl-D ends the session)']);
      driver.settle();
    }
  };
  // Readline reports Ctrl-C only at a terminal.
  if (tty) {
    rl.on('SIGINT', interrupt);
  } else {
    process.on('SIGINT', interrupt);
  }
  rl.on('close', () => driver.end());

  if (tty) {
    print(['NorthTalk REPL. :help shows the Session Commands.']);
  }
  driver.settle();
  return finished;
};
