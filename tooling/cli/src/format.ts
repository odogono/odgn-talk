import { readFileSync, writeFileSync } from 'node:fs';
import { formatSource } from '@odgn/northtalk-tooling/format';

/** All file and process concerns stay in the CLI, outside the tooling stack. */
export const format = (files: readonly string[], check: boolean): number => {
  let status = 0;
  for (const file of files) {
    try {
      const source = readFileSync(file === '-' ? 0 : file, 'utf8');
      const result = formatSource(source);
      if (result.error) {
        const { code, tok, message } = result.error;
        console.error(`${file}:${tok.line}:${tok.col}: ${code}: ${message}`);
        status = 1;
      } else if (check && result.source !== source) {
        console.error(`${file}: not formatted`);
        status = 1;
      }
      if (!check) {
        if (file === '-') {
          process.stdout.write(result.source);
        } else if (!result.error && result.source !== source) {
          writeFileSync(file, result.source);
        }
      }
    } catch (error) {
      console.error(
        `${file}: ${error instanceof Error ? error.message : error}`,
      );
      status = 1;
    }
  }
  return status;
};
