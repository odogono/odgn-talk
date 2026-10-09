// The Playground's example scripts, by group, for the Examples menu. Each
// is a `.talk` file under `examples/`; tests/examples.test.ts runs every one.
import type { Library } from './session';
import hello from './examples/basics/hello.talk' with { type: 'text' };
import variables from './examples/basics/variables.talk' with { type: 'text' };
import decisions from './examples/basics/decisions.talk' with { type: 'text' };
import loops from './examples/basics/loops.talk' with { type: 'text' };
import functions from './examples/basics/functions.talk' with { type: 'text' };
import scriptVariables from './examples/basics/script-variables.talk' with { type: 'text' };
import chunks from './examples/text/chunks.talk' with { type: 'text' };
import reverse from './examples/text/reverse.talk' with { type: 'text' };
import patterns from './examples/text/patterns.talk' with { type: 'text' };
import templates from './examples/text/templates.talk' with { type: 'text' };
import wordFrequency from './examples/text/word-frequency.talk' with { type: 'text' };
import lists from './examples/collections/lists.talk' with { type: 'text' };
import maps from './examples/collections/maps.talk' with { type: 'text' };
import lambdas from './examples/collections/lambdas.talk' with { type: 'text' };
import destructuring from './examples/collections/destructuring.talk' with { type: 'text' };
import exact from './examples/numbers/exact.talk' with { type: 'text' };
import units from './examples/numbers/units.talk' with { type: 'text' };
import trigonometry from './examples/numbers/trigonometry.talk' with { type: 'text' };
import clauses from './examples/handlers/clauses.talk' with { type: 'text' };
import errors from './examples/handlers/errors.talk' with { type: 'text' };
import messages from './examples/handlers/messages.talk' with { type: 'text' };
import waiting from './examples/handlers/waiting.talk' with { type: 'text' };
import joins from './examples/handlers/joins.talk' with { type: 'text' };
import dates from './examples/time/dates.talk' with { type: 'text' };
import clock from './examples/time/clock.talk' with { type: 'text' };
import standard from './examples/libraries/standard.talk' with { type: 'text' };
import userShapes from './examples/libraries/user-shapes.talk' with { type: 'text' };
import drawingShapes from './examples/drawing/shapes.talk' with { type: 'text' };
import grid from './examples/drawing/grid.talk' with { type: 'text' };
import barChart from './examples/drawing/bar-chart.talk' with { type: 'text' };
import spiral from './examples/drawing/spiral.talk' with { type: 'text' };
import clockFace from './examples/drawing/clock-face.talk' with { type: 'text' };
import sierpinski from './examples/drawing/sierpinski.talk' with { type: 'text' };
import fizzbuzz from './examples/classics/fizzbuzz.talk' with { type: 'text' };
import primes from './examples/classics/primes.talk' with { type: 'text' };
import fibonacci from './examples/classics/fibonacci.talk' with { type: 'text' };
import hanoi from './examples/classics/hanoi.talk' with { type: 'text' };
import caesar from './examples/classics/caesar.talk' with { type: 'text' };
import collatz from './examples/classics/collatz.talk' with { type: 'text' };
import roman from './examples/classics/roman.talk' with { type: 'text' };
import sorting from './examples/classics/sorting.talk' with { type: 'text' };
import billing from './examples/handlers/billing.talk' with { type: 'text' };
import shapes from './examples/libraries/shapes.talk' with { type: 'text' };

export type Example = {
  /** Whether it draws, so loading it shows the Canvas tab. */
  draws?: boolean;
  /** Unique across every group. */
  id: string;
  /** What Launch evaluates after Run fresh. */
  launch: string;
  libraries?: Library[];
  script: string;
  /** `:grant` commands the example needs beyond the default `canvas`. */
  setup?: string[];
  title: string;
};

export type ExampleGroup = { examples: Example[]; title: string };

export const EXAMPLES: ExampleGroup[] = [
  {
    title: 'Getting started',
    examples: [
      {
        id: 'hello',
        title: 'Hello',
        launch: 'greet "Ann"',
        script: hello,
      },
      {
        id: 'variables',
        title: 'Variables and arithmetic',
        launch: 'main',
        script: variables,
      },
      {
        id: 'decisions',
        title: 'Decisions',
        launch: 'main',
        script: decisions,
      },
      {
        id: 'loops',
        title: 'Loops',
        launch: 'main',
        script: loops,
      },
      {
        id: 'functions',
        title: 'Functions and Handlers',
        launch: 'main',
        script: functions,
      },
      {
        id: 'script-variables',
        title: 'Script Variables',
        launch: 'main',
        script: scriptVariables,
      },
    ],
  },
  {
    title: 'Text',
    examples: [
      {
        id: 'chunks',
        title: 'Chunk Expressions',
        launch: 'main',
        script: chunks,
      },
      {
        id: 'reverse',
        title: 'Reversing and palindromes',
        launch: 'main',
        script: reverse,
      },
      {
        id: 'patterns',
        title: 'Text Patterns',
        launch: 'main',
        script: patterns,
      },
      {
        id: 'templates',
        title: 'Templates',
        launch: 'main',
        script: templates,
      },
      {
        id: 'word-frequency',
        title: 'Word frequency',
        launch: 'main',
        script: wordFrequency,
      },
    ],
  },
  {
    title: 'Lists and maps',
    examples: [
      {
        id: 'lists',
        title: 'Lists',
        launch: 'main',
        script: lists,
      },
      {
        id: 'maps',
        title: 'Maps',
        launch: 'main',
        script: maps,
      },
      {
        id: 'lambdas',
        title: 'Lambdas',
        launch: 'main',
        script: lambdas,
      },
      {
        id: 'destructuring',
        title: 'Matching shapes',
        launch: 'main',
        script: destructuring,
      },
    ],
  },
  {
    title: 'Numbers and units',
    examples: [
      {
        id: 'exact',
        title: 'Exact decimals',
        launch: 'main',
        script: exact,
      },
      {
        id: 'units',
        title: 'Units and Quantities',
        launch: 'main',
        script: units,
      },
      {
        id: 'trigonometry',
        title: 'Trigonometry',
        launch: 'main',
        script: trigonometry,
      },
    ],
  },
  {
    title: 'Handlers and messages',
    examples: [
      {
        id: 'clauses',
        title: 'Clauses',
        launch: 'main',
        script: clauses,
        libraries: [{ name: 'billing', source: billing }],
      },
      {
        id: 'errors',
        title: 'Errors',
        launch: 'main',
        script: errors,
      },
      {
        id: 'messages',
        title: 'Messages',
        launch: 'main and wait',
        script: messages,
      },
      {
        id: 'waiting',
        title: 'Waiting',
        launch: 'main and wait',
        script: waiting,
      },
      {
        id: 'joins',
        title: 'Joins',
        launch: 'main and wait',
        script: joins,
      },
    ],
  },
  {
    title: 'Dates and time',
    examples: [
      {
        id: 'dates',
        title: 'Civil Dates',
        launch: 'main',
        script: dates,
      },
      {
        id: 'clock',
        title: 'The clock',
        launch: 'main and wait',
        script: clock,
        setup: [':grant clock clock'],
      },
    ],
  },
  {
    title: 'Libraries',
    examples: [
      {
        id: 'standard-library',
        title: 'The Standard Library',
        launch: 'main',
        script: standard,
      },
      {
        id: 'own-library',
        title: 'A Library of your own',
        launch: 'main',
        script: userShapes,
        libraries: [{ name: 'shapes', source: shapes }],
      },
    ],
  },
  {
    title: 'Drawing',
    examples: [
      {
        id: 'shapes',
        title: 'Shapes and text',
        launch: 'draw',
        script: drawingShapes,
        draws: true,
      },
      {
        id: 'grid',
        title: 'Grid of circles',
        launch: 'draw',
        script: grid,
        draws: true,
      },
      {
        id: 'bar-chart',
        title: 'Bar chart',
        launch: 'draw',
        script: barChart,
        draws: true,
      },
      {
        id: 'spiral',
        title: 'Spiral',
        launch: 'draw',
        script: spiral,
        draws: true,
      },
      {
        id: 'clock-face',
        title: 'Clock face',
        launch: 'face 10, 10',
        script: clockFace,
        draws: true,
      },
      {
        id: 'sierpinski',
        title: 'Sierpiński carpet',
        launch: 'draw',
        script: sierpinski,
        draws: true,
      },
    ],
  },
  {
    title: 'Classic puzzles',
    examples: [
      {
        id: 'fizzbuzz',
        title: 'FizzBuzz',
        launch: 'main',
        script: fizzbuzz,
      },
      {
        id: 'primes',
        title: 'Prime numbers',
        launch: 'main',
        script: primes,
      },
      {
        id: 'fibonacci',
        title: 'Fibonacci',
        launch: 'main',
        script: fibonacci,
      },
      {
        id: 'hanoi',
        title: 'Towers of Hanoi',
        launch: 'main',
        script: hanoi,
      },
      {
        id: 'caesar',
        title: 'Caesar cipher',
        launch: 'main',
        script: caesar,
      },
      {
        id: 'collatz',
        title: 'Collatz sequence',
        launch: 'main',
        script: collatz,
      },
      {
        id: 'roman',
        title: 'Roman numerals',
        launch: 'main',
        script: roman,
      },
      {
        id: 'sorting',
        title: 'Insertion sort',
        launch: 'main',
        script: sorting,
      },
    ],
  },
];

export const exampleById = (id: string): Example | undefined =>
  EXAMPLES.flatMap(g => g.examples).find(e => e.id === id);
