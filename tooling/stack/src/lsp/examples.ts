// Documentation Examples as diagnostics (ADR 0169, #2115): each failing
// example of an open Library's exports is a warning on its first differing
// line. Results are kept by the example and the Library sources it ran with,
// so an edit replays only what it could change.
import { stdlibSources } from '@northtalk/ts';
import {
  docExamples,
  replayExample,
  type ExampleResult,
} from '../doc-examples';
import type { LspDiagnostic } from './protocol';
import type { Analysis } from './workspace';

export type ExampleCache = Map<string, ExampleResult>;

/** The failing Documentation Examples of one analysed Library document. */
export const exampleDiagnostics = (
  analyses: ReadonlyMap<string, Analysis>,
  uri: string,
  previous: ExampleCache,
  next: ExampleCache,
): LspDiagnostic[] => {
  const analysis = analyses.get(uri);
  const name = analysis?.document.library;
  // A Library that doesn't load would fail every example the same way.
  if (
    !analysis ||
    !name ||
    Object.hasOwn(stdlibSources, name) ||
    analysis.diagnostics.some(d => d.severity === 1)
  ) {
    return [];
  }
  const libraries = [...analyses.values()].flatMap(a =>
    a.document.library && !Object.hasOwn(stdlibSources, a.document.library)
      ? [{ name: a.document.library, source: a.document.text }]
      : [],
  );
  const sources = libraries
    .map(l => `${l.name}\u0000${l.source}`)
    .sort()
    .join('\u0000');
  const lines = analysis.document.text.split('\n');
  return docExamples(name, analysis.document.text).flatMap(example => {
    const key = `${example.line}\u0000${example.transcript}\u0000${sources}`;
    const result =
      next.get(key) ?? previous.get(key) ?? replayExample(libraries, example);
    next.set(key, result);
    if (result.ok) {
      return [];
    }
    const line = result.line - 1;
    const message = [
      `${example.name}: ${result.problems.join('\n')}`,
      ...(result.differs
        ? [
            `expected: ${result.expected ?? '(end of the example)'}`,
            `actual:   ${result.actual ?? '(end of the example)'}`,
          ]
        : []),
    ].join('\n');
    return [
      {
        range: {
          start: { line, character: 0 },
          end: { line, character: lines[line]?.length ?? 0 },
        },
        code: 'documentation example',
        source: 'northtalk',
        severity: 2,
        message,
      },
    ];
  });
};
