# The Host drives the Core through a Pump, with Operations declared as data

Both Cores expose the same embedding shape. A Host declares its Capabilities once, as Operation Declarations (name, argument and result shapes, per-call cost, mode, and an optional `maxPending`), each paired with a Host function that implements it. It hands out Grants when it loads each Script. The Core owns no threads, timers or event loop. A Group runs only inside a Pump, a Host call that reads the Clock once, fires due waits and runs Runs until nothing is runnable or a Fuel Slice is spent, then returns with the Group Quiescent. A Group tells the Host it has work through an `OnReady` callback, which may be called from any thread. Everything that comes back to the Host is a report: Run outcomes, stops and unhandled messages. Every Delivery has an id, and the Run it starts reports it. The Core writes Host inputs into the Trace itself. We chose this because the same Pump fits all four Example Hosts unchanged (a 32-worker Go pool over 10k Groups, Bun's event loop, a 50 Hz game tick, and a parity runner on a virtual Clock). Because a Pump always ends Quiescent, save-anywhere (ADR 0008), pause and safe reload all come down to "between Pumps". A game pauses by not pumping and freezing its Clock, with no Core call. And Operation Declarations as data serve the Conformance Corpus, load-time checking, LSP completion from Grants, and the language-neutral message layer the Elixir path needs, all through one format.

## Considered Options

- **The Core drives itself** (a goroutine per Group, or its own timers in TS): this gives Go 10k goroutines and a scheduler of its own, and the Host has no way to fit Core work into its own game tick or event loop.
- **A `Ready()` channel per Group** (the first draft): a Host can't `select` on 10k channels. A callback that puts the Group on a run queue is what a worker pool needs, and it matches TS.
- **Operation Declarations only in Host code:** the corpus would need its own mock format, and a divergence between the two formats would look like a divergence between Cores.
- **`Charge` legal at any time:** a charge made after the Run has parked has no well-defined fault instruction. It can also hit a Run that was cancelled in the meantime.
- **Fuel Slices per Run or per Group:** per Run, a Script can multiply its slice by starting more Runs. Per Group, one busy Script starves the rest.
- **Long human waits by documentation only:** ADR 0005 already warns against them, but a 48-hour Suspending call would still pin Persistent State in memory, and nothing would stop it.

## Consequences

- **Operations:**
  - An Operation's mode is immediate, suspending or fire-and-forget.
  - Fire-and-forget Operations run at the call, in order; only their result is dropped.
  - Operations read time through `Call.Now()`, the scheduler's current Clock reading, and never read the Host's own time.
  - Declarations are ordered by name, so Go map order in Host code can never become observable.
  - Shapes cover Quantities (by Unit or Unit Kind), Civil Dates and Instants as well as the plain kinds.
- **Grants:**
  - A Grant carries Host-private binding data (a tenant, allowed origins) that each call can read, so Capability code stays shared.
  - A Host may grant "what the Script uses, from this allowlist", because the loader already knows every call.
  - Revoking a Grant makes later calls fail with an ordinary "capability revoked" error until the next Reload. From then on they are load-time errors. In-flight calls are left to the Host.
- **Charging:**
  - `Charge` is legal only while an Operation is starting.
  - A cost known only later travels with the answer, and is charged when the Run resumes, where it can fault. It is part of the recorded answer, so it replays.
  - A Host function failing with anything other than a Script error or a limit ends the call with a distinct, catchable `host error`.
- **Suspending calls:**
  - An answer that arrives after its Run was cancelled is ignored.
  - Call ids are unique within a Group (`pricing/r1.c1`).
  - An Operation may declare `maxPending`; otherwise the Script's `MaxWait` applies. When it runs out, the Core fails the call with an ordinary `timeout` error, measured on the Group's Clock.
- **Deliveries and reports:**
  - `Deliver` and `Request` return a delivery id, and each Run report carries the id of the Delivery that started it.
  - `Request` (a `send … and wait` from outside) takes a cancellation signal (a context in Go, an AbortSignal in TS) that cancels the Run it started.
  - Run outcomes are `completed`, `errored`, `limit fault`, `cancelled`, `unhandled`, `dropped` (ADR 0016) and `host error`.
- **Trace:**
  - The Core records Deliveries (with their ids), answers, settlements and Clock readings in the Trace, so a Trace replays on its own.
  - A lockstep desync report is therefore self-contained.
- **Fuel Slices:** narrows ADR 0010. A slice belongs to a Script, per Pump, and overrun debt is carried per Script. A Pump also takes a Fuel cap across the Group, for fairness between Groups.
- **Threads (Go):**
  - A Group is single-threaded, and Groups pump in parallel.
  - `Deliver`, `Broadcast`, `setParent`, `Stop`, `CancelRun`, `Answer` and `Fail` are safe from any goroutine.
  - `Load`, `Reload`, `Pump` and `Save` are not, so the Host queues them to the Group's worker.
- **Driver helpers:** each Core ships one: `talk.Driver` in Go (pool, run queue, a timer per Group), and `newGroup({ drive: "auto" })` in TS. Game Hosts pump by hand.
- **Time:**
  - An Instant has nanosecond resolution.
  - A Clock reading that goes backwards is a Host error. The Core rejects it rather than clamping.
- **Counters:** counters carry over a Reload, as they already do over a variables-only restore (ADR 0008).
- **Restore:** narrows ADR 0008. A pending call can also be settled by **adopt**, meaning the Host still has it in progress and will answer it under the same call id. Adopting costs nothing.
- **Go vs TS:**
  - The two APIs differ only in idiom: errors as values vs exceptions, `Start`/`Answer` vs an optional Promise-returning `run`, and pairs-only map building in Go vs `record()`, which refuses integer-like keys, in TS.
  - None of these differences can be observed by a Script.
- **Source:** the [Example Hosts sketch](https://github.com/odogono/odgn-talk/tree/prototype/example-hosts/prototypes/example-hosts) is the primary source.
- Narrowed by ADR 0017: a `Fail` raises the Host's code with its `Data` as fields. A catalogue code, or a clashing key, becomes `host error`. `timeout` and `host error` have catalogue shapes, and a failed `Request` rejects with `send failed`.
- Narrowed by ADR 0018: the Host input records are part of the Trace grammar, a Pump records the Clock reading it took, and results for immediate calls in the corpus come from `> stub` lines.
- Narrowed by ADR 0026: a `Call` carries a cancellation signal (a context in Go, an AbortSignal in TS) that fires when the call is abandoned, by a Join failing fast or by the Run's cancellation. The Host may honour it. A Script has a Host-set `MaxJoin` width. A Run suspended in a Join has several pending calls, each settled on its own. A cancelled `send … and wait` sender never cancels the receiver.
