import { expect, test } from 'bun:test';
import { checkCommands } from './commands';

const scripts = (directory: string) =>
  new Map([
    ['.', new Set(['check', 'grammar:check', 'corpus:run'])],
    ['impl/ts', new Set(['test:browser'])],
  ]).get(directory);

test('checks inline commands and shell examples, including arguments', () => {
  expect(
    checkCommands(
      '`bun run check`\n```sh\nbun run grammar:check && bun run corpus:run --list\n```',
      scripts,
    ),
  ).toEqual([]);
  expect(checkCommands('Run `bun run missing`.', scripts)).toEqual([
    'line 1: bun run missing: no script "missing" in ./package.json',
  ]);
});

test('resolves an explicit working directory without falling back to root', () => {
  expect(checkCommands('bun run --cwd impl/ts test:browser', scripts)).toEqual(
    [],
  );
  expect(checkCommands('bun run test:browser', scripts)).toHaveLength(1);
  expect(checkCommands('bun run --cwd impl/ts check', scripts)).toHaveLength(1);
  expect(checkCommands('bun run --cwd absent check', scripts)).toEqual([
    'line 1: bun run --cwd absent check: no package.json in absent',
  ]);
});

test('checks each command and reports its source line', () => {
  expect(
    checkCommands('Example:\n\nbun run lost && bun run gone', scripts),
  ).toEqual([
    'line 3: bun run lost: no script "lost" in ./package.json',
    'line 3: bun run gone: no script "gone" in ./package.json',
  ]);
});

test('ignores placeholders, direct file execution and incomplete commands', () => {
  expect(
    checkCommands(
      'bun run <script>\nbun run tools/example.ts\nbun run\nbun test tests',
      scripts,
    ),
  ).toEqual([]);
});
