// Documentation Examples as diagnostics (ADR 0169, #2115; ADR 0170): each
// failing example of an open Library's exports or a Script's Handlers is a
// warning on its first differing line. Results are kept by the example and the Library sources it ran with,
// so an edit replays only what it could change.
import { stdlibSources } from '@northtalk/ts';
import {
  docExamples,
  replayExample,
  scriptExamples,
  type ExampleResult,
} from '../doc-examples';
import type { LspDiagnostic } from './protocol';
import type { Analysis } from './workspace';

export type ExampleCache = Map<string, ExampleResult>;

/** The failing Documentation Examples of one analysed document. */
export const exampleDiagnostics = (
  analyses: ReadonlyMap<string, Analysis>,
  uri: string,
  previous: ExampleCache,
  next: ExampleCache,
): LspDiagnostic[] => {
  const analysis = analyses.get(uri);
  const name = analysis?.document.library;
  // A Script is named by its file stem, as `northtalk test` names it; a Test
  // Script carries no examples.
  const stem = /([^/]+)\.talk$/u.exec(uri)?.[1];
  const script =
    !name && stem && !stem.endsWith('.test') ? decodeURIComponent(stem) : null;
  // A unit that doesn't load would fail every example the same way.
  if (
    !analysis ||
    (!name && !script) ||
    (name && Object.hasOwn(stdlibSources, name)) ||
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
  const examples = name
    ? docExamples(name, analysis.document.text)
    : scriptExamples(script!, analysis.document.text);
  return examples.flatMap(example => {
    // A Handler's example also runs the whole Script it documents.
    const key = [
      example.name,
      example.line,
      example.transcript,
      example.script ?? '',
      sources,
    ].join('\u0000');
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
