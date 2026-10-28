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
  defineObjectKind,
  instant,
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
  timerCapability,
  waitUs,
  type Call,
  type CapabilityDef,
  type Grant,
  type GrantDecls,
  type Group,
  type HostObject,
  type Library,
  type ObjectKind,
  type Operation,
  type Report,
  type Value,
  newGroup,
  toValue,
} from '@northtalk/ts';
import { sourceForm } from '@northtalk/ts/debug';
import { calendar, locale } from '@northtalk/tooling/builtins';
import { readManifest, type HostManifest } from '@northtalk/tooling/lint';
import {
  errorAt,
  TEST_LIBRARY,
  testHandlersOf,
  type TestHandler,
} from '@northtalk/tooling/test-script';
import {
  ProjectFileError,
  readProjectFile,
} from '@northtalk/creative/project-file';
import { runProjectTests } from '@northtalk/creative/test-runner';
import { differs, replayFile } from './replay';

const LIBRARY_VERSION = '1';
// Every test starts at the same instant, under a virtual Clock.
const EPOCH = parseInstant('2026-01-01T00:00:00Z');
// How long a test may keep moving the Clock on before it counts as stuck.
const MAX_STEPS = 10_000;
// A harness call waits as long as a suspending call can.
const FOREVER_MS = 2_147_483_647;
const IDENTIFIER = /^[A-Z_a-z]\w*$/u;

export type TestOptions = { manifest?: string; only?: string };

type Test = TestHandler;
type Location = { col: number; file: string; line: number };
type Problem = { at?: Location; text: string };
type Stub = { error?: Value; value?: Value };
type Timer = {
  args: Value[];
  at: bigint;
  message: string;
  order: number;
  script: string;
};

/** Runs every test under the paths, and returns the exit code. */
export const runTests = async (
  paths: readonly string[],
  options: TestOptions = {},
): Promise<number> => {
  const manifest = options.manifest
    ? readManifest(readFileSync(options.manifest, 'utf8'))
    : null;
  if (manifest?.grants.has('harness')) {
    throw new Error('The Host Manifest may not name a Grant harness');
  }
  if (manifest?.objectsKinds.has('harness')) {
    throw new Error('The Host Manifest may not name an object harness');
  }
  for (const [name, kind] of manifest?.objectsKinds ?? []) {
    if (!manifest!.objectKinds.has(kind)) {
      throw new Error(
        `The Host Manifest has no Object Kind ${kind} for ${name}`,
      );
    }
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
    if (file.endsWith('.folio')) {
      for (const outcome of await folioTests(file, options.only)) {
        report(outcome.ok, outcome.lines);
      }
      continue;
    }
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

// Test Scripts, Session Transcripts and Folio Projects: a file as given, or
// every one in a directory, skipping dot directories and node_modules.
const TESTED = ['.test.talk', '.transcript', '.folio'];
const tested = (name: string) => TESTED.some(suffix => name.endsWith(suffix));
const discover = (path: string): string[] => {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`${path}: no such file or directory`);
  }
  if (stats.isFile()) {
    if (!tested(path)) {
      throw new Error(
        `${path} is not a Test Script, a Transcript or a Folio Project`,
      );
    }
    return [path];
  }
  return readdirSync(path, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
    .flatMap(e =>
      e.isDirectory()
        ? discover(join(path, e.name))
        : tested(e.name)
          ? [join(path, e.name)]
          : [],
    );
};

const indent = (lines: readonly string[]) => lines.map(line => `  ${line}`);

type Outcome = { lines: string[]; ok: boolean };

// Every Test Handler of a Folio Project's Test Scripts, run as Folio's Run
// Tests runs them (ADR 0133).
const folioTests = async (
  file: string,
  only: string | undefined,
): Promise<Outcome[]> => {
  let project;
  try {
    project = (await readProjectFile(readFileSync(file))).project;
  } catch (error) {
    if (!(error instanceof ProjectFileError)) {
      throw error;
    }
    return [{ ok: false, lines: [`FAIL ${file}`, `  ${error.message}`] }];
  }
  const results = await runProjectTests(
    project,
    (script, test) => !only || `${file} ${script} ${test}`.includes(only),
  );
  return results.map(r =>
    r.ok
      ? { ok: true, lines: [`ok ${file} ${r.script.name} ${r.test}`] }
      : {
          ok: false,
          lines: [
            `FAIL ${file}#${r.script.name}:${r.at.line}:${r.at.col}${
              r.test ? ` ${r.test}` : ''
            }`,
            ...indent(r.problems.flatMap(p => p.split('\n'))),
          ],
        },
  );
};

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
  const { setup, tests } = testHandlersOf(parsed.tree);
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
    // With an Owner Kind, the harness's `set` key names a Script's owner as
    // it names a well-known object, so the two may not share a name.
    if (manifest?.ownerKind && manifest.objectsKinds.has(name)) {
      return [
        {
          ok: false,
          lines: [
            `FAIL ${file}`,
            `  ${name} can't name a Script: a well-known object has that name`,
          ],
        },
      ];
    }
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
// mocked Grants and well-known objects, the harness, and a virtual Clock.
class TestRun {
  readonly output: string[] = [];
  private readonly calls = new Map<string, Value[]>();
  private readonly files = new Map<string, string>();
  private readonly group: Group;
  private readonly objects: Record<string, HostObject<Map<string, Value>>> = {};
  // Each Script under test's owner, when the manifest names an Owner Kind.
  private readonly owners = new Map<string, HostObject<Map<string, Value>>>();
  private readonly kinds = new Map<string, ObjectKind<Map<string, Value>>>();
  private readonly problems: Problem[] = [];
  private readonly stubs = new Map<string, Stub[]>();
  // Each Script's timers, by Script and timer name.
  private readonly timers = new Map<string, Timer>();
  private timersSet = 0;
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
    this.makeObjects();
    const ownerKind = manifest?.ownerKind;
    for (const script of scripts) {
      if (ownerKind && script.name !== testName) {
        this.owners.set(
          script.name,
          this.group.object(this.kindOf(ownerKind), script.name, new Map()),
        );
      }
    }
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
        const owner = this.owners.get(script.name);
        this.group.load({
          name: script.name,
          source: script.source,
          objects: this.objects,
          ...(owner ? { owner } : {}),
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
      if (this.fireTimers()) {
        continue;
      }
      if (answer) {
        // The Clock has reached the advance's end: let the test go on.
        answer.answer(nothing);
        answer = undefined;
        continue;
      }
      const next = earliest(pumped.nextDeadline, this.nextTimer());
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
        const at = errorAt(r.error.data) ?? r.at;
        // A failed assertion's expected and actual can be pasted back as source.
        const shown =
          r.error.code === 'assertion failed'
            ? sourceForm(error)
            : error.toString();
        this.problems.push({
          ...(at ? { at: this.location(at) } : {}),
          text: `${who} errored: ${shown}${
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

  // A source position in a Script's file. Inside a Host's Library, it's the
  // Test Handler's own.
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
              { atCaller: src.name === 'test' },
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
    out.set('timer', this.timer());
    for (const [grant, operations] of this.manifest?.grants ?? []) {
      if (this.manifest!.capabilities.get(grant) === 'timer') {
        out.set(grant, this.timer());
        continue;
      }
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
                do: (_call, ...args) => this.take(key, argValues(args)),
              }
            : op.mode === 'suspending'
              ? {
                  ...base,
                  mode: 'suspending',
                  start: (call, ...args) =>
                    this.suspend(key, call, argValues(args)),
                }
              : {
                  ...base,
                  mode: 'fire-and-forget',
                  fire: (_call, ...args) => {
                    this.record(key, argValues(args));
                  },
                };
      }
      out.set(grant, defineCapability(grant, ops));
    }
    out.set('harness', this.harness());
    return out;
  }

  // Timers the runner keeps and delivers on the virtual Clock.
  private timer(): CapabilityDef<unknown> {
    return timerCapability(
      {
        schedule: (call, name, at, message, args) => {
          const listed = Array.from({ length: args.length }, (_, i) =>
            args.index(i + 1),
          );
          this.record(`${call.grantName}.schedule`, [
            text(name),
            at,
            text(message),
            args,
          ]);
          this.timers.set(`${call.scriptName}\u0000${name}`, {
            script: call.scriptName,
            at: at.asInstant()!,
            message,
            args: listed,
            order: this.timersSet++,
          });
        },
        cancel: (call, name) => {
          this.record(`${call.grantName}.cancel`, [text(name)]);
          this.timers.delete(`${call.scriptName}\u0000${name}`);
        },
      },
      free(['schedule', 'cancel']),
    );
  }

  private nextTimer(): bigint | undefined {
    return [...this.timers.values()].reduce<bigint | undefined>(
      (soonest, timer) => earliest(soonest, timer.at),
      undefined,
    );
  }

  // Delivers every timer that is due, soonest and then first set first. True
  // if there were any.
  private fireTimers(): boolean {
    const due = [...this.timers]
      .filter(([, timer]) => timer.at <= this.now)
      .sort(
        ([, a], [, b]) =>
          (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || a.order - b.order,
      );
    for (const [key, timer] of due) {
      this.timers.delete(key);
      this.group
        .script(timer.script)
        ?.deliver({ name: timer.message, args: timer.args });
    }
    return due.length > 0;
  }

  // A mocked Object Kind, whose objects hold the property values Scripts and
  // the harness set.
  private kindOf(kindName: string) {
    const known = this.kinds.get(kindName);
    if (known) {
      return known;
    }
    const declared = this.manifest!.objectKinds.get(kindName)!;
    const kind = defineObjectKind<Map<string, Value>>({
      name: kindName,
      props: Object.fromEntries(
        [...declared.props].map(([prop, { readOnly, shape }]) => [
          prop,
          {
            shape,
            get: object => {
              const value = object.native.get(prop);
              if (!value) {
                throw new ScriptError(
                  'unset property',
                  `No value is set for ${object.id}.${prop}`,
                  map([]),
                );
              }
              return value;
            },
            ...(readOnly
              ? {}
              : {
                  set: (object, value) => {
                    object.native.set(prop, value);
                  },
                }),
          },
        ]),
      ),
    });
    this.kinds.set(kindName, kind);
    return kind;
  }

  // The manifest's well-known objects.
  private makeObjects() {
    for (const [name, kindName] of this.manifest?.objectsKinds ?? []) {
      this.objects[name] = this.group.object(
        this.kindOf(kindName),
        name,
        new Map(),
      );
    }
  }

  // The Test Script's control over everything else in the test.
  private harness(): CapabilityDef<unknown> {
    const manifest = this.manifest;
    return defineCapability<unknown>()('harness', {
      stub: {
        mode: 'fire-and-forget',
        args: [shape.text, shape.any],
        cost: { fuel: 0 },
        fire: (_call, op, value) => {
          this.queue(mockedOperation(manifest, op), { value });
        },
      },
      stubFail: {
        mode: 'fire-and-forget',
        args: [shape.text, shape.openMap({ code: shape.text })],
        cost: { fuel: 0 },
        fire: (_call, op, error) => {
          this.queue(mockedOperation(manifest, op), { error });
        },
      },
      set: {
        mode: 'fire-and-forget',
        args: [shape.text, shape.any],
        cost: { fuel: 0 },
        fire: (_call, property, value) => {
          const [object, prop] = this.property(property);
          object.native.set(prop, value);
        },
      },
      owner: {
        mode: 'immediate',
        args: [shape.text],
        result: manifest?.ownerKind
          ? shape.object(this.kindOf(manifest.ownerKind))
          : shape.any,
        cost: { fuel: 0 },
        do: (_call, name) => {
          const owner = this.owners.get(name);
          if (!owner) {
            throw new ScriptError(
              'no such script',
              `No Script under test named ${name} has an owner`,
              map([['name', text(name)]]),
            );
          }
          return owner;
        },
      },
      calls: {
        mode: 'immediate',
        args: [shape.text],
        result: shape.listOf(shape.listOf(shape.any)),
        cost: { fuel: 0 },
        do: (_call, op) =>
          list(...(this.calls.get(mockedOperation(manifest, op)) ?? [])),
      },
      advance: {
        mode: 'suspending',
        args: [shape.quantityKind('exact duration')],
        maxPendingMs: FOREVER_MS,
        cost: { fuel: 0 },
        start: (call, duration) => {
          const us = waitUs(duration);
          if (us < 0n) {
            throw new ScriptError(
              'out of domain',
              '',
              map([['value', duration]]),
            );
          }
          this.advances.push({ call, to: this.now + us });
        },
      },
    });
  }

  // A well-known object's or owner's property, named `<name>.<property>`.
  private property(key: string): [HostObject<Map<string, Value>>, string] {
    const [name = '', prop = ''] = key.split('.');
    const object = this.objects[name] ?? this.owners.get(name);
    if (!object?.kind.props.has(prop)) {
      throw new ScriptError(
        'no such property',
        `No well-known object or owner has a property ${key}`,
        map([['name', text(key)]]),
      );
    }
    return [object, prop];
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

// Arguments back as Values: a Host function receives each scalar Shape in
// its JS form and a Host Object as its handle (#1420), and these are disjoint.
const argValues = (args: readonly unknown[]): Value[] =>
  args.map(arg => {
    if (typeof arg === 'bigint') {
      return instant(arg);
    }
    if (arg === null || typeof arg !== 'object' || !('value' in arg)) {
      return toValue(arg);
    }
    return (arg as HostObject).value;
  });

// A mocked Operation, `console.read`, or a `timer` Operation, named
// `<grant>.<operation>`.
const mockedOperation = (
  manifest: HostManifest | null,
  key: string,
): string => {
  const [grant = '', name = ''] = key.split('.');
  const timer =
    (name === 'schedule' || name === 'cancel') &&
    (grant === 'timer' || manifest?.capabilities.get(grant) === 'timer');
  if (
    key !== 'console.read' &&
    !timer &&
    !manifest?.grants.get(grant)?.has(name)
  ) {
    throw new ScriptError(
      'no such operation',
      `No mocked Operation is named ${key}`,
      map([['name', text(key)]]),
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

const earliest = (a: bigint | undefined, b: bigint | undefined) =>
  a === undefined ? b : b === undefined || a <= b ? a : b;

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
