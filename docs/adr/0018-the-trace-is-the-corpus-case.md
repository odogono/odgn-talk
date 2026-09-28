# A Conformance Corpus case is a setup plus a Trace, and the Trace is the script

A Trace case is a directory. `case.toml` holds the setup: versions, limits, Operation Declarations as data (ADR 0015), Grants, and Host Objects with their stable ids, parents and bound names (ADR 0016). Each Script is a `.talk` file beside it. `case.trace` holds one Trace, one canonical line per record. Host Input lines start with `>`, and Core output lines have no prefix. The runner feeds each Host Input to the Core in order and requires every output line to match exactly. There is no separate list of steps, because the Core already writes its inputs into the Trace (ADR 0015). Every value is written in the normative display form (ADR 0014), which must round-trip, and both Cores ship its reader. An author writes only the `>` lines. `bless` fills in the output lines, and only when every available Core produces the same ones. We chose this because inputs are then written once, and a lockstep desync report or a fuzzer finding is already a case. It also leaves one value encoding, not a tagged-JSON decoder plus a printer that could each diverge on their own. A full-Trace expectation leaves no unasserted part in which a Core can drift. And regenerating expectations only on agreement keeps both Cores answerable to the spec, not to each other (ADR 0009).

## Considered Options

- **A steps list beside an expected Trace** (the #24 sketch): every input is written twice, and the step wording is Host code rather than spec.
- **JSON with tagged forms** (`{"$quantity": ["2.50", "GBP"]}`): a second encoding that both Cores must decode identically, where a decoder bug looks like a Core divergence.
- **Partial assertions** (end state, fault instruction, Script Variables): easier to write by hand, but a Core can drift in whatever isn't asserted.
- **An elision marker in expected Traces:** the same weakness, only local.
- **Unit and error-code catalogues versioned on their own:** more version fields for every lockstep handshake to compare, for data that only changes with the language.
- **A separate `machine` version:** ADR 0010 already versions the Abstract Machine with the Cost Model.
- **Blessing from either Core:** the first Core to bless would become the reference that ADR 0009 rejects.
- **Save/restore checked only by hand-written cases:** ADR 0008's invariant would hold only where someone thought to test it.
- **Canned results for immediate calls in `case.toml`, keyed by arguments:** the result sits far from the call it feeds, and a missing one silently becomes Nothing.
- **A case kind for load diagnostics:** loading is already a Host input, so a separate kind would add a format for nothing.
- **Session Transcripts as bare Traces:** ADR 0014 promises a readable form a user can share.
- **Separate repos for the spec, corpus and Cores:** a spec fix, its new case and both Core fixes could no longer land in one change.

## Consequences

- **Versions:**
  - A case states two versions: the language version and the Cost Model version.
  - The language version pins the grammar, Unicode (ADR 0011), the Unit catalogue, the error-code catalogue (ADR 0017), the display form and the Trace grammar.
  - The Cost Model version pins the Cost Model and the Abstract Machine (ADR 0010).
  - Bumping either one re-blesses the whole corpus, and a human reviews the diff.
- **Line grammar:**
  - A line is `<record> <ids…> key=value…`, with values in the display form, and `#` starts a comment.
  - `> pump clock=… [fuel-cap=…]` is the only record that carries a Clock reading, because a Pump reads the Clock once (ADR 0015). Deliveries, answers and other inputs queue between Pumps.
  - The display-form reader decides where each value ends, so a value such as `2.50 GBP` needs no quoting.
  - Call ids are Group-unique (`pricing/r1.c1`), and Host Objects print by stable id.
  - The Core writes Host Input lines too, so they are compared like any other line. Ids the Core assigns, such as delivery ids, appear on them. An author may leave those ids out, and `bless` fills them in.
- **Host Input records:**
  - Loading: `load`, `reload`, `extend`.
  - Scheduling: `pump`.
  - Messages: `deliver`, `request`, `broadcast`.
  - Calls: `answer`, `fail`, `stub`, and `settle` (answer, re-issue, fail or adopt).
  - Control: `cancel-run`, `stop`, `revoke`.
  - Objects: `set-parent`, `dispose`.
  - State: `save`, `restore`, `vars`.
- **Output records:**
  - `seg` gives start or resume, the Handler and clause, Fuel, allocation, Persistent State at its end, and the end reason.
  - The others are `preempt`, `call`, `send`, `raise` (code and instruction), `guard-skip`, `fault`, `cleanup-failed`, `note`, `run` (outcome and totals), `report`, `diag` and `vars`.
  - Only outcomes are recorded, never individual instructions.
  - A `vars` block prints every Script's Script Variables at the end of every case, so parity of state (ADR 0009) is always checked. `> vars` prints one mid-case.
- **Stubs:**
  - A `> stub cap.op value=… [charge=…]` line, written before the Pump, queues the next result and charge for an immediate or fire-and-forget Operation.
  - An immediate call that finds its queue empty fails with `host error`, and that failure is traced. A fire-and-forget call with no stub just succeeds, since its result is dropped anyway.
  - Suspending calls are answered by later `> answer` or `> fail` lines.
- **Case kinds:**
  - **Trace case:** ordinary replays, exhaustion points (tight limits), load diagnostics, Reload and extend Script, and save/restore.
  - **Disassembly case:** a `.talk` file plus its expected canonical disassembly and Unwind Tables (ADR 0010, ADR 0017), blessed the same way.
  - **Session Transcript:** a readable `.transcript` file of Entries, Session Commands and echoed output, with a blessed `case.trace` beside it (ADR 0014).
- **Save and restore:**
  - Every Trace case is also replayed with a save and a restore between each pair of Pumps, and its output must be identical apart from those two input lines (ADR 0008).
  - Hand-written cases cover what that can't reach: settlements, variables-only restores, and partners outside the saved set.
- **Running parity:**
  - The spec, the corpus and both Cores live in one repo.
  - Each Core has a corpus-runner Example Host. The runners share only data: the corpus and the spec files (ADR 0009).
  - CI runs the whole corpus, including the save/restore replays, on both Cores for every change.
  - A divergence report gives the case, both Cores' versions, the first line that differs with context, and both Traces.
  - On a mismatch, the runner also writes a ready-to-commit case directory, and the fix starts from that case.
- **Differential fuzzing:**
  - Fuzzing stays a required practice, not part of the spec (ADR 0009).
  - A nightly job generates Scripts, Host Inputs and limit sweeps, runs them on both Cores and compares their Traces directly, with no expected Trace.
  - Every divergence is minimised and committed as a Trace case.
  - Until the Go Core exists, the TS Core runs against itself, with and without the save/restore replays.
- **Not in this decision:** the exact key names of every record and of `case.toml` are settled with the final spec. The [worked example](../../corpus/examples/orders-pricing/) shows the shape.
