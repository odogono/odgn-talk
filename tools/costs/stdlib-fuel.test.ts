import { expect, test } from 'bun:test';
import { libraryExports } from '../../impl/ts/src/generated/syntax';
import { stdlibFuel } from './stdlib-fuel';

test('the stdlib Fuel snapshot has a block for every export', () => {
  const headings = stdlibFuel()
    .split('\n\n')
    .slice(1)
    .map(block => block.split('\n')[0]);
  expect(headings.sort()).toEqual(
    libraryExports.map(e => `${e.library}.${e.name}`).sort(),
  );
});
