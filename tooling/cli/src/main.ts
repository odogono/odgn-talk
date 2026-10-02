#!/usr/bin/env bun
// The `northtalk` command (chapter 12, Tooling): the TS REPL, and replaying a
// Session Transcript. Its interface is outside parity; what the Session Host
// prints and records isn't.
import { repl } from './repl';
import { replay } from './replay';

const usage = `Usage:
  northtalk [repl] [--transcript <file>]   start a REPL session
  northtalk replay <transcript> [--trace <file>]
                                          replay a Session Transcript`;

const main = async (args: string[]): Promise<number> => {
  const [command = 'repl', ...rest] = args[0]?.startsWith('--')
    ? ['repl', ...args]
    : args;
  const option = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    if (i < 0) {
      return undefined;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} needs a file`);
    }
    rest.splice(i, 2);
    return value;
  };
  if (command === 'repl') {
    const transcript = option('--transcript');
    if (rest.length) {
      throw new Error(usage);
    }
    return repl({ transcript });
  }
  if (command === 'replay') {
    const trace = option('--trace');
    if (rest.length !== 1) {
      throw new Error(usage);
    }
    return replay(rest[0]!, { trace });
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(usage);
    return 0;
  }
  throw new Error(usage);
};

if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
