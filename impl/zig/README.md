# Zig Core

The Zig Core is a third NorthTalk Core for embedding outside Go and TS: natively
through the C API in [`include/talk.h`](include/talk.h), and as a `wasm32-wasi`
module for Hosts with a WASM runtime
([ADR 0078](../../docs/adr/0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md)).
It is written from the Spec, its Data Files and the Conformance Corpus, never
translated from the Go or TS Core
([ADR 0071](../../docs/adr/0071-a-third-core-serves-embedding-outside-go-and-ts-after-the-message-layer-is-measured.md),
[ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md)). The
design decisions that bind it are recorded on
[#625](https://github.com/odogono/odgn-talk/issues/625#issuecomment-6111271797).

Built step by step through
[Appendix B](../../spec/appendix-b-implementation-order.md), it conforms to
language 1.0-rc.3 and Cost Model 0
([#636](https://github.com/odogono/odgn-talk/issues/636)): it passes every
Corpus case, every Trace Case in both replays and the pinned Unicode tests, its
REPL reproduces every Session Transcript, and `talk.h` declares every `talk.go`
name. Blessing needs it to agree with the Go and TS Cores, and the nightly
differential fuzzer runs it. Its Message Layer carries `request-charge` alongside the other chapter 9 messages.

Use the [Zig task map](NAVIGATION.md) for implementation files, Spec links,
tests and check commands.

A local Handler may share a Script Variable's or Constant's name in either
declaration order. Value references read the variable or Constant; Command
Calls and Deliveries reach the Handler. Extensions preserve both inherited
lookups and Handler suspension checking, including after Save/Restore. An
extension that redeclares an existing name is still refused with `name reused`;
Library Import clashes retain chapter 7's rules.

`it` is a body local. In a Constant or Script Variable initialiser or a
parameter default, each unbound `it` reports `unknown name`, alongside
`not constant` at only the first disallowed token. Handler, function and
Lambda bodies retain their own `it`, including Lambdas created at load.

Statically resolved Built-in calls check the required and total parameter
counts from chapter 7 at load, including trailing defaults. Invalid counts
report `wrong argument count` at the Built-in name; calls through shadowing
variables remain dynamic.

Whole Host Object properties can be assigned with `set` through `me`, `it`
or `the target`, including intermediate keys/chunks that locate the Object.
These implicit bindings cannot be replaced or used as roots for ordinary
Container mutations. `set` does not modify chunks inside a property's value.
Direct known-owner read-only properties are checked at load; `it` and Target
properties are checked at runtime ([ADR 0085](../../docs/adr/0085-property-writes-do-not-replace-implicit-bindings.md)).

`a otherwise b` and `the optional k of x` follow [chapter 4](../../spec/04-expressions-and-statements.md#nothing-defaults) of language 1.0-rc.3. `otherwise` parses as the lowest binary operator and lowers to `branch-not-nothing` and `pop` at its own token, so the left side runs once and the fallback only on Nothing. Optional reads parse into their own `optional_key` node, so they are never Containers; `the optional of m` stays the ordinary key read by the `optional-key` decision. They lower to `get-optional-key` instructions at their `the`, which read maps and Nothing only and reject every Host Object, even for `id`, with no Host crossing. The checker checks both forms in every operand in Guards, Constants and other restricted expressions, and an optional read of a known Host Object is no Host property access in a Guard. An unknown name in an initialiser or parameter default is both `unknown name` and `not constant`. The Zig Core passes the shared `disassembly/nothing-defaults` case and the `nothing-defaults/`, `load-diagnostics/nothing-defaults` and `load-diagnostics/constant-unknown-name` Trace Cases.

## Layout

- `build.zig`, `build.zig.zon`: one Zig package, `northtalk`, pinned to Zig
  0.17.0 by `minimum_zig_version`. It uses Zig's standard library only: no
  third-party packages and no linked C libraries.
- `include/talk.h`: the C API. It mirrors
  [`spec/embedding/talk.go`](../../spec/embedding/talk.go)'s names in C style,
  as [`tools/zig/api.ts`](../../tools/zig/api.ts) spells them, and declares only
  what the Core implements.
- `src/root.zig`: the package root. [`src/talk.zig`](src/talk.zig) holds
  `talk.h`'s exports.
- `src/unicode/`: UTF-8, NFC, Characters (extended grapheme clusters), simple
  case folding, and the `word` and `word break` rules, built only on the
  generated tables.
- `src/generated/`: tables written from the Data Files and the pinned Unicode
  data. Never edit them by hand.
- `src/decimal/`: chapter 3 decimals and exact rational arithmetic. Addition,
  subtraction, multiplication, terminating division and integer `div`/`mod`
  use checked `u128` intermediates when the exact result fits. Terminating
  division selects the representable exponent nearest its ideal without
  rounding. Decimal comparisons handle signs, zeros and equal exponents
  directly, and align unequal exponents with checked `u128` scaling when it
  fits. Wider comparisons retain bounded padded-digit comparison without
  allocating. Rounding and wider arithmetic intermediates use managed big
  integers.
  Quantity arithmetic shares these paths and uses compile-time catalogue
  factors, preserving separate conversion steps and their rounding; immutable
  result Values still allocate.
- `src/value.zig`, `src/units.zig`, `src/dates.zig`: immutable values,
  copy-on-write containers, catalogue Units and Gregorian dates.
- `src/display.zig`, `src/encoding.zig`, `src/pattern.zig`: the display reader
  and writer, lossless Value Encoding and canonical Pattern source reader.
- `src/syntax/`: the modal lexer of chapter 1 and the predictive parser of
  chapter 2, which builds a lossless syntax tree.
- `src/check/`: the checker, which raises chapter 2's load-time diagnostics
  and resolves the names the lowering reads.
- `src/lower/`: the normative lowering of chapter 8 to `machine.toml`'s
  instructions, and the canonical disassembly.
- `src/corpus/`: case discovery, metadata, encoding replay, Trace parsing,
  case setup and Disassembly Cases.
- `src/machine/`: the Abstract Machine: Groups, Scripts, Runs and frames,
  the run loop, Cost Model 0 charging, chunks and properties, the Built-ins it
  has so far, Trace writing, the Group Fingerprint, and saving and restoring.
- `tests/`: C programs that use `talk.h` as a Host would.

- `src/session/`: the Session Host of chapter 12, an ordinary Host over
  `talk.h`, and Session Transcripts.
- `src/notify/`: the Notification router `store` watches use.

The REPL joins `src/` in step 6.

## Syntax

The parser drives the lexer: it names the mode of every token it asks for,
reads at most two tokens ahead for the decisions `grammar.toml` lists, and
stops at the first syntax error with its code and position. A lexical error
comes back as an `invalid` token, so a parser that has peeked past the token
it fails at still reports that one. Fenced text is scanned whole when its
opener is lexed, holes and nested literals included, and each literal is
remembered by its offset, so nested interpolation stays linear. Margins,
escapes and line breaks are decoded then; NFC is left to the value.

Every token, line breaks and the end of the source included, is kept in
source order, and a backtick literal with holes is split into pieces around
its holes' tokens. `Tree.reconstruct` rebuilds the source byte for byte from
them. The tree's shape is the Zig Core's own.

Source nesting is bounded at 128 recursive parser regions, and an expression
tree at 128 levels, so hostile source ends in `source nesting too deep`, never
a stack overflow. Like the Go Core's limit, that code is an implementation
limit outside the Spec's catalogue.

Loading retains the source, executable code and required metadata. The syntax
tree, checker tables and lowering buffers use temporary storage counted against
the Group's physical cap, then released. Extensions, Reload and restored code
use the same policy; compiled Libraries also release their compiler storage.
The WASI check loads 1 MiB of newlines and 100,000 empty Handlers within a
256 MiB instance cap, bounds their retained memory and load time, and runs
Handlers after compilation. [The load measurements](../../docs/research/zig-load-scaling.md)
record the causes and before/after figures for #790.

Text-to-Text concatenation trusts the immutable operands' validated UTF-8.
ASCII Values keep an exact Character count, correcting for CRLF at joins,
and their byte length supplies scalar charges without rescanning the result.
The metadata uses existing Value header space, adds no separate allocation,
and is reconstructed from Text bytes on Restore; saved formats and logical
charges are unchanged. Unicode joins still normalise the complete result and
use the pinned grapheme rules rather than adding Character counts. Host Text
construction still validates strict UTF-8. Results remain contiguous owned
buffers, so repeated growth still copies the whole prefix.

ASCII concatenation writes directly into the result's owned storage. The WASI check doubles text
under the default Allocation Budget with a 128 MiB instance cap, and the
conformance minimum with a 1 GiB cap. Three successive Runs must end in the
Allocation Limit Fault, with the instance still answering and running a
fresh Handler after each fault.

## Checking

`check.check` takes a parsed unit and a `Context`: whether it is a Library,
the well-known objects, the Script's Grants and the Group's Libraries. It
returns every load-time diagnostic, ordered by position and then by
`diagnostics.toml`'s order, with what each Name refers to, each body's locals
and captures, and which Handlers may suspend. `check.exports` gives what a
checked Library exports to its importers. The stdlib Libraries' exports and
the Built-ins come from `stdlib.toml`.

A Handler may suspend when a clause holds a written Suspension Point, or a
Command Call to a Handler that may, found over the call graph to a fixpoint.
That decides `missing and wait`, `needless and wait` and `can't suspend here`.
A `, deciding` Handler's `veto` and `pass` are checked over every path through
its body for `after a suspension`.

Capability calls, `say` included, are checked only when the `Context` gives
the Grants, `wrong argument` among them for a literal against an Operation's
Shape. The checker also records each call as a Library's `needs`, which a
Script's load checks against its Grants for `missing grant`. Loading raises two
diagnostics after the checker: `pattern too large` for a Text Pattern literal
whose compiled program, every copy of a counted repetition counted, runs past
the default `patternSize`, and `initialiser failed` at the instruction where a
unit's initialiser raises, which leaves no Script in the Group, or no compiled
Library. `import cycle` is never raised: `talk_compile_library` takes a
Library's imports already compiled, so a cycle can't be built.

## Lowering

`lower.lower` turns a unit that checks clean into a code unit: its constant
pool, definitions, variables, objects, body table, code, Unwind Table, offer
records and event table, each instruction with its source position.
`lower.disassemble` prints its canonical disassembly. The in-memory
instructions are the Zig Core's own (ADR 0009), and nothing outside `src/`
depends on them.

Verified static Unit conversion targets carry a dimension signature and an
ordered factor plan in counted code storage. Invalid Unit targets retain their
runtime conversion failure; preparing metadata adds no Load diagnostic.
Plans preserve each Decimal operation and rounding step, storing exponent
repetitions as counts. Reload and Restore rebuild them with the code unit;
they are absent from canonical disassembly, fingerprints and snapshots.
Unit Values keep compact catalogue indices and a derived active-Kind mask,
so arithmetic and comparison traverse only present Kinds. No runtime Unit
combination or dimension cache is retained.

Each body is lowered into its own buffer, with labels local to it, and the
buffers are laid out in body order at the end. A Lambda or an event test is
numbered and lowered where the lowering reaches it, so its constants and
nested bodies are numbered there too. Temps take the lowest free slot; a catch
handler's dispatch slots start above every slot the protected body used.
Every inlined copy of a `finally` block, and the exit after it, is cut out of
the spans of the `try`s it leaves, so an entry split by copies becomes one
entry per span. The Operation modes that pick `ask`, `ask-wait`, `join-ask`
or `tell` come from the Context's Grants.

## Building and testing

Run these from `impl/zig/`, after `bun install --frozen-lockfile` and
`bun run unicode:check` at the repository root. The Unicode check downloads and
verifies the pinned UCD files the tests read.

```sh
zig build test                    # the Zig tests and the talk.h C tests
zig build                         # zig-out/lib/libtalk.a and zig-out/include/talk.h
zig build -Dtarget=wasm32-wasi    # zig-out/bin/talk.wasm
zig build corpus                  # the whole Corpus, as CI runs it
zig build corpus -- --list
zig build fuzzworker              # zig-out/bin/talk-fuzzworker, for the fuzzer
zig build sidecar                 # zig-out/bin/messagelayer, native framed stdio
zig build corpus -- bytes/value-encoding
zig fmt --check .
```

The build has no `-Dtest-filter` option: run `zig build test` for unit and C
tests, or select a Corpus case with `zig build corpus -- <case>`.

Every build is `-Doptimize=safe` (ReleaseSafe) unless told otherwise, so bounds
and integer overflow stay checked while the Core reads hostile input.
`-Doptimize=fast` is refused.

Instruction scratch uses the standard arena. At each instruction boundary,
an empty arena or one empty buffer without a free list skips the redundant
`retain_capacity` reset. Dirty buffers, chains and free lists use the standard
reset. This fast path reads the pinned Zig arena state; an upgrade must
recheck that empty-state invariant and the tests in
[`scratch.zig`](src/machine/scratch.zig). Charging, limit admission, landed
control, preemption and operand protection still run at every instruction.

Zig 0.17 renamed standard library APIs that older examples and documentation
still use. Check names against the installed source, under `lib_dir` from
`zig env`, rather than online docs:

- `std.builtin` is an alias for `std.lang`, defined in `std/lang.zig`.
- Optimize modes are `debug`, `safe`, `fast` and `small`, so the flags are
  `-Doptimize=safe` and so on.
- `std.testing.refAllDeclsRecursive` is gone; use `refAllDecls` per container.
- `@typeInfo` of an enum gives `field_names` and `field_values`, not `fields`.

The `wasm32-wasi` target is the Message Layer reactor for Hosts with a WASM runtime, replacing the retired Go `wasip1` entry point ([ADR 0089](../../docs/adr/0089-the-zig-build-serves-the-message-layer-reactor.md)). The native sidecar also uses Zig ([ADR 0090](../../docs/adr/0090-the-native-message-layer-sidecar-uses-zig.md)). Go-Core saves cannot be restored here: saves are per Core ([ADR 0008](../../docs/adr/0008-same-core-save-restore.md)). Start fresh Groups from source and Host-owned data, or retain the old Go runtime/artifact until existing Groups are drained or rebuilt; no save converter is supplied.

The `wasm32-wasi` target builds a WASI reactor: a module with no `_start` that
exports `talk.h`'s functions. A Host instantiates it once per instance and calls
the exports directly, passing structs and text through `talk_alloc` and
`talk_free`. It also speaks the
[Message Layer](../../spec/09-embedding.md#the-message-layer) through
`talk_buffer`/`talk_send` ([`src/message.zig`](src/message.zig),
[#635](https://github.com/odogono/odgn-talk/issues/635)): one Core per
instance, its `hello`, Capability definition and Grants, `new-group`, `load`,
`deliver`/`request`, `pump` with interim `op` and `prop` needs, `answer`/`fail`,
`save` and `fingerprint`, Object Kinds with `object`, `set-parent` and
`dispose`, `{object}` Delivery targets and load `owner`/`objects`,
`broadcast` and `decide`, `reload` and `extend`, `compile-library`,
`add-library` and `replace-library`, `inspect` and `grants`, `restore`
with its interim `resolve` need, `settle`, `$function` values and `call`, `export-manifest`,
`standard-capability` for all but `sqlite`, which the layer doesn't offer,
`counters`, and the Host Inputs `stop`, `cancel-run`, `rewind-run`, `revoke`
and `cancel-delivery`. Capabilities may declare scopes and Segment-bound Operations, with
`segmentLifecycle` and `release`. Their hooks reach the Host during a Pump,
`reload` or `replace-library` as `effect` and `release` needs and automatic
`op` needs, and a `grant` may name a
shared `coordinator`; `store`'s hooks are one Coordinator's. A `pump`,
`reload` or `replace-library` reply's `abandoned` lists the started calls the
Core has abandoned since the last notification, once each. To observe cancellation
before subsequent Host callbacks, request `features: ["abandoned-before-needs-v1"]`
in `hello` and check the advertised feature. Opt-in lasts for the Session:
interim `op`, `prop`, `effect` and `release` replies then carry outer `abandoned`
before their callback, including a release which precedes a held need or final
reply. Final successes retain unreported notices in `ok.abandoned`; final worker
errors carry them at the outer level. Hosts without opt-in retain final-success
notification timing. See the [contract](../../spec/embedding/paused-crossing-inputs.md#abandonment-before-a-subsequent-callback). `request-charge` acknowledges
enqueue with a Group-wide `q<N>` id; its later Pump returns a `charge result`
report with `accepted`, `limit` or `inactive`. Post-start work needs this
authorization; the starting need's local `fuelLeft` cannot fund it. A crossing pause, where a
Host function answers `deferred`, is the transport's: it ends no Stretch and
writes no record. Segment `begin`, `commit` and `rollback` hooks and automatic
abandonment may defer at a Segment's end, while draining Stop, cancellation,
owner disposal and Rewind inputs, and while Reload or Library replacement
terminates old Runs. Library replacement holds every proposed Library and
Script until all terminations finish; fatal cleanup prevents publication and
returns `effect state unknown`. Load, Reload, Extend and Library replacement
cannot revive a Group stopped by fatal cleanup. Pump, Save, Fingerprint, Inspect
and code-change worker calls from lifecycle callbacks return `reentrant call`,
during a Pump and during code changes. Refused worker inputs retain their Trace
records after the callback record, including across a Message Layer pause.
Paused needs admit the same Group's queued Host Inputs under distinct refs;
`hello.features` advertises `paused-inputs-v1`. Admission preserves synchronous
errors and ids, while ordinary inputs still wait for the next Pump. Stop,
CancelRun and RewindRun land after the callback record and scope acknowledgement,
before result conversion. A suspending Call retains its identity and metering
eligibility while Start is paused, including a restored Call reissued at the
first Pump. Reissued Start preserves its settlement until acknowledged and lands
controls before a sibling Start. Answer/Fail and RequestCharge can enqueue
before `started`. Worker reentry remains refused throughout a transport pause.
Grant releases pause the continuation until `release-result`, before later
callbacks or Script execution; inputs queued by release use the original worker's
Pump/code-change boundary. Deferred cleanup of another Run retains the original
Host return without repeating its callback or record. Native callbacks retain
their synchronous contract.
Hosts may opt in to `crossing-trace-v1` to receive available Trace before
Operation needs and a `trace` need after each ordinary Operation's call record,
before controls land or result conversion. Its `trace-result` acknowledgement
continues the same Pump without repeating the callback or accounting. Refusal
and Load-error replies carry outer Trace with this feature; legacy Hosts retain
final-reply timing. This is an Operation crossing observation contract, not
per-record suspension during arbitrary execution or non-yielding WASM admission.
The [contract](../../spec/embedding/paused-crossing-inputs.md#operation-trace-observation-at-a-paused-crossing)
describes the supported boundary. Message Layer `answer.fuel` now reaches the
settlement-cost API. A queued settlement remains tracked until consumed, so a
Run discarded before resumption still notifies cancellation before later needs.
Typed CallFailed reports name the Capability definition, while Trace and
ScriptError fields continue to name the Grant.

`zig build corpus -- --defer-crossings` defers each eligible crossing once and
holds every Trace unchanged. It is stripped of debug sections and has a 1 MiB stack, since the
stack sits in linear memory: source recursion stops at the depth guards, and
Values are walked from heap work lists, never by native recursion.
For the Message Layer, supply WASI imports and call `_initialize` once before
serial export calls. `talk_buffer(n) -> i32` reserves the input frame's bytes;
write JSON without a length prefix. Zero or more than 64 MiB returns 0, which
must not be written through. `talk_send(n) -> i64` returns the reply as unsigned
`ptr << 32 | len`; copy it before the next `talk_send`. The input buffer lasts
until the next `talk_buffer`. A length beyond the reserved buffer is a protocol
error. Either export may grow memory, so refresh memory views
after calls. Host Operations and properties use interim needs and result
messages, without custom Host imports or reentrant exports.

Message Layer frames have no JSON nesting-depth cap. Parsed Value Encodings,
including Function captures, go directly to the Core's heap-stack Value builder
without recursive JSON re-encoding. Replies use the iterative Value writer.
Native tests and the WASI Message Layer check exercise arrays and maps nested
100,000 levels, including deep error data in replies. The frame-size and
available-memory limits still apply; malformed deep JSON is a protocol error
and leaves the Session and any pending Host exchange usable. Hosts must decode
deep replies within their own resources, as
[chapter 9 specifies](../../spec/09-embedding.md#rules)
([ADR 0088](../../docs/adr/0088-the-message-layer-accepts-deep-values.md)).
[`tools/wasi/zig.py`](../../tools/wasi/zig.py) runs it in wasmtime and holds its
memory per instance and payload to #532's thresholds, in CI; the [first
figures](../../docs/research/zig-wasi-figures.md) are 2 MiB per instance and
0.40 MiB of Brotli payload, against the Go reactor's 15.5 and 2.04.

After building the WASI target, run its pinned Python dependencies through `uv`
from the repository root:

```sh
uv run tools/wasi/zig.py impl/zig/zig-out/bin/talk.wasm
```

The script declares its Python version and dependencies inline; `uv run` creates
the environment. This checks the C API reactor; Message Layer verification uses
the shared [reactor harness](../../tools/wasi/check.py):

```sh
(cd impl/zig && zig build -Dtarget=wasm32-wasi --prefix ../../.cache/zig-wasi)
uv run tools/wasi/check.py
uv run tools/wasi/list_memory.py --profile minimum
```

The shared scripts default to `.cache/zig-wasi/bin/talk.wasm`; an explicit path
(`check.py path/to/talk.wasm`, or `list_memory.py --wasm path/to/talk.wasm`)
selects another build. CI runs both checks against Zig, with each List workload
in its own job. The [C](../../bench/message-layer-c/) and
[Elixir](../../bench/message-layer/elixir/) harnesses also build and default to
this module, so remeasurement needs no `TALK_WASM` override.

### Native Message Layer sidecar

`zig build sidecar` installs `zig-out/bin/messagelayer` (also included in a
native `zig build`). It shares `src/message.zig` with the WASI reactor and
needs neither Go nor a WASI runtime. macOS uses the system `libSystem` for
process I/O; the Linux artifacts are statically linked. The safe optimization policy applies
to every target. Linux builds use static `*-linux-musl` targets:

```sh
# From impl/zig:
zig build sidecar -Dtarget=x86_64-linux-musl --prefix ../../.cache/zig-linux-amd64
zig build sidecar -Dtarget=aarch64-linux-musl --prefix ../../.cache/zig-linux-arm64
zig build sidecar -Dtarget=x86_64-macos --prefix ../../.cache/zig-macos-amd64
zig build sidecar -Dtarget=aarch64-macos --prefix ../../.cache/zig-macos-arm64
# From the root, using a binary executable on this machine:
python3 tools/sidecar/check.py impl/zig/zig-out/bin/messagelayer
uv run tools/wasi/list_memory.py --sidecar impl/zig/zig-out/bin/messagelayer
```

CI cross-builds and executes the sidecar on Linux amd64/arm64 and macOS arm64.

Each request and reply is a four-byte big-endian length followed by UTF-8 JSON.
Every request receives one flushed reply, including interim needs. Stdout is
reserved for frames. Clean EOF between frames exits with status zero; a
truncated header or body exits unsuccessfully with a `messagelayer:` stderr
diagnostic. The maximum incoming frame is 64 MiB. Larger frames are drained
through a 64 KiB buffer, answered with a protocol error under `ref: -1`, and
leave the Session usable. Truncation while draining is a transport failure.
JSON and Value nesting have no fixed depth limit. Callback inputs use distinct
refs while the worker ref remains reserved for its result, just as in WASI.

The executable checks exercise framing, malformed/deep JSON, Value Encoding,
immediate and suspended Operations, paused Host Inputs, properties, effects,
scope cleanup, Grant releases, cancellation/Stop and Zig save/restore in a fresh
process. The shared Message Layer tests include Reload/replacement and native
callback parity. CI separates cross-builds from execution on macOS and Linux,
amd64 and arm64, and runs native List-memory and Linux cgroup checks. The
[Elixir harness](../../bench/message-layer/elixir/) builds both Zig transports
and uses the sidecar through an Erlang Port. Its Linux containment checks need
Docker; an unavailable Docker check is unverified. Local platform and memory
evidence is recorded in [the cutover verification](../../docs/research/zig-native-sidecar.md).

Go-sidecar saves require fresh Groups from source and Host-owned data; there
is no cross-Core converter. Keep the previous Go executable to drain old Groups
if necessary. Zig saves remain supported on the replacement. The Go public API
and its facilities stay available; [#884](https://github.com/odogono/odgn-talk/issues/884)
retains the separate full-Core retirement and performance gates.

From the repository root, `bun tools/zig/api.ts` compares `talk.h` with
`talk.go`. It fails on a `talk.h` name that `talk.go` doesn't declare, unless
the declaration is marked `C only`, and on a `talk.go` name `talk.h` doesn't
declare.

## The Session Host

[`src/session/session.zig`](src/session/session.zig) is chapter 12's Session
Host. It is an ordinary Host: it drives a Group named `session`, holding one
Script, through `talk.h` alone, using the front end only to read Entries. It
follows its Runs through their reports, placed by the Group's Trace records,
and never inserts `Inspect()` to do so. A Driver gives it everything from
outside: Clock readings, typed lines, prompt answers, and where its output and
Trace go.

- **Entries** are decided on their first token. A declaration with new names
  extends the Script, and a redefinition reloads it from the session source,
  carrying Script Variables over. A statement or an expression becomes
  `entry<n>`, with the names it binds as Container roots or Captures as new
  Script Variables. The checker gives these as each body's `roots`.
- **Positions** of an Entry's diagnostics and errors are shown in its own
  lines: the extension's lines before the Entry's first, and `return ` before
  an expression's first line, are taken off.
- **Output** of a Pump is placed by its Trace: a Host function's lines at its
  `call` record, a Run's end at its `run` record, and `unhandled` at its
  record. A Run other than the current Entry's has `[<run>] ` before its lines.
- **The corpus runner** replays `session.transcript` through it, and compares
  the Transcript it writes, its `@`, `<` and `~` lines included where it read
  them, and the Group's Trace with `case.trace`.

- **The Session Store** ([`src/session/store.zig`](src/session/store.zig))
  keeps each Store in memory, every value by its Value Encoding, so Stores
  outlive any Group a `:restore` replaces. Writes wait in their Segment until
  it commits, and a commit with changed keys counts a revision and goes to the
  router. After each Pump the router retries, and while it admitted a
  Notification the session pumps again at the same reading. `:save` and
  `:restore` take and restore router checkpoints.

- **Observation** (`:describe`, `:inspect`, `:apropos`, `:trace`, `:untrace`,
  `:fuel`) follows [Session observation](../../spec/session-observation.md).
  The session keeps every code unit's source by its code identity, which
  `talk_script_unit` gives, so `talk_function_info_of` finds a Function
  Value's documentation even once a Reload has made it stale. Trace rows come
  from the Run lifecycle reports, and Fuel Measurements from Run accounting,
  each after a Host call's ordinary output.

- **Object crossings** (`%` envelopes) follow
  [Session observation](../../spec/session-observation.md#object-crossings-in-session-transcripts).
  A replay defines each recorded Object Kind and registers each object with a
  dummy native identity. Its getters and setters answer from the recorded
  `property-begin`/`property-end` pairs, making the Host actions recorded
  between them. Each Function Value leaf a report or a setter exposes binds
  the next `function` handle, and a Restore's resolver answers from the
  `resolve` envelope. Crossing Values go directly from parsed JSON to the
  Core's iterative Value decoder, which resolves `$sessionFunction` handles
  as owned Function references, including inside lists and maps nested
  100,000 deep on a 256 KiB native stack. Unknown or malformed handles are
  refused, with partial Values released even after allocation failure;
  ordinary text stays text. This Transcript-only resolver is internal to
  Zig and does not change `talk.h` or durable Value Encoding. `:inspect`
  of an object adds its `object` and `property` rows. It then reads each
  property in a second Run, the normative
  reader, extended under the first free `entry<n>`.

### The REPL and Transcript replay

[`src/repl/main.zig`](src/repl/main.zig) is `talk-repl`, the Session Host at
a terminal under a real Clock. It reads Entries and Session Commands from
standard input and prints what the session prints. An Entry may span lines:
the REPL prompts `| ` and waits while its syntax ends early or a fenced literal
or hole is open
([chapter 12](../../spec/12-sessions-and-tooling.md#fenced-text-in-sessions-and-tooling)). It answers
the foreground's `read` with the next line (`< `), and a `user` prompt (`~ `)
with a value in the display form, or `fail` and an error map. A line that
isn't in the display form answers as text. While it waits for input, it pumps at each deadline the session
reaches. `:library add|replace <name> <path>`, `:fix <run> <path>` and
`:store load [<store>] <path>` read the file, and the Transcript records its
lines in place of the path. End the session with end of input (Ctrl-D). Ctrl-C
isn't caught yet, so it ends the REPL rather than cancelling the foreground
Run.

From a clean checkout, with Zig 0.17 (nothing else is needed to build):

```sh
cd impl/zig
zig build repl                                       # start a session
zig build repl -- --transcript s.transcript --trace s.trace
zig build && ./zig-out/bin/talk-repl --help          # the installed binary
```

`--transcript` writes the session's Transcript as it goes, and `--trace` the
Group's Trace.

Transcript replay is the corpus runner's. It gives a case's
`session.transcript` to a fresh Session Host, with the recorded Clock
readings, lines, answers and object crossings, and compares what it writes
with the Transcript and its Trace with `case.trace`:

```sh
cd impl/zig
zig build corpus -- sessions                         # every Session Transcript case
zig build corpus -- sessions/real-clock              # one
```

To replay a Transcript the REPL wrote, put it in a case directory under
`corpus/` as `session.transcript`, with the Trace as `case.trace`, and a
`case.toml` holding `kind = "transcript"` and the `[versions]` table, as in
[`corpus/sessions/mocks`](../../corpus/sessions/mocks/case.toml).

## The Notification router

[`src/notify/router.zig`](src/notify/router.zig) is the router chapter 7
describes for `store` watches, declared in `talk.h` as `talk_router_*`. It is
Host code over `talk.h`, as talk.go's `notify` package is: the Core takes no
part in it. A Host's `store` implementation forwards `watch`, `unwatch` and
its Grant release hook to it, calls `talk_router_commit` with each commit's
changed keys under the Store's synchronization, and calls
`talk_router_pumped` after each Pump. `talk_router_save` and
`talk_router_restore` take and restore checkpoints, which hold the Group's
save and the routing state tied to it by its digest. C has no way to read a
Store's name out of an opaque binding, so the router's options include
`store_of`, which does that.

## The machine

**Metering support:** Operation Declarations carry `metering: "read-only"` or
`"segment-bound"`, validated against mode, scope and coordinator metadata.
It participates in the Host Manifest, Group Fingerprint and restore matching.
`talk_call_charge` permits repeated callback-time increments, retains the
accepted prefix and latches the first budget refusal even if the Host suppresses
it. Invalid Fuel amounts are `invalid value` and do not latch a Limit Fault.

A suspending read-only Operation may call `talk_call_request_charge`, including
while starting, and receive a Group-owned `talk_charge_request`. The by-id
`talk_request_charge` has the same admission rules for the Message Layer and
restored issued ids. Admission is safe from Host threads: one unresolved request
per call, Group-wide `q<N>` ids, and FIFO order with other queued inputs. Install
`talk_group_on_ready` before starting workers to receive enqueue notifications;
its hook runs outside the admission lock. `talk_charge_request_done` and
`talk_charge_request_result` use the processing Pump's completed outcome. A
starting callback must return before awaiting it. Check `talk_call_context`
after acceptance and before work, since a later cancellation or timer in that
Pump may already have abandoned the call.

Accepted charges immediately contribute to Run accounting, Script counters,
Pump Fuel and slice debt, including Pumps with only waiting Runs. Refusal faults
at the originating call, including a Join Member, without a synthetic Segment.
A preempted Join's open Segment rolls back; a suspended Run keeps its committed
variables. `talk_save` refuses with `effects pending` for pending metered calls
or unresolved requests, even after Reload ends their call. Successful saves
preserve the request counter and issued-call eligibility in save format `zig/7`;
older Zig snapshot layouts are refused.

The [#472 handoff](../../docs/handoffs/472-metered-operations.md) still stages the
shared executable catalogues and Go/TS target declarations. The maintainer
authorized Zig to lead with Zig-only tests under
[#911](https://github.com/odogono/odgn-talk/issues/911). Zig-only unit,
C Host, Message Layer and replay tests exercise the target contract without
blessing shared expectations. Its replay consumers understand the metering
Trace/setup extensions, including accepted-prefix-plus-refusal replay. Existing
shared SQLite fixtures use `talk_sqlite_legacy_capability` and their explicit
up-front `perRow` replay Host until every consumer migrates; ordinary embedding
uses the metered step factory below.

`talk_new`, `talk_new_group`, `talk_load`, `talk_script_deliver`,
`talk_script_request`, `talk_pending_result`, `talk_pump`, `talk_inspect` and
`talk_script_counters` drive a Group. A Group's Trace reaches the Host's `talk_trace_sink` one line at
a time. `talk_pump`, `talk_script_reload` and `talk_replace_library`
also return the Host call's reports ([chapter 9](../../spec/09-embedding.md)),
in the order they happened, as a `talk_reports` the caller releases before
its Group: each `run end` with its result, error or limit, `stop`,
`unhandled`, `call failed`, `effect failure`, `decided`, and a queued input
the Pump refused. A Pump's result also gives its next deadline. The Group
collects reports whether or not it writes a Trace, and charges nothing for
them. Each Host call that returns reports ends with Run accounting's tail:
`run started` and `run discarded` join the other reports as they happen, then
come a `run accounting` row for each Run started, charged, ended or discarded,
in the order the Runs were made, and `causal work` for each root whose work
changed, in admission order. Every message carries its root Delivery, and the
Run and call that sent it, so a save keeps ancestry, the roots' discard counts
and the roots not yet reported. `talk_restore_result_reports` gives a
restore's baseline. The [shared fixtures](../testdata/run-accounting.json)
run against the exports. Loading a Script parses, checks and lowers it, runs its initialiser
uncharged and writes its `load` record with its code identity, or its `diag`
records and `TALK_LOAD_REFUSED`. Limits and Fuel Slices aren't reachable
through `talk.h` yet.

`talk_inspect` is the Host Input `vars`: it writes each Script's `vars`
record and, when asked, returns the `talk_inspection` a REPL renders `:vars`,
`:runs` and `:mailbox` from. That is each Script's disabled Grants, its Script
Variables, its Runs that haven't ended, in the order they started, and its
mailbox. A Run is preempted mid-Segment, ready with what it resumes with,
parked by its clause's Queueing Policy, or suspended. A suspended Run shows
the end reason and the deadline its `seg` record wrote, and the calls,
replies or Join Members it waits for.

Each Group allocates everything it holds through its own allocator
([Group allocator](src/machine/group_allocator.zig)), which wraps the
`talk_allocator` the Host gives in `talk_group_options`, or the Core's, and
counts physical bytes against `memory_cap` (256 MiB by default). Freed Value
nodes are kept for reuse in a cache of at most 128 nodes, counted against the
cap like everything else, flushed under cap pressure and returned when the
Group is released. Released frame locals and operand buffers have a separate
cache of at most 32 buffers, each at most 1 KiB (at most 32 KiB retained).
Only empty buffers with room for an intrusive header are kept; Values and
internal stack objects are released first. Reuse requires the same byte size
and alignment, including for frames rebuilt by Restore, and every local is
initialised again. Unbound locals share one immutable Nothing per call, with
one owned reference per slot. Both caches count in physical memory, are
flushed before a cap refusal, and return all storage on Group release.
Cost Model 0
still charges logical allocation; the cap is for defects. A refused
allocation becomes `TALK_OUT_OF_MEMORY`: the Run in flight is dropped whole,
messages and waits that couldn't be queued are released, and the Group takes
no more work, while `talk_group_release` still gives back every byte.
`talk_group_memory` reports the bytes held, the peak, the cap and whether a
refusal happened. A test refuses at every allocation of a run of Scripts with
sends, Joins, `wait for`, errors and `finally`, and checks that nothing is
left.

A Pump writes and drains the queued Deliveries and Requests, then runs each
Script's mailbox: each Run tries its Handler's clauses in order, charging the
`clause` rate at each clause's first instruction. A Command Call to a Handler
of the Script, with or without `and wait`, tries its clauses the same way in a
new frame, and raises `no match` at the call when none takes it. A message no
named clause takes goes to the Fallback's clauses with its `{name, args}` map,
built without charge, unless it is an `error` message; its Run's records add
`fallback=yes`. A clause's Queueing Policy applies once its patterns and Guard
have passed, while a Run of the clause hasn't ended. `, queued` parks the new Run after its `clause` charge, and the
first parked Run becomes ready when the clause's Run ends, behind any `error`
message. `, dropping` ends the new Run `dropped`. `, replacing` cancels the
earlier Runs: what each waits on is abandoned at once, and in its own turn it
runs its `finally` blocks, innermost first, with nothing unwound, and ends
`cancelled`. A waiting sender gets `send failed` with that reason.

A Decision (`talk_decide`, `talk_script_decide`) is a Delivery that carries
an open Verdict. A `wait for` that takes it allows it, and so does a selected
clause without `, deciding`; a selected `, deciding` clause holds it. The
Verdict is sealed at the end of that Run's first Segment, with a `decided`
record after its `seg`: `veto` vetoes it, and suspending or ending without one
allows it. `pass` carries it up the Message Path, and the end of the path
allows it. A Run that errors, faults or ends `effect failed` first, or a
`, dropping` clause that drops it, leaves it undecided, after the `run`
record. A Delivery, Request or Decision whose name has a `:` but isn't a
Selector with one argument per part is refused at the call, with its `>`
line, no id, and `refused code="invalid value"`. `cancel-delivery` comes
with cancellation.

A Broadcast (`talk_broadcast`) or Broadcast Decision (`talk_decide_broadcast`)
finds its recipients when the queue is drained: the Scripts with a Handler
for the message or a `wait for` pending on it, in load order, each with its
own delivery id, which the `>` line lists. A wait whose Run a `cancel-run` or
`cancel-delivery` queued in the same drain will cancel doesn't count. A limit
override may not loosen the default limits; each recipient keeps the tighter of
its own limits and the override. A refused Broadcast's `>` line keeps the
override's fields as given, and consumes no id. A recipient's Delivery carries the
broadcast id, never climbs, never reaches a Fallback and is never
`unhandled`; neither does a Decision's. A Broadcast Decision gathers each
recipient's part, its veto, its undecided outcome or its allowing, and writes
one `decided` record once the last has one: vetoed if any vetoed, undecided
if none did but one was undecided, and allowed otherwise, at once when there
are no recipients. Frames are on the heap, so
the run loop never recurses on Script depth. Every instruction is charged by
its `machine.toml` cost key, or `builtin.<name>`, from the generated Cost Model
0 terms, with `scanned` reported by the operation itself, and Persistent State
is measured over the Script Variables and the mailbox at a Segment's end.

Opcode rates are resolved at compile time. The Cost Model generator also emits
shared evaluators for static Fuel/allocation formula pairs, selecting measures
and folding constants ahead of execution while retaining each term's own
rounding and checked arithmetic. Dynamic Built-ins, keyed charges and formulas
with unsupported measures or subjects use the term interpreter, which remains
the differential-test oracle. Extra Host Fuel and allocation are still added
at each charge; the machine owns refusal ordering and instruction boundaries.

`talk_script_counters` reads a Script's lifetime Fuel, allocation, Runs and
Limit Faults, live Runs included, with its current Persistent State and
mailbox, and writes the `counters` record without draining Host Inputs.

Instructions within a `finally` scope retain their popped operands until the
instruction ends, so Error-mode cleanup can keep the failed continuation's
stack. The eight-slot inline buffer is reused within each `execute` call;
release clears its live-slot metadata after releasing those owners and any
overflow storage. Each retained slot is written before its length is published.
This storage remains local to execution; it adds no Run or snapshot state.

Lists keep immutable visible slices over shared backing storage. Appending or
prepending to the newest slice uses spare capacity, with geometric growth when
it runs out, so repeated spine growth takes amortised linear time when the
inserted values have lower ownership ranks. Ranks decrease along physical
ownership edges, including hidden items, so cycle prevention needs no graph
walk. Growing an older slice or writing inside a shared slice copies its
spine; inserting a value with an equal or higher rank also copies into new,
higher-ranked storage. Growing a Host List copies its spine into the Group
allocator. `collecting` and List literal spreads use the same growth path,
without a temporary copy of the preceding List. Scalar collecting therefore
has amortised linear spine work; nested values with equal or higher ownership
ranks can still force copies.

In-range single-item writes use the copy-on-write point setter directly,
without first building a temporary spine. A unique same-allocator List can
reuse its storage for a lower-ranked child. Chunk writes retain the borrowed
input, including lowering temporaries and Segment rollback bindings, so they
still copy the visible spine once per replacement; repeated writes on a long
List remain linear in its length per write. Padded writes and range replacement
rebuild the result. Host-owned input spines copy into the Group allocator.
Snapshots, captures and rollback bindings keep their previous contents. Spare
capacity and retained items outside an older slice count against the Group's
physical cap; Cost Model 0 still charges only the specified logical allocation.
The [List measurements](../../bench/results/2026-10-14-zig-list-paths.md)
record size scaling, allocations and the remaining point-write cost.
Lowering temp release makes a slot available to the compiler; it does not
clear the runtime local. Such locals still contribute to retained frame size
and Save/Restore. The [local-write ownership investigation](../../bench/results/2026-10-15-zig-local-list-writes.md)
explains why last-use loads alone cannot enable unique machine point writes.

Forward Character reads walk only through the requested end and keep byte
offsets instead of segmentation arrays. Missing and reversed reads still
charge every Character as scanned input. Negative indexes retain full
segmentation; there is no retained Text index or cache.

So far the machine runs straight-line code, branches, loops, functions, chunks
and properties, keys, lists and maps, `match` with its destructuring tests,
Bytes builds and Binary Patterns, `as` conversions, number, Quantity and date
arithmetic, `^`, and the Built-ins. `floor`,
`ceiling`, `truncate` and `round` round the coefficient exactly by the General
Decimal Arithmetic's modes; `upper` and `lower` use the full case mappings, with
Final_Sigma, then NFC; the date fields, ISO weeks, `toCivil` and `toInstant`
work on proleptic Gregorian days; and the float Built-ins read and write IEEE
754 bytes through the shortest round-trip decimal. `sqrt` and `power` are the
decimal `power`, exact where the value is. `exp`, `ln`, `log10` and the
trigonometric functions ([transcendental](src/decimal/transcendental.zig))
bound the exact value in a fixed-point interval, with pi by Machin's formula
and each series' tail bounded, and round both ends; by Ziv's method, a
disagreement retries with twice the guard bits. A Built-in that raises still
pays its rate. A
raised error unwinds in two phases: the catch search walks the Unwind Table
outward, charging `unwind` per frame it leaves and running each catch test in
a dispatch activation over the owner's locals, then the exited `finally`
blocks run, innermost first. A Run keeps its error control as a stack of
dispatches and cleanups, so a catch's tests and a Recovery policy run in the
ordinary run loop and may call functions; the failed frames above the owner
are held aside meanwhile. An error inside a policy, or inside a `finally`
block a cleanup is running, first searches only inside it, then escapes as
chapter 6 says: an escaping policy runs its own and the failure's `finally`
blocks and goes on outward from the catching `try`, past its other catches,
from where the policy failed. `choose-offer` looks the name up in the failure
chain, charging `4 * frames` for the frames it scans, and transfers after the
policy's `finally` blocks and then the failure's down to the offering `try`,
with `offer-chosen` and `offer-entered` records. `offerAvailable` searches the
innermost dispatch's chain, or a pending transfer's until its action is
entered. An uncaught error ends the Run and queues an
`error` message to the Script's own mailbox, for its `on error` Handler. Core
messages are left out of the Trace, since their wording is outside parity.

Text Patterns run on chapter 8's Pike VM ([matcher](src/machine/matcher.zig)).
A pattern value keeps its canonical source, so the matcher reads it back,
compiles it and runs the program, counting `steps` by the Running rules: the
threads in the list at each position. `make-pattern` splices values into a
template and writes the result's canonical source. A text needle, or a Bytes
needle in Bytes, runs as a literal program. A pattern's logical size compiles
it to count its program. Patterns made at run time can nest without bound, and
a program can be a long chain of splits, so reading, splicing, writing,
compiling and matching keep their pending work on explicit stacks and never
recurse on a pattern or its subject.

A Host defines Capabilities and Grants through `talk.h`
([capabilities](src/machine/capabilities.zig)), and binds Grants at Load, by
the name the Script uses. `ask` and `tell` call immediate and fire-and-forget
Operations: each argument is checked against its Shape first, with nothing
charged for a mismatch, then the declared cost and any `Charge` are charged,
the Host function runs, and its result is checked against the result Shape.
Function Values that break scalar, container or closed-map Shapes raise
`wrong kind` with `got: "function"`. Data scans under `any` and open maps'
undeclared fields raise `not encodable`. A mismatching Quantity reports
`got: "quantity"` unless the failing Shape constrains its Unit or Unit Kind,
in which case it reports the Unit; an Optional preserves that diagnostic.
A `Fail` raises its code with its Data as fields, unless it misuses a
catalogue code, a reserved key or an undeclared code, which the Script sees
as `host error`, with a `call-failed` record. The loader checks each literal
argument's kind against its Shape. The corpus runner answers calls from
`stub` lines.

An Operation may open or close a Capability Scope
([the lifecycle contract](../../spec/embedding/scoped-effects.md)). A Run keeps
its occupied slots, by named Grant and scope, in opening order. After the
argument checks, a call that would open an occupied slot, close an empty one
or open one inside a Join is refused, uncharged, and so is a suspending
Operation, `wait`, `wait for`, a waiting send, a Join or another Script's
Function Value while a scope is open. A Host return acknowledges the opening
or closing with a `scope` record before its result is checked. When the Run
ends, the Core calls each slot's abandonment Operation, newest first, with
`automatic` set and nothing charged; a failure disables the Grant, so later
calls raise `capability disabled`.

`talk_script_revoke` queues a `revoke` input. When it is drained, the first
revocation of a name the Script keeps marks that Grant revoked, and later
calls through it raise `capability revoked`, uncharged, after the
`capability disabled` check. A call in flight is left to the Host, and its
answer still resumes the Run. A repeat, or a name the Script doesn't keep, is
recorded and does nothing. A Capability's release hook, a
`talk_with_release_hook` option given with its definition or `store`'s
`release`, is called with the reason `revoke` then, and with `disable` right
after the `effect-failure` record of a failed abandonment. Stop releases with `stop`, and Reload and Library
replacement with `reload`, only once the new code is accepted.

Segment-bound Operations come from `talk_define_segment_capability`, which
makes each Grant its own Segment Coordinator, or
`talk_define_coordinated_capability`, which maps each Grant's binding to one
when the Grant is made; `talk_define_capability` refuses them. A Run's first
Segment-bound call in a Segment enrolls its Grant and calls the coordinator's
`begin`, after the call's checks and charges. Later calls through Grants
mapped to the same coordinator enroll them with no hook, and any other is
`segment participant conflict`, uncharged. When the Segment ends, after
abandonment, the participant commits, unless the Segment faulted or was
cancelled, or abandonment failed on a participating Grant, when it rolls back.
A failed commit rolls back too, restores the Script Variables to the
Segment's base, which a Script with Segment-bound Grants keeps at each
Segment's start, and ends the Run `effect failed`. An `unknown` begin or
commit, after a rollback attempt, or a rollback that doesn't succeed, stops the
Group: the running Run's Stretch ends `stop`, keeping the call's charge, and
every Script is stopped with reason `effect state unknown`.

`clock`, `calendar`, `locale` and `console` come from factories with chapter
7's fixed declarations ([standard](src/machine/standard.zig)). `clock.now`
answers from the Pump's Clock. The Core makes the chapter's own checks:
`toInstant`'s date-time and disambiguation and a Locale's option words and
BCP 47 tag before the call, charged nothing, and each result's rules after it,
whose failure is `host error`. A Host function receives the resolved
arguments, with a Locale's options map complete.

`store` (`talk_store_capability`) declares its eight Operations, with `set`,
`delete`, `increment` and `swap` Segment-bound, and maps every binding to the
one Segment Coordinator its implementation gives. The Core refuses an empty
key with `invalid key`, and a `watch` or `unwatch` with an empty name or a
message that isn't a plain Name with `invalid watch`, before the call is
charged. The implementation hears `get`'s and `increment`'s omitted
arguments as Nothing, `keys`' as empty text, and `watch`'s effective message.
A Host failure must name a declared code with the catalogue's fields:
`store full`'s and `watch limit`'s `limit` must be one of the chapter's
words, and the codes the Core raises itself are `host error` from the Host.
Notifications, and so the router, aren't implemented yet.

`sqlite` (`talk_sqlite_capability`) is optional
([values at the boundary](src/machine/sqlite.zig)). Each Grant's binding is a
`talk_sqlite_binding`, and maps to its database's coordinator, which the
implementation gives; `change`, `begin`, `commit` and `rollback` are
Segment-bound, and `begin` opens the scope `transaction` that `rollback`
abandons. Before the call, uncharged, the Core checks `max` (`out of range`),
then that `params` is a list or a map, then each value (`wrong kind` at
argument 2, with its `path`). `max` defaults to the binding's cap. The factory
converts `params` to SQL values and supplies `before_step` and its opaque
`step_context` to `query` and `change`. The driver calls it once immediately
before every statement step and propagates refusal without stepping, including
completion, SQL errors and the overflow probe. `per_step` is the factory's rate;
N returned rows normally cost N+1 steps, an empty result or a non-returning
change costs one. `max=0` still permits a completion step. Queries are metered
read-only; changes are metered Segment-bound and roll back on refusal. The Core
converts the rows back, raising `sql` for a column named twice and
`unrepresentable` for a double it can't hold or text that isn't UTF-8. A
malformed result is `host error`. `talk_store_coordinator` gives the Core's
copy of a `store` implementation's coordinator, the same one for the same
hooks and context, which the implementation's `coordinator` may give for the
database that keeps the Stores, so both share a Segment's participant.

`timer` (`talk_timer_capability`) forwards `schedule`'s name, Instant, message
and arguments and `cancel`'s name to the Host, both fire-and-forget. The Host
stores timers and delivers a due one as an ordinary Delivery; the Core keeps
no timer of its own. `user` (`talk_user_capability`) is optional and has no
binding. The Core refuses an empty `choose` with `out of domain` before the
call, and the implementation hears each omitted option resolved: an empty
`prompt`, `default` or `title`, and `multiple` false. `confirm`, `choose` and
`enter` suspend for up to 2,147,483,647 ms, and the Core checks the answer:
a boolean, text or Nothing, and for `choose` Nothing, one of the items, or
with `multiple: true` a subsequence of them. Any other answer ends the call as
`host error`. A suspending call whose Operation checks its answer keeps its
arguments until it is answered or the Group is released.

Runs suspend at `ask … and wait` and `wait d`. A suspended Run lives on the
heap, its Script goes on to its next work, and each Script's work is one
queue of messages and ready Runs, in the order each became ready. A
suspending call's `talk_call` outlives the call, and `talk_call_answer`,
`talk_call_answer_with_cost` and `talk_call_fail` queue Host Inputs that the
next Pump drains; an answer for a call that no longer waits becomes a
`late-answer` note. `talk_call_context` turns true, readable from any thread,
once a call's wait ends without its answer, so the Host may give up its work. Each Pump then fires due deadlines, `maxPending` or the
default `MaxWait` for a call, in deadline order, and a timed-out call raises
`timeout` and is abandoned. A resumed Run is charged its answer's terms over
the result and any cost the answer brought. Persistent State counts each
suspended or ready Run's frames, its pending call and what it will resume
with.

Scripts send to each other: `send`, `send … and wait` and the computed-name
and spread forms put the message at the back of the receiver's work, with a
`send` record, and a waiting sender resumes with the reply or `send failed`.
A Script named as a receiver is its name, and `me` with no owner is the
Script itself. A Join starts its members where they stand and suspends once at
its `end`: it resumes with every answer in start order, or with the first
failure, `index` added, and an error leaving the Join abandons its pending
members. A Timeout Block's deadline sits on the frame's stack, bounds every
Suspension Point inside it, and raises `timeout` with `deadline: true`, at once
when it has already passed.

A `wait for` holds the values its branches popped and suspends. Before a
Script dispatches a message, every pending `wait for` in it runs its test
bodies on the waiting Run, which pays for them, in the order the waits began.
A match binds the names its test gives and leaves the message in `it`, and
the message still goes to the Handler Clauses. A timeout or an `after` branch
resumes the Run with Nothing, and a Timeout Block bounds them all.

Host Objects ([objects](src/machine/objects.zig)) are the Group's handles,
each of an Object Kind defined once on the Core with `talk_define_object_kind`,
and their object value's identity is the handle. The Core holds each object's
parent, set by a queued `talk_set_parent` that is checked at the call and
again when drained, each refusal a `refused` record, and `talk_dispose` marks
one disposed. A Script may own an object, which is `me`, and binds well-known
objects by name, which the checker uses for `can't write`. `the k of o` reads
the Kind's Get, with a `prop` record, charged `get-key`, the property's
`getCost` and the value's conversion; `id` is the Core's, and a Guard reads
nothing else. A well-formed Get or Set failure raises its code, as an
Operation's does, with `capability` the Kind and `operation` the property,
and its Data's conversion is charged. Any other failure is `host error`, with
a `call failed` Report identifying the Kind/property and an empty Call id.
Properties emit no `call-failed` Trace record. A failed setter's `prop` record
retains both its assigned `value` and `error`; Stop/cancel landing still happens
before failure classification and suppresses interrupted Host-failure Reports.
`set` checks the Shape, uncharged when it fails, then runs the
Set. A Delivery or `send` to an object goes to its nearest Owning Script,
whose path is walked again when the message reaches the head of its mailbox,
so a message follows its object if it moves. A Run that ends `unhandled` or
reaches `pass` sends the message on from the parent of the object whose
Owning Script took it, and a Command Call with no Handler climbs from the
parent of `me`. A message with no Owning Script left is reported `unhandled`.

Libraries are compiled once per Core with `talk_compile_library`, against the
Libraries they import and the Grant declarations their Capability calls are
checked and lowered against: each Operation's mode and argument Shapes, as
`talk_grant_decls`, which `talk_capability_def_checks` gives for a definition
the Host holds. Their Constants are evaluated at compile time, since an
initialiser may use only literals, Constants and Built-ins. A code
identity covers each imported Library's identity, in the order the `use` lines
first name them. `talk_add_library` writes the `add-library` record and refuses
a stdlib name, a name the Group holds, or an import the Group doesn't hold.
The seven stdlib Libraries, generated from `spec/stdlib/` into
`src/generated/stdlib_sources.zig`, are compiled the first time a unit imports
one, and every Group holds them. A Library's code runs in the caller's Run:
each frame names the Library whose code it runs, so its constants, Unwind
Table and positions are that unit's. `call-import` calls a Library function
with its defaults, and a Command Call finds an imported Handler. An error raised
in stdlib code looks like a Built-in's: its `at` names the call into the stdlib
and the Core adds its `message`. Loading a Script checks the `needs` of every
Library it imports against its Grants, at the `use` line, and `grantsAsUsed`
keeps the Operations those `needs` call.

The trusted stdlib loader alone lowers private `map:restrictedCall` to
`call-restricted`. Its inherited frame restriction rejects live Script state,
Host effects and recovery-context access before acting, and survives catches,
cleanup, preemption and restore. Host Library compilation cannot enable it.
Snapshot format `6` rejects earlier formats. The `map.transform` Library export uses this boundary for callbacks; no
public pure-call API is available. See [the normative contract](../../spec/08-the-abstract-machine-and-the-cost-model.md#restricted-stdlib-callbacks)
and [the cross-Core kit](../../corpus/restricted-kit/README.md).

`map.transform` implements ordered, presence-aware Mappings from the shared
normative Library source, including wildcard/default/skip selection, complete
Shape checks, definition validation before callbacks and complete output or
ordered diagnostics. Limit Faults escape. The [contract](../../spec/07-libraries-and-the-standard-library.md#checked-mappings)
fixes definition precedence and concrete source locations; the `stdlib/mappings*`
Corpus cases cover behavior, sliced restore and resource exhaustion.
Mapping introduces no depth cap; its depth case verifies 96-step paths under a
12-frame call-depth limit.

A Lambda makes a Function Value with its captures, by name in slot order, and
a function's bare name makes one with none. Each Group keeps one record of
the code a Function Value runs, its Home Script, unit and body, which the
value's identity names. It displays as `<function home:where {captures}>`,
where `where` puts a Library's name before a function's name or a Lambda's
position. Its size is 32 and its captures, since `items` is 0 for it.
`call-value` runs one whose Home Script is this one, and that can't suspend,
in the caller's Run with its captures and defaults, after the `wrong kind`,
`would suspend` and `wrong arity` checks. `call-value-wait` may run one that
suspends, and sends another Script's to its Home Script, whose Run has one
frame and no Handler Clause and writes `fn=` in place of a Handler.
`functionArity` and `functionName` read what the record kept when the value
was made. The record also holds its Home Script's code generation, which a
Reload replaces, so a value made before it is stale: calling it raises
`function gone`, while `functionArity` and `functionName` still answer and its
display is unchanged. An extension's Lambda displays with the extension's unit
name, `<function s+1:3:9>`, and its named functions, like the Script's own,
with the Script's name.

`talk_script_extend` adds an Entry as a new code unit of the Script, an
extension named `<script>+<n>`, counted from its last Load or Reload. Its
checker sees the Script's Script Variables first, then its Constants,
functions, Handlers and imports as imports from the unit that declares them,
`@<unit>`, or from their Library, and only the Script's unrevoked Grants with
the Operations it keeps. An Entry that declares a name the Script has is
refused `name reused` before it's checked. The extension's definitions start
with the Script's Constants, and its variables table with the Script's
variables, which grow by its own; its initialiser runs, then the Script's
Persistent State must fit its cap, or `state too large` puts everything back.
An extension's diagnostics and errors are placed in its own source, under its
unit name. Dispatch, `wait for` tables and Command Calls look across all the
Script's units, since each Handler is in one of them. The extended Script's
identity hashes the previous identity, `extend` and the extension's own.

`talk_script_reload` builds the new code in a detached Script against the
Script's kept, unrevoked Grants, objects and owner, and runs its initialiser
between Pumps, with no Fuel Slice or Fuel cap. With `TALK_CARRY_VARIABLES`,
each Script Variable both codes declare takes its old value, a preempted Run's
Segment base standing in for what its Segment wrote. A LoadError or a carry
over the cap changes nothing. Then the Script is stopped with reason
`reload`, keeping its mailbox if asked, its revoked Grants are removed, and
the new code replaces the old and every extension. Reload isn't sticky, and of a stopped Script it stops nothing. A stop whose
rollback leaves an effect's state unknown stops the Group, with reason
`effect state unknown`, and prevents the replacement.
`talk_replace_library` recompiles each held Library that imports the
replaced one, directly or through another, with the Grant declarations it was
compiled with, then rebuilds every Script that imports any of them from its
source and extensions, in load order; any refusal changes nothing, and the
Core owns the recompiled Libraries. A `use` line naming something its Library
doesn't export binds nothing, so a later use is `unknown name`.

`talk_save` saves the Group between Pumps in the Zig Core's own format
([snapshot](src/machine/snapshot.zig)), which no other Core reads: a header
with the format version, the language and Cost Model versions and the Group
Fingerprint; the Group's state as plain data; and the SHA-256 of all of it.
It holds every Library by identity, every Host Object by kind and id, every
Function Value's code by its Home Script, unit and body, each Script's
sources, Grants with their declarations, Script Variables, Constants and
counters, every Run with its frames, error control, wait and Join, the
Scripts' work, the waits in the order they were set, the pending calls with
their arguments, the queued Host Inputs and the open Broadcast Decisions.
Code is never saved, and pointers become indices. An attempt takes the next
save id, `s<n>`; a live Capability Scope, a Segment participant or a stopped
Group refuses it with `effects pending` and no snapshot.

`talk_restore` builds a new Group in chapter 10's order. Bytes it can't read,
or whose digest is wrong, are `invalid save`. It matches the Libraries the
Host passes by name and identity, asks the Host's `grants` function to
re-bind each Grant, whose kept Operations' declarations must match the
saved ones, and compiles each Script's sources again as they were first
compiled, against every Grant, without running an initialiser. A Grant the
Host doesn't re-bind restores revoked, with a placeholder Capability built
from its saved declarations. If the Group Fingerprint of what it rebuilt
differs from the saved one, it is `save mismatch`, unless the Host's policy
is `TALK_VARIABLES_ONLY`. A variables-only restore rebuilds each Script from
its saved source and extensions, like a Reload, against the Library given
under each saved name and its Grants, revoked ones included, so a Grant the
Host didn't re-bind still binds its name. It reads the Runs only to discard
them, trusting none of their code positions: each Script Variable the new
code declares takes its saved value, as a preempted Run's rollback would
leave it, and each discarded Run's Fuel stays in its counters. The
mailboxes, the input queue, whose lines it writes before its own, the Fuel
Slice debt and every pending call go, and each open Decision settles
undecided, `cancelled`, at the first Pump. A Script that no longer loads is
`TALK_LOAD_REFUSED`, and carried variables over a cap
`TALK_STATE_TOO_LARGE`. Then every Run is read and
checked against its unit's code, Host Objects the Host's `resolve` refuses
restore disposed, and the `restore` record lists the pending calls. Until
the first Pump, `talk_settle` queues each settlement: Answer and Fail as
the Host's would, Reissue runs the Operation's Start again, charging only
its `Charge`, which a Run that can't cover it faults on at the call, and
Adopt hands back the call. The first Pump must read a Clock at or after the
saved one, or it is `clock backwards`, and after draining the settlements
it fails every call still pending with `call lost`, in call id order.

A restore checks every index, length, count and code position a save
gives, so a corrupt or hostile save is refused, never read past or run into
a crash. Integers above 2⁵⁶, and limits above 2⁶², are refused, so the
machine's arithmetic on them can't overflow, and every deadline must be an
Instant the Core can show. [The stack verifier](src/machine/verify.zig)
works out, from each unit's code and `machine.toml`'s stack effects, the
operand stack every instruction expects: its depth, and which slots hold an
iterator, a reader, a replacement or a Timeout Block's deadline, through
jumps, Unwind Table targets and offer action entries. Each saved frame's
stack must be that one: a calling frame's less its call's result, a
suspended Run's top frame's less what its Suspension Point pushes on
resuming. Inside a catch dispatch or cleanup, where frames are held aside
and stacks cut back, each stack must be a prefix of its code's, and its
search, cleanups and transfer must point at frames and Unwind Table entries
that exist, counting the frames a dispatch holds aside. A Run's own wait is no Join Member's, a Run queued in its
Script's work is ready or preempted, and a saved iterator stays within what
it iterates. A test holds every corpus unit to one stack shape at each
instruction, and the decoder is fuzzed: every byte of two busy Groups'
saves changed, and thousands of random changes, each with its digest made
good again, must be refused or restore and run without a crash or leak,
under both mismatch policies.

The `store` notification router, a Host companion, waits for checkpoints.

A Script's limits come from `talk_load_options`' `talk_limits`, a zero field
taking its default from `limits.toml`. On both native and WASI targets, each
positive field is supported up to its conformance minimum in that Data File;
a larger or negative field is refused at load as `TALK_INVALID_VALUE`, before
the Script is compiled or registered. The Message Layer's `load` follows the
same profile and returns `invalid value`. Refusing an unsupported profile
leaves the Group able to load and run Scripts. A Delivery's `talk_limit_override`
tightens its Run's Fuel, allocation, MaxWait and MaxJoin; one that loosens is
refused `invalid value`, with the override on its `>` line. A Limit Fault
comes before the faulting instruction's charge, so none of it is made:

- **Its own limit first:** a call past the call depth, a `make-pattern` past
  the Text Pattern size and a Join Member past MaxJoin fault before anything
  else, through `error.LimitFault`.
- **Fuel and allocation:** every other instruction faults when its whole
  charge, dispatch's `clause` rate included, won't fit. A search's `unwind`
  is part of the charge of the instruction driving it, and an error is
  raised, with its record and its Join abandoned, before that charge. A
  Capability call checks its declared cost before the Host is called; one
  whose `Charge` is refused spends its own charge, and one whose result's
  conversion faults on allocation keeps its Fuel before the conversion.
  `store-var` checks its charge before it writes.
- **Persistent State:** a Run-ending `return`, `pass` or `veto` measures the
  Script without the Run before its charge, and a suspension measures it with
  the Run after its charge, abandoning the call it waits on.

The fault's record names the Script Variables its rollback changes back, and
every Script's Segment keeps a base for it. MaxWait bounds a Run's waiting
calls, and a Script's `send` to a mailbox at its depth raises `mailbox full`.
A Host Delivery to a Script whose mailbox and queued Deliveries reach its
depth is refused `TALK_ERR_MAILBOX_FULL`.

`talk_pump_options` gives a Pump a Fuel Slice per Script and a Fuel cap for
the Group. Each Script's slice is what its debt leaves of it, and an overrun
is carried to its next Pump as debt. Before each instruction, a Run whose
Script has spent its slice, or whose Group has spent its cap, is preempted:
its Stretch ends with a `preempt` record, it stays at the head of its
Script's work, and a later Pump continues it with `seg … continue`, in the
same Segment. A Run preempted in a clause's patterns or Guard goes on with
its dispatch from that clause. A Script that has spent its slice takes no
more turns, a spent cap ends the turns, and either leaves the Pump `sliced`.
A preempted Run's Persistent State counts its catch dispatches: each context
and Error, its activation, the owner's own stack and the frames it holds
aside. Its pending cleanup has no size of its own, as chapter 8's Pending
cleanup state gives it: an Error-mode cleanup counts its Error's context and
the failed continuation's operand stack, which keeps the failed
instruction's operands; an acceptance its context and activation; a transfer
its pending arguments. A cancellation's cleanup drops the dispatch contexts
it interrupted and keeps only the frames and activations its remaining
`finally` blocks need, their stacks cut to the iterator prefixes those
blocks use. Dispatch's `clause` rate is paid at the clause's first instruction,
with that instruction's fixed rate for a clause with no patterns or Guard, or
alone for one that parks or is dropped; parking and dropping measure
Persistent State.

`talk_script_cancel_run` cancels a Run by its id, and the C-only
`talk_cancel_delivery` a Request or Decision by its delivery id, both as Host
Inputs; `, replacing` cancels through the same path. Where the cancel lands, a
preempted Run, in the middle of its Segment, has its scopes abandoned and its
Segment and participant rolled back, and its cleanup becomes a Segment of its
own. Every cancelled Run's pending calls and Join Members are abandoned, and
named in `abandon` records after its first cleanup Stretch. This includes a
suspending Call cancelled at its starting callback, before any suspension
Segment commits. Its `finally` blocks run once, innermost first, in its Script's turn, a queued Run keeping
its place, on the Cleanup Budget in place of Fuel per Run. An error escaping
cleanup ends it with `cleanup-failed … code=`, keeping its writes; a limit
ends it with `cleanup-failed … limit=`, rolling them back. Either way the Run
ends `cancelled`, and its cleanup Segment's participant commits unless a limit
ended it. A Delivery still in a mailbox is removed and reported as a `run`
with no Run, and its Decision settles undecided.

`talk_script_stop`, `talk_script_cancel_run` and `talk_script_rewind_run`
made between Pumps wait for the next one's drain. Made during a Pump, from
a Host function, they land at that Host crossing (chapter 9, Threads and the
input queue): right after the crossing's `call` or `prop` records, and its
`scope` record, and before its result is converted, which isn't charged.
What a Host function writes while it runs, such as a refused `set-parent`,
is held and written there too, in the order made, and a Stop, cancellation
or Rewind of the running Run ends its Stretch there: a Stop with
`end=stop`, a cancellation rolling the Segment back before its cleanup, and
a Rewind with `end=rewind`. Anything else made during a Pump lands between
turns, or at its end.

`talk_script_rewind_run` is RewindRun (ADR 0068): a Run still in its first
Segment, or parked at dispatch, ends as if it had never started. Its Segment
rolls back as at a Limit Fault, its Script Variables too unless it was
parked, its scopes are abandoned and its participant rolled back, and its
message goes back to the head of its Script's mailbox as it left it, its ids,
its place on its Message Path and an open Decision kept. Its Fuel stays in
its Script's counters. The Pump it lands in returns `rewound`, so the Host can Reload before the
message is dispatched again. When a callback rewinds another Run, the active
callback and its Segment finalization finish before that Pump returns, including
any deferred lifecycle cleanup. One that lands on a
Run that has passed a Suspension Point, or has ended, writes `note … kind=
not-rewindable` and does nothing.

`talk_group_call` calls a Function Value from the Host, the Host Input
`call-value`: a Request to its Home Script, whose Run writes `fn=` in place
of a Handler. A value whose Home Script is stopped, or that is stale, writes
`note d<n> kind=function-gone` when the queue is drained and runs nothing,
and one called with the wrong number of arguments raises `wrong arity` at
its function's first instruction, charging nothing.

`talk_script_stop` queues Stop Script, which is sticky; disposing a Script's
owner stops it within that input, with reason `owner disposed`. Each of the
Script's Runs, in start order, has its scopes abandoned and its participant
rolled back, and one in the middle of its Segment its Script Variables too;
then they are discarded with no `finally` and the mailbox is dropped. Senders
waiting on them get `send failed`, reason `stopped`. The Script's named Grants
are released with reason `stop`, in code-point order, then its `stopped`
record lists what was discarded, dropped and abandoned, the pending calls in
call id order, and its open Decisions settle undecided, `cancelled`. A
Delivery that reaches a stopped Script later is
dropped with another `stopped` record, a Script's `send` to it is dropped, and
a Broadcast leaves it out, as it does a Script a Stop or disposal queued ahead
of it will stop. A Group whose Scripts are all stopped pumps as `stopped`.

## Values and ownership

`talk.h` implements Nothing, Bool, Text, Int, Uint, FromFloat, Dec, Quantity,
CivilDate, ParseCivilDate, Instant, Bytes, List, Map and Range, and their value
and Decimal accessors. Number text is checked before arithmetic, including
linear rejection of oversized inputs. Arithmetic uses native Zig integers
and arbitrary-precision rational intermediates, with one half-even rounding
and the operator's ideal exponent. Addition, subtraction, multiplication,
division, `div`, `mod` and `^` are available internally, and `^` is also
`power(x, y)`. An integer exponent of any size gives the exact power, rounded
once; any other exponent gives the correctly rounded result with trailing
zeros dropped. Noninteger powers bound e^(y ln x) in fixed point and add
precision until both bounds round alike, after exact results and ties are
found directly. Results that overflow or round to zero are settled from their
magnitude, so huge exponents stay cheap.

Each returned value owns one reference. Constructors copy byte input and
retain child values; text and map keys become NFC. Map keys preserve insertion
order and refuse NFC duplicates. Container writes rebind the root, preserving
aliases and preventing cycles, including insertion of the previous root into
its replacement. Map writes validate and normalise only the incoming key.
Maps of at most 64 entries use flat storage; larger Maps share immutable blocks
of 32 ordered entries. A write copies the directory and its changed block,
including that block's key bytes, while retaining the other blocks. Indexed
entry access is constant-time; key lookup remains linear. Deletion rebuilds
ordered storage inside the value module without repeating key validation.
Storage sharing does not change logical sizes, Fuel or the Save format. Final
block release queues children through the allocation-free Value teardown.
The [Map storage measurements](../../bench/results/2026-10-15-zig-map-storage.md)
record scaling, retained-version memory and the small-Map regression checks.
Every node remembers its allocator, so Zig tests use the leak-detecting test
allocator. C values use the
process allocator; a Group's own values use its Group allocator. Handles require
Host synchronization when shared across threads.

Number, Boolean and Nothing construction specializes the active tag before
allocating a node. Each node initializes every header and its active payload
through its owning allocator, without `Allocator.create`'s whole-node poison
fill. Number and Boolean construction also avoid copying the full Data union;
Zig still zero-fills Nothing's inactive union storage. The Value layout,
inline Quantity and Group cache are unchanged. The
[constructor measurements](../../bench/results/2026-10-14-zig-scalar-constructors.md)
record safe native assembly, paired timings and allocation probes.

Text and Decimal accessor pointers borrow their value. Byte accessors copy
out, and display, encoding and canonical Unit strings return an owned
`talk_owned_bytes`, released with `talk_owned_bytes_release`. Child accessors
return owned references; the header documents each lifetime. Encoding refuses
Function Values at any depth and resolves Host Objects through the decoder's
callback. Decoding accepts only the forms the encoder writes: a decoded value
must re-encode to the number, tag and payload the input spelled, so `{"$dec":
"3"}`, `1.0` and a non-UTC or non-shortest `$instant` are refused. JSON white
space and string escapes are syntax, and text is normalised to NFC. Pattern
decoding reparses canonical source; compilation and matching belong to the
front end.

Values nest without a Core cap, as in the Go and TS Cores: only the Allocation
Budget, the Persistent State cap and the Group's physical cap bound them, each
with its specified fault (#871). Every container and Function Value keeps its
contents' logical size as it is built, so measuring one never walks it.
Equality and ordering honor `ignoring case` at every text value, including
texts inside lists, map values and Function captures. Map keys and Text Pattern
sources remain exact. Comparison Fuel counts Characters of the simple foldings,
and each comparison folds a shared text node once while charging every logical
occurrence. Membership and Destructuring literal tests use the same comparison
mode.

Equality, ordering, display, both JSON encodings, decoding, snapshots, Shape
scans and teardown keep their pending work on heap stacks, so a value nested
100,000 deep runs on a 256 KiB native stack. The `json` Library's source
recurses on nesting, so a deep value there meets the call-depth Limit Fault;
[`limits/deep-values`](../../corpus/limits/deep-values/case.trace) shows both.

## Corpus runner

`zig build corpus -- [--list] [case directory ...]` discovers
all case kinds and runs encoding cases through `talk.h`, and Disassembly
Cases through the front end, since `talk.h` exposes no compiled unit, with the
Go runner's messages. It holds each `case.toml` to the language and Cost Model versions
and to the tables and keys that [corpus.toml](../../spec/data/corpus.toml)
allows for its kind. Selectors may name a category or a case, with or without
a `corpus/` prefix. `--list` prints each case's kind and whether it is
supported or deferred, and a failure prints the first divergent line and the
command that reproduces it. [The case setup reader](src/corpus/case.zig)
builds each Script's Grants, with their modes and arities, from the case's
Operation Declarations and Standard Capabilities. Trace Cases replay through
`talk.h` alone ([`talk_replay.zig`](src/corpus/talk_replay.zig)) when they need
only loads, Deliveries and Requests, Pumps, `vars`, `counters`, Host Object
inputs, the Grants it makes and its Libraries, compiled with its Operations as
their Grant declarations, and `reload`, `extend` and `replace-library`, whose
`source` it reads with its scalars as written, compiling a replacement against
the version of each Library it compiled last. It keeps each `save` by its id,
restores with the Libraries it compiled last but those `withheld`, the
Grants it loaded each Script with but those `unbound`, and every Host Object
but those `disposed`, and goes on with the restored Group's handles.

A Stop, CancelRun, RewindRun or `set-parent` written inside a Pump's output
is made from the Host function of the crossing whose `call` or `prop` record
it follows, counting from the Pump, so that it lands there. A `call-value`
calls the Function Value a Request earlier gave the Host.

Every Trace Case runs twice: as written, and with a save and restore between
each pair of Pumps (chapter 11, Save and restore replays), which must give
the same Trace. After each Pump that another follows, the runner saves; a
save refused with `effects pending` leaves the original Group going on.
Otherwise it restores with every Library, Grant and Host Object given back,
adopts each pending call, and goes on in the restored Group. The lines it
causes are left out of the Trace, the `settle` lines its adoptions make when
the next Pump drains them included, and the case's own save ids keep the
numbers they would have had. It skips the round trip where the case saves,
restores or settles next itself, before any later `call-value`, whose
Function Value the original Group made, and where a later `answer` or `fail`
is for a call the save doesn't hold, whose handle belongs to the original
Group. A
failure in this replay says so. Encoding cases that register Host Objects are
not supported.

With no selection the runner runs the whole Corpus, as CI does, and every
case must pass: a failing or unsupported case fails the run. There is no
passing list. Expected corpus bytes are never rewritten. The runner's replay backend says which cases it
supports and replays each from its directory;
[Trace parsing](src/corpus/trace.zig) uses generated record/key metadata,
including filled input keys and optional ids, for the comparison.

## Fuzz worker

`zig build fuzzworker` builds `talk-fuzzworker`, which the differential
fuzzer runs with `--zig-runner` ([the fuzzer](../../tooling/fuzz/README.md#dual-core-mode)).
It reads a Fuzz Case's setup as the Corpus runner reads case.toml, with each
inline source under its `source` name, and takes the case's Host Inputs one
at a time through the same replay Host, resolving each symbolic reference
against its own Trace as the fuzzer's `runner.ts` does. A bare `> save` is
kept under the id the Core gives it. It answers with the Trace, the action and
record counts and the Group Fingerprints around each input.

## Regenerating tables

[`tools/zig/generate.ts`](../../tools/zig/generate.ts) writes the catalogues
and compiled Cost Model terms from `spec/data/*.toml`, and
[`tools/unicode/generate.ts`](../../tools/unicode/generate.ts) writes
`unicode.zig` and its `UNICODE-LICENSE.txt` from the pinned UCD. Neither reads
another Core.

```sh
bun run zig:generate        # the catalogues
bun run unicode:generate    # the Unicode table, for every Core
```

The catalogues include `grammar.toml`'s word lists, which the parser reads,
and `stdlib.toml`'s Built-ins and stdlib Library exports, which the checker
reads.
`bun run check` holds both to their sources and fails on a stale table. The
emitters write `zig fmt`'s canonical form themselves, so the check needs no Zig
toolchain; CI's `zig fmt --check` holds them to it.

Every Pump enforces a nondecreasing Clock before draining queued inputs or
changing accounting. Equal readings are allowed, and a new Group may begin
before the Unix epoch. A restored Group starts with its saved Clock as the
lower bound. The C API and Message Layer return `clock backwards` for a
decrease. Without `crossing-trace-v1`, the Message Layer retains refusal Trace
for its next successful reply; opted-in Hosts receive available records on the
error reply itself. Early Load refusals record the attempted input and refusal.
