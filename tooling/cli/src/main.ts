#!/usr/bin/env bun
// The `northtalk` command (chapter 12, Tooling). The REPL's interface and
// formatting and Lints are outside parity; Session output and recording aren't.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { format } from './format';
import { lintFiles } from './lint';
import { lsp } from './lsp';
import { replay } from './replay';

const usage = `Usage:
  northtalk debug <script> [--trace <file>] live debugger in a Bun Host
  northtalk debug --trace <file> [--setup <file>]
                                          replay debugger (case.toml by default)
  northtalk lsp                           language server over stdio
  northtalk [repl] [--transcript <file>]   start a REPL session
  northtalk replay <transcript> [--trace <file>]
                                          replay a Session Transcript
  northtalk fmt [--check] <file>…          format in place, or check layout
  northtalk fmt [--check] -                read source from stdin
  northtalk lint [--profile beginner|standard] [--manifest <file>] <file>...
                                          print Lints (default: standard)`;

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
      throw new Error(
        `${name} needs ${name === '--profile' ? 'a profile' : 'a file'}`,
      );
    }
    rest.splice(i, 2);
    return value;
  };
  if (command === 'debug') {
    const trace = option('--trace');
    const setup = option('--setup');
    if (trace && rest.length === 0) {
      const { debugTrace } = await import('./debug-replay');
      return debugTrace(trace, setup);
    }
    if (setup) {
      throw new Error('--setup is for Trace replay');
    }
    if (rest.length !== 1 || rest[0]!.startsWith('-')) {
      throw new Error(usage);
    }
    const { debugScript } = await import('./debug');
    return debugScript(rest[0]!, trace);
  }
  if (command === 'lsp') {
    if (rest.length) {
      throw new Error(usage);
    }
    return lsp();
  }
  if (command === 'repl') {
    const transcript = option('--transcript');
    if (rest.length) {
      throw new Error(usage);
    }
    const { repl } = await import('./repl');
    return repl({ transcript });
  }
  if (command === 'fmt') {
    const check = rest.includes('--check');
    const files = rest.filter(arg => arg !== '--check');
    if (
      !files.length ||
      files.some(arg => arg.startsWith('-') && arg !== '-') ||
      files.filter(file => file === '-').length > 1
    ) {
      throw new Error(usage);
    }
    return format(files, check);
  }
  if (command === 'lint') {
    const manifest = option('--manifest');
    const profile = option('--profile') ?? 'standard';
    if (profile !== 'beginner' && profile !== 'standard') {
      throw new Error('--profile must be beginner or standard');
    }
    if (!rest.length || rest.some(arg => arg.startsWith('--'))) {
      throw new Error(usage);
    }
    return lintFiles(rest, profile, manifest);
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
