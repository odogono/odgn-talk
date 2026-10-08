import { describe, expect, test } from 'bun:test';
import fixture from '../../testdata/declaration-docs.json';
import { checkSource } from '../src/checker';
import { functionDoc } from '../src/documentation';
import { newGroup, restore, type Group } from '../src/group';
import { compileLibrary } from '../src/library';
import { parseInstant } from '../src/index';
import { SessionHost } from '../src/session';
import { viewSource } from '../src/view';

// impl/testdata/declaration-docs.json, which the Go Core's documentation
// tests read too.
type Step = {
  docs?: string;
  expect?: unknown;
  functionDoc?: string;
  incomplete?: string;
  input?: string;
  library?: [string, string];
  output?: string[];
};

describe('Declaration Documentation', () => {
  for (const unit of fixture.units) {
    test(`attaches to top-level declarations: ${unit.name}`, () => {
      const tree = checkSource(unit.source).tree!;
      const kinds = viewSource(tree.root).map(d => d.k);
      expect(kinds.map((k, i) => [k, tree.docs![i]])).toEqual(unit.docs);
    });
  }

  for (const session of fixture.sessions) {
    test(`in the session: ${session.name}`, () => {
      const now = parseInstant('2026-10-08T10:00:00Z');
      const host = new SessionHost({ now: () => now });
      (session.steps as Step[]).forEach((step, i) => {
        let got: unknown;
        let want = step.expect;
        if (step.input !== undefined) {
          got = host.input(step.input);
          want = step.output;
        } else if (step.incomplete !== undefined) {
          got = host.incomplete(step.incomplete);
        } else if (step.docs !== undefined || step.library) {
          const docs =
            step.docs !== undefined
              ? host.documentation(step.docs)
              : host.libraryDocumentation(...step.library!);
          got = docs.map(d => [d.origin, d.declaration, d.clause, d.doc]);
        } else {
          const value = host
            .inspect()!
            .scripts[0]!.vars.find(([name]) => name === step.functionDoc)![1];
          got = host.functionDocumentation(value);
        }
        const at = `${session.name}, step ${i}`;
        expect([at, got]).toEqual([at, want]);
      });
    });
  }
});

const DOUBLED =
  '--| Doubles.\nfunction double n\n  return n * 2\nend double\nscript variable f\nscript variable l';
const SETUP =
  'on setup\n  put double into f\n  put given x: x into l\nend setup';
const restoreOptions = {
  name: 'resumed',
  libraries: [],
  grants: () => undefined,
  resolve: () => undefined,
  onMismatch: 'reject' as const,
};
const docOf = (group: Group, name: string) =>
  functionDoc(group.inspect().scripts[0]!.vars.find(([n]) => n === name)![1]);

describe('Function Value documentation', () => {
  test('a stale Function Value keeps its documentation through restore', () => {
    const g = newGroup({ name: 'g' });
    g.load({ name: 's', source: `${DOUBLED}\n${SETUP}` });
    g.script('s')!.deliver({ name: 'setup' });
    g.pump(0n);
    expect([docOf(g, 'f'), docOf(g, 'l')]).toEqual(['Doubles.', '']);
    g.script('s')!.reload(
      'function double n\n  return n + n\nend double\nscript variable f\nscript variable l',
      'carry variables',
    );
    expect(docOf(g, 'f')).toBe('Doubles.');
    const { group: copy } = restore(g.save(), restoreOptions);
    expect(docOf(copy, 'f')).toBe('Doubles.');
  });

  test('a variables-only restore keeps the documentation of the saved code', () => {
    const library = compileLibrary({
      name: 'fmt',
      version: '1',
      source: 'function label\n  return 1\nend label',
    });
    const g = newGroup({ name: 'g' });
    g.addLibrary(library);
    g.load({ name: 's', source: `${DOUBLED}\n${SETUP}` });
    g.script('s')!.deliver({ name: 'setup' });
    g.pump(0n);
    const { group: copy, result } = restore(g.save(), {
      ...restoreOptions,
      onMismatch: 'variables only',
    });
    expect(result.variablesOnly).toBe(true);
    expect(docOf(copy, 'f')).toBe('Doubles.');
  });
});
