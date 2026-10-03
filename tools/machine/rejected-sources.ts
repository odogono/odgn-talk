import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// A diagnostic fixture deliberately cannot be lowered. Read its blessed load
// result, while retaining checks for valid sources and failed inline reloads.
export const rejectedUnits = (trace: string): Set<string> => {
  const rejected = new Set<string>();
  const accepted = new Set<string>();
  let loading: string | undefined;
  let diagnosed = false;
  const finishLoad = () => {
    if (loading && !diagnosed) {
      accepted.add(loading);
    }
  };
  for (const line of trace.split('\n')) {
    if (line.startsWith('> ')) {
      finishLoad();
      diagnosed = false;
      loading = /^> (?:load|add-library) (\S+)(?: |$)/.exec(line)?.[1];
    } else if (loading && line.startsWith(`diag ${loading} `)) {
      rejected.add(loading);
      diagnosed = true;
    }
  }
  finishLoad();
  for (const name of accepted) {
    rejected.delete(name);
  }
  return rejected;
};

export const isRejectedSource = (file: string): boolean => {
  const setupFile = join(dirname(file), 'case.toml');
  const traceFile = join(dirname(file), 'case.trace');
  if (!existsSync(setupFile) || !existsSync(traceFile)) {
    return false;
  }
  const setup = Bun.TOML.parse(readFileSync(setupFile, 'utf8')) as {
    kind: string;
    libraries?: { name: string; source: string }[];
    scripts?: { name: string; source: string }[];
  };
  if (setup.kind !== 'trace') {
    return false;
  }
  const rejected = rejectedUnits(readFileSync(traceFile, 'utf8'));
  const users = [...(setup.scripts ?? []), ...(setup.libraries ?? [])].filter(
    unit => unit.source === basename(file),
  );
  return users.length > 0 && users.every(unit => rejected.has(unit.name));
};
