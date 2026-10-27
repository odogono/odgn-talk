// Run Tests (ADR 0133): each Test Handler of a Project's Test Scripts runs
// against a fresh Play Session, granted the Folio Harness. Tooling, so
// nothing here is normative; ADR 0056's runner is `northtalk test`.
import {
  compileLibrary,
  defineCapability,
  LoadError,
  map,
  nothing,
  parseSource,
  ScriptError,
  shape,
  text,
  toValue,
  waitUs,
  type Call,
  type Report,
  type Value,
} from '@northtalk/ts';
import {
  errorAt,
  TEST_LIBRARY,
  testHandlersOf,
} from '@northtalk/tooling/test-script';
import { textOf, type Project, type ProjectTestScript } from './model';
import { PlaySession, unitLabel } from './play';
import type { DeepReadonly } from './readonly';

// How many Pumps a test may take before it counts as never settling.
const MAX_PUMPS = 100_000;
// How often a test may move the Clock on to a deadline before it counts as
// stuck.
const MAX_STEPS = 10_000;
// A Harness call waits as long as a suspending call can.
const FOREVER_MS = 2_147_483_647;

/** A place in a Test Script. */
export type TestLocation = { col: number; line: number };

/** One Test Handler's outcome, or a Test Script that doesn't load. */
export type TestResult = {
  /** Where the failure is, else the Test Handler's `on`. */
  at: TestLocation;
  ok: boolean;
  problems: string[];
  script: DeepReadonly<ProjectTestScript>;
  /** The Test Handler's name; empty when the Test Script doesn't load. */
  test: string;
};

/** Every Test Handler in the Project's Test Scripts, in order. */
export const runProjectTests = async (
  project: DeepReadonly<Project>,
): Promise<TestResult[]> => {
  const results: TestResult[] = [];
  for (const script of project.testScripts) {
    const parsed = parseSource(script.source);
    if (!parsed.tree) {
      const { tok, message } = parsed.error!;
      results.push({
        script,
        test: '',
        ok: false,
        at: { line: tok.line, col: tok.col },
        problems: [message],
      });
      continue;
    }
    const { setup, tests } = testHandlersOf(parsed.tree);
    for (const test of tests) {
      const run = new TestRun(project, script, test);
      const problems = await run.run(setup);
      results.push({
        script,
        test: test.name,
        ok: !problems.length,
        at: run.failedAt ?? { line: test.line, col: test.col },
        problems,
      });
      if (run.loadFailed) {
        break;
      }
    }
  }
  return results;
};

type Action = {
  // What the action does once the Clock reaches `to`, if anything.
  act?: () => void;
  acted?: boolean;
  // Answered once the action is done and the Group idle; absent for a step
  // on the way.
  call?: Call<unknown>;
  to?: bigint;
};

// A Harness duration in microseconds.
const duration = (value: Value) => {
  const us = waitUs(value);
  if (us < 0n) {
    throw new ScriptError('out of domain', '', map([['value', value]]));
  }
  return us;
};

// One test: a fresh Play Session of the Project on the first Page with the
// seed fixed, the Test Script in its Group, and a virtual Clock.
class TestRun {
  failedAt: TestLocation | undefined;
  loadFailed = false;
  private readonly play: PlaySession;
  private readonly problems: string[] = [];
  private readonly unit: string;
  private readonly actions: Action[] = [];
  private now = 0n;

  constructor(
    project: DeepReadonly<Project>,
    private readonly script: DeepReadonly<ProjectTestScript>,
    private readonly test: { col: number; line: number; name: string },
  ) {
    this.unit = `test:${script.name}`;
    this.play = new PlaySession(project, 0, { seed: 0n });
    const harness = this.harness();
    try {
      if (project.libraries.some(library => library.name === 'test')) {
        throw new Error(
          'A Project Library named test hides the Test Library. Rename it.',
        );
      }
      this.play.group.addLibrary(
        compileLibrary(
          { name: 'test', version: '1', source: TEST_LIBRARY },
          [],
          {},
          { atCaller: true },
        ),
      );
      this.play.group.load({
        name: this.unit,
        source: script.source,
        // Like the Project Script, it reaches Pages by name.
        objects: {
          ...Object.fromEntries(
            this.play.project.pages.map(page => [
              page.name,
              this.play.objects.get(page)!,
            ]),
          ),
          project: this.play.objects.get(this.play.project)!,
        },
        grants: { harness: harness.grant('all', undefined) },
      });
    } catch (error) {
      if (error instanceof LoadError) {
        const [first] = error.diagnostics;
        this.failedAt = first
          ? { line: first.line, col: first.col }
          : undefined;
        this.problems.push(
          ...error.diagnostics.map(d => `line ${d.line}: ${d.message}`),
        );
      } else if (error instanceof Error) {
        this.problems.push(error.message);
      } else {
        throw error;
      }
      this.loadFailed = true;
    }
  }

  async run(setup: boolean): Promise<string[]> {
    if (this.loadFailed) {
      return this.problems;
    }
    // A Script under test that doesn't load fails every test.
    for (const problem of this.play.problems) {
      const owner = 'pages' in problem.owner ? 'project' : problem.owner.name;
      this.problems.push(`${owner} line ${problem.line}: ${problem.message}`);
    }
    if (this.problems.length) {
      return this.problems;
    }
    // startPlay, openPage and a first `frame` run first, as in Browse, so
    // the next `frame` reports the time since this one.
    if (!(await this.settle(undefined))) {
      return this.problems;
    }
    this.play.frame(this.now);
    if (!(await this.settle(undefined))) {
      return this.problems;
    }
    if (setup && !(await this.request('setup'))) {
      return this.problems;
    }
    await this.request(this.test.name);
    return this.problems;
  }

  private async request(handler: string): Promise<boolean> {
    const { id, result } = this.play.group.script(this.unit)!.request({
      name: handler,
    });
    // The run end report carries the reason; the rejection says less.
    result.catch(() => {});
    return this.settle(id);
  }

  // Pumps until the Run `id` ends and the Group is idle, carrying out the
  // Harness's actions in turn. True if nothing went wrong.
  private async settle(id: string | undefined): Promise<boolean> {
    const before = this.problems.length;
    let ended = id === undefined;
    let current: Action | undefined;
    let steps = 0;
    for (let pumps = 0; ; pumps++) {
      if (pumps > MAX_PUMPS) {
        this.problems.push('the test never settles');
        return false;
      }
      const pumped = this.play.pump(this.now);
      // Lets Run promises, such as a finished `frame`, resolve.
      await Promise.resolve();
      for (const report of pumped.reports) {
        if (report.kind === 'run end' && report.delivery === id) {
          ended = true;
        }
        this.reported(report);
      }
      if (pumped.state === 'stopped') {
        break;
      }
      if (pumped.state === 'sliced') {
        continue;
      }
      let next = pumped.nextDeadline;
      if (!current && this.actions.length) {
        current = this.actions.shift()!;
      }
      if (current) {
        if (current.to !== undefined && this.now < current.to) {
          next = next !== undefined && next < current.to ? next : current.to;
        } else if (current.act && !current.acted) {
          current.acted = true;
          current.act();
          continue;
        } else if (!this.play.navigating) {
          current.call?.answer(nothing);
          current = undefined;
          continue;
        }
      } else if (ended) {
        break;
      }
      if (next === undefined) {
        break;
      }
      // Only the Clock can move the test on, so time passes.
      this.now = next;
      if (++steps > MAX_STEPS) {
        this.problems.push('the test keeps waiting and never ends');
        return false;
      }
    }
    if (!ended) {
      this.problems.push(
        `${this.test.name} waits for something that never comes`,
      );
    }
    return this.problems.length === before;
  }

  // A Test Script Run that doesn't complete fails the test, and so does an
  // error in any other Run.
  private reported(r: Report) {
    if (r.kind !== 'run end' || r.outcome === 'completed') {
      return;
    }
    const mine = r.script === this.unit;
    if (!mine && r.outcome !== 'errored' && r.outcome !== 'limit fault') {
      return;
    }
    const who = mine
      ? `${this.script.name}${r.handler ? ` ${r.handler}` : ''}`
      : `${unitLabel(r.script)}${r.handler ? ` ${r.handler}` : ''}${
          r.at ? ` line ${r.at.line}` : ''
        }`;
    const at = (r.error && errorAt(r.error.data)) ?? r.at;
    if (at?.unit === this.unit) {
      this.failedAt ??= { line: at.line, col: at.col };
    }
    if (r.outcome === 'errored' && r.error) {
      const fields = r.error.data.kind === 'map' ? r.error.data.entries() : [];
      const error = map([
        ['code', text(r.error.code)],
        ...fields.filter(([k]) => k !== 'at'),
      ]);
      this.problems.push(
        `${who} errored: ${error.toString()}${
          r.error.message ? `\n  ${r.error.message}` : ''
        }`,
      );
    } else {
      this.problems.push(
        `${who} ended ${r.outcome}${r.limit ? ` (${r.limit})` : ''}`,
      );
    }
  }

  // The named Element on the current Page.
  private element(name: string) {
    const element = this.play.page.elements.find(e => e.name === name);
    if (!element) {
      throw new ScriptError(
        'no such element',
        `Page ${this.play.page.name} has no Element ${name}`,
        map([['name', text(name)]]),
      );
    }
    return element;
  }

  private queue(call: Call<unknown> | undefined, action: Omit<Action, 'call'>) {
    this.actions.push({ ...(call ? { call } : {}), ...action });
  }

  // ADR 0056's `advance`, plus reader input and read-only Element access.
  private harness() {
    const suspending = {
      mode: 'suspending',
      maxPendingMs: FOREVER_MS,
      cost: { fuel: 0 },
    } as const;
    return defineCapability<unknown>()('harness', {
      advance: {
        ...suspending,
        args: [shape.quantityKind('exact duration')],
        start: (call, value) => {
          this.queue(call, { to: this.now + duration(value) });
        },
      },
      frame: {
        ...suspending,
        args: [shape.quantityKind('exact duration')],
        start: (call, value) => {
          const to = this.now + duration(value);
          this.queue(call, { to, act: () => this.play.frame(to) });
        },
      },
      key: {
        ...suspending,
        args: [shape.text],
        start: (call, key) => {
          const args = [text(key)];
          this.queue(undefined, {
            act: () => this.play.send(this.play.page, 'keyDown', args),
          });
          this.queue(call, {
            act: () => this.play.send(this.play.page, 'keyUp', args),
          });
        },
      },
      click: {
        ...suspending,
        args: [shape.text],
        start: (call, name) => {
          const element = this.element(name);
          this.queue(call, { act: () => this.play.send(element, 'click') });
        },
      },
      goTo: {
        ...suspending,
        args: [shape.text],
        start: (call, name) => {
          const index = this.play.project.pages.findIndex(p => p.name === name);
          if (index < 0) {
            throw new ScriptError(
              'no such page',
              `The Project has no Page ${name}`,
              map([['name', text(name)]]),
            );
          }
          this.queue(call, { act: () => this.play.goTo(index) });
        },
      },
      property: {
        mode: 'immediate',
        args: [shape.text, shape.text],
        result: shape.any,
        cost: { fuel: 0 },
        do: (_call, property, name) => {
          const element = this.element(name);
          if (property === 'text' && element.kind === 'text') {
            return text(textOf(element));
          }
          if (property === 'visible') {
            return toValue(this.play.isVisible(element));
          }
          const value = (element as Record<string, unknown>)[property];
          if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
          ) {
            return toValue(value);
          }
          throw new ScriptError(
            'no such property',
            `Element ${name} has no property ${property}`,
            map([['name', text(property)]]),
          );
        },
      },
    });
  }
}
