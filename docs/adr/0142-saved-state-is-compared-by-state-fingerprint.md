# Saved state is compared by State Fingerprint, not snapshot bytes

Hosts need to tell whether two saved Groups are in the same state, but consecutive saves of an unchanged Group differ because the Trace save id counter is part of the snapshot ([#1693](https://github.com/odogono/odgn-talk/issues/1693)). We keep the counter in the snapshot and add a State Fingerprint: a spec-defined SHA-256 over a canonical encoding of the Group's state that leaves out only that counter, counts code by identity and Host Objects by Object Kind, id, parent and disposal, and covers no Session observation state. Both Cores compute it bit for bit alike from a live Group or from snapshot bytes, and it is stable across Core versions until the Cost Model version changes.

## Considered Options

- **Drop the counter from the snapshot.** Makes `save()` bytes repeatable, but a restored Group would reuse save ids and its Trace would no longer match the Group that was never saved, breaking [ADR 0008](0008-same-core-save-restore.md).
- **Advance the counter only when state changed.** "Changed" has no clean definition once Clock readings and refused attempts count.
- **Document the byte layout so Hosts blank the counter.** Ties every Host to a Core-specific, versioned format.
