# Run accounting is returned to every Host

Exact observation cannot be recovered by summing Trace Segments: `wait for` tests can charge a Run outside its execution stretches, and a Run can disappear during Reload before a Host inspects it. We return ordered Run lifecycle events, cumulative Fuel updates and queued descendant counts through the existing report-returning interfaces, including Restore. They are always available, cost no Fuel and add no canonical Trace records. The public contract serves any Host and is checked on both Cores independently of Trace parity. Settled in [#370](https://github.com/odogono/odgn-talk/issues/370).

This narrows [ADR 0045](0045-the-session-host-follows-its-runs-through-the-trace.md): the Session Host uses public accounting for tracing and Fuel, while existing Trace observations still identify console calls and suspension. No hidden `Inspect()` Host Inputs are introduced. [The accounting contract](../../spec/09-embedding.md#run-accounting) and the embedding declarations hold the rules.

## Considered Options

- An internal Session-only observer: less public surface, but duplicates a capability other Hosts need.
- Per-Run Fuel in `Inspect()`: misses Runs discarded before inspection and adds `vars` to the Trace.
- Callback observations: require reentry and callback-failure rules; existing Host boundaries already return reports.
- Cumulative Fuel alone: loses same-call dispatch/termination ordering and cannot account for descendants still queued.
