// Every I/O concern stays here; the shared Lint engine is browser-safe.
import { readFileSync } from 'node:fs';
import {
  lint,
  readManifest,
  type LintProfile,
} from '@odgn/northtalk-tooling/lint';

export const lintFiles = (
  files: readonly string[],
  profile: LintProfile,
  manifestFile?: string,
): number => {
  const manifest = manifestFile
    ? readManifest(readFileSync(manifestFile, 'utf8'))
    : null;
  let code = 0;
  for (const file of files) {
    const result = lint(readFileSync(file, 'utf8'), { profile, manifest });
    for (const { error } of result.diagnostics) {
      console.error(
        `${file}:${error.tok.line}:${error.tok.col}: ${error.code}: ${error.message}`,
      );
      code = 1;
    }
    for (const item of result.lints) {
      console.log(
        `${file}:${item.span.line}:${item.span.col}: ${item.level} [${item.id}] ${item.message}`,
      );
    }
  }
  // Advice never changes loading or the exit status. Syntax errors are separate.
  return code;
};
