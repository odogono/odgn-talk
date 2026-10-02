# Capability Scopes guarantee abandonment, not atomicity

A Capability Scope belongs to a Run through a named Grant. The Core invokes its declared immediate abandonment Operation when the Run ends with it open, including after Limit Faults and Stop. This makes paired resource calls safe where Script `finally` cannot run, without adding syntax or treating every resource as a transaction ([#219](https://github.com/odogono/odgn-talk/issues/219)). The [Spec](../../spec/embedding/scoped-effects.md) holds the rules.

## Considered Options

- A `using` construct based on `finally` cannot guarantee invocation after a Limit Fault or Stop.
- Per-acquisition handles permit several resources of the same kind, but require passing acquisition data through closing and abandonment. V1 instead has one slot per Run, named Grant and scope name; the Host retains its resource data.
- Suspension-spanning scopes require ownership and locking rules beyond the existing scheduler. V1 rejects suspension-producing boundaries and Joins while a scope is open, but preserves Fuel Slice preemption.

## Consequences

- Successful acquisition is registered before Script result processing can fail. Cleanup authority survives revocation and exhausted Script budgets; failed abandonment disables the Grant rather than silently allowing reuse.
- The Core guarantees an abandonment attempt, not successful external release. The Host enforces isolation across Scripts and shared bindings and repairs damaged resources before a fresh Script load.
- Ordinary file writes and explicit database commits are final unless the Operations also participate in Segment-bound effects. Closing a file handle does not undo its bytes.
