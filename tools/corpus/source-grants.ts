// Declaration modes for static source checks, which do not run a case's Host.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

type Operation = {
  args?: unknown[];
  capability: string;
  command?: boolean;
  mode: 'immediate' | 'suspending' | 'fire-and-forget';
  name: string;
};
type Grant = { capability?: string; ops: 'all' | string[] };
export const sourceGrants = (file: string) => {
  const path = join(dirname(file), 'case.toml');
  if (!existsSync(path)) {
    return undefined;
  }
  const setup = Bun.TOML.parse(readFileSync(path, 'utf8')) as {
    libraries?: { source: string }[];
    operations?: Operation[];
    scripts?: { grants?: Record<string, Grant>; source: string }[];
  };
  if (!setup.operations?.length) {
    return undefined;
  }
  const operations = setup.operations;
  const library = setup.libraries?.some(l => l.source === basename(file));
  const bindings: Record<string, Grant> = library
    ? Object.fromEntries(operations.map(o => [o.capability, { ops: 'all' }]))
    : (setup.scripts?.find(s => s.source === basename(file))?.grants ?? {});
  return Object.fromEntries(
    Object.entries(bindings).map(([name, grant]) => [
      name,
      Object.fromEntries(
        operations
          .filter(
            o =>
              o.capability === (grant.capability ?? name) &&
              (grant.ops === 'all' || grant.ops.includes(o.name)),
          )
          .map(o => [o.name, o]),
      ),
    ]),
  );
};

/** Case-local Library identities, which need not match their source filenames. */
export const sourceLibraries = (file: string): Map<string, string> => {
  const path = join(dirname(file), 'case.toml');
  if (!existsSync(path)) {
    return new Map();
  }
  const setup = Bun.TOML.parse(readFileSync(path, 'utf8')) as {
    libraries?: { name: string; source: string }[];
  };
  return new Map(
    (setup.libraries ?? []).map(l => [
      l.name,
      readFileSync(join(dirname(file), l.source), 'utf8'),
    ]),
  );
};
