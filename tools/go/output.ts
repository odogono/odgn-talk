import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const formatGo = (source: string): string => {
  const result = Bun.spawnSync(['gofmt'], {
    stdin: new TextEncoder().encode(source),
  });
  if (!result.success) {
    throw new Error(`gofmt failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

export const writeOutput = async (
  path: string,
  content: string,
  check: boolean,
  regenerate: string,
): Promise<void> => {
  if (check) {
    let current: string | undefined;
    try {
      current = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (current !== content) {
      throw new Error(`${path} is stale; run ${regenerate}`);
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
};
