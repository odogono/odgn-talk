// The browser corpus page: runs the Conformance Corpus's Trace Cases and
// Session Transcripts on the TS Core in this browser, with the same checks
// `corpus:run` makes under Bun (impl/ts/tools/case-checks.ts).
import type { Setup } from '@odgn/northtalk/replay';
import {
  checkTraceCase,
  checkTranscriptCase,
} from '../../../impl/ts/tools/case-checks';

type Case = {
  files: Record<string, string>;
  kind: 'trace' | 'transcript';
  name: string;
  setup: Setup & { versions: { costModel: string; language: string } };
};

const out = document.getElementById('results')!;
const summary = document.getElementById('summary')!;
const report = (name: string, ok: boolean, detail: string) => {
  const row = document.createElement('div');
  row.className = ok ? 'pass' : 'fail';
  row.textContent = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`;
  out.append(row);
};

const run = async () => {
  const cases = (await (await fetch('./cases.json')).json()) as Case[];
  let failures = 0;
  const started = performance.now();
  for (const c of cases) {
    const read = (path: string) => {
      const text = c.files[path];
      if (text === undefined) {
        throw new Error(`The page has no file ${path}`);
      }
      return text;
    };
    try {
      if (
        c.setup.versions.language !== '1.0-rc.2' ||
        c.setup.versions.costModel !== '0'
      ) {
        throw new Error(
          'Unsupported case versions; expected language 1.0-rc.2 / Cost Model 0',
        );
      }
      const result =
        c.kind === 'trace'
          ? checkTraceCase(read, c.setup)
          : checkTranscriptCase(read);
      if (result.divergence) {
        const d = result.divergence;
        failures++;
        report(
          c.name,
          false,
          `${'file' in d ? d.file : 'case.trace'}:${d.line}\n  expected: ${d.expected}\n  actual:   ${d.actual}`,
        );
      } else {
        report(c.name, true, `(${result.lines} lines)`);
      }
    } catch (error) {
      failures++;
      report(
        c.name,
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
    // Let the page paint between cases.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  summary.textContent = `${cases.length - failures} of ${cases.length} cases pass in ${navigator.userAgent.match(/(Firefox|Chrome|Safari)\/[\d.]+/u)?.[0] ?? 'this browser'} (${Math.round(performance.now() - started)} ms)`;
  summary.className = failures ? 'fail' : 'pass';
  document.body.dataset.done = failures ? 'fail' : 'pass';
};
void run();
