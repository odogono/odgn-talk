# Notes: where the proposed embedding API holds and where it strains

Throwaway digest of the sketches in this folder. The `??` lines in each file have the detail.

## Verdict

The API's shape holds across all four Hosts. The four pillars are:

- **Define once, grant per Script.** The Host defines Capabilities as Operations (name, shapes, cost, mode) and Host Object Kinds once, then grants a subset at Load.
- **The Host pumps.** The Core owns no goroutines, timers or event loop. A Group runs only inside `Pump`, which reads the Clock once and returns Quiescent.
- **Reports out.** Run outcomes, stops and unhandled messages come back to the Host as reports.
- **Whole-Group save and restore,** with Host-supplied stable ids and a `settle` callback.

The same pump model serves a 32-worker Go pool, Bun's event loop and a 50 Hz game tick unchanged, and that was the biggest open risk. What strains is the layer around it: addressing (which Script or object a message goes to), request/reply from outside, charging after a suspension, JSON and case values at the boundary, and one Damocles need the execution model doesn't cover (script-wide busy).

## Felt right

- **The pump model.** `Pump` returns Quiescent, so "save anywhere", "pause" and "is it safe to reload?" all reduce to "between pumps". A game pauses by not pumping and freezing its Clock, with no Core call. A server gets fairness from `FuelCap` per pump.
- **Operations as the unit.** Per-Operation costs and modes read naturally in all three Hosts. `http.Grant([]string{"get"}, …)` makes plan tiers trivial.
- **Grant binding data** (`Call.Binding()`), such as the tenant, allowed origins or team DB. It keeps Capabilities stateless and shared by every tenant.
- **Cancellation.** `Call.Context()` in Go and `call.signal` in TS map a `, replacing` cancel or a Stop Script straight onto `fetch`/DB cancellation.
- **Reports as the only feedback channel.** Limit Faults, errors and cancellations become tenant activity-log lines with no extra machinery.
- **Catalogue ids as stable Host Object ids.** Damocles already has `object-slot-183`, `body-25`, `session`. ADR 0008's Host-supplied ids cost the game nothing.
- **Decimal money.** The original's BCD records map onto the decimal number type exactly.
- **Parity as data.** In `04-parity` the Capabilities are mocked from `case.json` and answered by call id, so the same case runs on every Core with no Host logic to diverge.

## Changed while sketching

- **`Group.Ready() <-chan struct{}` → `GroupOptions.OnReady func()`.** A Host with 10k Groups can't `select` on 10k channels. A callback that enqueues the Group on a run queue is what the pool needs, and it matches TS.

## Go vs TS: what differs and why

| Concern | Go | TS | Why |
| --- | --- | --- | --- |
| Suspending Operation | `Start(c, args)`, then `c.Answer`/`c.Fail` from any goroutine | `start` (same), or `run` returning a Promise | A Promise is the TS idiom, but it can't be saved. `run` is sugar, and on restore its call is settled like any other. |
| Cancellation | `c.Context()` | `call.signal` (AbortSignal) | The native idiom for each, and both feed the Host's own I/O. |
| Charging and limits | `c.Charge(n) error`, return `ErrLimit` | `call.charge(n)` throws `LimitReached` | Errors as values vs exceptions. |
| Script errors | `*talk.Error{Code,…}` | `throw new ScriptError(code, …)` | Same. |
| Integers | `Int(int64)`, checked by the type system | `int(n)` throws unless a safe integer or bigint | JS has no integer type, so `int(0.1)` can only fail at run time. |
| Maps | `Map(KV(…)…)` only | `map(pairs)` or `record({…})` | Go map order is random. JS object order puts integer-like keys first, so `record` refuses them. |
| Clock | `interface{ Now() time.Time }` | `{ now(): bigint }` (epoch ns) | `time.Time` carries a monotonic part and a zone. Only the instant may reach the Core. |
| Threading | A Group is single-threaded, but `Deliver`, `Stop`, `CancelRun`, `Answer` and `Fail` are goroutine-safe, while `Load`, `Reload`, `Pump` and `Save` are not. Groups pump in parallel. | One thread, and `onReady` fires on the same thread | The Go server needs parallel Groups (ADR 0009). |
| Driving | The Host writes a pool, run queue and timers (proposed: `talk.Driver`) | `autoDrive(group)` helper | Every Go Host would otherwise rewrite the same 30 lines. |
| Request/reply from outside | `Request` → `*Pending` with `Done()` | `request` → `Promise<Value>` | Idiom. |
| Load errors | `(*Script, []Diagnostic, error)` | throws `LoadError` with `diagnostics` | Idiom. Diagnostics are identical by parity (ADR 0009). |

Everything else is the same by design: shapes, grants, the pump and its results, reports, save and restore with settlements, and Trace lines. The differences are all idiom. None of them changes what a Script can observe.

## Open API questions

### Driving and threading

1. **Driver helpers.** Should `talk.Driver` (Go: pool size, `FuelCap`, a timer per Group, re-queue on `Sliced`) and `autoDrive` (TS) be part of each Core's package? `autoDrive` needs `onReady`, which is fixed at `newGroup`, so it probably becomes `newGroup({ drive: "auto" | "manual" })`. *(01, 02)*
2. **The Go thread-safety split** above. `Reload`, `Load` of a new Script and `Save` on a live Group have to be queued as work for the Group's worker. Should the Core offer `group.Do(func())` for that? *(01)*
3. **Fuel Slice owner.** The sketches use a slice per Script per pump, so one busy Script can't starve its Group; ADR 0010 left this open. A game might want a slice per Group per tick instead. *(03)*

### Calls

4. **Charging after a suspension.** Proportional cost is known only once the fetch returns, after the Run has parked. Should `Charge` be legal only inside `Start`/`Do`, with a post-hoc charge through `c.AnswerCharged(v, fuel)`? The Core must also map a `LimitReached` rejection from `run` to a Limit Fault, a `ScriptError` to an ordinary error, and anything else to a "host error". *(01, 02)*
5. **The Clock inside Operations.** A `calendar.today` that calls `time.Now()` breaks replay. Proposed: `Call.Now()`, the scheduler's current reading. *(01)*
6. **Fire-and-forget ordering.** `tell keys to forget` must take effect before the next statement. The spec should say that fire-and-forget Operations run at the call, in order, and only their result is dropped. *(03)*
7. **An answer after cancellation** is silently ignored. *(01)*
8. **Call ids** are per Script (`r1.c1`). Settlements and corpus cases need Group-unique ones (`pricing/r1.c1`). *(04)*
9. **Long human waits** (`inbox.ask`, 48 h) are allowed and nothing warns. Should an Operation declare `MaxPending`, so the Core fails the call rather than pinning Persistent State for days? ADR 0005 says this should be Host state plus an event. *(01)*

### Grants

10. **Per-Script grant sets** are repetitive, and in practice the Host grants everything to every Script. Proposed: a "grant what the Script uses, from this allowlist" mode, since the loader already knows. *(01)*
11. **Revocation** is a run-time "capability revoked" error until the next Reload, and then a load-time error. In-flight calls are left to the Host. Is that acceptable? *(01)*

### Addressing

12. **Names of other Scripts** (`send review … to approvals`). Proposed: Scripts in one Group are addressable by name, and anything across Groups is routed by the Host. *(01, 04)*
13. **Delivering to an object** rather than a Script (`taken` to `object-slot-183`, `landed` to `body-25`). Proposed: `group.deliver(m)` routes by `m.to` along the Message Path, and `Script.deliver` is the no-object case. *(03)*
14. **Well-known Host Objects** (`session`, `player`) have no binding. Proposed: `LoadOptions.objects`, checked at load like grants. *(03)*
15. **`the target`.** A Handler up the Message Path can't tell which object a message was sent to unless the Host passes it as an argument. *(03)*
16. **Broadcast for `wait for`.** The Host can't know which Script is waiting for `keypress`. Proposed: `group.broadcast(m)`, which is dropped silently where no Handler and no `wait for` wants the message. *(03)*

### Request/reply from outside

17. **Correlation.** `RunReport` names the Handler, not the delivery, so "document INV-42 failed" is impossible. Proposed: `Deliver` returns a delivery id and `RunReport` carries it. *(01)*
18. **Cancelling a request.** A Host that times out on `request()` can't cancel the Run it started. Proposed: `request(m, { signal })`. *(02)*
19. **Debounce vs reply.** A `, replacing` Handler behind `request()` rejects every superseded request with `RunEnded(cancelled)`. That works, but the Host has to know which Handlers debounce. *(02)*

### Queueing and dispatch

20. **A queueing policy per clause?** Webhook and pickup clauses want different policies on one message (`, every time` for most webhooks and `, replacing` for pushes; `, dropping` vs `, queued` per Damocles trigger). ADR 0004 gives one policy per Handler. *(02, 03)*
21. **Script-wide busy.** The original Damocles runs one script VM. While any trigger runs, a new trigger is queued in a *single pending slot* (a later one replaces it) or discarded. Here each Handler has its own policy, so two triggers can interleave their lines on the Damocles Display. There are three ways out: a Script-level `exclusive` mode (the "strict serial Script" option ADR 0004 rejected, as an opt-in); a single `trigger n` message with a Host-side pending slot; or a `display` Operation that takes a whole presentation. *(03)*
22. **When the Message Path is read.** `Parent` reads live game state (Object Residence) at dispatch. A taken object's path runs through the player, not the Body it lay on. For lockstep, the spec must say when `Parent` is called, or parents become Core-owned (`obj.setParent`). *(03)*
23. **Guards reading Host Objects.** `where the id of item is "object-slot-183"` is pure only because the id is Core-held. Should the id be the only Host Object property allowed in a Guard? *(03)*
24. **Decision-mode (`Decide`) went unexercised.** In Damocles, refusals (Vehicle Key, a lift request) are native and silent, and no sketch needed a veto. It still needs a Host that does. *(all)*

### Values at the boundary

25. **Host-side JSON ↔ Value.** Every Host needs it: insertion order, exact decimals, 34-digit numbers going out. The Core packages should ship it (separate from the stdlib's Script-side `json of`). *(01, 02)*
26. **A canonical value encoding for Host storage** (`kv` storing any Value). The save format is Core-private, so it can't serve here. *(02)*
27. **Shapes** lack Quantity (`GBP`), Civil Date and Instant shapes, and what load-time checking shapes buy is unclear beyond arity and literal map keys. *(01)*
28. **Instant resolution** (ns?) and **who clamps a Clock** that goes backwards: the Host or the Core. *(02, 04)*

### Save and restore

29. **An `adopt` Settlement.** A `say` in flight at save is still in progress in the Host's own restored display state. Reissuing restarts the scroll, which is observable. The sketch fakes it with `reissue` plus a `start` that is idempotent by call id. A fourth settlement, "the Host still has this call and will answer it", is honest. *(03)*
30. **Nested save formats.** The port's strict JSON Save Snapshot wraps talk's opaque bytes, so the port's "decode strictly, refuse on mismatch" rule stops at the blob. The port also always rejects mismatches; it never uses variables-only restore. *(03)*
31. **Lazily created Host Objects** must still resolve on restore. This is easy with catalogue ids; a Host without them needs its own id registry. *(03)*
32. **Counters across `Reload`.** Host quota code diffs `FuelTotal`, so a reset on Reload breaks it. They should carry over, as ADR 0008 already says for variables-only restore. *(01)*

### Parity and lockstep

33. **Operations as data.** The parity runner is the one Host that declares Operations as data. A data form (names, shapes, costs, modes) would serve the corpus, LSP completion from grants, and the Elixir message layer. *(04)*
34. **The Trace records Host inputs.** The runner writes its own `step` lines. If the Core recorded deliveries, answers and Clock readings, a Trace alone would be a replayable case. *(04)*
35. **A case-value decoder** (`$quantity`, `$dec`, …) must be identical on every Core, or a runner bug looks like a divergence. Ship it with the corpus format in both Cores. *(04)*
36. **Go map order** in Host code (Operation declaration order) must never become observable. The spec should sort by name. *(04)*
37. **The tick protocol.** The order inside a game tick (Clock, native step, deliveries, display, pump) is Host policy, but lockstep makes it a contract that both Hosts copy. It belongs in a Host-side document next to the parity example. *(03, 04)*
38. **Version fields.** Are the Unit catalogue and error-code catalogue pinned by `Language`, or do they need their own versions? *(04)*

## Language-side findings (for other fog)

- **`ask` on an Immediate Operation** (`ask calendar to today`) reads the same as a suspending one. ADR 0012 says `ask` means "I want a result", not "this suspends", so the reader can't see Suspension Points after all. *(01)*
- **Operation naming.** `ask inbox to ask …` reads badly, and `tell mail to send …` is fine only because of ADR 0012's rule. Hosts need a naming guide. *(01)*
- **Shared helpers across Scripts** (`epilogue` used by `tolosa.talk`). Calling it as a command climbs the Message Path as a `send`, which doesn't wait. This is Modules fog. *(03)*
- **A Handler called like a command** hides its Suspension Point (again). *(03)*
- **`wait for` buffers nothing**, but the original polls a *latched* key. The Script has to check the latch first and then wait, which is correct but easy to get wrong. *(03)*

## Damocles departures (for the port's governed-departure record)

- **Trigger arming moves into Script Variables** (`spent`). Native code can no longer read it; nothing in the original does.
- **Landing lines come from a Body property** instead of inline strings in each trigger's script.
- **`wait for` can't miss a key** that the original's ordered Y/O/N/timeout polls could miss mid-cycle.
- **Two triggers can interleave their lines on the Display** (see question 21), where the original's single VM serialises them.
- **Out of scope as native code:** lifts, doors, take/drop guards, boarding and the Vehicle Key gate, and the Impact Clock. Scripts only hear about them as events, or set flags they read (`encounterGate`).
