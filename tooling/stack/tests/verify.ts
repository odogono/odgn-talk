// The same fixtures run under Bun, Node and an actual browser module.
import { lint } from '../src/lint';
import { fixtures } from './fixtures';
export const verifyLintFixtures = (): number => {
  for (const { id, positive, negative, options } of fixtures) {
    for (const [source, expected] of [
      [positive, true],
      [negative, false],
    ] as const) {
      const result = lint(source, { ...options, profile: 'beginner' });
      if (
        result.diagnostics.length ||
        result.lints.some(item => item.id === id) !== expected
      ) {
        throw new Error(`${id}: expected ${expected} for ${source}`);
      }
    }
  }
  return fixtures.length * 2;
};
