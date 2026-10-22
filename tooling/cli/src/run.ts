// The Script Runner: `northtalk app.talk [args…]` (chapter 12, The Script
// Runner; ADR 0126). It loads the file as one Script, Delivers `start` and
// runs until nothing can happen again. Runtime-neutral: node:* APIs only, so
// it runs under Bun and in the Node build.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import {
  calendarCapability,
  clockCapability,
  consoleCapability,
  createCore,
  httpCapability,
  list,
  LoadError,
  localeCapability,
  map,
  ScriptError,
  sqliteCapability,
  storeCapability,
  text,
  timerCapability,
  userCapability,
  type Call,
  type CapabilityDef,
  type Costs,
  type Grant,
  type Report,
  type SegmentCoordinator,
  type SqliteImpl,
  type UserImpl,
  type Value,
} from '@northtalk/ts';
import { newDrivenGroup } from '@northtalk/ts/driver';
import { createHttpHost } from '@northtalk/ts/http';
import type { UserPrompt } from '@northtalk/ts/session';
import { memoryStores, sessionQuotas } from '@northtalk/ts/store';
import { calendar, locale } from '@northtalk/tooling/builtins';
import { promptAnswer, promptLines } from './prompts';

export type RunOptions = {
  /** The arguments after the file, given to `start`. */
  args: readonly string[];
  file: string;
  /** Overrides every `serve`'s port; `--port` or `PORT`. */
  port?: number;
};

// How long the first signal waits for open HTTP Exchanges.
const DRAIN_MS = 5000;
// The rows one `sqlite` call may give.
const MAX_ROWS = 10_000;
type SqliteModule = typeof import('@northtalk/ts/sqlite');
const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

// Every Operation costs only its base Fuel: the Runner charges nothing more.
const free: Costs = new Proxy(
  {},
  {
    get: () => ({ fuel: 0 }),
    getOwnPropertyDescriptor: () => ({
      configurable: true,
      enumerable: true,
      value: { fuel: 0 },
      writable: true,
    }),
  },
);

/** Runs the file, and returns the exit code. */
export const runScript = async (o: RunOptions): Promise<number> => {
  const source = readFileSync(o.file, 'utf8');
  const name = scriptName(o.file);
  const core = createCore();
  const tty = Boolean(process.stdin.isTTY);
  const lines = lineReader();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const httpHost = createHttpHost({
    ...(o.port === undefined ? {} : { portOverride: o.port }),
    log: message => process.stderr.write(`${message}\n`),
  });
  // node:sqlite is loaded only by a runtime that has it.
  const sqlite = lazySqlite(
    await import('@northtalk/ts/sqlite').catch(() => undefined),
  );
  const stores = memoryStores(sessionQuotas);
  let failed = false;
  let finish!: (code: number) => void;
  const finished = new Promise<number>(resolve => {
    finish = resolve;
  });

  const { group, drive } = newDrivenGroup(core, {
    name: 'main',
    onPump: result => {
      httpHost.pumped(group, result);
      stores.router.pumped(group);
      for (const report of result.reports) {
        failed = reportProblem(report, o.file, name) || failed;
      }
      if (result.state === 'idle' && result.nextDeadline === undefined) {
        setTimeout(exitIfDone, 0);
      }
    },
    onError: error => {
      process.stderr.write(`${errorText(error)}\n`);
      failed = true;
    },
  });
  // Nothing can happen again: no live Runs or queued messages, no timers,
  // Serve Registrations or open HTTP Exchanges. A pending `console.read` or
  // `user` prompt keeps its Run alive.
  const exitIfDone = () => {
    if (
      stopping ||
      timers.size ||
      httpHost.registrations ||
      httpHost.openExchanges ||
      group
        .inspect()
        .scripts.some(s => s.runs.length > 0 || s.mailbox.length > 0)
    ) {
      return;
    }
    void shutDown(failed ? 1 : 0);
  };

  const capabilities: Record<string, CapabilityDef<unknown>> = {
    console: consoleCapability(
      {
        write: (_call, value) => {
          process.stdout.write(`${value.asText() ?? value.toString()}\n`);
        },
        read: call => lines.wait(call, line => call.answer(text(line))),
      },
      free,
    ),
    clock: clockCapability(free),
    timer: timerCapability(
      {
        schedule: (call, timerName, at, message, args) => {
          const key = `${call.scriptName}\u0000${timerName}`;
          clearTimeout(timers.get(key));
          const ms = Number((at.asInstant()! - nowMicros()) / 1000n);
          timers.set(
            key,
            setTimeout(
              () => {
                timers.delete(key);
                group.script(call.scriptName)?.deliver({
                  name: message,
                  args: Array.from({ length: args.length }, (_, i) =>
                    args.index(i + 1),
                  ),
                });
              },
              Math.min(Math.max(ms, 0), 2 ** 31 - 1),
            ),
          );
        },
        cancel: (call, timerName) => {
          const key = `${call.scriptName}\u0000${timerName}`;
          clearTimeout(timers.get(key));
          timers.delete(key);
        },
      },
      free,
    ),
    calendar: calendarCapability(calendar, free) as CapabilityDef<unknown>,
    locale: localeCapability(locale, free) as CapabilityDef<unknown>,
    store: storeCapability(stores, free) as CapabilityDef<unknown>,
    http: httpCapability(httpHost.impl, free),
    ...(sqlite
      ? {
          sqlite: sqliteCapability(
            sqlite.impl,
            free,
            0,
          ) as CapabilityDef<unknown>,
        }
      : {}),
    ...(tty ? { user: userCapability(terminalUser(lines), free) } : {}),
  };
  const bindings: Record<string, unknown> = {
    calendar: 'UTC',
    locale: 'und',
    store: 'default',
    sqlite: { database: 'main', maxRows: MAX_ROWS },
  };
  const grants: Record<string, Grant<unknown>> = Object.fromEntries(
    Object.entries(capabilities).map(([grant, capability]) => [
      grant,
      capability.grant('all', bindings[grant]),
    ]),
  );

  let stopping = false;
  let closed = false;
  // Stops everything the Runner started; the process then ends by itself.
  const shutDown = async (code: number) => {
    if (closed) {
      return;
    }
    closed = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    try {
      await drive.close();
    } catch (error) {
      process.stderr.write(`${errorText(error)}\n`);
    }
    await httpHost.close();
    lines.close();
    sqlite?.close();
    finish(code);
  };
  let signalled: number | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    const code = SIGNAL_CODES[signal as keyof typeof SIGNAL_CODES] ?? 1;
    if (signalled !== undefined) {
      process.exit(signalled);
    }
    signalled = code;
    stopping = true;
    httpHost.stopAccepting();
    // A Script without a `stop` Handler ends that Run `unhandled`.
    group.script(name)?.deliver({ name: 'stop' });
    // Let the `stop` Run go as far as it can before the Group stops.
    void new Promise(resolve => setTimeout(resolve, 0))
      .then(() => drive.idle())
      .then(() => httpHost.drain(DRAIN_MS))
      .then(() => shutDown(code))
      .catch(error => {
        process.stderr.write(`${errorText(error)}\n`);
        process.exit(code);
      });
  };

  try {
    group.load({ name, source, grants, grantsAsUsed: true });
  } catch (error) {
    if (!(error instanceof LoadError)) {
      throw error;
    }
    for (const d of error.diagnostics) {
      // A diagnostic's message may already begin with its code.
      const message = d.message.startsWith(d.code)
        ? d.message
        : `${d.code}: ${d.message}`;
      process.stderr.write(`${o.file}:${d.line}:${d.col}: ${message}\n`);
    }
    await httpHost.close();
    lines.close();
    sqlite?.close();
    drive.stop();
    return 1;
  }
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  group.script(name)!.deliver({
    name: 'start',
    args: [list(...o.args.map(arg => text(arg)))],
  });
  return finished;
};

/** The Script's name: the file's basename, without `.talk`. */
const scriptName = (file: string): string =>
  basename(file, extname(file)) || 'main';

const nowMicros = () => BigInt(Date.now()) * 1000n;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Writes a Run that ended with an uncaught error, or a Host mistake, to
// standard error. True when the exit code is to be 1.
const reportProblem = (r: Report, file: string, name: string): boolean => {
  const where = (at?: { col: number; line: number; unit: string }) =>
    at && at.unit === name ? `${file}:${at.line}:${at.col}: ` : `${file}: `;
  if (r.kind === 'run end') {
    const handler = r.handler ? ` in ${r.handler}` : '';
    if (r.outcome === 'errored' && r.error) {
      const data = r.error.data;
      const fields =
        data.kind === 'map' ? data.entries().filter(([k]) => k !== 'at') : [];
      process.stderr.write(
        `${where(r.at)}uncaught error${handler}: ${r.error.code}${
          r.error.message ? `: ${r.error.message}` : ''
        }${fields.length ? ` ${map(fields).toString()}` : ''}\n`,
      );
      return true;
    }
    if (r.outcome === 'limit fault' || r.outcome === 'effect failed') {
      process.stderr.write(
        `${where(r.at)}${r.outcome}${handler}${r.limit ? ` (${r.limit})` : ''}\n`,
      );
      return true;
    }
    return false;
  }
  if (r.kind === 'host error' || r.kind === 'call failed') {
    process.stderr.write(`${file}: ${r.kind}: ${r.detail ?? ''}\n`);
    return true;
  }
  return false;
};

// Cancels the Run a call belongs to.
const cancel = (call: Call<unknown>) =>
  call.group.script(call.scriptName)?.cancelRun(call.runId);

type LineWaiter = { call: Call<unknown>; take(line: string): void };

// Standard input's lines, read only while a `console.read` or `user` prompt
// waits, so a Script that reads nothing never holds standard input open. At
// its end, each waiting Run is cancelled.
const lineReader = () => {
  let rl: Interface | undefined;
  let ended = false;
  const buffered: string[] = [];
  const waiting: LineWaiter[] = [];
  const open = () => {
    if (rl || ended) {
      return;
    }
    rl = createInterface({ input: process.stdin, terminal: false });
    rl.on('line', line => {
      const waiter = waiting.shift();
      if (waiter) {
        waiter.take(line);
      } else {
        buffered.push(line);
      }
      if (!waiting.length) {
        rl?.pause();
      }
    });
    rl.on('close', () => {
      ended = true;
      rl = undefined;
      for (const waiter of waiting.splice(0)) {
        cancel(waiter.call);
      }
    });
  };
  return {
    wait(call: Call<unknown>, take: (line: string) => void) {
      const line = buffered.shift();
      if (line !== undefined) {
        take(line);
        return;
      }
      if (ended) {
        // Cancelled once the call is pending, after its start returns.
        queueMicrotask(() => cancel(call));
        return;
      }
      const waiter = { call, take };
      waiting.push(waiter);
      call.signal.addEventListener('abort', () => {
        const at = waiting.indexOf(waiter);
        if (at >= 0) {
          waiting.splice(at, 1);
        }
        if (!waiting.length) {
          rl?.pause();
        }
      });
      open();
      rl?.resume();
    },
    close() {
      ended = true;
      rl?.close();
      process.stdin.pause();
    },
  };
};

// `user` at a terminal, with the REPL's questions and answers.
const terminalUser = (lines: ReturnType<typeof lineReader>): UserImpl => {
  let asking = false;
  const ask = (call: Call<unknown>, prompt: UserPrompt) => {
    if (asking) {
      throw new ScriptError(
        'user busy',
        'Another prompt is waiting for an answer',
      );
    }
    asking = true;
    call.signal.addEventListener('abort', () => {
      asking = false;
    });
    const show = () =>
      process.stdout.write(`${promptLines(prompt).join('\n')}\n`);
    const take = (line: string) => {
      const answer: Value | undefined = promptAnswer(prompt, line);
      if (answer === undefined) {
        show();
        lines.wait(call, take);
        return;
      }
      asking = false;
      call.answer(answer);
    };
    show();
    lines.wait(call, take);
  };
  return {
    confirm: (call, message) => ask(call, { k: 'confirm', message }),
    choose: (call, items, prompt, multiple) =>
      ask(call, { k: 'choose', items, prompt, multiple }),
    enter: (call, message, fallback) =>
      ask(call, { k: 'enter', message, fallback }),
    notify: (_call, message, title) => {
      process.stdout.write(`* ${title ? `${title}: ` : ''}${message}\n`);
    },
  };
};

// `sqlite` on a database in a temporary directory, opened at its first use
// and removed at exit; undefined when the runtime's node:sqlite can't serve.
const lazySqlite = (
  module: SqliteModule | undefined,
): { close(): void; impl: SqliteImpl } | undefined => {
  if (!module) {
    return undefined;
  }
  let directory: string | undefined;
  let impl: SqliteImpl | undefined;
  let database: ReturnType<SqliteModule['openSqliteDatabase']> | undefined;
  const opened = (): SqliteImpl => {
    if (!impl) {
      directory = mkdtempSync(join(tmpdir(), 'northtalk-run-'));
      database = module.openSqliteDatabase(join(directory, 'main.db'));
      impl = module.sqliteDatabases({ main: database });
    }
    return impl;
  };
  // The one database's coordinator, the same object for every Grant.
  const coordinator: SegmentCoordinator = {
    begin: context => opened().coordinator('main').begin(context),
    commit: context => opened().coordinator('main').commit(context),
    rollback: context => opened().coordinator('main').rollback(context),
  };
  return {
    impl: {
      coordinator: () => coordinator,
      query: (...args) => opened().query(...args),
      change: (...args) => opened().change(...args),
      begin: call => opened().begin(call),
      commit: call => opened().commit(call),
      rollback: call => opened().rollback(call),
    },
    close() {
      database?.close();
      if (directory) {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
};
