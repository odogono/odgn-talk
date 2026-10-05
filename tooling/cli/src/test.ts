// `northtalk test`: run each Test Handler in a Test Script against the Scripts
// beside it, and replay each Session Transcript (ADR 0056). Tooling, so
// nothing here is normative; it drives the Core only through its public API.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  calendarCapability,
  clockCapability,
  compileLibrary,
  consoleCapability,
  defineCapability,
  list,
  LoadError,
  localeCapability,
  map,
  nothing,
  parseInstant,
  parseSource,
  ScriptError,
  shape,
  text,
  waitNs,
  type Call,
  type CapabilityDef,
  type Grant,
  type GrantDecls,
  type Group,
  type Library,
  type Operation,
  type Report,
  type SyntaxElement,
  type SyntaxNode,
  type Value,
  newGroup,
} from '@odgn/northtalk';
import { calendar, locale } from '@odgn/northtalk-tooling/builtins';
import { readManifest, type HostManifest } from '@odgn/northtalk-tooling/lint';
import { differs, replayFile } from './replay';

// The Test Library, supplied by the runner as a Host-supplied Library.
const TEST_LIBRARY = `function assert condition, message = "expected true"
  if condition is not true then throw {code: "assertion failed", message: message}
  return nothing
end assert

function assertEqual actual, expected
  if actual is not expected then throw {code: "assertion failed", expected: expected, actual: actual}
  return nothing
end assertEqual
`;
const LIBRARY_VERSION = '1';
// Every test starts at the same instant, under a virtual Clock.
const EPOCH = parseInstant('2026-01-01T00:00:00Z');
// How long a test may keep moving the Clock on before it counts as stuck.
const MAX_STEPS = 10_000;
// A harness call waits as long as a suspending call can.
const FOREVER_MS = 2_147_483_647;
const IDENTIFIER = /^[A-Z_a-z]\w*$/u;
const TEST_HANDLER = /^test[A-Z]/u;

export type TestOptions = { manifest?: string; only?: string };

type Test = { col: number; line: number; name: string };
type Location = { col: number; file: string; line: number };
type Problem = { at?: Location; text: string };
type Stub = { error?: Value; value?: Value };

/** Runs every test under the paths, and returns the exit code. */
export const runTests = (
  paths: readonly string[],
  options: TestOptions = {},
): number => {
  const manifest = options.manifest
    ? readManifest(readFileSync(options.manifest, 'utf8'))
    : null;
  if (manifest?.grants.has('harness')) {
    throw new Error('The Host Manifest may not name a Grant harness');
  }
  if (manifest?.libraries.some(library => library.name === 'test')) {
    throw new Error('The Host Manifest may not name a Library test');
  }
  const files = [...new Set(paths.flatMap(path => discover(path)))].sort();
  let passed = 0;
  let failed = 0;
  const report = (ok: boolean, lines: string[]) => {
    console.log(lines.join('\n'));
    if (ok) {
      passed++;
    } else {
      failed++;
    }
  };
  for (const file of files) {
    if (file.endsWith('.transcript')) {
      if (options.only && !file.includes(options.only)) {
        continue;
      }
      const result = replayFile(file);
      report(
        result.ok,
        result.ok
          ? [`ok ${file}`]
          : [`FAIL ${file}:${result.line}`, ...indent(differs(file, result))],
      );
      continue;
    }
    for (const outcome of testScript(file, manifest, options.only)) {
      report(outcome.ok, outcome.lines);
    }
  }
  if (!passed && !failed) {
    console.error('No tests found');
    return 1;
  }
  console.log(`${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
};

// Test Scripts and Session Transcripts: a file as given, or every one in a
// directory, skipping dot directories and node_modules.
const discover = (path: string): string[] => {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`${path}: no such file or directory`);
  }
  if (stats.isFile()) {
    if (!path.endsWith('.test.talk') && !path.endsWith('.transcript')) {
      throw new Error(`${path} is neither a Test Script nor a Transcript`);
    }
    return [path];
  }
  return readdirSync(path, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
    .flatMap(e =>
      e.isDirectory()
        ? discover(join(path, e.name))
        : e.name.endsWith('.test.talk') || e.name.endsWith('.transcript')
          ? [join(path, e.name)]
          : [],
    );
};

const indent = (lines: readonly string[]) => lines.map(line => `  ${line}`);

// The Test Handlers a Test Script declares: parameterless Handlers named
// `test` and then a capital, once each however many clauses they have.
const testsOf = (tree: SyntaxNode): { setup: boolean; tests: Test[] } => {
  const seen = new Map<string, Test>();
  let setup = false;
  for (const declaration of tree.children) {
    const handler =
      declaration.kind === 'node'
        ? declaration.children.find(
            (c): c is SyntaxNode => c.kind === 'node' && c.rule === 'Handler',
          )
        : undefined;
    if (!handler) {
      continue;
    }
    const nodes = handler.children.filter(
      (c): c is SyntaxNode => c.kind === 'node',
    );
    const name = nodes.find(n => n.rule === 'MessageName');
    const word = name && firstToken(name);
    const on = firstToken(handler);
    if (!word || !on || nodes.some(n => n.rule === 'Pattern')) {
      continue;
    }
    if (word.v === 'setup') {
      setup = true;
    } else if (TEST_HANDLER.test(word.v) && !seen.has(word.v)) {
      seen.set(word.v, { name: word.v, line: on.line, col: on.col });
    }
  }
  return { setup, tests: [...seen.values()] };
};

type Token = { col: number; line: number; v: string };
const firstToken = (element: SyntaxElement): Token | undefined => {
  if (element.kind !== 'node') {
    return element as unknown as Token;
  }
  for (const child of element.children) {
    const token = firstToken(child);
    if (token) {
      return token;
    }
  }
  return undefined;
};

type Outcome = { lines: string[]; ok: boolean };

// Every Test Handler in one Test Script, each in a fresh Group.
const testScript = (
  file: string,
  manifest: HostManifest | null,
  only: string | undefined,
): Outcome[] => {
  const source = readFileSync(file, 'utf8');
  const parsed = parseSource(source);
  if (!parsed.tree) {
    const { tok, message } = parsed.error!;
    return [
      {
        ok: false,
        lines: [`FAIL ${file}:${tok.line}:${tok.col}`, `  ${message}`],
      },
    ];
  }
  const { setup, tests } = testsOf(parsed.tree);
  const chosen = tests.filter(t => !only || `${file} ${t.name}`.includes(only));
  if (!chosen.length) {
    return [];
  }
  const dir = dirname(file);
  const stem = basename(file, '.test.talk');
  const scripts = readdirSync(dir)
    .filter(name => name.endsWith('.talk') && !name.endsWith('.test.talk'))
    .sort()
    .map(name => ({
      name: basename(name, '.talk'),
      file: join(dir, name),
      source: readFileSync(join(dir, name), 'utf8'),
    }));
  const testName = `${stem}Test`;
  for (const name of [testName, ...scripts.map(s => s.name)]) {
    if (!IDENTIFIER.test(name)) {
      return [
        {
          ok: false,
          lines: [`FAIL ${file}`, `  ${name} can't name a Script`],
        },
      ];
    }
  }
  return chosen.map(test => {
    const run = new TestRun(
      manifest,
      [...scripts, { name: testName, file, source }],
      testName,
      test,
    );
    const problems = run.run(setup);
    const label = `${file} ${test.name}`;
    if (!problems.length) {
      return { ok: true, lines: [`ok ${label}`] };
    }
    const at = problems.find(p => p.at)?.at ?? {
      file,
      line: test.line,
      col: test.col,
    };
    return {
      ok: false,
      lines: [
        `FAIL ${at.file}:${at.line}:${at.col} ${test.name}`,
        ...indent(problems.flatMap(p => p.text.split('\n'))),
        ...run.output.map(line => `  | ${line}`),
      ],
    };
  });
};

// One test: a fresh Group of the Scripts under test and the Test Script, with
// mocked Grants, the harness, and a virtual Clock.
class TestRun {
  readonly output: string[] = [];
  private readonly calls = new Map<string, Value[]>();
  private readonly files = new Map<string, string>();
  private readonly group: Group;
  private readonly problems: Problem[] = [];
  private readonly stubs = new Map<string, Stub[]>();
  private readonly unhandled: string[] = [];
  private advances: { call: Call<unknown>; to: bigint }[] = [];
  private answers: (() => void)[] = [];
  private now = EPOCH;
  private loadFailed = false;

  constructor(
    private readonly manifest: HostManifest | null,
    scripts: { file: string; name: string; source: string }[],
    private readonly testName: string,
    private readonly test: Test,
  ) {
    this.group = newGroup({
      name: 'test',
      // Only unhandled messages need the Trace: a Run's report lacks the name.
      trace: line => {
        const name = /^unhandled (?:\S+ )?message=(\S+)/u.exec(line)?.[1];
        if (name) {
          this.unhandled.push(name);
        }
      },
    });
    const capabilities = this.capabilities();
    const declarations = declarationsOf(capabilities);
    let loading = 'a Library';
    try {
      for (const library of this.libraries(declarations)) {
        this.group.addLibrary(library);
      }
      const grants = Object.fromEntries(
        [...capabilities]
          .filter(([name]) => name !== 'harness')
          .map(([name, capability]) => [name, grantOf(name, capability)]),
      );
      for (const script of scripts) {
        loading = script.file;
        this.files.set(script.name, script.file);
        this.group.load({
          name: script.name,
          source: script.source,
          grants:
            script.name === testName
              ? {
                  ...grants,
                  harness: capabilities.get('harness')!.grant('all', undefined),
                }
              : grants,
          grantsAsUsed: true,
        });
      }
    } catch (error) {
      if (!(error instanceof LoadError)) {
        throw error;
      }
      this.loadFailed = true;
      this.problems.push({
        text: `${loading} doesn't load: ${error.message}`,
      });
    }
  }

  run(setup: boolean): Problem[] {
    if (this.loadFailed) {
      return this.problems;
    }
    if (setup && !this.request('setup')) {
      return this.problems;
    }
    this.request(this.test.name);
    return this.problems;
  }

  // Runs one Handler of the Test Script to its end, and then the Group to
  // idle without moving the Clock on. True if nothing went wrong.
  private request(handler: string): boolean {
    const before = this.problems.length;
    const { id, result } = this.group.script(this.testName)!.request({
      name: handler,
    });
    // The run end report carries the reason; the rejection says less.
    result.catch(() => {});
    let ended = false;
    let answer: Call<unknown> | undefined;
    for (let steps = 0; ;) {
      const pumped = this.group.pump(this.now);
      for (const r of pumped.reports) {
        if (r.kind === 'run end' && r.delivery === id) {
          ended = true;
        }
        this.reported(r);
      }
      if (pumped.state === 'stopped') {
        break;
      }
      if (pumped.state === 'sliced') {
        continue;
      }
      if (this.answers.length) {
        this.answers.splice(0).forEach(settle => settle());
        continue;
      }
      if (answer) {
        // The Clock has reached the advance's end: let the test go on.
        answer.answer(nothing);
        answer = undefined;
        continue;
      }
      const next = pumped.nextDeadline;
      const advance = this.advances[0];
      if (advance) {
        if (next !== undefined && next <= advance.to) {
          this.now = next;
        } else {
          this.now = advance.to;
          answer = advance.call;
          this.advances.shift();
        }
      } else if (!ended && next !== undefined) {
        // Only the Clock can move the test on, so time passes.
        this.now = next;
      } else {
        break;
      }
      if (++steps > MAX_STEPS) {
        this.problems.push({ text: 'the test keeps waiting and never ends' });
        return false;
      }
    }
    if (!ended) {
      this.problems.push({
        text: `${handler} waits for something that never comes`,
      });
    }
    return this.problems.length === before;
  }

  // A Run that didn't complete, or a mistake the Host made, is a problem.
  private reported(r: Report) {
    if (r.kind === 'run end') {
      if (r.outcome === 'completed') {
        return;
      }
      const who = `${r.script}${r.handler ? ` ${r.handler}` : ''}`;
      if (r.outcome === 'errored' && r.error) {
        const fields =
          r.error.data.kind === 'map' ? r.error.data.entries() : [];
        // The message reads better as plain text than in display form.
        const error = map([
          ['code', text(r.error.code)],
          ...fields.filter(([k]) => k !== 'at'),
        ]);
        this.problems.push({
          ...(r.at ? { at: this.location(r.at) } : {}),
          text: `${who} errored: ${error.toString()}${
            r.error.message ? `\n  ${r.error.message}` : ''
          }`,
        });
      } else if (r.outcome === 'unhandled') {
        const name = this.unhandled.shift();
        this.problems.push({
          text: `${r.script} has no Handler for ${name ?? 'a message'}`,
        });
      } else {
        this.problems.push({
          ...(r.at ? { at: this.location(r.at) } : {}),
          text: `${who} ended ${r.outcome}${r.limit ? ` (${r.limit})` : ''}`,
        });
      }
    } else if (r.kind === 'call failed') {
      this.problems.push({ text: `${r.script}: ${r.detail}` });
    } else if (r.kind === 'stop') {
      this.problems.push({ text: `${r.script} stopped: ${r.reason}` });
    } else if (r.kind === 'unhandled') {
      this.problems.push({
        text: `${this.testName} has no Handler for ${r.message.name}`,
      });
    }
  }

  // A source position in a Script's file. Inside the Test Library, or any
  // other Library, it's the Test Handler's own.
  private location(at: { col: number; line: number; unit: string }): Location {
    const file = this.files.get(at.unit);
    return file
      ? { file, line: at.line, col: at.col }
      : {
          file: this.files.get(this.testName)!,
          line: this.test.line,
          col: this.test.col,
        };
  }

  private libraries(declarations: GrantDecls): Library[] {
    const sources = [
      { name: 'test', source: TEST_LIBRARY },
      ...(this.manifest?.libraries ?? []),
    ];
    // A Library compiles once each Library it imports has, so in any order.
    const out: Library[] = [];
    let pending = sources;
    while (pending.length) {
      const failed: typeof pending = [];
      let last: unknown;
      for (const src of pending) {
        try {
          out.push(
            compileLibrary(
              { name: src.name, version: LIBRARY_VERSION, source: src.source },
              out,
              declarations,
            ),
          );
        } catch (error) {
          failed.push(src);
          last = error;
        }
      }
      if (failed.length === pending.length) {
        throw last;
      }
      pending = failed;
    }
    return out;
  }

  // The Standard Capabilities, a mock of each Grant the Host Manifest
  // declares, and the harness.
  private capabilities(): Map<string, CapabilityDef<unknown>> {
    const out = new Map<string, CapabilityDef<unknown>>();
    out.set(
      'console',
      consoleCapability(
        {
          write: (_call, value) => {
            this.output.push(value.asText() ?? value.toString());
          },
          read: call => this.suspend('console.read', call, []),
        },
        { write: { fuel: 0 }, read: { fuel: 0 } },
      ),
    );
    out.set('clock', clockCapability({ now: { fuel: 0 } }));
    out.set(
      'calendar',
      calendarCapability(
        calendar,
        free(['today', 'now', 'toCivil', 'toInstant', 'offset', 'zone']),
      ) as CapabilityDef<unknown>,
    );
    out.set(
      'locale',
      localeCapability(
        locale,
        free([
          'compare',
          'rank',
          'upper',
          'lower',
          'numberSymbols',
          'monthNames',
          'dayNames',
          'tag',
        ]),
      ) as CapabilityDef<unknown>,
    );
    for (const [grant, operations] of this.manifest?.grants ?? []) {
      const ops: Record<string, Operation<unknown>> = {};
      for (const [name, op] of operations) {
        const key = `${grant}.${name}`;
        const base = {
          args: op.args,
          cost: { fuel: 0 },
          // A declared list of errors must let the missing answer through.
          ...('errors' in op.declaration
            ? {
                errors: [...op.errors, 'unstubbed call'].map(code => ({
                  code,
                })),
              }
            : {}),
        };
        ops[name] =
          op.mode === 'immediate'
            ? {
                ...base,
                mode: 'immediate',
                do: (_call, ...args) => this.take(key, args),
              }
            : op.mode === 'suspending'
              ? {
                  ...base,
                  mode: 'suspending',
                  start: (call, ...args) => this.suspend(key, call, args),
                }
              : {
                  ...base,
                  mode: 'fire-and-forget',
                  fire: (_call, ...args) => {
                    this.record(key, args);
                  },
                };
      }
      out.set(grant, defineCapability(grant, ops));
    }
    out.set('harness', this.harness());
    return out;
  }

  // The Test Script's control over everything else in the test.
  private harness(): CapabilityDef<unknown> {
    const manifest = this.manifest;
    return defineCapability<unknown>('harness', {
      stub: {
        mode: 'fire-and-forget',
        args: [shape.text, shape.any],
        cost: { fuel: 0 },
        fire: (_call, op, value) => {
          this.queue(mockedOperation(manifest, op!), { value: value! });
        },
      },
      stubFail: {
        mode: 'fire-and-forget',
        args: [shape.text, shape.openMap({ code: shape.text })],
        cost: { fuel: 0 },
        fire: (_call, op, error) => {
          this.queue(mockedOperation(manifest, op!), { error: error! });
        },
      },
      calls: {
        mode: 'immediate',
        args: [shape.text],
        result: shape.listOf(shape.listOf(shape.any)),
        cost: { fuel: 0 },
        do: (_call, op) =>
          list(...(this.calls.get(mockedOperation(manifest, op!)) ?? [])),
      },
      advance: {
        mode: 'suspending',
        args: [shape.quantityKind('exact duration')],
        maxPendingMs: FOREVER_MS,
        cost: { fuel: 0 },
        start: (call, duration) => {
          const ns = waitNs(duration!);
          if (ns < 0n) {
            throw new ScriptError(
              'out of domain',
              '',
              map([['value', duration!]]),
            );
          }
          this.advances.push({ call, to: this.now + ns });
        },
      },
    });
  }

  private queue(key: string, stub: Stub) {
    this.stubs.set(key, [...(this.stubs.get(key) ?? []), stub]);
  }

  private record(key: string, args: Value[]) {
    this.calls.set(key, [...(this.calls.get(key) ?? []), list(...args)]);
  }

  // The next answer queued for a call, or `unstubbed call` with none.
  private take(key: string, args: Value[]): Value {
    this.record(key, args);
    const stub = this.stubs.get(key)?.shift();
    if (!stub) {
      throw new ScriptError(
        'unstubbed call',
        `No answer is queued for ${key}`,
        map([]),
      );
    }
    if (stub.error) {
      throw failure(stub.error);
    }
    return stub.value ?? nothing;
  }

  // A queued failure fails the call at once; an answer waits for the Pump to
  // finish, since a call isn't pending until its start returns.
  private suspend(key: string, call: Call<unknown>, args: Value[]) {
    const value = this.take(key, args);
    this.answers.push(() => call.answer(value));
  }
}

// A mocked Operation, or `console.read`, named `<grant>.<operation>`.
const mockedOperation = (
  manifest: HostManifest | null,
  value: Value,
): string => {
  const key = value.asText()!;
  const [grant = '', name = ''] = key.split('.');
  if (key !== 'console.read' && !manifest?.grants.get(grant)?.has(name)) {
    throw new ScriptError(
      'no such operation',
      `No mocked Operation is named ${key}`,
      map([['name', value]]),
    );
  }
  return key;
};

// An error map as a Host function fails with it, its code and message apart.
const failure = (error: Value): ScriptError =>
  new ScriptError(
    error.get('code').asText() ?? '',
    error.get('message').asText() ?? '',
    map(error.entries().filter(([k]) => k !== 'code' && k !== 'message')),
  );

const free = (operations: readonly string[]) =>
  Object.fromEntries(operations.map(op => [op, { fuel: 0 }]));

// Each Grant's binding: a calendar in UTC and the root locale, as the Session
// Host's defaults.
const grantOf = (
  name: string,
  capability: CapabilityDef<unknown>,
): Grant<unknown> =>
  capability.grant(
    'all',
    name === 'calendar' ? 'UTC' : name === 'locale' ? 'und' : undefined,
  );

// What the Library compiler checks a Library's Capability calls against.
const declarationsOf = (
  capabilities: ReadonlyMap<string, CapabilityDef<unknown>>,
): GrantDecls =>
  Object.fromEntries(
    [...capabilities]
      .filter(([name]) => name !== 'harness')
      .map(([name, capability]) => [
        name,
        Object.fromEntries(
          [...capability.operations].map(([operation, op]) => [
            operation,
            { args: op.args ?? [], mode: op.mode },
          ]),
        ),
      ]),
  );
