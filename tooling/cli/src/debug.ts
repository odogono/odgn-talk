// Bun Host for chapter 12's live debugger. All process and file I/O stays here.
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { createInterface } from 'node:readline';
import { compileSource, newGroup } from '@odgn/northtalk';
import {
  LiveDebugger,
  copyDebugVar,
  renderDebugView,
  type DebugResult,
  type SourceBreakpoint,
} from '@odgn/northtalk-tooling/debug';

const help = `:break <line>[:<column>]  add a source breakpoint
:clear                   remove breakpoints
:run [message]           deliver a message (default: go)
:continue                resume the paused Run
:step / :over / :out      step by statement
:runs / :mailbox / :vars  inspect the paused Group
:copy <name>             print a Script Variable in source form
:errors on|off           break on caught and uncaught Errors
:limits on|off           break on Limit Faults
:reload                  reload the file, carrying Script Variables; while
                         paused, rerun the paused Run on it (Fix and Continue)
:help / :quit`;

export const debugScript = async (
  file: string,
  trace?: string,
): Promise<number> => {
  const source = readFileSync(file, 'utf8');
  if (trace) {
    const input = statSync(file);
    const output = statSync(trace, { throwIfNoEntry: false });
    if (output && input.dev === output.dev && input.ino === output.ino) {
      throw new Error('Trace file must differ from Script source');
    }
    writeFileSync(trace, '');
  }
  const name = basename(file, extname(file));
  const group = newGroup({
    name: 'debug',
    ...(trace
      ? { trace: (line: string) => appendFileSync(trace, `${line}\n`) }
      : {}),
  });
  const script = group.load({ name, source });
  const debug = new LiveDebugger(group, {
    now: () => BigInt(Date.now()) * 1_000_000n,
  });
  debug.registerSource(compileSource(source, { name }).unit!, name);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  const breaks: SourceBreakpoint[] = [];
  const faults = { error: false, limitFault: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let exitCode = 0;
  // A Fix and Continue waiting for its y/N answer.
  let confirming: (() => void) | null = null;
  const prompt = () => {
    if (process.stdin.isTTY) {
      rl.setPrompt('debug> ');
      rl.prompt();
    }
  };
  const cancelTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const show = (result: DebugResult) => {
    cancelTimer();
    if (result.state === 'paused') {
      const p = result.pause;
      console.log(
        `paused ${p.reason} ${p.unit}:${p.line}:${p.col} ${p.run}${p.limit ? ` ${p.limit}` : ''}${p.error ? ` ${p.error.toString()}` : ''}`,
      );
    } else {
      for (const report of result.reports) {
        if (report.kind === 'run end') {
          console.log(
            `${report.run} ${report.outcome}${report.result ? ` ${report.result.toString()}` : ''}${report.error ? ` ${report.error.toString()}` : ''}`,
          );
          if (
            ['errored', 'limit fault', 'effect failed'].includes(report.outcome)
          ) {
            exitCode = 1;
          }
        }
      }
      if (result.state === 'sliced' || result.nextDeadline !== undefined) {
        const delay =
          result.state === 'sliced'
            ? 0
            : Math.max(
                0,
                Math.ceil(
                  Number(result.nextDeadline! - debug.clock()) / 1_000_000,
                ),
              );
        timer = setTimeout(
          () => {
            try {
              show(debug.pump(undefined, { fuelCap: 10_000 }));
            } catch (error) {
              console.error(error instanceof Error ? error.message : error);
              exitCode = 1;
            }
          },
          Math.min(delay, 2_147_483_647),
        );
      }
    }
    prompt();
  };
  // Check the edit and list what will happen again, then wait for y/N
  // (ADR 0068). Only a Run still in its first Segment can be rewound.
  const fixAndContinue = () => {
    const pause = debug.current!;
    const run = debug
      .snapshot()
      .scripts.find(s => s.name === pause.script)!
      .runs.find(r => r.id === pause.run)!;
    if (!run.rewindable) {
      throw new Error(
        `${pause.run} has passed a Suspension Point, so it can't be rewound; :continue first`,
      );
    }
    const changed = readFileSync(file, 'utf8');
    const compiled = compileSource(changed, { name });
    if (!compiled.unit) {
      throw new Error(
        `not reloaded: ${compiled.diagnostics.map(d => d.message).join('; ')}`,
      );
    }
    const effects = debug
      .repeatedEffects()
      .map(e =>
        e.kind === 'call'
          ? `  call ${e.op} (${e.id})`
          : `  send ${e.message ?? 'a message'} to ${e.to}`,
      );
    console.log(
      `Fix and Continue rewinds ${pause.run} and runs its message again on the new code.`,
    );
    console.log(
      effects.length
        ? `These effects happen again:\n${effects.join('\n')}`
        : 'No effects happen again.',
    );
    console.log(`Rewind ${pause.run} and reload? [y/N]`);
    return () =>
      show(debug.fixAndContinue(changed, 'carry variables', compiled.unit!));
  };
  console.log(
    `NorthTalk live debugger: ${file}\n:help lists commands. :run starts a Handler.`,
  );
  prompt();
  try {
    for await (const line of rl) {
      const [command, ...args] = line.trim().split(/\s+/);
      if (confirming) {
        const confirmed = /^y(es)?$/i.test(line.trim());
        const fix = confirming;
        confirming = null;
        try {
          if (confirmed) {
            fix();
          } else {
            console.log(`not reloaded; ${debug.current!.run} is still paused`);
          }
        } catch (error) {
          console.error(error instanceof Error ? error.message : error);
        }
        prompt();
        continue;
      }
      try {
        if (command === ':quit') {
          break;
        }
        if (command === ':help') {
          console.log(help);
        } else if (command === ':break') {
          if (args.length !== 1 || !/^\d+(?::\d+)?$/.test(args[0]!)) {
            throw new Error('Usage: :break <line>[:<column>]');
          }
          const [line, col] = args[0]!.split(':').map(Number);
          const breakpoint = {
            unit: name,
            script: name,
            line: line!,
            ...(col === undefined ? {} : { col }),
          };
          const resolved = debug
            .setBreakpoints([...breaks, breakpoint])
            .at(-1)!;
          breaks.push(breakpoint);
          console.log(
            resolved.verified
              ? `breakpoint ${name}:${resolved.line}:${resolved.col}`
              : `unverified breakpoint ${name}:${resolved.line}`,
          );
        } else if (command === ':clear') {
          breaks.length = 0;
          debug.clearBreakpoints();
        } else if (command === ':errors' || command === ':limits') {
          if (args.length !== 1 || !['on', 'off'].includes(args[0]!)) {
            throw new Error(`Usage: ${command} on|off`);
          }
          faults[command === ':errors' ? 'error' : 'limitFault'] =
            args[0] === 'on';
          debug.pauseOn(faults);
        } else if (command === ':run') {
          if (debug.isPaused) {
            throw new Error(
              'Resume the paused Run before starting another message',
            );
          }
          if (args.length > 1) {
            throw new Error('Usage: :run [message]');
          }
          script.deliver({ name: args[0] ?? 'go' });
          show(debug.pump(undefined, { fuelCap: 10_000 }));
        } else if (command === ':continue') {
          show(debug.resume());
        } else if (command === ':step') {
          show(debug.step());
        } else if (command === ':over') {
          show(debug.stepOver());
        } else if (command === ':out') {
          show(debug.stepOut());
        } else if (
          command === ':runs' ||
          command === ':mailbox' ||
          command === ':vars'
        ) {
          for (const row of renderDebugView(
            debug.snapshot(),
            command.slice(1) as 'runs' | 'mailbox' | 'vars',
          )) {
            console.log(row);
          }
        } else if (command === ':copy') {
          if (args.length !== 1) {
            throw new Error('Usage: :copy <name>');
          }
          const rows = copyDebugVar(debug.snapshot(), args[0]!);
          if (!rows.length) {
            throw new Error(`No Script Variable is named ${args[0]}`);
          }
          rows.forEach(row => console.log(row));
        } else if (command === ':reload' && debug.isPaused) {
          confirming = fixAndContinue();
        } else if (command === ':reload') {
          const changed = readFileSync(file, 'utf8');
          script.reload(changed, 'carry variables');
          debug.registerSource(compileSource(changed, { name }).unit!, name);
          console.log('reloaded');
        } else if (command) {
          throw new Error('Unknown debug command; :help lists commands');
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      prompt();
    }
  } finally {
    cancelTimer();
    rl.close();
  }
  return exitCode;
};
