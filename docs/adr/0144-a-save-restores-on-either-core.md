# A save restores on either Core, in one shared binary format

[ADR 0008](0008-same-core-save-restore.md) kept saves bound to one Core family, and [ADR 0142](0142-saved-state-is-compared-by-state-fingerprint.md) made the State Fingerprint each family's own. Hosts now need to save on one Core and restore on the other, for example saving on the Zig Core in an Elixir Host and restoring on the TS Core in a browser. Splitting each format into a header and sections ([#1719](https://github.com/odogono/odgn-talk/issues/1719)) means a format bump in both Cores anyway. So we replace both formats with one normative binary save format that every Core writes and reads, and save → restore stays unobservable (ADR 0008) on any pair of Cores.

The format is a header followed by tagged sections:

- **Encoding.** Little-endian, with unsigned LEB128 for lengths and counts, and SHA-256 for every digest.
- **Header.** Magic `NTSV`, the save format version, the language version, the Cost Model version, the Group Fingerprint, the Trace save id counter, the State Fingerprint and the body digest. A restore rejects any version or digest mismatch.
- **Sections.** Each one has a 1-byte tag, a required-or-optional flag, a LEB128 length and its own SHA-256 digest. A reader skips an unknown optional section and rejects an unknown required one. All machine state is required. Embedded sources and diagnostic data are optional, so an Embedded-source and an External-source Snapshot of the same state differ only in optional sections.
- **Values.** Encoded canonically, never by display form. A Decimal is a signed coefficient and exponent. A Quantity is a Decimal plus a unit. Text is length-prefixed UTF-8. Lists and Maps are written in a fixed order. A Function Value is a code identity plus a body index.
- **Runs.** Chapter 10 defines a normative Run-state model: frames, typed operand-stack slots, and recovery and handler dispatch. Each Core converts its own internals to and from that model. Saved positions are meaningful on both Cores because chapter 8's lowering is exact.
- **Digests.** Each byte is hashed once. The State Fingerprint is the SHA-256 of each required section's tag byte and digest, in tag order. The body digest is the SHA-256 of the header fields before it plus each section's tag, flags and digest.

The State Fingerprint is therefore shared by every Core: equal state gives an equal fingerprint whichever Core took the save, and reading it means checking a digest and reading 32 bytes from the header.

## Considered Options

- **Keep each Core's format, with a shared header and section framing only.** Tooling could read either save, but no Host could restore across Cores, and that is now required.
- **Make saves portable only when no Run is suspended or preempted.** That needs less normative state, but a save that restores across Cores only some of the time is a trap for Hosts that save anywhere.
- **Ship the framing now and the portable bodies in a later bump.** That means two `reactor-v*` releases, two Elixir re-pins and two rounds of rejected saves.
- **Keep JSON bodies in the TS Core.** TS readers would then decode two formats, and the result still wouldn't be portable.
- **A cheaper hash (CRC32, xxHash3) or BLAKE3.** The fingerprint claims two states are equal, so its collisions must not be constructible, which rules out CRC32 and xxHash. BLAKE3 only gains speed with SIMD, which pure JS lacks, and it would add a second hash family next to code identity. Hashing each byte once saves more than changing the algorithm.
- **A migration reader for the old formats (Zig 17, TS 11).** Saves are short-lived Host state, so old ones are rejected.

## Consequences

- Supersedes ADR 0008's rule that a save restores only on the same Core family, and narrows ADR 0005's rejection of a cross-Core snapshot format. Save-anywhere, Quiescence and the version binding are unchanged.
- Supersedes ADR 0142's rule that State Fingerprint bytes are each Core family's own. What the fingerprint covers is unchanged.
- Save bytes and State Fingerprints are now part of parity. Every Trace Case's saves are restored on the other Core, in all four directions, and must continue identically and give equal bytes and fingerprints.
- The Host API is unchanged: `save()` returns bytes and `restore(bytes)` takes them. TS bytes are no longer JSON.
- Parity is checked by a cross-Core replay of every Trace Case (chapter 11), not by a separate case kind.
- Shipping needs a `reactor-v*` release, a refresh of the Go adapter's embedded reactor and an Elixir re-pin.
