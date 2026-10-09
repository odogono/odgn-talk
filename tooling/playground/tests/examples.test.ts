import { describe, expect, test } from 'bun:test';
import { parseInstant } from '@odgn/northtalk';
import { calendar, locale } from '@odgn/northtalk-tooling/builtins';
import { lint, readManifest } from '@odgn/northtalk-tooling/lint';
import { EXAMPLES, type Example } from '../src/examples';
import { PlaygroundSession } from '../src/session';

// Every Handler in an example is one the Playground's manifest doesn't
// declare, so that hint is expected.
const EXPECTED_LINTS = new Set(['unknown-message']);

// Run fresh as the page does, then pump each deadline at once, so waits
// and background Runs finish.
const run = (example: Example) => {
  let now = parseInstant('2026-10-09T09:00:00Z');
  const session = new PlaygroundSession({
    now: () => now,
    monotonic: () => Number(now / 1_000_000n),
    builtIns: { calendar, locale },
  });
  const setupLines = [':grant canvas canvas', ...(example.setup ?? [])].flatMap(
    command => session.input(command),
  );
  const prepared = session.prepareFresh({
    script: example.script,
    libraries: example.libraries ?? [],
  });
  const fresh = prepared.session;
  if (!fresh) {
    throw new Error(
      `${example.id} did not load: ${JSON.stringify(prepared.result)}`,
    );
  }
  const lines = [...setupLines, ...fresh.input(example.launch)];
  for (let pumps = 0; pumps < 1000; pumps++) {
    const waiting = fresh.host.waiting;
    const at = waiting.k === 'deadline' ? waiting.at : fresh.host.nextDeadline;
    if (at === undefined) {
      break;
    }
    now = at > now ? at : now;
    lines.push(...fresh.tick());
  }
  return { fresh, lines };
};

describe('Every example', () => {
  const all = EXAMPLES.flatMap(g => g.examples);
  test('has a unique id', () => {
    expect(new Set(all.map(e => e.id)).size).toBe(all.length);
  });
  for (const example of all) {
    test(`${example.id} runs to the prompt without errors or lints`, () => {
      const { fresh, lines } = run(example);
      expect(lines.filter(l => l.startsWith('! '))).toEqual([]);
      expect(fresh.host.waiting.k).toBe('prompt');
      if (example.draws) {
        expect(fresh.trace.some(l => l.includes('canvas'))).toBe(true);
      } else {
        expect(lines.length).toBeGreaterThan(0);
      }
      const manifest = readManifest(fresh.host.exportManifest());
      for (const source of [
        example.script,
        ...(example.libraries ?? []).map(l => l.source),
      ]) {
        const { diagnostics, lints } = lint(source, {
          profile: 'beginner',
          manifest,
        });
        expect(diagnostics).toEqual([]);
        expect(
          lints.filter(l => !EXPECTED_LINTS.has(l.id)).map(l => l.message),
        ).toEqual([]);
      }
    });
  }
});
