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
import { parseEntry } from '@odgn/northtalk';
import { SessionHost, writeTranscript } from '@odgn/northtalk/session';
import session from '../../../spec/data/session.toml';
import { calendar, locale } from '@odgn/northtalk-tooling/builtins';

type Command = {
  does: string;
  name: string;
  recorded?: boolean;
  usage: string;
};
const commands = (session as { command: Command[] }).command;

const help = (name: string | undefined): string[] => {
  if (name) {
    const c = commands.find(
      c => c.name === (name.startsWith(':') ? name : `:${name}`),
    );
    return c ? [c.usage, `  ${c.does}`] : [`No Session Command ${name}`];
  }
  return [
    'Enter a declaration, a statement or an expression. An unfinished one',
    'goes on at the next line; an empty line ends it. Ctrl-C cancels the',
    'Run waiting at the prompt, and Ctrl-D or :quit ends the session.',
    '',
    ...commands.map(c => `  ${c.usage}`),
  ];
};

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
  let entry: string[] = [];
  let sleeping: ReturnType<typeof setTimeout> | null = null;
  let background: ReturnType<typeof setTimeout> | null = null;
  let closing = false;
  let ended = false;
  // Lines typed while the Host sleeps wait their turn.
  const queued: string[] = [];
  let done!: (code: number) => void;
  const finished = new Promise<number>(resolve => {
    done = resolve;
  });

  const prompt = () => {
    if (!tty) {
      return;
    }
    rl.setPrompt(host.waiting.k === 'read' ? '' : entry.length ? '| ' : '> ');
    rl.prompt(true);
  };
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
  const quit = () => {
    if (ended) {
      return;
    }
    ended = true;
    for (const timer of [sleeping, background]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    rl.close();
    done(0);
  };

  // After each Host call: sleep while the Foreground Run waits only for a
  // deadline, and otherwise pump at the next background deadline.
  const settle = () => {
    if (background) {
      clearTimeout(background);
      background = null;
    }
    const waiting = host.waiting;
    if (waiting.k === 'deadline') {
      sleeping = setTimeout(
        () => {
          sleeping = null;
          print(host.tick());
          settle();
        },
        Math.max(0, Number((waiting.at - now()) / 1_000_000n)),
      );
      return;
    }
    if (queued.length) {
      handle(queued.shift()!);
      return;
    }
    if (closing) {
      quit();
      return;
    }
    const next = host.nextDeadline;
    if (next !== undefined && !host.virtualClock) {
      background = setTimeout(
        () => {
          background = null;
          print(host.tick());
          settle();
        },
        Math.max(0, Number((next - now()) / 1_000_000n)),
      );
    }
    prompt();
  };

  const submit = (source: string) => {
    entry = [];
    print(host.input(source));
    settle();
  };

  rl.on('line', line => {
    if (sleeping || queued.length) {
      queued.push(line);
    } else {
      handle(line);
    }
  });

  const handle = (line: string) => {
    if (ended) {
      return;
    }
    if (host.waiting.k === 'read') {
      print(host.read(line));
      settle();
      return;
    }
    if (!entry.length) {
      const command = /^:(\S*)\s*(.*)$/su.exec(line);
      if (command?.[1] === 'quit') {
        quit();
        return;
      }
      if (command?.[1] === 'help') {
        print(help(command[2] || undefined));
        settle();
        return;
      }
      if (command) {
        submit(line);
        return;
      }
      if (!line.trim()) {
        settle();
        return;
      }
    }
    // An empty line ends an unfinished Entry, so its syntax error shows.
    if (line.trim() === '' && entry.length) {
      submit(entry.join('\n'));
      return;
    }
    entry.push(line);
    const source = entry.join('\n');
    const parsed = parseEntry(source, () => false);
    if (parsed.error && parsed.incomplete) {
      settle();
      return;
    }
    submit(source);
  };

  // Ctrl-C cancels the Run the prompt waits for, or else drops an unfinished
  // Entry.
  const interrupt = () => {
    if (sleeping) {
      clearTimeout(sleeping);
      sleeping = null;
    }
    if (host.waiting.k !== 'prompt') {
      submit(':cancel');
      return;
    }
    if (entry.length) {
      entry = [];
      print(['(Entry dropped)']);
    } else {
      print(['(:quit or Ctrl-D ends the session)']);
    }
    prompt();
  };
  // Readline reports Ctrl-C only at a terminal.
  if (tty) {
    rl.on('SIGINT', interrupt);
  } else {
    process.on('SIGINT', interrupt);
  }

  rl.on('close', () => {
    closing = true;
    if (!sleeping && !queued.length) {
      quit();
    }
  });

  if (tty) {
    print(['NorthTalk REPL. :help shows the Session Commands.']);
  }
  prompt();
  return finished;
};
