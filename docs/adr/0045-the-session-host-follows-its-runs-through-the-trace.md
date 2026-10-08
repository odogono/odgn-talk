# The Session Host follows its Runs through the Trace

**Narrowed by [ADR 0065](0065-run-accounting-is-returned-to-every-host.md):** public accounting supplies exact Fuel and Run lifecycle observations. The original Trace-based console/suspension tracking remains valid; relying only on those records is no longer the complete Session Host contract.

The Session Host has to know which Run each Entry's Delivery started, whether a `console` write or `read` came from the Foreground Run, and whether the Foreground Run waits only for a deadline. It learns all three from the records the Group is already writing to its Trace: each `seg` record's `run`, its `delivery` at a start, its `end` reason and its `until`, and each `call` record. It doesn't learn them from a Host API. `Inspect()` would give the answers, but it is the Host Input `vars` (chapter 9), so a Session Host that used it to decide what to print would add lines to the very Trace a Session Transcript's `case.trace` pins. Because the Trace is normative, the Go REPL can follow its Runs the same way and get the same answers, and the Cores need no new Host API for a session. Settled in #131.

## Considered Options

- **Extending the Host API:** `Call` would carry the calling Run's run and delivery ids, and a Pump would report each Run's suspension. Both Cores would gain a chapter 9 surface whose only consumer is the Session Host.
- **A peek at the Group that isn't a Host Input:** a second, Trace-silent `Inspect()` would blur the rule that a Host reads a Group only through Host Inputs. The debugger's pause hook already covers tooling's need, and it isn't normative.
- **`Inspect()` after each Pump:** every Pump would add a `> vars` line to the Trace.

## Consequences

- **The TS Session Host** reads typed records through an internal hook in the TS Core, rather than parsing Trace text. The hook is the TS Core's own, and isn't part of its Host API.
- **Chapter 12** says that the Session Host follows its Runs through the Trace's `seg` and `call` records.
- **`:runs`, `:mailbox` and `:vars`** still render `Inspect()`, and each one is a `vars` Host Input in the Trace.
