import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { autoDrive, type AutoDriveOptions, type Drive } from '../../src/driver';
import {
  defineCapability,
  encodeJson,
  newGroup,
  nothing,
  num,
  record,
  ScriptError,
  shape,
  text,
  type Group,
  type ScriptHandle,
  type Value,
} from '../../src/index';

export const rulesSource = readFileSync(
  new URL('rules.talk', import.meta.url),
  'utf8',
);

/** One routing rule: events of `type` go to the named `target`. */
export type Rule = { retries: number; target: string; type: string };

/** The `fetch` the Host posts with. Tests and the recorder supply their own. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type WebhookHostOptions = {
  /** SQLite path; the default is an in-memory database. */
  database?: string;
  drive?: Omit<AutoDriveOptions, 'onPump'>;
  fetch?: Fetch;
  /** Keeps the Trace, with Stubs for the immediate database calls. */
  record?: boolean;
  rules?: Rule[];
  /** Target names Scripts may post to, and their URLs. Scripts never see a URL. */
  targets: Record<string, string>;
};

type Outbound = { fetch: Fetch; targets: Record<string, string> };

// Capabilities are defined once per process. Their Host functions read
// everything else from each Grant's binding.
const rules = defineCapability<DatabaseSync>('rules', {
  match: {
    mode: 'immediate',
    args: [shape.text],
    result: shape.oneOf(
      shape.nothing,
      shape.map({ target: shape.text, retries: shape.number }),
    ),
    cost: { fuel: 25 },
    do: (call, type) => {
      const row = call.binding
        .prepare('SELECT target, retries FROM rules WHERE type = ?')
        .get(type.asText()!) as { retries: number; target: string } | undefined;
      const v = row
        ? record({ target: text(row.target), retries: num(row.retries) })
        : nothing;
      stub(call.group, `rules.match${row ? ` value=${v}` : ''}`);
      return v;
    },
  },
  record: {
    mode: 'immediate',
    args: [shape.text, shape.oneOf(shape.text, shape.number)],
    result: shape.number,
    cost: { fuel: 25 },
    do: (call, type, outcome) => {
      const { lastInsertRowid } = call.binding
        .prepare('INSERT INTO events (type, outcome, at) VALUES (?, ?, ?)')
        .run(
          type.asText()!,
          outcome.asText() ?? outcome.toString(),
          String(call.now),
        );
      const id = num(Number(lastInsertRowid));
      stub(call.group, `rules.record value=${id}`);
      return id;
    },
  },
});

const outbound = defineCapability<Outbound>('outbound', {
  post: {
    mode: 'suspending',
    args: [shape.text, shape.any],
    result: shape.number,
    errors: [
      { code: 'unknown target' },
      { code: 'rejected', fields: { status: shape.number } },
      { code: 'unreachable' },
    ],
    cost: { fuel: 40 },
    maxPendingMs: 2000,
    // Promise sugar: the Core answers or fails the call when it settles. The
    // call's signal aborts the fetch when the call is abandoned, by its
    // maxPendingMs or by the Request being cancelled.
    run: async (call, target, body) => {
      const url = call.binding.targets[target.asText()!];
      if (url === undefined) {
        throw new ScriptError('unknown target', '', record({ target }));
      }
      let response: Response;
      try {
        response = await call.binding.fetch(url, {
          body: encodeJson(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          signal: call.signal,
        });
      } catch {
        throw new ScriptError('unreachable', '');
      }
      if (!response.ok) {
        throw new ScriptError(
          'rejected',
          '',
          record({ status: num(response.status) }),
        );
      }
      return num(response.status);
    },
  },
});

/** The Trace sinks of recording Hosts, by Group. */
const recorders = new WeakMap<Group, Recorder>();
const stub = (group: Group, line: string) =>
  recorders.get(group)?.stubs.push(`> stub ${line}`);

// The Inputs a Pump drains. The Core writes them as it drains them, and a
// replaying runner writes its Stubs as it reads them, so Stubs go first.
const queued = new Set([
  'deliver',
  'request',
  'broadcast',
  'decide',
  'decide-broadcast',
  'call-value',
  'set-parent',
  'dispose',
  'stop',
  'cancel-run',
  'rewind-run',
  'cancel-delivery',
  'revoke',
  'answer',
  'fail',
  'settle',
]);

/**
 * A live Host has no Stubs, so the recorder writes what each immediate Host
 * function returned as `stub` lines ahead of the Pump that made the calls.
 * The Trace then replays on a corpus runner (spec chapter 11, Stubs).
 */
export class Recorder {
  readonly lines: string[] = [];
  stubs: string[] = [];
  private pumpAt = 0;

  readonly trace = (line: string) => {
    if (line.startsWith('> pump ')) {
      this.pumpAt = this.lines.length;
    }
    this.lines.push(line);
  };

  pumped() {
    if (!this.stubs.length) {
      return;
    }
    let at = this.pumpAt;
    while (at > 0) {
      const line = this.lines[at - 1]!;
      if (!line.startsWith('> ') || !queued.has(line.slice(2).split(' ')[0]!)) {
        break;
      }
      at--;
    }
    this.lines.splice(at, 0, ...this.stubs);
    this.stubs = [];
  }

  comment(note: string) {
    if (this.lines.length) {
      this.lines.push('');
    }
    let line = '#';
    for (const word of note.split(/\s+/)) {
      if (line.length + 1 + word.length > 76) {
        this.lines.push(line);
        line = '#';
      }
      line += ` ${word}`;
    }
    this.lines.push(line);
  }
}

export type WebhookHost = {
  close(): void;
  readonly db: DatabaseSync;
  readonly drive: Drive;
  readonly group: Group;
  /** Sends `event` as a Request. Aborting the signal cancels its Run. */
  handle(event: Value, signal?: AbortSignal): Promise<Value>;
  readonly recorder?: Recorder;
  readonly script: ScriptHandle;
};

export const createWebhookHost = (o: WebhookHostOptions): WebhookHost => {
  const db = new DatabaseSync(o.database ?? ':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rules (type TEXT PRIMARY KEY, target TEXT NOT NULL, retries INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, outcome TEXT NOT NULL, at TEXT NOT NULL);
  `);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO rules (type, target, retries) VALUES (?, ?, ?)',
  );
  for (const rule of o.rules ?? []) {
    insert.run(rule.type, rule.target, rule.retries);
  }
  const recorder = o.record ? new Recorder() : undefined;
  // The Group's onReady is fixed when it is made, so it calls the driver made
  // just after it. Loading queues nothing, so it isn't called before then.
  const group = newGroup({
    name: 'webhooks',
    onReady: () => drive.ready(),
    trace: recorder?.trace,
  });
  if (recorder) {
    recorders.set(group, recorder);
  }
  const drive = autoDrive(group, {
    ...o.drive,
    onPump: () => recorder?.pumped(),
  });
  const script = group.load({
    name: 'rules',
    source: rulesSource,
    grants: {
      rules: rules.grant('all', db),
      outbound: outbound.grant('all', {
        fetch: o.fetch ?? fetch,
        targets: o.targets,
      }),
    },
  });
  return {
    db,
    drive,
    group,
    recorder,
    script,
    handle: (event, signal) =>
      script.request({ name: 'event', args: [event] }, { signal }).result,
    close: () => {
      drive.stop();
      db.close();
    },
  };
};
