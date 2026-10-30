# How NorthTalk runs

> This page is an informative introduction to the ideas behind NorthTalk: what a Host, a Script Group, a Pump and a Trace are, and how they fit together. The [tour](tour.md) teaches the language itself. The rules are in [the spec](../spec/), and where this page and the spec disagree, the spec wins. Capitalised terms are defined in the [glossary](../GLOSSARY.md).

NorthTalk is built to run Scripts that end users wrote inside an application that doesn't trust them. Three ideas shape everything below:

- **Scripts can't do anything by themselves.** Every effect goes through a Capability the application grants.
- **Scripts never run on their own.** The application decides when they run and for how long.
- **The same inputs always give the same result,** on every Core, down to the instruction where a Script runs out of Fuel. So a run can be recorded, replayed, saved and moved.

## Hosts and Cores

The **Host** is the application that embeds the language: a Go or Bun server, an Elixir app or a browser page. It loads Scripts, grants them Capabilities, sets their limits and feeds them messages.

A **Core** is an implementation of the language that a Host embeds. There are two, the TS Core and the Zig Core. Go and Elixir Hosts run the Zig Core through a Host Adapter. No Core is the reference: each answers to the spec and the Conformance Corpus, and both must give identical results ([ADR 0009](adr/0009-twin-cores-held-to-bit-for-bit-parity.md)).

The embedding guides show the API for each language: [TypeScript](embedding-typescript.md), [Go](../impl/go/README.md), [Elixir](../impl/elixir/README.md) and [Zig](../impl/zig/README.md).

## Scripts are actors

A **Script** is one unit of source that a user wrote, loaded by the Host under a name. It is an actor ([ADR 0004](adr/0004-scripts-are-actors.md)):

- It has its own **Script Variables**, which no other Script can read or write.
- It has one first-in, first-out **mailbox**. Every message it receives, from the Host or from another Script, waits there.
- It reacts to a message by running a **Handler**, `on name … end name`. One execution of a Handler is a **Run**.

A Run may pause at a **Suspension Point**, such as `wait 1 s`, `send … and wait` or a call to a Capability that takes time to answer. Each one is marked `wait` in the source. While a Run is paused, the Script can start other Runs. Between two Suspension Points a Run is never interrupted by another Run of the same Script, so the code from one `wait` to the next sees Script Variables that nothing else changes. That piece of a Run is a **Segment**.

A **Library** is source the Host supplies, holding Handlers, functions and Constants that Scripts `use`. It has no state, no mailbox and no Grants of its own: its code runs inside the calling Script's Run.

## Script Groups

A **Script Group** is a set of Scripts that one deterministic scheduler runs together. It is the unit the Host creates, runs, records, saves and restores. The Host makes one with `NewGroup`, giving a name and, optionally, a seed for `random` ([ADR 0096](adr/0096-random-draws-from-a-seeded-generator-the-script-group-holds.md)), and then loads Scripts into it.

Scripts in the same Group talk to each other only by message. In this pair, adapted from the Conformance Corpus's [orders-pricing example](../corpus/examples/orders-pricing/), `orders` asks `pricing` for a quote and waits for the reply:

```talk
-- orders.talk
script variable total = 0.00 GBP

on order {sku: s, qty: q}
  send quote with s, q to pricing and wait
  add it to total
  tell log to write "total " & total
end order
```

```talk
-- pricing.talk
on quote sku, qty
  ask prices to lookup sku and wait
  return it * qty
end quote
```

The order in which messages pass between Scripts in a Group is fixed by the spec. So is the way their Runs interleave. A message from outside the Group is always an input the Host delivers.

What belongs to the whole Group, rather than to one Script:

- **The scheduler.** Scripts take turns in the order they were loaded.
- **The `random` generator.** There is one per Group, seeded by the Host, so draws are the same on every Core.
- **Host Objects.** Their parents and disposal belong to the Group, and a value from one Group can't be used in another.
- **The Trace, the save and the fingerprints,** described below.

A Host can run as many Groups as it needs: one per user, one per document or one per game. Groups share nothing, so one Group's Scripts can never reach another's.

One kind of "group" is unrelated: a Folio **Group Element** is a visual composite of Elements on a Page ([ADR 0103](adr/0103-folio-groups-are-nested-elements-with-page-wide-names.md)), not a Script Group.

## Messages from the Host

The Host gives a Group work through calls that queue an input and return at once:

| Call             | What it does                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Deliver`        | Sends a message to a Script, or to a Host Object, which routes it to its Owning Script. It returns a delivery id.                         |
| `Request`        | A `send … and wait` from outside: it settles with the Run's result.                                                                       |
| `Broadcast`      | Delivers to every Script in the Group that currently wants the message, through a Handler or a pending `wait for`.                        |
| `Decide`         | Asks Scripts whether something may happen, such as a game move. A Handler marked `, deciding` may `veto` it, and the answer is a Verdict. |
| `Answer`, `Fail` | Settle a pending call to a suspending Capability.                                                                                         |

If a Script has no Handler for a message sent to a Host Object, the message climbs the **Message Path**, through the parents the Host declared for that object. This is how a button's click can reach the card or page that contains it.

## Pumps: the Host drives

Queued inputs do nothing until the Host **Pumps** the Group ([ADR 0015](adr/0015-the-host-drives-the-core-through-a-pump.md)). The Core has no threads, no timers and no clock of its own. A Pump:

1. Takes one **Clock** reading from the Host.
2. Drains the input queue in order: Deliveries join mailboxes, and answers resume waiting Runs.
3. Fires every `wait` and timeout that is now due.
4. Runs Scripts in turns until nothing can run, or their **Fuel Slices** are spent.

When a Pump returns, the Group is **Quiescent**: no Run is part-way through a step. The Pump reports what happened and when the next deadline is due, so the Host knows when to Pump again. A game might Pump once per frame, and a server whenever a request arrives. The TS package ships a [driver](../spec/09-embedding.md#driving-a-ts-group) that schedules Pumps on the event loop for you.

## Fuel and limits

Scripts are untrusted, so all their work is metered. **Fuel** is an abstract, deterministic measure of work. The **Cost Model** fixes the cost of each instruction of the **Abstract Machine** that every Core compiles to. The same Script with the same inputs uses the same Fuel on every Host.

- A **Fuel Slice** caps what each Script may spend in one Pump. When a Script spends its slice, its Run is **preempted** and continues in the next Pump. Preemption isn't a Suspension Point: no other Run of that Script runs in the meantime.
- Other limits cap how much a Run may allocate, how much state a Script may keep and how deep its mailbox may grow.
- A Run that exceeds a limit ends in a **Limit Fault**. A Script can't catch it, and the Segment it was in is rolled back, so its changes to Script Variables never happened ([ADR 0006](adr/0006-limit-faults-roll-back-the-segment.md)).

## Capabilities and Grants

A Script has no ambient I/O: it can't read a file, open a socket or even read the time on its own. Every effect is an **Operation** of a **Capability** the Host defines, and a Script can call only the Operations it was **Granted** when it was loaded:

```talk
tell log to write "done"                -- fire-and-forget
ask http to get url and wait            -- suspending: the Run waits for the answer
```

Each Operation has a declared shape and Fuel cost. Its mode, immediate, suspending or fire-and-forget, decides whether calling it is a Suspension Point. The spec defines **Standard Capabilities**, such as `clock`, `timer`, `console` and `store`, so every Host offers them in the same shape. The Host still supplies the answers. The [spec's Capabilities section](../spec/09-embedding.md#capabilities) has the details.

A **Host Object** is an opaque handle to something the Host owns, such as a document, a player or a button. A Script can read and set its properties, and an object can have one **Owning Script**, whose `me` it is.

## Traces and replay

Because the Host supplies every input, including the time, a Group's whole life can be written down. A **Trace** records:

- every **Host Input** in order: loads, Pumps with their Clock readings, Deliveries and Capability answers;
- what the Group did in response: for each Segment, its Fuel, allocation, Capability calls, sends and outcome.

A Trace holds its own inputs, so it replays on its own, and replaying it on any Core must reproduce every line exactly ([ADR 0018](adr/0018-the-trace-is-the-corpus-case.md)). This is how the two Cores are held to parity: the **Conformance Corpus** is a set of Trace Cases that each Core must reproduce. The replay debugger works the same way, and a REPL session can be shared and replayed as a Session Transcript.

## Save and restore

Between Pumps, the Host can save a Quiescent Group as a **Script Snapshot**: its Script Variables, mailboxes, paused Runs, pending calls, counters and `random` state, as plain data. **Restore** rebuilds the Group from it on either Core ([ADR 0144](adr/0144-a-save-restores-on-either-core.md)). Host Objects come back as new handles, which the Host resolves by kind and id ([ADR 0058](adr/0058-a-restored-groups-host-objects-are-found-by-kind-and-id.md)).

Saving and restoring can't be observed: given the same later inputs, a restored Group behaves exactly as if it had never been saved, Fuel included ([ADR 0008](adr/0008-same-core-save-restore.md)). So a Host can park an idle Group in storage, move it to another machine, or keep a game's state across sessions.

Two hashes help a Host check Groups against each other:

- The **Group Fingerprint** covers everything two Groups need in common to run in lockstep: the language and Cost Model versions, the code of each Script and Library, the Grants and the limits. It never covers state.
- The **State Fingerprint** covers a Group's state. Two Groups with the same State Fingerprint are in the same state, whichever Core saved them.

## Further reading

- [The tour](tour.md): the language, section by section.
- [Embed in a TypeScript app](embedding-typescript.md): a working Host, step by step.
- Spec chapters: [Handlers, messages and scheduling](../spec/05-handlers-messages-and-scheduling.md), [Embedding](../spec/09-embedding.md), [Save and restore](../spec/10-save-and-restore.md) and [The Trace and conformance](../spec/11-the-trace-and-conformance.md).
- [The glossary](../GLOSSARY.md): every term on this page, defined.
