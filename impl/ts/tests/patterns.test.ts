import { expect, test } from 'bun:test';
import { checkSource } from '../src/checker';
import { compile, runProgram } from '../src/patterns';
import { characters } from '../src/text';
import { viewSource } from '../src/view';

// Captures at converging branches must keep the first thread's slots. Empty
// repetitions also revisit instructions without consuming a Character.
test.each([
  ['<a: <"ab" or "a">, b: optional "b">', 'ab', 2, [0, 2, 2, 2], 9],
  ['<a: optional "x", b: "y">', 'y', 1, [0, 0, 0, 1], 5],
  ['<a: text lazily, b: "x">', 'axbxx', 2, [0, 1, 1, 2], 7],
  ['<a: text, b: "x">', 'axbxx', 5, [0, 4, 4, 5], 15],
  ['<a: <"a" or "b"> or b: "bc">', 'bc', 1, [0, 1, null, null], 8],
  ['<zero or more of <optional "x">, y: optional "y">', 'xy', 2, [1, 2], 7],
] as const)(
  '%s keeps priority, Capture slots and steps',
  (source, subject, end, slots, steps) => {
    const declaration = viewSource(
      checkSource(`constant p = ${source}`).tree!.root,
    )[0]!;
    if (declaration.k !== 'constant' || declaration.value.k !== 'pattern') {
      throw new Error('not a Text Pattern');
    }
    const program = compile(declaration.value.pattern.els);
    expect(runProgram(program, characters(subject), 0, 'search')).toEqual({
      found: { start: 0, end, slots: [...slots] },
      steps,
    });
  },
);
