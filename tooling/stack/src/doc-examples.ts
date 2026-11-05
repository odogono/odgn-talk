// Documentation Examples (ADR 0169, ADR 0170): the Session Transcripts written
// in the `--|` blocks of a manifest Library's exports or a Script's Handlers,
// each replayed in a fresh session as one test. Tooling, so the extraction isn't normative; the replay is the
// Session Host's own.
import { canvasCapabilities } from './canvas';
import {
  parseTranscript,
  replayTranscript,
  writeTranscript,
  type TranscriptItem,
} from '@northtalk/ts/session';

/** One Documentation Example of a Library export or a Script's Handler. */
export type DocExample = {
  /** The documented export or Handler. */
  export: string;
  /** The example's first line within the unit's source, from 1. */
  line: number;
  /** The test's name: `<unit>.<export> example <n>`. */
  name: string;
  /** The documented Script's source, for an example of a Script's Handler. */
  script?: string;
  /** The example as a Session Transcript. */
  transcript: string;
  /** The Library's name or the Script's file stem. */
  unit: string;
};

const MARKER = '--|';
// A top-level declaration a Library exports, unless it starts `private`.
const DECLARATION = /^(private\s+)?(?:function|constant|on)\s+([A-Z_a-z]\w*)/u;
// A Script's Handler: only these carry examples, since a Script's functions
// and Constants are reached by no message (ADR 0170).
const HANDLER = /^on\s+([A-Z_a-z]\w*)/u;
const IMPORT = /^use\b.*\bfrom\s+([A-Z_a-z]\w*)\s*$/u;
// Session Commands that name files or outlive the example.
const REFUSED =
  /^:(library|script|fix|export|save|restore|quit|store\s+load|store\s+save)(?:\s|$)/u;
// Every example starts here, under a virtual Clock, as Test Scripts do.
const EPOCH = '2026-01-01T00:00:00Z';

// A whole-line `--|` comment's documentation text, or null for any other line.
const docLine = (line: string): string | null => {
  if (!line.startsWith(MARKER)) {
    return null;
  }
  const text = line.slice(MARKER.length);
  return text.startsWith(' ') ? text.slice(1) : text;
};

/**
 * Each Documentation Example of a Library's exports, in source order: a `> `
 * line in a declaration's `--|` block starts one, and the block's next blank
 * line or its end ends it.
 */
export const docExamples = (library: string, source: string): DocExample[] =>
  examplesOf(library, source, line => {
    const declared = DECLARATION.exec(line);
    return declared && !declared[1] ? declared[2]! : null;
  });

/**
 * Each Documentation Example of a Script's Handlers, as `docExamples` finds a
 * Library's, named by the Script's file stem. Examples on its functions and
 * Constants are ignored.
 */
export const scriptExamples = (stem: string, source: string): DocExample[] =>
  examplesOf(stem, source, line => HANDLER.exec(line)?.[1] ?? null).map(
    example => ({ ...example, script: source }),
  );

const examplesOf = (
  unit: string,
  source: string,
  declared: (line: string) => string | null,
): DocExample[] => {
  const lines = source.split('\n');
  const out: DocExample[] = [];
  lines.forEach((line, at) => {
    const name = declared(line);
    if (name === null) {
      return;
    }
    let first = at;
    while (first > 0 && docLine(lines[first - 1]!) !== null) {
      first--;
    }
    let n = 0;
    let current: { line: number; text: string[] } | null = null;
    const end = () => {
      if (current) {
        n++;
        out.push({
          unit,
          export: name,
          line: current.line,
          name: `${unit}.${name} example ${n}`,
          transcript: current.text.map(l => `${l}\n`).join(''),
        });
        current = null;
      }
    };
    for (let i = first; i < at; i++) {
      const text = docLine(lines[i]!)!;
      if (text.trim() === '') {
        end();
      } else if (current) {
        current.text.push(text);
      } else if (text === '>' || text.startsWith('> ')) {
        current = { line: i + 1, text: [text] };
      }
    }
    end();
  });
  return out;
};

/**
 * An example's outcome. A failure has the line within the unit's source
 * it is reported at, what went wrong, and for a differing replay the
 * expected and actual lines, either missing at the Transcript's end.
 */
export type ExampleResult =
  | { ok: true }
  | {
      actual?: string;
      differs?: true;
      expected?: string;
      line: number;
      ok: false;
      problems: string[];
    };

/**
 * Replays one example through a fresh Session Host. Before its first Entry
 * the runner sets the virtual Clock, adds the manifest's Libraries it needs,
 * and for a Script's Handler adds the Script, and leaves those lines out of
 * what it compares.
 */
export const replayExample = (
  libraries: readonly { name: string; source: string }[],
  example: DocExample,
): ExampleResult => {
  const fail = (line: number, problems: string[]): ExampleResult => ({
    ok: false,
    line,
    problems,
  });
  let recorded: TranscriptItem[];
  try {
    recorded = parseTranscript(example.transcript);
  } catch (error) {
    return fail(example.line, [(error as Error).message]);
  }
  for (const [i, item] of recorded.entries()) {
    const refused =
      item.k === 'input' ? REFUSED.exec(item.source.split('\n')[0]!) : null;
    if (refused) {
      const command = refused[1]!.replaceAll(/\s+/gu, ' ');
      return fail(example.line + lineOf(recorded, i), [
        `an example may not use :${command}`,
      ]);
    }
  }
  // Grants and mocks must come before the session starts, and the Clock and
  // Libraries start it.
  const lead = recorded.findIndex(
    item =>
      item.k !== 'comment' &&
      !(item.k === 'input' && /^:(grant|mock)\s/u.test(item.source)),
  );
  const split = lead < 0 ? recorded.length : lead;
  const hidden: TranscriptItem[] = [
    { k: 'input', source: `:clock virtual ${EPOCH}` },
    ...needed(libraries, example, recorded).map((library): TranscriptItem => ({
      k: 'input',
      source: `:library add ${library.name}\n${trimmed(library.source)}`,
    })),
    ...(example.script === undefined
      ? []
      : [
          {
            k: 'input',
            source: `:script add ${example.unit}\n${trimmed(example.script)}`,
          } satisfies TranscriptItem,
        ]),
  ];
  // Each of the runner's lines, by its first line, to be dropped once.
  const heads = hidden.map(item => head((item as { source: string }).source));
  let items: TranscriptItem[];
  try {
    items = replayTranscript(
      [...recorded.slice(0, split), ...hidden, ...recorded.slice(split)],
      { capabilities: canvasCapabilities },
    ).items;
  } catch (error) {
    return fail(example.line, [(error as Error).message]);
  }
  // Drop the runner's own lines, which must print nothing.
  const shown: TranscriptItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.k !== 'input' || head(item.source) !== heads[0]) {
      shown.push(item);
      continue;
    }
    heads.shift();
    const printed: string[] = [];
    while (items[i + 1] && items[i + 1]!.k === 'output') {
      printed.push((items[++i] as { text: string }).text);
    }
    if (printed.length) {
      return fail(example.line, [`${head(item.source)} printed:`, ...printed]);
    }
  }
  const expected = example.transcript.split('\n');
  const actual = writeTranscript(shown).split('\n');
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (expected[i] !== actual[i]) {
      return {
        ok: false,
        line: example.line + i,
        problems: ['the replay differs'],
        differs: true,
        ...(expected[i] === undefined ? {} : { expected: expected[i] }),
        ...(actual[i] === undefined ? {} : { actual: actual[i] }),
      };
    }
  }
  return { ok: true };
};

const trimmed = (source: string) => source.replace(/\n+$/u, '');

// The Libraries a source's `use` lines name.
const imports = (source: string) =>
  source.split('\n').flatMap(line => {
    const name = IMPORT.exec(line.trim())?.[1];
    return name ? [name] : [];
  });

// An input's first line.
const head = (source: string) => source.split('\n')[0]!;

// Each item's first line within the Transcript, from 0.
const lineOf = (items: readonly TranscriptItem[], index: number): number =>
  items
    .slice(0, index)
    .reduce(
      (n, item) =>
        n + (item.k === 'input' ? item.source.split('\n').length : 1),
      0,
    );

// The example's own Library, or its Script's, and those its `use` lines name,
// with what they import, each after its imports as `:library add` needs. Only these, since a
// Library calling a Capability compiles only once the example mocks it.
const needed = <L extends { name: string; source: string }>(
  libraries: readonly L[],
  example: DocExample,
  recorded: readonly TranscriptItem[],
): L[] => {
  const byName = new Map(libraries.map(l => [l.name, l]));
  const out: L[] = [];
  const seen = new Set<string>();
  const visit = (library: L) => {
    if (seen.has(library.name)) {
      return;
    }
    seen.add(library.name);
    for (const line of library.source.split('\n')) {
      const imported = byName.get(IMPORT.exec(line)?.[1] ?? '');
      if (imported) {
        visit(imported);
      }
    }
    out.push(library);
  };
  const named = [
    ...(example.script === undefined
      ? [example.unit]
      : imports(example.script)),
    ...recorded.flatMap(item =>
      item.k === 'input' ? imports(item.source) : [],
    ),
  ];
  for (const name of named) {
    const library = byName.get(name);
    if (library) {
      visit(library);
    }
  }
  return out;
};
