# Script Variable migration on source edits

Research for [#371](https://github.com/odogono/odgn-talk/issues/371), checked
2026-10-07 against repository revision `12a35fb`. This is a design recommendation,
not an accepted ADR or implemented behavior.

## Recommendation

Explore an explicit, general embedding operation that prepares migrated Script
Variables **before** stopping the old Script. Do not implement `on reloaded old`
as an ordinary message automatically delivered after Reload. That version cannot
preserve the live session when migration fails, and an ordinary Handler may
suspend or make irreversible effects. The existing replacement boundary already
validates prospective state before discarding old work; migration should extend
that boundary, rather than repair state after it. See [Reload](../../spec/10-save-and-restore.md#reload)
and [lifecycle ordering](../../spec/embedding/scoped-effects.md#automatic-abandonment).

The proposed contract below needs an ADR, normative specification and both Cores.
For the immediate list-to-map need, an explicitly invoked migration Handler can
already change a live Script Variable. Automatic migration for a complete
Playground edit also needs a decision about batching source replacement: today's
Apply is a sequence of Entries, not one source replacement.

## What exists today

- Reload loads and initialises new source, then optionally carries old values by
  matching declaration names. Removed names disappear; newly declared names keep
  their initial values; a matching name keeps its value regardless of Kind.
  It validates the carried Persistent State cap before stopping old Runs. The old
  values are the **prospective post-rollback bindings**, not provisional writes
  from a preempted Segment. [Chapter 10](../../spec/10-save-and-restore.md#carrying-variables-over),
  [TS replacement](../../impl/ts/src/group.ts),
  [Go preparation](../../impl/go/script_reload.go).
- Successful Reload discards every Run and mailbox message, abandons pending
  calls and live scopes, rolls back the current participant, then replaces code
  and variables together. No Script `finally` runs. A Function Value whose Home
  Script is replaced becomes stale, even with identical replacement source.
  Invalid source or oversized carried state leaves old work intact; fatal
  external cleanup failure can instead stop the Group, and completed cleanup
  cannot be undone. [Reload](../../spec/10-save-and-restore.md#reload),
  [reload tests](../../impl/ts/tests/reload.test.ts),
  [effect lifecycle](../../spec/embedding/scoped-effects.md).
- Session Entries with new names Extend and preserve Runs. A Handler, function
  or Constant redefinition Reloads. Redeclaring an existing Script Variable
  updates its initialiser in Session Source and runs `put e into x`, **without
  Reload**; omitting the initialiser assigns Nothing. Thus changing the starting
  value is currently an explicit reset, not a migration trigger.
  [Session declarations](../../spec/12-sessions-and-tooling.md#declarations),
  [TS Session Host](../../impl/ts/src/session/host.ts),
  [Go Session Host](../../impl/go/session/host.go).
- Playground Apply compares declaration text, enters changed declarations in tab
  order, and retries unsuccessful declarations while others load. One Apply can
  cause multiple Reloads with intermediate Session Sources, and some Entries may
  succeed while others fail. Removing or renaming an existing declaration needs a
  Restart. Apply with no changed declarations enters nothing.
  [ADR 0051](../adr/0051-the-playgrounds-script-tab-is-the-session-source.md),
  [Apply planning](../../tooling/playground/src/declarations.ts),
  [Apply execution](../../tooling/playground/src/session.ts).
- Initialisers are restricted to literals, prior Constants and Built-ins, and
  loading and initialisation are not charged. Arbitrary migration code cannot
  simply be placed in that uncharged execution path.
  [Load diagnostics](../../spec/02-grammar.md#load-time-diagnostics),
  [charging](../../spec/08-the-abstract-machine-and-the-cost-model.md#charging).

## Primary-source precedents

### Common Lisp

Class redefinition updates an existing instance by preserving same-name local
slots, then calls `update-instance-for-redefined-class` with the transformed
instance, added/discarded names and values of discarded bound slots. The old-values
argument is not a complete snapshot; retained values are on the current instance.
Updating occurs by the next slot access, at an implementation-dependent time.
With no change in accessible slots, whether updating occurs is also
implementation-dependent: an initialiser-only edit does not guarantee a hook.
[HyperSpec §4.3.6](https://www.lispworks.com/documentation/HyperSpec/Body/04_cf.htm),
[structure changes](https://www.lispworks.com/documentation/HyperSpec/Body/04_cfa.htm),
[update arguments](https://www.lispworks.com/documentation/HyperSpec/Body/04_cfb.htm).

The different-class hook receives a temporary old instance holding all prior slot
values plus the altered current instance. Its return is ignored. Neither hook's
documented algorithm promises rollback of a failing user migration. LispWorks
adds instance locking and warns that waiting for a process accessing that instance
can deadlock; this is implementation-specific, not an ANSI suspension contract.
[Different-class hook](https://www.lispworks.com/documentation/HyperSpec/Body/f_update.htm),
[redefinition hook](https://www.lispworks.com/documentation/HyperSpec/Body/f_upda_1.htm),
[LispWorks locking](https://www.lispworks.com/documentation/lw81/lw/lw-common-lisp-57.htm).

Inference: the issue's complete `old` map resembles different-class migration's
input, although its source-change trigger resembles class redefinition. It is a
NorthTalk design choice, rather than a direct copy of one Common Lisp contract.

### Erlang/OTP

`gen_server:code_change/3` belongs to an explicit advanced upgrade/downgrade. It
receives the old version, complete state and extra upgrade information, returning
`{ok, NewState}`. Advanced updates suspend affected processes around code and state
replacement; a suspended process handles system messages, not ordinary requests.
This is a controlled upgrade boundary, not an ordinary application message.
[Callback](https://www.erlang.org/doc/apps/stdlib/gen_server.html#c:code_change/3),
[release handling](https://www.erlang.org/doc/system/release_handling.html#update),
[sys change_code](https://www.erlang.org/doc/apps/stdlib/sys.html#change_code/5).

OTP 29.1.1 source installs new server state only on callback success. On a bad
return or caught exception, `sys` keeps the original state and reports an error;
the process remains suspended. That does not roll back already loaded code or
external effects made by the callback.
[gen_server source](https://github.com/erlang/otp/blob/OTP-29.1.1/lib/stdlib/src/gen_server.erl#L2456),
[sys source](https://github.com/erlang/otp/blob/OTP-29.1.1/lib/stdlib/src/sys.erl#L992).

Inference: whole old state plus a returned candidate gives a useful publication
boundary. NorthTalk needs stronger effect restrictions to promise that failed
preparation preserves the live session.

### Python reload as a caution

`importlib.reload` retains the module dictionary, overwrites redefined names and
leaves omitted names present. External references are not rebound, existing class
instances keep old definitions, and reload is not thread-safe.
[Python documentation](https://docs.python.org/3/library/importlib.html#importlib.reload).

Inference: distinguish the old-values input, which should retain removed names,
from live variables after migration, which should follow new declarations.

## Answers to the issue's questions

### Overlap with fix-and-continue

[#332](https://github.com/odogono/odgn-talk/issues/332) preserves and rewinds a
chosen Run onto edited code. #371 transforms retained Script Variables, and can
keep today's stop-and-reload rule for every Run. Neither requires the other.
They share the need to distinguish committed bindings from an active Segment's
provisional writes and to account for effects that Script rollback cannot undo.
See [Segment rollback](../../spec/06-errors-and-limits.md#limit-faults).

Do not initially combine them: a resumed frame may expect the old variable shape
even after a successful state migration. A future combined operation would need
an explicit order for rollback, migration and frame rebuilding, plus compatibility
rules for retained locals. This is a design inference from the two issue briefs.

### Trigger and old values

Recommendation: an explicit Host-selected migration policy on a whole-source
Reload, using migration code from the **new** source. Do not infer need from a
changed initialiser, changed Kind or source position. An unchanged initialiser
can hide a schema change; a changed one can merely change a fresh-load default.
Constants and Libraries can also change the expected shape. Scripts should use
a retained schema version or shape checks to make repeated migrations safe.

The input should be a map of **all** old Script Variables at the prospective
post-rollback boundary, including removed names and names being renamed. It must
be assembled before the normal by-name carry drops them. Do not infer a rename:
the author maps old keys to new declarations explicitly. Include keys whose value
is Nothing; missing keys and present Nothing values convey different facts.
Value Semantics make a map suitable for holding the old bindings without writes
through it altering the old Script. [Carry rules](../../spec/10-save-and-restore.md#carrying-variables-over),
[Value Semantics](../../spec/03-values.md#value-semantics).

Recommendation for the initial scope:

- Ordinary CarryVariables, ResetVariables, first Load and Extend retain their
  existing behavior. Migration is a distinct opt-in policy.
- An explicitly requested migration runs once per replacement attempt, even if
  the source text is identical; callers must not equate Reload with editor Apply.
- Library replacement and variables-only Restore do not implicitly run it.
  A later extension must stage every affected Script before publishing any and
  specify which Library version migration calls use. Full Restore must preserve
  save-then-restore unobservability, rather than rerun migration.

These are proposed boundaries, not current API options. Existing replacement and
restore obligations are in [chapter 10](../../spec/10-save-and-restore.md).

### Is it a Run?

Recommendation: a restricted preparation execution, using the Abstract Machine
and deterministic resource charges, rather than an ordinary mailbox Run. Reuse
instruction costs, source positions and diagnostics; specify its own bounded
Fuel and allocation allowance, accounting in lifetime counters on success and
failure, and Trace representation in the ADR. Failed attempts must not refund work.
Building the old-values map and returned state also needs defined resource costs.
[Existing limits](../../spec/06-errors-and-limits.md#limits),
[machine charging](../../spec/08-the-abstract-machine-and-the-cost-model.md#charging).

It must not suspend, deliver messages, call Capabilities, read or mutate Host
Object properties, or invoke old Function Values. Permit value computations and
new-source functions or Libraries subject to the same restrictions. Old Function
Values can be inspected as data or discarded; carrying them preserves the
existing stale-function rule. Nested Host Objects still have identity, so Value
Semantics alone does not make all computations free of external effects.
[Kinds and values](../../spec/03-values.md),
[function calls](../../spec/04-expressions-and-statements.md#calls),
[replacement staleness](../../spec/10-save-and-restore.md#carrying-variables-over).

These restrictions need transitive load checks and runtime checks for dynamic
calls, not just rejection of `wait` tokens. Existing non-suspending contexts are
precedents for suspension checks, but not for banning all effects.
[Recovery Catch rules](../../spec/02-grammar.md#load-time-diagnostics).

Reload is currently a synchronous worker call, whereas Runs progress in Pumps.
For a first proposal, use a finite preparation budget and execute to completion
or refusal within that worker call, without normal Fuel Slice preemption. This
is a new execution contract requiring explicit specification. If cancellable,
Pump-sliced migration is required instead, stage an asynchronous reload operation
and define gating of incoming messages, queued inputs and saves; do not quietly
run an ordinary Run inside today's synchronous Reload.
[Worker calls](../../spec/09-embedding.md#threads-and-the-input-queue),
[Pumps](../../spec/05-handlers-messages-and-scheduling.md#a-pump).

### Failure and publication

Proposed sequence:

1. Load and initialise the candidate source without touching the old Script.
2. Build the complete old-values map from prospective post-rollback bindings;
   build the candidate variables using existing initialisation and by-name carry.
3. Execute the migration against old values and the candidate view. Prefer a
   returned map of updates to newly declared Script Variables over arbitrary
   writes. A returned key must name a candidate Script Variable; unknown keys
   reject the attempt. Omitted keys retain the candidate's carried or initial value.
   A rename reads the removed key from `old` and returns its value under a new
   declared key; blindly returning the complete old map may therefore be invalid.
4. Validate the **final migrated** state against the Persistent State cap. Do not
   reject the transient carried candidate first: migration may shrink it. Bound
   temporary old/candidate/output values through the preparation allocation rules.
5. Only after preparation succeeds, perform the existing stop/abandon/rollback
   lifecycle, then publish the candidate. Preserve the existing fatal-cleanup
   failure behavior and reports.

An uncaught Error, limit exhaustion, forbidden operation or invalid return rejects
preparation and leaves old code, variables, Runs, pending calls and Session Source
available. Do not invoke `on error` on the live Script for a failed preparation:
that would mutate the state promised to be retained. Report the attempt, diagnostic
and charged work to the Host and Trace. Existing ordinary Errors do not roll back
Script writes, so ordinary Run semantics cannot provide this guarantee unaided.
[Errors and cancellation](../../spec/06-errors-and-limits.md),
[replacement boundary](../../spec/embedding/scoped-effects.md).

The spellings `on reloaded old`, a restricted function, and the embedding policy
remain design choices. If a Handler spelling is retained, its special preparation
semantics and collision with ordinary messages must be explicit; delivery of a
message named `reloaded` must not forge the replacement protocol.

### General Hosts and Session Hosts

Expose the same preparation contract through the embedding API and Message Layer.
Session Hosts should use it, rather than gaining a private migration rule. This
follows [ADR 0014](../adr/0014-a-session-is-an-ordinary-host.md), which makes sessions
ordinary Hosts, and keeps Trace/Transcript parity enforceable.

The Playground cannot deliver one migration against the complete edit through
today's per-declaration Apply. Worse, its existing variable redeclaration can
overwrite the old value before a later Handler redefinition Reloads. A migration
hook on Reload alone therefore does **not** solve the issue's main use case.
[Apply](../../tooling/playground/src/session.ts),
[variable redeclaration](../../impl/ts/src/session/host.ts).

Choose one of two deliberate delivery boundaries in the ADR:

- Keep incremental Apply and add explicit whole-source migration as a separate
  author action. Individual REPL redefinitions remain individual updates.
- Make an edited Script replacement one normative Session Command and have Apply
  use it. This revisits ADR 0051's rejected whole-source command, changes existing
  variable-reset and removal behavior, and requires Transcript replay on both Cores.

In either case, source and migration result must advance together after successful
preparation. Renames and removal can then use the old-values map without Restart,
but only in the chosen whole-source workflow. Do not promise that benefit from an
embedding hook alone.

## An explicit migration works today

For an existing `items` Script Variable containing `[10, 20]`, this declaration
adds a new Handler without resetting the variable. Entering `migrateItems` at the
prompt converts it and is safe to repeat:

```talk
on migrateItems
  if items is a list then
    put {first: item 1 of items, second: item 2 of items} into items
  end if
end migrateItems
```

This example uses a known two-item shape. It is an ordinary Run with the existing
error, effect and rollback rules, not the proposed atomic preparation contract.
It also does not remove declarations or change the fresh-load initialiser.
[Extend](../../spec/10-save-and-restore.md#extend-script),
[statement Entries](../../spec/12-sessions-and-tooling.md#statements-and-expressions).

## Delivery and acceptance before implementation

There is no specification commit or required implementation base in #371; it is
labelled research and currently asks for exploration. Do not treat this note as a
handoff to implement grammar or embedding changes.

An accepted ADR should settle triggering, migration syntax, returned-map contract,
missing migration definition behavior, forbidden effects, budgets and accounting,
worker execution, diagnostic/report fields, and the whole-source Session workflow.
It must explicitly revisit ADR 0051 if Apply changes. Then update chapters 2, 6,
8–12 and relevant grammar, costs, error, embedding and Trace Data Files, following
the [change-impact guide](../agents/spec-changes.md). Both Cores, Message Layer,
replay drivers and Session Transcript behavior need one shared contract.

Minimum acceptance cases should cover:

- List-to-map conversion preserving live contents, no-op already-migrated state,
  repeated attempts and identical-source replacement.
- Removed/renamed variables, new defaults, Nothing versus absent keys, unknown
  output keys and stale Function Values nested inside values.
- Preempted provisional writes excluded; suspended and queued old Runs kept on
  preparation failure and discarded only on successful replacement.
- Uncaught Error after partial preparation, forbidden effects through nested or
  dynamic calls, Fuel exhaustion and temporary/final size limits; oversized carry
  shrunk by migration must succeed if it fits the defined preparation budget.
- Disabled/revoked Grants, pending calls, lifecycle failure after successful
  preparation, preserved counters and deterministic Trace replay.
- Multi-declaration editor changes, migration code later in the tab, failed
  preparation preserving Session Source, removals/renames, no-op Apply and matching
  Go/TS Transcripts for the selected Session workflow.

## Verification of current behavior

At the revision named above, `bun install --frozen-lockfile` and
`bun run unicode:check` succeeded. The following existing tests passed; these
verify the baseline findings, not the proposed migration contract:

```sh
bun test impl/ts/tests/reload.test.ts impl/ts/tests/session.test.ts \
  impl/ts/tests/segment-effects.test.ts \
  tooling/playground/tests/declarations.test.ts \
  tooling/playground/tests/session.test.ts
# 138 passed, 0 failed

go -C impl/go test ./session \
  -run 'TestEntriesAndAtomicRedefinition|TestVariableReinitializationUsesEntryPositions' \
  -count=1
# passed
```

Two direct TS Session/Playground probes also confirmed:

- The explicit Handler above produces `{first: 10, second: 20}` from `[10, 20]`,
  and a second call retains that map.
- Applying an edit that changes `items = []` to `items = {}` and changes two
  existing Handlers produces two Reload Trace inputs. The old `[10, 20]` has
  already been reset to `{}` by the variable Entry before those Reloads.
