# Embed the TS Core in a TypeScript app

Use `@northtalk/ts` to let users write NorthTalk Scripts inside your application.
Your app is the **Host**: it supplies source, sends messages, grants access to
application services and sets resource limits. The TS Core parses, checks and
executes the Scripts.

This guide starts with a Handler that adds two numbers, then connects a Script
to an asynchronous application service. The [language tour](tour.md) introduces
NorthTalk syntax; the [embedding specification](../spec/09-embedding.md) and
[TypeScript declarations](../spec/embedding/talk.ts) define the API.

## Install and run

In an ESM TypeScript application:

```sh
npm install @northtalk/ts
```

The package contains JavaScript and TypeScript declarations. Use TypeScript 5.9
or later. The examples below run with Bun, or with Node 24.10 or later after
compilation to JavaScript. For a new Bun app:

```sh
mkdir northtalk-app
cd northtalk-app
bun init -y
bun add @northtalk/ts
```

Save an example as `main.ts` and run `bun main.ts`. In an existing app, use your
usual TypeScript build and entry point. The Core also runs in browsers through
an ESM bundler or import map; load `.talk` source as text through your app's
asset pipeline. See the [package runtime details](../impl/ts/tools/package/README.md#runtimes).

To try the complete application-service example from this checkout, run these
commands at the repository root:

```sh
bun install --frozen-lockfile
bun run unicode:check
bun impl/ts/examples/embedding/main.ts
```

It prints `Hello, Ada!`. The [runnable source](../impl/ts/examples/embedding/main.ts)
uses the same package imports as an external app; the workspace resolves them
to the local TS Core.

## Load a Script and call a Handler

```ts
import { newGroup, num, parseInstant } from '@northtalk/ts';

const group = newGroup({ name: 'calculator' });
const script = group.load({
  name: 'main',
  source: `on total a, b
  return a + b
end total`,
});

const reply = script.request({ name: 'total', args: [num(2), num(3)] });
group.pump(parseInstant('2026-10-20T09:00:00Z'));
const answer = await reply.result;
console.log(answer.asDecimal()!.toString()); // 5
```

A **Group** owns Script state and schedules its messages. `load` checks and
compiles the source synchronously, then returns a Script handle. Source contains
declarations; executable statements go inside Handlers such as `on total`.

`request` queues a message and returns `{ id, result }`. Execution happens when
the Host calls `pump`, so awaiting the result without arranging a Pump leaves
the request pending. This Handler finishes in one Pump. Longer work can require
more Pumps, and a suspending Operation needs a later Pump after its answer
arrives.

Use `request` when the app needs an answer. Use `deliver` for a message whose
answer the app does not need; it returns a delivery id and still needs pumping.
Keep a loaded Script handle for subsequent requests. Its `script variable`
declarations retain state across Handler calls.

## Convert values at the boundary

Arguments and results are NorthTalk `Value` instances. Construct them explicitly:

| TypeScript data | NorthTalk constructor | Read the result |
| --- | --- | --- |
| Text | `text('Ada')` | `value.asText()` |
| Boolean | `bool(true)` | `value.asBool()` |
| Integer | `num(42)` or `num(42n)` | `value.asDecimal()?.toBigInt()` |
| Exact decimal | `dec('19.95')` | `value.asDecimal()?.toString()` |
| List | `list(text('a'), text('b'))` | `value.index(1)`, `value.length` |
| Map | `record({ name: text('Ada') })` | `value.get('name')` |
| No value | `nothing` | `value.kind === 'nothing'` |

Import constructors from `@northtalk/ts`. Plain JS objects, `null` and `undefined`
cannot be passed as Script values. Accessors such as `asText()` return
`undefined` for a different kind. Lists use **1-based** indexes.

NorthTalk numbers are decimals. Use `dec` with decimal text when precision
matters; converting a JS number cannot recover precision it has already lost.
For an HTTP JSON body, `decodeJson(rawText)` reads numbers directly from their
text, and `encodeJson(value)` produces ordinary JSON for supported kinds.
`encodeValue`/`decodeValue` instead provide the lossless tagged Value Encoding.
`toString()` produces the language's display form. See [public values](../impl/ts/README.md#public-values).

## Connect a Script to your application

Scripts have no ambient access to your database, filesystem, network or JS
objects. Expose an application action as a **Capability Operation**, then give
the Script a **Grant** containing the Operations it may call.

This complete `main.ts` looks up a customer's name through an app-owned service:

```ts
import {
  defineCapability,
  newGroup,
  ScriptError,
  shape,
  text,
} from '@northtalk/ts';
import { autoDrive } from '@northtalk/ts/driver';

type CustomerDirectory = {
  lookup(id: string, signal: AbortSignal): Promise<string | undefined>;
};

// Define the API once. Each Grant supplies its own application binding.
const customers = defineCapability<CustomerDirectory>('customers', {
  lookup: {
    mode: 'suspending',
    args: [shape.text],
    result: shape.text,
    errors: [{ code: 'customer missing' }],
    cost: { fuel: 10 },
    maxPendingMs: 2000,
    run: async (call, id) => {
      const name = await call.binding.lookup(id.asText()!, call.signal);
      if (name === undefined) {
        throw new ScriptError('customer missing', 'No matching customer');
      }
      return text(name);
    },
  },
});

// Stand-in for the application's database or service client.
const names = new Map([['c-1', 'Ada']]);
const directory: CustomerDirectory = {
  lookup: (id, signal) => {
    signal.throwIfAborted();
    return Promise.resolve(names.get(id));
  },
};

const group = newGroup({
  name: 'greetings',
  onReady: () => drive.ready(),
});
const drive = autoDrive(group, {
  pump: { fuelSlice: 1000, fuelCap: 5000 },
  onError: error => console.error('Pump failed:', error),
});

try {
  const script = group.load({
    name: 'welcome',
    source: `on greet customerId
  ask customers to lookup customerId and wait
  return "Hello, " & it & "!"
end greet`,
    grants: { customers: customers.grant(['lookup'], directory) },
    limits: { fuelPerRun: 10_000, mailboxDepth: 32, maxWaitMs: 3000 },
  });

  const answer = await script.request({
    name: 'greet',
    args: [text('c-1')],
  }).result;
  console.log(answer.asText()); // Hello, Ada!
} finally {
  // Stop is queued: let the driver apply it before stopping the driver.
  group.script('welcome')?.stop('Application shutdown');
  await drive.idle();
  drive.stop();
}
```

Replace `directory.lookup` with your app's service call and pass its cancellation
signal through to the underlying client. The Script receives only the returned
name; the Grant's binding stays in Host code. Bind a tenant-scoped client here
when the app serves several tenants. Scripts in the same Group can message one
another, so use separate Groups for tenants that must be isolated.

The declaration checks argument and result Shapes. That makes `id.asText()!`
safe in the callback: the Core has already checked `shape.text`. The Grant
exposes only `lookup`, under the Script-visible name `customers`. Calls to an
ungranted Operation are rejected at load.

`mode: 'suspending'` and `run` adapt a Promise to a Script's `ask … and wait`.
The Core queues its answer or failure when the Promise settles. `maxPendingMs`
bounds the pending call; `call.signal` aborts when it is abandoned, including
cancellation or timeout. The Host's I/O client must honor that signal to stop
the underlying work. For a short synchronous action, use `mode: 'immediate'`
with a `do` callback returning a `Value`, and call it with `ask …` without
`and wait`.

## Drive execution and manage lifetime

`autoDrive` connects a Group to the event loop. Its `onReady` callback schedules
a later Pump when an input arrives, including an asynchronous Operation answer.
It also schedules deadlines and continues after Fuel slicing. Create the driver
before queuing requests. The `onReady` closure above is safe because Group
creation queues no work.

`fuelSlice` lets other event-loop work run between Pumps; `fuelCap` bounds the
Group's work in each Pump. These scheduling settings are separate from
`fuelPerRun`, which limits the total work of a Handler invocation. `load` also
accepts allocation, persistent-state, call-depth and other limits; omitted
fields use `defaultLimits`. A message's `limits` can tighten the permitted
per-Delivery limits. See [limits](../spec/06-errors-and-limits.md#limits).

For a game loop or deterministic test, pump manually instead. Pass `bigint`
epoch **microseconds**, such as `BigInt(Date.now()) * 1000n`, with readings
that never go backwards. Continue when the result is `sliced` or `rewound`,
schedule `nextDeadline`, and arrange another Pump when an input becomes ready.
An `idle` result can still have suspended work waiting for I/O or a deadline.
Choose one owner of pumping for a Group.

When a request should follow an app task's cancellation, pass its signal:

```ts
const controller = new AbortController();
const reply = script.request(
  { name: 'greet', args: [text('c-1')] },
  { signal: controller.signal },
);
controller.abort(); // Queues cancellation; the driver applies it.
await reply.result; // Rejects if cancellation wins the race.
```

On shutdown, stop accepting new app requests, queue `script.stop(reason)` for
each loaded Script, let the driver drain with `await drive.idle()`, then call
`drive.stop()` and release app-owned resources. `drive.stop()` cancels the
driver's scheduling; stopping Scripts is a separate step. `drive.idle()` alone
means no Pump is scheduled or running, and can resolve while I/O is pending.

Operation and property callbacks run during a Pump. They may enqueue messages,
but must not call worker methods such as `pump`, `load`, `save` or `inspect` on
that Group. Those calls raise `HostError` with code `reentrant call`. Use
`autoDrive`'s `onPump` callback for work that must happen after a Pump returns.

## Handle failures and observe execution

Catch synchronous failures around `load` and request admission, and catch the
request's result rejection:

| Failure | What the Host receives |
| --- | --- |
| Invalid source or unavailable Operation | `LoadError`, with `diagnostics` containing code, unit, line and column |
| Full receiver mailbox | Synchronous `MailboxFull`; the app can apply backpressure |
| Invalid Host input or reentrant worker call | `HostError`, with a stable `code` |
| Request that cannot complete successfully | Rejected result with `ScriptError`, code `send failed` and reason in `data` |

A declared `ScriptError` thrown by an Operation is catchable inside the Script.
For example, replace the greeting Handler with:

```talk
on greet customerId
  try
    ask customers to lookup customerId and wait
    return "Hello, " & it & "!"
  catch {code: "customer missing"}
    return "Hello, visitor!"
  end try
end greet
```

Use `autoDrive`'s `onPump` callback, or a manual Pump's return value, to inspect
reports such as `run end` and `call failed`. A failed request's `send failed`
error does not replace those detailed reports. The driver's `onError` handles
a Pump that throws; it does not handle request result rejections for you.

For a textual execution Trace, pass `trace: line => console.log(line)` to
`newGroup`. Keep tracing optional in the app: it records input values and
execution details. See [Trace support](../impl/ts/README.md#the-group-and-trace-cases).

## Extend the integration

- **Editor support:** export a Host Manifest describing your Grants, messages
  and Libraries with `exportManifest`. Bindings are omitted. See
  [Host Manifests](../impl/ts/README.md#process-wide-core-and-host-manifests).
- **Persistence and reload:** save a Quiescent Group with `group.save()` and
  restore it with Host-supplied Grants, Libraries and Object resolution. Saves
  use the originating Core family's format; they cannot transfer a TS Group to
  the Zig Core. Live effects can prevent saving. See
  [save and restore](../spec/10-save-and-restore.md) and the
  [core-switch example](../impl/ts/examples/core-switch/README.md).
- **Databases:** use the optional `sqlite` Standard Capability for SQL, or
  `store` for keyed values. See [Using SQLite](sqlite.md) and the
  [SQLite Store example](../impl/ts/examples/store-sqlite/README.md).
- **A fuller server:** the [webhook Example Host](../impl/ts/examples/webhooks/README.md)
  combines `autoDrive`, Promise-backed I/O, cancellation and an HTTP endpoint.
- **A browser REPL:** use `SessionHost` from `@northtalk/ts/session`. It provides
  interactive Entries and Transcripts; see the [Session Host guide](../impl/ts/README.md#the-session-host).
