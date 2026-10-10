import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseInstant,
  readDisplay,
  type ScriptError,
  type Value,
} from '../../src/index';
import { createWebhookHost, rulesSource, type Rule } from './host';

export const demoRules: Rule[] = [
  { type: 'order.created', target: 'fulfilment', retries: 1 },
  { type: 'invoice.paid', target: 'accounts', retries: 0 },
];

/** A clock that moves only when told to, firing due deadlines. */
export class ManualClock {
  private deadlines: { at: bigint; fire: () => void }[] = [];
  constructor(public now: bigint) {}
  readonly read = () => this.now;
  readonly setDeadline = (at: bigint, fire: () => void) => {
    const entry = { at, fire };
    this.deadlines.push(entry);
    return () => {
      this.deadlines = this.deadlines.filter(d => d !== entry);
    };
  };
  advance(ns: bigint) {
    this.now += ns;
    const due = this.deadlines
      .filter(d => d.at <= this.now)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    this.deadlines = this.deadlines.filter(d => d.at > this.now);
    for (const d of due) {
      d.fire();
    }
  }
}

type Pending = {
  body: string;
  refuse(): void;
  respond(status: number): void;
  url: string;
};

/** A stand-in upstream whose answers the scenario gives, one by one. */
export class Upstream {
  readonly pending: Pending[] = [];
  readonly aborted: string[] = [];
  readonly fetch = (url: string, init: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const entry: Pending = {
        url,
        body: String(init.body),
        respond: status => resolve(new Response(null, { status })),
        refuse: () => reject(new TypeError('connection refused')),
      };
      init.signal?.addEventListener('abort', () => {
        this.aborted.push(url);
        reject(init.signal!.reason);
      });
      this.pending.push(entry);
    });
  next(): Pending {
    const p = this.pending.shift();
    if (!p) {
      throw new Error('no request is waiting upstream');
    }
    return p;
  }
}

const SECOND = 1_000_000_000n;
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Plays the scenario on a recording Host with a manual Clock and a
 * stand-in upstream. Each step ends when the Group has settled, so every
 * Pump lands in the same place on each run.
 */
export const runScenario = async () => {
  const clock = new ManualClock(parseInstant('2026-10-10T12:00:00Z'));
  const upstream = new Upstream();
  const host = createWebhookHost({
    rules: demoRules,
    targets: {
      fulfilment: 'http://fulfilment.test/hooks',
      accounts: 'http://accounts.test/hooks',
    },
    fetch: upstream.fetch,
    drive: { clock: clock.read, setDeadline: clock.setDeadline },
    record: true,
  });
  const recorder = host.recorder!;
  const settled = async () => {
    for (let i = 0; i < 4; i++) {
      await turn();
      await host.drive.idle();
    }
  };
  const results: string[] = [];
  // The reply arrives in a later step, so nothing waits on it here.
  const send = (source: string, signal?: AbortSignal) => {
    host.handle(readDisplay(source), signal).then(
      v => results.push(v.toString()),
      error => results.push(`rejected: ${(error as ScriptError).code}`),
    );
  };
  const step = async (note: string, f: () => unknown) => {
    recorder.comment(note);
    clock.advance(SECOND);
    await f();
    await settled();
  };

  await step(
    'No rule matches, so the Run records the event and replies at once.',
    () => send('{type: "user.signup", data: {id: 7}}'),
  );
  await step(
    'A match posts to `fulfilment`: a suspending call whose fetch is still running when the Pump ends.',
    () => send('{type: "order.created", data: {id: 41, total: 12}}'),
  );
  await step(
    "The fetch's Promise resolves with 202, which answers the call and resumes the Run.",
    () => upstream.next().respond(202),
  );
  await step(
    '`accounts` answers 500: the Promise rejects with `rejected`, which fails the call. The rule allows no retry.',
    async () => {
      send('{type: "invoice.paid", data: {id: 9}}');
      await settled();
      upstream.next().respond(500);
    },
  );
  await step(
    'The connection is refused: the call fails `unreachable`, and the Run waits 1 s on the Clock to retry.',
    async () => {
      send('{type: "order.created", data: {id: 42, total: 30}}');
      await settled();
      upstream.next().refuse();
    },
  );
  await step(
    "The driver's deadline Pumps the retry, and it succeeds.",
    async () => {
      await settled();
      upstream.next().respond(200);
    },
  );
  await step('`accounts` never answers.', () =>
    send('{type: "invoice.paid", data: {id: 10}}'),
  );
  await step(
    "Past `post`'s 2 s maxPending the call fails `timeout`, and its signal aborts the fetch; the fetch's late rejection is recorded and ignored.",
    () => clock.advance(SECOND),
  );
  await step(
    'The webhook client hangs up: aborting the Request cancels its Run, and the abandoned call aborts its fetch.',
    async () => {
      const client = new AbortController();
      send('{type: "order.created", data: {id: 43, total: 5}}', client.signal);
      await settled();
      client.abort();
    },
  );
  recorder.comment(
    'The case ends by reading the counters and inspecting the Group.',
  );
  host.script.counters();
  const vars: [string, Value][] = host.group.inspect().scripts[0]!.vars;
  const events = host.db
    .prepare('SELECT type, outcome FROM events ORDER BY id')
    .all() as { outcome: string; type: string }[];
  host.close();
  return {
    aborted: upstream.aborted,
    events,
    lines: recorder.lines,
    results,
    vars,
  };
};

const caseToml = `# webhooks: the Bun webhook rules Example Host (impl/ts/examples/webhooks,
# spec Appendix B milestone 2). Its database and fetch bindings never appear
# here: the immediate \`rules\` calls replay from Stubs, and \`post\` from the
# recorded answers and failures.

kind = "trace"

[versions]
language = "1.0-rc.2"
costModel = "0"

[[operations]]
capability = "outbound"
name = "post"
mode = "suspending"
args = ["text", "any"]
result = "number"
cost = { fuel = 40 }
maxPending = 2000
errors = [{ code = "rejected", fields = [{ key = "status", shape = "number" }] }, { code = "unknown target" }, { code = "unreachable" }]

[[operations]]
capability = "rules"
name = "match"
mode = "immediate"
args = ["text"]
result = { oneOf = ["nothing", { map = [{ key = "target", shape = "text" }, { key = "retries", shape = "number" }] }] }
cost = { fuel = 25 }

[[operations]]
capability = "rules"
name = "record"
mode = "immediate"
args = ["text", { oneOf = ["text", "number"] }]
result = "number"
cost = { fuel = 25 }

[[scripts]]
name = "rules"
source = "rules.talk"
grants = { outbound = { ops = ["post"] }, rules = { ops = ["match", "record"] } }
`;

/** The Trace Case the scenario records: case.toml, the Script and case.trace. */
export const caseFiles = async (): Promise<Record<string, string>> => {
  const { lines } = await runScenario();
  const header = [
    '# Unblessed: the Bun webhook rules Example Host (#144); first blessing awaits human review.',
    '# webhooks: the Bun webhook rules Example Host',
    '# (impl/ts/examples/webhooks), recorded by `bun impl/ts/examples/webhooks/main.ts record`.',
    '# The Host recorded the `stub` lines from what its immediate Host functions',
    "# returned. Its Fuel, allocation and state figures are Cost Model 0's.",
    '',
  ];
  return {
    'case.toml': caseToml,
    'case.trace': [...header, ...lines].join('\n') + '\n',
    'rules.talk': rulesSource,
  };
};

export const record = async (dir: string) => {
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(await caseFiles())) {
    writeFileSync(join(dir, file), content);
  }
};
