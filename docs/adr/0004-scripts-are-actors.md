# Scripts are actors, interleaving only at statically known Suspension Points

Each Script is an actor. It has one FIFO mailbox and never executes two steps at the same instant, but a new Run may start while another Run of the same Script is suspended. Runs interleave **only** at Suspension Points: `wait`, `wait for`, `send … and wait`, and calls to Capabilities the Host declares as suspending. So every Suspension Point is known when the Script loads, and code between two of them is atomic with respect to Script Variables. The syntax stays async-transparent as in _hyperscript: no `await` keyword. `send` to another object never runs the receiver inside the sender. It either puts the message in the receiver's mailbox and returns immediately (`send`) or suspends until the receiver's Run replies (`send … and wait`). The scheduler is part of the spec, so the same Script with the same delivered events, Capability results and budgets interleaves identically, and exhausts fuel at the same step, on every Host. We chose this because a multi-tenant Go Host runs Scripts in parallel, and nested synchronous delivery across Scripts would break their isolation. Server-style Scripts can't afford a strict one-Run-at-a-time Script where a single `wait for approval` stalls everything. And the conformance corpus needs interleavings that can be pinned down.

## Considered Options

- **Strict serial Script:** one Run at a time from start to finish, even across waits. Script Variables never change underneath a Run, but one long wait blocks every other event.
- **Nested synchronous `send`** (HyperTalk, _hyperscript/DOM): the receiver runs inside the sender until its first wait. It feels natural in a single-threaded UI, but crosses actor boundaries and depends on how the receiver happens to suspend.
- **Fully transparent suspension:** any Host call may pause, and nobody can tell which ones. That makes interleaving invisible, so no atomicity rule can be stated.
- **Per-Run processes with no shared state** (Erlang): conflicts with Script Variables (ADR 0001).

## Consequences

- Runs must be resumable at any step: suspension, time-slicing in the TS core and cancellation all need heap-allocated frames and an interpreter loop that can return and resume. A native-stack tree-walker is ruled out.
- Time-slicing is not a Suspension Point. While the TS core yields to the Host's event loop mid-Run, no other Run of that Script may proceed.
- Handler Clause dispatch, Guards and the walk along the Message Path never suspend.
- `veto` in a decision-mode event must be reachable before the Run's first Suspension Point. Otherwise it's a load-time error.
- Hosts must say which of their Capabilities suspend. That's part of the embedding API.
- Narrowed by ADR 0016: queueing policies belong to Handler Clauses, not whole messages. A `, queued` Run parks after dispatch without blocking the mailbox, and a `, dropping` Run ends as `dropped`. Message Path parents are Core-owned, and `the target` names the object a message was delivered to.
- Narrowed by ADR 0025: a Function Value called with `f(x) and wait` is a possible Suspension Point, since the loader can't know which value a variable holds. So every *possible* Suspension Point is written in the source and known at load, and a call without `and wait` never suspends. A call to a Function Value from outside its Home Script is a message to that Script, with `send … and wait` semantics.
- Narrowed by ADR 0026: a Join (`wait for all … end wait`) starts several calls from one Run and suspends once, at `end wait`, so a Run still waits at one Suspension Point at a time. A Handler Clause with no queueing suffix runs concurrently, which settles the default, and `, every time` is removed.
