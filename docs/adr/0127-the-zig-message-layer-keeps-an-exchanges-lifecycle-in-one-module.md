# The Zig Message Layer keeps an Exchange's lifecycle in one module

An Exchange's state in the Zig Message Layer was 15 loose fields in `message.zig`: `paused_ref`, `need`, `held`, `held_ref`, `release_continuation`, `work_paused`, `in_pump`, `in_work` and others. Its rules were repeated in each layout:

- the JSON and the binary paths each checked held releases, reserved refs and expected answers before matching a result;
- each path held a final reply until queued Grant releases were acknowledged;
- `releaseResultReply` decided between the held reply, the next release and resuming a Pump or Reload;
- `inlineRound` swapped the exchange's Group and worker to admit a paused input;
- with `group-exchanges-v1`, `message.zig` parked and loaded each Group's Exchange by hand.

A change to one rule had to be made in every copy. Mapping them found #1492 and #1493. The Zig Message Layer now keeps an Exchange's lifecycle in one module, `exchange.zig` ([#1481](https://github.com/odogono/odgn-talk/issues/1481)).

The module owns:

- the Exchange's state between frames, stored explicitly: idle, awaiting a result, awaiting the crossing's Trace, or awaiting release acknowledgements before a held reply, a held need or the worker's resumption;
- the worker on the stack, and the need its callback made;
- the gate every frame passes in either layout: dispatch, admission to the paused worker, refusal with its reason, or a result of a given kind;
- which paused inputs join the worker, as `spec/embedding/paused-crossing-inputs.md` decides;
- the queue of Grant releases and what follows each acknowledgement;
- each Group's Exchange under `group-exchanges-v1`: loading one, parking the one loaded before in its own Group, and refusing to drop an open one.

It does not decode or encode frames, run workers or write replies. It holds no reference to the Session. A `Parts` type supplies its payload types, the Group's crossing-pause calls and where a Group parks its Exchange, so its tests run on stand-ins. The JSON and fields adapters in `message.zig` still read and write their layouts. They act on what the module returns.

Hosts cannot observe the module. Replies, refusal texts, Trace order and ownership cleanup stay the same.

## Considered Options

- **Moving only the struct**: a struct with `open` and `deinit` leaves every caller to know which field combinations are valid. Deleting it would remove nothing but a type.
- **One adapter for both layouts**: JSON and binary are negotiated separately, and an Exchange can mix them ([ADR 0110](0110-request-and-pump-have-an-optional-binary-exchange.md)). Decoding stays per layout, and only the policy is shared.
- **Making the JSON and binary refusals agree now**: their checks run in a different order and their texts differ. The module keeps the difference in a `Layout` argument, and tests pin it. Making them agree is a behaviour change, tracked in #1496.
- **Moving Waits or the Run's lifecycle into the module**: those stay with [ADR 0105](0105-each-core-keeps-its-waits-in-one-wait-table-module.md) and [ADR 0123](0123-the-zig-core-keeps-a-runs-lifecycle-in-one-module.md). An Exchange spans Message Layer frames, and a Run's lifecycle spans turns in the machine.

## Consequences

- The changes are refactors. The frame-level tests in `message.zig` and the Go adapter's combined tests in both layouts stay as integration coverage. Any bug found while moving code ships as its own fix, as #1493 and #1500 did.
- The module's unit tests cover each state, including a need reply held behind a release, which no frame-level test reaches.
- An Exchange records the Group it belongs to, so a parked Exchange is put back in the right Group without a separate field on the Session.
