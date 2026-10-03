// File and stdio concerns for the browser-safe replay debugger.
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseTranscript, replayTranscript } from '@odgn/northtalk/session';
import { sessionSetup, type Setup } from '@odgn/northtalk/replay';
import {
  ReplayDebugger,
  renderDebugView,
  type ReplayResult,
  type SourceBreakpoint,
} from '@odgn/northtalk-tooling/debug';

const help = `:break <unit>:<line>[:<column>]  add a source breakpoint
:clear                         remove breakpoints
:continue                      replay until a break or end
:step / :over / :out            step by statement
:back                          reverse one statement
:input <n>                     run to zero-based Host Input n
:runs / :mailbox / :vars        inspect the paused Group
:errors on|off                 break on Errors
:limits on|off                 break on Limit Faults
:help / :quit`;

export const debugTrace = async (
  file: string,
  setupFile?: string,
): Promise<number> => {
  const setupPath = resolve(setupFile ?? resolve(dirname(file), 'case.toml'));
  const dir = dirname(setupPath);
  const text = readFileSync(setupPath, 'utf8');
  const parsed = (
    extname(setupPath) === '.json' ? JSON.parse(text) : Bun.TOML.parse(text)
  ) as Setup & { kind?: string };
  const setup =
    parsed.kind === 'transcript'
      ? sessionSetup(
          replayTranscript(
            parseTranscript(
              readFileSync(resolve(dir, 'session.transcript'), 'utf8'),
            ),
          ).host,
        )
      : parsed;
  const debug = new ReplayDebugger(setup, readFileSync(file, 'utf8'), path =>
    readFileSync(resolve(dir, path), 'utf8'),
  );
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  const breaks: SourceBreakpoint[] = [];
  const faults = { error: false, limitFault: false };
  let exitCode = 0;
  const prompt = () => {
    if (process.stdin.isTTY) {
      rl.setPrompt('replay> ');
      rl.prompt();
    }
  };
  const show = (result: ReplayResult) => {
    if (result.state === 'paused') {
      const p = result.pause;
      console.log(
        `paused ${p.reason} ${p.unit}:${p.line}:${p.col} ${p.run}${p.limit ? ` ${p.limit}` : ''}${p.error ? ` ${p.error.toString()}` : ''}`,
      );
    } else if (result.state === 'input') {
      console.log(
        `Host Input ${result.hostInputIndex}${result.applied ? ' (applied inside the preceding Pump)' : ''}`,
      );
    } else {
      for (const report of debug.reports) {
        if (report.kind !== 'run end') {
          continue;
        }
        console.log(
          `${report.run} ${report.outcome}${report.result ? ` ${report.result.toString()}` : ''}${report.error ? ` ${report.error.toString()}` : ''}`,
        );
        if (
          ['errored', 'limit fault', 'effect failed'].includes(report.outcome)
        ) {
          exitCode = 1;
        }
      }
      console.log('end of Trace');
    }
  };
  console.log(
    `NorthTalk replay debugger: ${file}\n${debug.hostInputCount} Host Inputs. :help lists commands. :continue starts replay.`,
  );
  prompt();
  try {
    for await (const line of rl) {
      const [command, ...args] = line.trim().split(/\s+/);
      try {
        if (command === ':quit') {
          break;
        }
        if (command === ':help') {
          console.log(help);
        } else if (command === ':break') {
          const target =
            args.length === 1
              ? /^(?:([^:]+):)?(\d+)(?::(\d+))?$/.exec(args[0]!)
              : null;
          if (!target) {
            throw new Error('Usage: :break <unit>:<line>[:<column>]');
          }
          const unit =
            target[1] ??
            (setup.scripts?.length === 1 ? setup.scripts[0]!.name : undefined);
          if (!unit) {
            throw new Error(
              'Choose a Script or Library unit for the breakpoint',
            );
          }
          const breakpoint = {
            unit,
            line: Number(target[2]),
            ...(target[3] ? { col: Number(target[3]) } : {}),
          };
          const resolved = debug
            .setBreakpoints([...breaks, breakpoint])
            .at(-1)!;
          breaks.push(breakpoint);
          console.log(
            `${resolved.verified ? 'breakpoint' : 'pending breakpoint'} ${unit}:${breakpoint.line}`,
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
        } else if (command === ':input') {
          if (args.length !== 1 || !/^\d+$/.test(args[0]!)) {
            throw new Error('Usage: :input <n>');
          }
          show(debug.runToHostInput(Number(args[0])));
        } else if (command === ':continue') {
          show(debug.resume());
        } else if (command === ':step') {
          show(debug.step());
        } else if (command === ':over') {
          show(debug.stepOver());
        } else if (command === ':out') {
          show(debug.stepOut());
        } else if (command === ':back') {
          show(debug.reverseStep());
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
        } else if (command) {
          throw new Error('Unknown replay command; :help lists commands');
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        exitCode = 2;
      }
      prompt();
    }
  } finally {
    rl.close();
  }
  return exitCode;
};
