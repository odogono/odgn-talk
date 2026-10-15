# NorthTalk for Elixir

An Elixir embedding of NorthTalk, backed by the Zig Core's `wasm32-wasi` reactor in [Wasmex](https://hex.pm/packages/wasmex). It speaks the [Message Layer](../../spec/09-embedding.md#the-message-layer) and needs neither Go nor a sidecar. Applications can supervise an Instance Owner, create Groups, load Scripts and Libraries, and request or deliver to Handlers.

It supports Elixir 1.17 or later on OTP 27 or later, with Wasmex 0.15.1.

```sh
cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi
cd ../elixir
mix deps.get
mix test          # uses .cache/zig-wasi/bin/talk.wasm
```

## Getting started

Add `{:north_talk, path: "path/to/impl/elixir"}` to your Mix dependencies and
configure the reactor as described below. Start one Instance Owner under your
application's ordinary OTP supervision:

```elixir
children = [{NorthTalk, name: MyApp.Talk}]
Supervisor.start_link(children, strategy: :one_for_one)

{:ok, group} = NorthTalk.new_group(MyApp.Talk)
{:ok, _} = NorthTalk.load_library(group, "util", """
function double n
  return n * 2
end double
""")
{:ok, _} = NorthTalk.load_script(group, "counter", """
use double from util
on calculate n
  return double(n)
end calculate
""")

{:ok, %NorthTalk.Result{value: value, delivery: id, report: report}} =
  NorthTalk.request(group, "counter", "calculate", [Decimal.new("2.50")])
# value == Decimal.new("5.00"); report includes Fuel and allocation accounting.
```

`NorthTalk.start_link/1` also works directly. `NorthTalk.close/1` stops an owner
and closes all its Groups. A supervisor may restart the owner, but old handles
remain bound to the old instance; create and load new Groups after a restart.
Use separate child IDs when supervising several owners.

Every `%NorthTalk.Group{}` routes through its owner. One owner drives several
Groups in one reactor instance; compiled Wasm code is cached by artifact path
and optimization level and reused across instances. A complete Message Layer
exchange, including interim needs, finishes before the next exchange begins.
Independent owners execute concurrently.

Library `:version` defaults to `"1"`. `load_library/4` accepts `imports: ["util"]`
to compile against named Libraries already loaded in that Group.

## Acceptance, completion and errors

`request/5` accepts a Request and waits for its terminal Handler outcome.
`request_async/5` returns `{:ok, %NorthTalk.Delivery{}}` at acceptance, without
waiting for execution. `deliver/5` returns the same receipt but keeps no outcome
for later observers:

```elixir
{:ok, receipt} = NorthTalk.request_async(group, "counter", "calculate", [21])
{:ok, %NorthTalk.Result{value: result}} = NorthTalk.await(receipt)
# result == Decimal.new("42")
```

A receipt means the Core accepted the input. Execution may still fail.
Completion returns `{:ok, %NorthTalk.Result{}}` or `{:error, error}`:

- `%NorthTalk.LoadError{diagnostics: [...]}` retains load diagnostic codes,
  messages, units, lines and columns.
- `%NorthTalk.ScriptError{}` carries the Script error code/message/data, the
  terminal outcome, delivery/run identity, terminal `report` and `reports`.
  Unhandled messages, cancellation and Limit Faults are unsuccessful outcomes.
- `%NorthTalk.HostError{}` represents admission, compatibility, unsupported-value
  or transport failures. Execution failures include delivery identity and reports;
  an Operation failure also carries its call identity and Host detail.

`Result.value` uses the Elixir mapping below. Reports and diagnostic metadata
retain their Message Layer field names and encodings. `reports` contains, in order,
the Pump reports that belong to that Delivery while it was pending: those naming it
as `delivery` or `rootDelivery`, its Runs' reports and their calls' reports,
including accounting from earlier Fuel Slices.
Completion describes the requested Handler; descendants may continue running.
`await/1` consumes the retained outcome; all callers already waiting receive it.
A `request_async/5` receipt retains its outcome until awaited, forgotten or the
owner closes. Call `NorthTalk.forget(receipt)` to discard it without cancelling
execution. A `deliver/5` outcome goes only to callers already awaiting when it
completes; afterwards `await/1` returns an `"unknown delivery"` `HostError`.

`new_group!`, `load_script!`, `load_library!`, `request!`, `request_async!`,
`deliver!`, `await!` and `pump!` return the result directly or raise the same
exception. No atoms are created from Script input.

Script loads accept `limits: [fuel_per_run: 100_000, ...]`. Supported load keys
are `:fuel_per_run`, `:alloc_per_run`, `:persistent_state`, `:call_depth`,
`:pattern_size`, `:mailbox_depth`, `:max_wait_ms`, `:max_join` and
`:cleanup_budget`. Requests and Deliveries accept the per-Delivery overrides
`:fuel_per_run`, `:alloc_per_run`, `:max_wait_ms` and `:max_join`, which may only
tighten the Script's limits. Values are nonnegative integers, with durations
in whole milliseconds.

## Driving and time

By default the owner self-schedules Pumps with a Fuel Slice of 10,000 per Script.
Set `fuel_slice: n` to a positive integer to change it. Each Pump yields back to
the GenServer mailbox, so another Group can progress between slices. An idle
Group sleeps until its next deadline or a newly accepted Delivery. The Clock
uses elapsed `System.monotonic_time/1` from a UTC origin captured once at startup;
subsequent wall-clock corrections cannot move it backwards.

For deterministic/manual driving, start the owner with `drive: :manual`:

```elixir
{:ok, owner} = NorthTalk.start_link(drive: :manual)
group = NorthTalk.new_group!(owner)
NorthTalk.load_script!(group, "s", "on ping\nreturn 42\nend ping")
receipt = NorthTalk.request_async!(group, "s", "ping")
pump = NorthTalk.pump!(group, ~U[2026-10-15 12:00:00Z])
result = NorthTalk.await!(receipt)
```

Pump again at the same or a later reading while `pump["state"] == "sliced"`,
and at the next deadline for a waiting Run. `pump/2` returns the complete Pump
reply; Clock readings are `DateTime` values. A backwards reading is refused and
can be retried with a valid reading. Manual `request/5` waits for another caller
to Pump; use `request_async/5` when accepting and pumping from the same process.
Automatic owners reject explicit Pumps.

## Values

| NorthTalk | Elixir |
| --- | --- |
| Nothing | `nil` |
| Boolean | `true` / `false` |
| Exact number | `Decimal`; integers are also accepted as inputs |
| Text | UTF-8 binary, normalized to NFC |
| List | Elixir list, recursively converted |
| Empty or single-key map | Elixir map with a text key, recursively converted |

Decimal scale survives (`Decimal.new("2.50")`), and large integers never pass
through floats. Positive decimal exponents are expanded and negative zero loses
its sign, as required by canonical Value Encoding. Floats, invalid UTF-8,
nonfinite Decimals and unsupported kinds are refused. `$`-prefixed map keys are
escaped automatically, so `%{"$dec" => "ordinary text"}` remains a map.
Multi-key/ordered maps, Bytes, quantities, dates/instants, ranges, Patterns and
Object/Function handles are not exposed yet. An unsupported result returns a
HostError with the original execution report; execution is not retried.

## The reactor

`NorthTalk.Artifact.path/0` looks for the reactor in this order:

1. The `NORTH_TALK_WASM` environment variable.
2. `config :north_talk, wasm_path: ...`.
3. The package's `priv/talk.wasm`.

The test configuration points at the repository's `.cache/` build.

Startup sends `hello` with protocol 1 and checks this package's contract:
`zig/0.0.0`, language `1.0-rc.3`, Cost Model `0`, Unicode `18.0.0` and save format
`zig/7`. `NorthTalk.info/1` returns the validated reply, including feature markers.
`required_features: ["feature-name"]` refuses startup if a marker is absent.
Save/restore itself is not yet part of this API.

Owner options also include the transport's `:path`, `:compiled`, `:opt_level`,
`:memory_cap` and `:timeout`; see `NorthTalk.Transport.Wasi`. The transport default
is no guest linear-memory cap and a 60-second timeout per Wasm export call.
A trap, timeout, malformed reply or reply with the wrong ref invalidates and
closes the instance, fails pending work and prevents further exchanges. No
externally visible work is retried. A Script error or Limit Fault leaves the
instance usable.

## Current boundary

Capability registration/Grants, application callbacks, Function invocation,
save/restore and artifact distribution are later slices tracked by
[#963](https://github.com/odogono/odgn-talk/issues/963). This API registers no user
callbacks: unexpected Operation/property needs receive a Host failure, lifecycle
effects fail, and releases are acknowledged before the exchange completes.
Future callbacks must run outside the owner and must not synchronously wait for
work requiring the same paused Group to progress. The Message Layer's Standard
`sqlite` factory is unavailable.

## Layout

| Path | Contents |
| --- | --- |
| [`lib/north_talk.ex`](lib/north_talk.ex) | Public Group, loading, Handler, awaiting and driving API. |
| [`lib/north_talk/owner.ex`](lib/north_talk/owner.ex) | GenServer Instance Owner, complete exchanges, scheduling and outcomes. |
| [`lib/north_talk/group.ex`](lib/north_talk/group.ex) | Group/Delivery handles and terminal results. |
| [`lib/north_talk/value.ex`](lib/north_talk/value.ex) | Basic Elixir values and canonical Value Encoding. |
| [`lib/north_talk/errors.ex`](lib/north_talk/errors.ex) | Host, Script and load exceptions. |
| [`lib/north_talk/transport.ex`](lib/north_talk/transport.ex) | The transport behaviour: one frame in, one frame out. |
| [`lib/north_talk/transport/wasi.ex`](lib/north_talk/transport/wasi.ex) | The reactor in Wasmex: compiling, instantiating, guest linear memory and `talk_buffer`/`talk_send`. |
| [`lib/north_talk/artifact.ex`](lib/north_talk/artifact.ex) | Where the reactor is found. |

The [Elixir benchmark Host](../../bench/message-layer/elixir/) measures this transport.
