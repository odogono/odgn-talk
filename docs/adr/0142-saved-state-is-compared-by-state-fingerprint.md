# Saved state is compared by State Fingerprint, not snapshot bytes

Hosts need to tell whether two saved Groups are in the same state, but consecutive saves of an unchanged Group differ because the Trace save id counter is part of the snapshot ([#1693](https://github.com/odogono/odgn-talk/issues/1693)). We keep the counter in the snapshot and add a State Fingerprint: a 32-byte hash of everything a save holds except that counter, with code counted by identity and Host Objects by kind, id, parent and disposal. It is taken from a live Group or from a save's bytes, and the two agree. Like the save's bytes, it is each Core family's own: the spec fixes what it covers and that equal state gives equal fingerprints on one Core family and save-format version, not how it is computed.

## Considered Options

- **Drop the counter from the snapshot.** Makes `save()` bytes repeatable, but a restored Group would reuse save ids and its Trace would no longer match the Group that was never saved, breaking [ADR 0008](0008-same-core-save-restore.md).
- **Advance the counter only when state changed.** "Changed" has no clean definition once Clock readings and refused attempts count.
- **Document the byte layout so Hosts blank the counter.** Ties every Host to a Core-specific, versioned format.
- **One fingerprint shared by every Core.** Needs a normative, byte-exact encoding of all machine state, frames and operand stacks included: a second save format both Cores must track on every machine change. The Hosts asking compare states on one Core, so a cross-Core version can come later as a new fingerprint if one is needed.

## Consequences

- Superseded in part by [ADR 0144](0144-a-save-restores-on-either-core.md): the State Fingerprint is shared by every Core and read from the save's header.
