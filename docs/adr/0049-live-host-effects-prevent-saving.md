# Live Host effects prevent saving

A Quiescent Group with an open Capability Scope or an enlisted Segment participant cannot be saved: Save returns `effects pending` without draining, abandoning or advancing execution. This narrows [ADR 0008](0008-same-core-save-restore.md) and [ADR 0018](0018-the-trace-is-the-corpus-case.md). Fuel Slice preemption can leave Host state live even when scopes cannot span Suspension Points; that state is absent from a Script Snapshot and cannot be reconstructed by settling pending suspending calls. The [Spec](../../spec/10-save-and-restore.md#saving) holds the rule.

## Considered Options

- Saving live resources requires a Host persistence and restoration contract for file handles, locks and transactions, beyond the existing snapshot interface.
- Suppressing preemption until a scope closes would compromise Pump responsiveness and still needs a rule for Segment-bound effects after explicit scope closure.
- Automatically rolling back or completing the work to save would make Save observable.

## Consequences

The Host can resume pumping until effects finalize and retry, or intentionally stop work before saving. Successful save/restore remains unobservable. Conformance checks refusal at live-effect boundaries and resumes the original Group; elsewhere it retains automatic save/restore replay. Failed-release Grant disablement is saved state, so restoring or reloading cannot bypass it.
