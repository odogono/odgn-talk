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
import { num, talk } from '@northtalk/ts';
import { newDrivenGroup } from '@northtalk/ts/driver';

const { group, drive } = newDrivenGroup({ name: 'calculator' });
const script = group.load({
  name: 'main',
  source: talk`
    on total a, b
      return a + b
    end total
  `,
});

const answer = await script.invoke('total', num(2), num(3));
console.log(answer.asDecimal()!.toString()); // 5
await drive.close();
```

A **Group** owns Script state and schedules its messages. `load` checks and
compiles the source synchronously, then returns a Script handle. Source contains
declarations; executable statements go inside Handlers such as `on total`.
The `talk` tag strips the common indentation so inline source can follow the
surrounding code. It rejects JS `${…}` values: write NorthTalk interpolation as
`\${…}` and its backticks as `` \` ``, and pass values as Request arguments.

`invoke` queues a Request and resolves with its answer. `request` does the same
but returns `{ id, result }`, and takes a cancellation signal. `newDrivenGroup` wires
the Group to an event-loop driver before returning, so you can await Requests
immediately. This Handler finishes in one Pump. The driver also schedules later
Pumps for longer work and for a suspending Operation after its answer arrives.

Use `request` when the app needs an answer. Use `deliver` for a message whose
answer the app does not need; it returns a delivery id and still needs pumping.
Keep a loaded Script handle for subsequent requests. Its `script variable`
declarations retain state across Handler calls.

## Convert values at the boundary

Arguments and results are NorthTalk `Value` instances. Construct them explicitly:

| TypeScript data | NorthTalk constructor           | Read the result                  |
| --------------- | ------------------------------- | -------------------------------- |
| Text            | `text('Ada')`                   | `value.asText()`                 |
| Boolean         | `bool(true)`                    | `value.asBool()`                 |
| Integer         | `num(42)` or `num(42n)`         | `value.asDecimal()?.toBigInt()`  |
| Exact decimal   | `dec('19.95')`                  | `value.asDecimal()?.toString()`  |
| List            | `list(text('a'), text('b'))`    | `value.index(1)`, `value.length` |
| Map             | `record({ name: text('Ada') })` | `value.get('name')`              |
| No value        | `nothing`                       | `value.kind === 'nothing'`       |

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
import { defineCapability, ScriptError, shape, talk, text } from '@northtalk/ts';
import { newDrivenGroup } from '@northtalk/ts/driver';

type CustomerDirectory = {
  lookup(id: string, signal: AbortSignal): Promise<string | undefined>;
};

// Define the API once. Each Grant supplies its own application binding,
// whose type the curried call names.
const customers = defineCapability<CustomerDirectory>()('customers', {
  lookup: {
    mode: 'suspending',
    args: [shape.text],
    result: shape.text,
    errors: [{ code: 'customer missing' }],
    cost: { fuel: 10 },
    maxPendingMs: 2000,
    run: async (call, id) => {
      const name = await call.binding.lookup(id, call.signal);
      if (name === undefined) {
        throw new ScriptError('customer missing', 'No matching customer');
      }
      return name;
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

const { group, drive } = newDrivenGroup({
  name: 'greetings',
  pump: { fuelSlice: 1000, fuelCap: 5000 },
  onError: error => console.error('Pump failed:', error),
});

try {
  const script = group.load({
    name: 'welcome',
    source: talk`
      on greet customerId
        ask customers to lookup customerId and wait
        return "Hello, " & it & "!"
      end greet
    `,
    grants: { customers: customers.grant(['lookup'], directory) },
    limits: { fuelPerRun: 10_000, mailboxDepth: 32, maxWaitMs: 3000 },
  });

  const answer = await script.invoke('greet', text('c-1'));
  console.log(answer.asText()); // Hello, Ada!
} finally {
  await drive.close('Application shutdown');
}
```

Replace `directory.lookup` with your app's service call and pass its cancellation
signal through to the underlying client. The Script receives only the returned
name; the Grant's binding stays in Host code. Bind a tenant-scoped client here
when the app serves several tenants. Scripts in the same Group can message one
another, so use separate Groups for tenants that must be isolated.

The declaration checks argument and result Shapes, and the callback's types
follow from them: `shape.text` makes `id` a `string`, and the `string` it
returns becomes the text result. Composite Shapes such as `shape.listOf` still
arrive as a `Value`. Without a binding, call `defineCapability(name, ops)`
directly. The Grant
exposes only `lookup`, under the Script-visible name `customers`. Calls to an
ungranted Operation are rejected at load.

`mode: 'suspending'` and `run` adapt a Promise to a Script's `ask … and wait`.
The Core queues its answer or failure when the Promise settles. `maxPendingMs`
bounds the pending call; `call.signal` aborts when it is abandoned, including
cancellation or timeout. The Host's I/O client must honor that signal to stop
the underlying work. For a short synchronous action, use `mode: 'immediate'`
with a `do` callback returning its result, and call it with `ask …` without
`and wait`.

## Drive execution and manage lifetime

`newDrivenGroup` creates a Group connected to an event-loop driver and returns
`{ group, drive }`. It combines Group options (`name`, optional `seed` and
`trace`) with driver options (`clock`, `pump`, `setDeadline`, `onPump` and
`onError`). The factory owns `onReady`: queued inputs, including asynchronous
Operation answers, schedule a later Pump automatically. The driver also schedules
deadlines and continues after Fuel slicing.

`autoDrive(group, options)` remains available for Hosts that wire an existing
Group's `onReady` to `drive.ready()`.

`fuelSlice` lets other event-loop work run between Pumps; `fuelCap` bounds the
Group's work in each Pump. These scheduling settings are separate from
`fuelPerRun`, which limits the total work of a Handler invocation. `load` also
accepts allocation, persistent-state, call-depth and other limits; omitted
fields use `defaultLimits`. A message's `limits` can tighten the permitted
per-Delivery limits. See [limits](../spec/06-errors-and-limits.md#limits).

For a game loop or deterministic test, create a Group with `newGroup` from
`@northtalk/ts` and pump manually. Requests stay pending until your Host pumps:

```ts
import { newGroup, num, parseInstant, talk } from '@northtalk/ts';

const group = newGroup({ name: 'calculator' });
const script = group.load({
  name: 'main',
  source: talk`
    on total a, b
      return a + b
    end total
  `,
});
const reply = script.request({ name: 'total', args: [num(2), num(3)] });
group.pump(parseInstant('2026-10-20T09:00:00Z'));
console.log((await reply.result).toString()); // 5
```

Pass `bigint` epoch **microseconds**, such as `nowMicros()`, with
readings that never go backwards. Continue when the result is `sliced` or `rewound`,
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

On shutdown, stop accepting app work, including new Scripts and Reloads, then
call `await drive.close('Application shutdown')` before releasing app-owned
resources. It stops every loaded Script, aborts pending Operations, settles their
Requests, waits for Promise-backed `run` callbacks to finish, drains late answers
and failures, and cancels scheduling. Stop releases Grants but does not run
Script `finally` blocks. Repeated closes share one Promise and the first reason;
the default reason is `Host shutdown`.

`close()` also waits for `run` Promises already abandoned by cancellation or a
timeout. Your I/O clients must honor `call.signal`: a Promise that never settles
keeps close pending, with no automatic timeout. Callback-style `start` Operations
receive the abort signal, but have no completion Promise to await; the Host must
finish any further cleanup itself. A Clock, Pump or driver callback failure
rejects close and stops scheduling; cleanup may be incomplete.

For scope-based lifetime management, the driver also supports async disposal:

```ts
import { newDrivenGroup } from '@northtalk/ts/driver';

const driven = newDrivenGroup({ name: 'app' });
await using drive = driven.drive;
// Load Scripts through driven.group and send requests here.
// Scope exit awaits drive.close(), even if the scope throws.
```

The driver declarations reference TypeScript's `ESNext.Disposable` library.
`await using` also needs runtime support for `Symbol.asyncDispose`; explicit
`close()` works on older browser runtimes.

`drive.idle()` only means no Pump is scheduled or running; it can resolve while
I/O is pending. `drive.stop()` only cancels scheduling. Closing works after a
previous stop, and calling stop during a close does not interrupt shutdown.

Operation and property callbacks run during a Pump. They may enqueue messages,
but must not call worker methods such as `pump`, `load`, `save` or `inspect` on
that Group. Those calls raise `HostError` with code `reentrant call`. Use
the driver's `onPump` callback for work that must happen after a Pump returns.

## Handle failures and observe execution

Catch synchronous failures around `load` and request admission, and catch the
request's result rejection:

| Failure                                     | What the Host receives                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| Invalid source or unavailable Operation     | `LoadError`, with `diagnostics` containing code, unit, line and column      |
| Full receiver mailbox                       | Synchronous `MailboxFull`; the app can apply backpressure                   |
| Invalid Host input or reentrant worker call | `HostError`, with a stable `code`                                           |
| Request that cannot complete successfully   | Rejected result with `ScriptError`, code `send failed` and a typed `reason` |

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

Use the driver's `onPump` callback, or a manual Pump's return value, to inspect
reports such as `run end` and `call failed`. A failed request's `send failed`
error does not replace those detailed reports. The driver's `onError` handles
a Pump that throws; it does not handle request result rejections for you.

For a textual execution Trace, pass `trace: line => console.log(line)` to
`newDrivenGroup` or `newGroup`. Keep tracing optional in the app: it records
input values and execution details. See [Trace support](../impl/ts/README.md#the-group-and-trace-cases).

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
  combines `newDrivenGroup`, Promise-backed I/O, cancellation and an HTTP endpoint.
- **A browser REPL:** use `SessionHost` from `@northtalk/ts/session`. It provides
  interactive Entries and Transcripts; see the [Session Host guide](../impl/ts/README.md#the-session-host).
