# Errors may transfer to named restarts chosen before unwinding

Code may offer named Restart blocks, and an explicitly marked Recovery Catch may choose one before failed frames are discarded. This lets an outer caller set policy across deep Library calls without forwarding a callback through every API, while retaining the Library's local work; recovery remains a structured transfer to code the callee declared, never arbitrary failed-instruction resumption. Settled in [#367](https://github.com/odogono/odgn-talk/issues/367); the complete [staged specification](../../spec/proposals/structured-error-restarts.md) is accepted, with implementation pending.

## Why this boundary

- A local catch plus a non-suspending callback already preserves accumulated rows. The new value is choosing outer policy without callback plumbing, not undoing Error rollback: caught Errors do not roll back Script Variable writes (ADR 0017).
- Ordinary catches keep their unwind-first behavior and source order. Only `catch … before unwind` retains failed continuations. Selection is synchronous and confined to one Run, preserving the actor and Home Script boundaries of ADRs 0004, 0020 and 0025.
- Named actions declare the recovery destination and fixed parameters. They run after exited cleanup, with the offering try's finally afterward. This rejects general expression resumption, retrying a failed Segment and durable restart handles.
- The decision narrows [#339](https://github.com/odogono/odgn-talk/issues/339)'s exclusion of resumable exceptions: arbitrary resumption remains excluded, but named structured transfers are accepted. Library variables do not acquire ambient bindings, and `on error` still cannot resume an ended Run.
- This resembles Common Lisp's separation of pre-unwind [handlers](https://www.lispworks.com/documentation/HyperSpec/Body/m_handle.htm) and declared [restart cases](https://www.lispworks.com/documentation/HyperSpec/Body/m_rst_ca.htm). NorthTalk deliberately limits selection to lexical invocation permission, synchronous policy and current-Run extent.

## Delivery

The design/spec/docs PR lands the full contract as a staged proposal, terms and examples. Executable grammar, catalogues, generated tables, reference tools, both Cores and tooling land through the linked implementation issue; declaring opcodes or Advanced tags now would require unsupported coverage (the [change-impact guide](../agents/spec-changes.md)). Proposed examples remain visibly implementation-pending `text` blocks; the supported callback example is checked `talk`.

The language remains `1.0-rc.2` because it is unreleased. Cost Model 0 remains provisional. Implementation must preserve ordinary-only lowering and Error Fuel, save recovery state without duplicated owner locals, and agree across both Cores before corpus expectations receive their separate first-blessing review.
