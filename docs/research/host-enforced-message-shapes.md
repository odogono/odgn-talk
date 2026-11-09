# Host-enforced message Shapes at admission

Answers [#2057](https://github.com/odogono/odgn-talk/issues/2057), part of [#2054](https://github.com/odogono/odgn-talk/issues/2054). The issue asks whether a Host should be able to opt in to the Core checking each message against declared message Shapes, and refusing a bad one before any Run starts, as the Capability boundary already does for arguments. [ADR 0171](../adr/0171-a-handler-clause-may-require-a-shape-of-a-parameter.md) gave Clause Shapes Guard semantics, and it left contract semantics, where a mismatch is an error that blames the sender, for this issue to settle. This note answers the issue's six questions and recommends what to do. It was read and measured at `05dfcfb3`. The throwaway benchmark code is reproduced at the [end](#reproducing-the-measurements), and nothing from it is left in the tree.

## Summary

- **Clause Shapes already cover most of the issue's case.** A Script can require a Shape in a Handler head ([chapter 5](../../spec/05-handlers-messages-and-scheduling.md#handlers-and-dispatch), ADR 0171). The Trace says which clause failed and why ([chapter 11](../../spec/11-the-trace-and-conformance.md#clause-mismatches), [ADR 0172](../adr/0172-the-trace-explains-why-no-handler-clause-matched.md)). The LSP shows a Script's message interface, and the `send-fits-no-clause` Lint warns about a literal `send` that no clause takes (#2147, [tooling README](../../tooling/stack/README.md)).
- **An admission check would add no safety.** The Core checks every Capability argument at the boundary, uncharged, whatever a Script checked earlier ([chapter 9, Shapes](../../spec/09-embedding.md#shapes)). So a malformed message can only make its own receiving Run fail, within that Script's Fuel and limits. Three things are left that only a Host-side check gives:
  - It refuses the message before any Run starts.
  - It blames the sender of a `send` that doesn't wait.
  - It covers a Script whose author wrote no Clause Shapes.
- **Opt-in granularity:** only a Group-wide table, keyed by Selector, holds together with the Message Path. Shapes per Script or per kind of Script don't fit climbing, the Fallback Handler or Broadcast. A Core has no notion of a kind of Script anyway: that is a Host Manifest label. Whatever changes admission must be in the Group Fingerprint, since it changes behaviour.
- **Refusal:** a Host Delivery would be refused at the call, as `MailboxFull` is, with a Host Error and a `refused` Trace record. A Script's `send` would raise `wrong kind` at the `send`, as `mailbox full` does, whether or not it waits.
- **Charging:** the check would be uncharged in both cases. A Host Delivery has no Run to charge, and the Capability boundary sets the precedent for a `send`.
- **Script-to-Script sends would use only the declared table, never the receiver's Clause Shapes.** A Clause Shape mismatch means "not this clause". The message then goes to the next clause, the Fallback Handler or the next Script on the path, so it is not a refusal.
- **Saves and Reload:** messages already admitted stay, because admission is checked once. A changed table changes the Group Fingerprint, so a restore under the changed table is a mismatch, which the Host's policy then handles.
- **Cost per check is small but not negligible against a minimal Delivery.** On an Apple M5, the pre-decoded Capability-boundary check costs:
  - Zig: 0.13 µs for a three-field pointer event and 0.37 µs for a two-line invoice. One Delivery and one Pump of an empty Handler costs 0.85 µs.
  - TS: 0.34 µs and 1.0 µs, against 1.97 µs for the same Delivery and Pump.

  These are proxies, measured with no prototype (see [Cost on each Core](#cost-on-each-core)).
- **Surprise: a Clause Shape costs ~10× the boundary check.** It decodes and validates its Shape data on every test. That is 38 Fuel for the pointer Shape and 64 Fuel for the invoice Shape, per message, on both Cores, plus 1.1–2.4 µs on Zig.
- **Recommendation: close #2057 as not worth it now.** The guarantee is ergonomic, not a safety property, and #2059 has already delivered most of the diagnostics. It would cost a new Group input on every embedding surface, a Group Fingerprint change, new refusal and error rules in five Spec chapters, and corpus setup. No Host has asked for it. If a Host does, the [proposed decision](#if-it-is-reopened-the-adrs-decision) below is ready. Two small follow-ups are worth filing on their own: a Host-side Shape check on the embedding interface, and caching decoded Clause Shapes.

## What exists today

### The Capability boundary

- **Arguments:** the Core checks each argument against its Shape before the Host function runs. A mismatch raises `wrong kind` (or `not encodable`) in the Script, the Host function never runs, and nothing is charged ([chapter 9, Shapes](../../spec/09-embedding.md#shapes); [chapter 6, Errors from Capabilities](../../spec/06-errors-and-limits.md#errors-from-capabilities)).
- **Results:** a result that breaks its Shape is the Host's fault, and the call ends as `host error` (chapter 9).
- **In the Cores:** both check a Shape that was decoded once, when the Host defined the Capability:
  - TS: `mismatch` ([`capabilities.ts:156`](../../impl/ts/src/capabilities.ts)), called per argument at [`machine.ts:5033`](../../impl/ts/src/machine.ts).
  - Zig: `checkValue` ([`capabilities.zig:392`](../../impl/zig/src/machine/capabilities.zig)), called at [`machine.zig:11073`](../../impl/zig/src/machine/machine.zig), which sets `m.uncharged` on a mismatch.
- **Messages are unchecked:** "Messages have Shapes only in the Host Manifest, for tooling. The Core never checks a Delivery against them" (chapter 9).

### Script-side checks

- **The Built-ins:** `conforms`, `check` and `explain` use the same acceptance under the Script's own budgets ([chapter 7, Shape checks](../../spec/07-libraries-and-the-standard-library.md#shape-checks), [ADR 0080](../adr/0080-scripts-check-shapes-through-built-ins.md)). Each charges `4 + scanned` Fuel, and `scanned` includes validating the Shape definition ([`costs.toml`](../../spec/data/costs.toml), `builtin.conforms`).
- **Each call decodes the Shape data again:**
  - TS: `decodeShape(y!)` in the Built-in ([`operations.ts:2443-2462`](../../impl/ts/src/operations.ts)), then `shapeDiagnostics` ([`capabilities.ts:595`](../../impl/ts/src/capabilities.ts)).
  - Zig: `shape_check.run` ([`builtins.zig:259`](../../impl/zig/src/machine/builtins.zig)).
- **Clause Shapes:** `on handle inv is an Invoice` lowers to exactly what the Guard `where inv is an Invoice` lowers to, which is a `conforms` call. It is charged to the receiving Run. A mismatch skips the clause, then dispatch tries the Fallback Handler, and then the message climbs (chapter 5, ADR 0171).
- **Explanations:** when no named clause matched, the Trace's `run` record carries `mismatches`, with what `explain` gives for the failing argument. It is uncharged and written only while tracing (ADR 0172). Reports to the Host don't carry it.

### Where message Shapes live

- **In the Host Manifest:** message Shapes appear only there, as `messages`, each with a name (a Selector), argument Shapes, receiving kinds and documentation ([chapter 9](../../spec/09-embedding.md#the-host-manifest-format); [chapter 12](../../spec/12-sessions-and-tooling.md#the-host-manifest); [ADR 0028](../adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).
- **Separate from any Group:** `exportManifest(ManifestSpec)` is a pure function of its definitions, with no Group behind it:
  - TS: `MessageDecl` ([`talk.ts:1054`](../../spec/embedding/talk.ts)).
  - Zig: `talk_export_manifest` ([`talk.zig:1935`](../../impl/zig/src/talk.zig)).
  - Go: `ExportManifest` ([`talk.go:1494`](../../spec/embedding/talk.go)).

  Nothing in `GroupOptions`, `LoadOptions` or the Message Layer's group and load messages carries message Shapes today ([`talk.ts:658-751`](../../spec/embedding/talk.ts)).
- **The Core never reads it:** "a stale manifest can only mislead tooling" (chapters 9 and 12).
- **No Host-side check:** a Host can build Shapes, but it can't check a value against one. `Shape` is an opaque branded type in TS ([`talk.ts:204`](../../spec/embedding/talk.ts)), and no `conforms` is exported to Hosts. So a Host that wants to check its own Deliveries today would have to re-implement the acceptance rules.

### Admission today

- **Host Deliveries:** a Delivery is refused at the call, before it gets a delivery id, for:
  - a bad Selector or a loosening limit override, as `invalid value`;
  - a full mailbox in the Script it routes to at the call, as `MailboxFull`.

  The refusal writes a `refused` Trace record with only a `code` ([chapter 9, Deliveries](../../spec/09-embedding.md#deliveries); [chapter 11](../../spec/11-the-trace-and-conformance.md#what-is-recorded-and-when), "A Host Input refused at the call"). In TS this is `queueDelivery` ([`group.ts:4813-4880`](../../impl/ts/src/group.ts)), and in Zig it is `queue` ([`talk.zig:1211-1229`](../../impl/zig/src/talk.zig)).
- **Script sends:** a Script's `send` raises errors at the `send`, before anything is sent: `bad message name`, `object gone`, and `mailbox full`, even for a `send` that doesn't wait ([chapter 5, Sending](../../spec/05-handlers-messages-and-scheduling.md#sending)). The mailbox check is at TS [`group.ts:4499`](../../impl/ts/src/group.ts) and Zig [`machine.zig:5549`](../../impl/zig/src/machine/machine.zig).
- **Admission is checked once:** "a Delivery the Host was told is accepted is never lost" (chapter 9). A message that moves with its object, or that a Rewind puts back, is not admitted again ([chapter 5, The Message Path](../../spec/05-handlers-messages-and-scheduling.md#the-message-path)). Climbs still check depth.

## What a Host-side check would guarantee that Clause Shapes don't

The issue's motivation is "this Script only ever sees well-formed events". Set against what exists:

1. **Not safety.** The Host and every other Script are already protected:
   - Each Capability call re-checks its arguments, so a malformed message can't push bad data into the Host.
   - A Script's Runs are bounded by its own Fuel and limits ([chapter 6, Limits](../../spec/06-errors-and-limits.md#limits)).

   What a bad message can do is make the receiving Run end `errored` (say, adding text to a number) or `unhandled`. That stays in the Script.
2. **Refusing before any Run starts.** With Clause Shapes, a mismatching message still starts a Run. The Run pays for dispatch (38–64 Fuel per Clause Shape in the measurements below), ends `unhandled` or reaches the Fallback Handler, and climbs. An admission check would start nothing.
   - This matters to a Host whose end users' Scripts receive high-rate input, where a misbehaving sender could burn the receiver's Fuel.
   - It is a weak argument where the Host is the sender, since the Host already decides what it delivers.
3. **Blaming the sender.** Today:
   - A Host Request whose message no clause takes rejects with `send failed`, reason `unhandled` (chapter 6).
   - A Script's `send … and wait` gets the same.
   - A Script's plain `send` gets nothing. The receiver's Trace shows why, but the sender's code is never told.

   Of the three gains, only the third, an error at a plain `send`, needs a Core change.
4. **Not trusting the Script author.** Clause Shapes protect only a Script whose author wrote them. A Host check covers every Script. The protection is from the Script's own confusion, though, not from harm to anything else (point 1).

Most messages that reach Scripts are Host Deliveries, and the Host builds them. Folio's frame and pointer messages are examples ([ADR 0095](../adr/0095-folio-delivers-a-frame-message-to-scripts-that-handle-it.md), [ADR 0145](../adr/0145-pointer-messages-carry-an-event-map.md)). So checking a Delivery against the Host's own declared Shapes mostly catches the Host's own bugs. That is the same fault the Capability boundary blames on the Host for a bad result.

The one path where a Host relays data it didn't build is a Remote Send. There the receiving Host gives the Exposed Script a `Script.Deliver` or `Script.Request` ([ADR 0153](../adr/0153-a-send-to-a-peer-is-a-remote-send-answered-like-an-operation.md)). Two things already protect it:

- The Exposed Script opted in through its own `peer` Grant (glossary), so its author can be expected to write Clause Shapes.
- The receiving Host's transport code can refuse a frame before delivering it.

## The questions

### Opt-in granularity, and the Group Fingerprint

The issue offers three granularities: per Group, per Script kind, and per message.

- **Per Script kind isn't something a Core knows.** A Host Manifest describes "one kind of Script" (glossary, Host Manifest), but the kind is a label in a tooling file. The Core sees only Scripts loaded by name, each with its Grants (`LoadOptions`, [`talk.ts:742`](../../spec/embedding/talk.ts)). The Core's nearest equivalent is per Script, given at Load beside the Grants.
- **Per Script fights the Message Path.** Admission happens once, at the call, against the Script the message routes to at that moment (chapter 9, Deliveries). After that, three cases have no Script to check against, or no sender to blame:
  - **Climbing:** an unhandled message climbs to the next Owning Script (chapter 5). If that Script declared other Shapes, the climb would need a second check, with no sender left to blame. The only possible outcome is the one a full mailbox at a climb has today: a `note` and `unhandled`.
  - **Moving:** a message whose object moves follows it to a new Owning Script without a new admission (chapter 5). It could arrive at a Script whose Shapes it breaks.
  - **Broadcast:** a Broadcast has no receiver at the call. Its recipients are chosen when it is drained (chapter 5, Broadcast). A per-Script check would have to drop recipients silently at drain.
- **A Group-wide table keyed by Selector avoids all three.** It is checked once at admission, and every Script on the path, every recipient and every later owner sees the same rule. This is "per message" in the issue's terms: each declared Selector opts in, and an undeclared one is unchecked. It matches how the Host Manifest's `messages` are keyed. A Host with several kinds of Script would merge their `messages`, and must refuse two kinds that declare different Shapes for one Selector. *Inferred:* no Host in the repo does this today. Folio's kinds share their message names.
- **It must be in the Group Fingerprint.** The Fingerprint covers "everything that must match for two Script Groups to run in lockstep" (glossary, Group Fingerprint). Two Groups with different tables refuse different inputs, so they diverge, and the table must be covered. To keep existing Fingerprints and saves stable, the key would appear only when the table isn't empty. The current layout is the fixed object `{"language", "costModel", "libraries", "scripts"}` ([chapter 9](../../spec/09-embedding.md#the-pump-and-the-group-fingerprint)).
- **A Host Manifest `description` or `examples` stays out of it,** as an Operation's documentation does today (chapter 9, Capabilities).

### Refusal: what the sender sees

- **A Host Delivery, Request, Decision or Broadcast** would be refused at the call, with no delivery id. This is the `MailboxFull` path in both Cores ([`group.ts:4875-4880`](../../impl/ts/src/group.ts); [`talk.zig:1225-1228`](../../impl/zig/src/talk.zig)).
  - **The code:** the Host error catalogue already uses `invalid value` for "a message name with a `:` that isn't a Selector with one argument per part". A mismatched argument would fit there as a third admission check of the same kind ([chapter 9, Host error catalogue](../../spec/09-embedding.md#host-error-catalogue)). A distinct code would let a Host tell a malformed end-user input from its own misuse. *Inferred:* a Host relaying Remote Sends needs that distinction, because the refusal must become the remote caller's `send failed`, not an exception in the receiving Host.
  - **The Trace:** the `refused` record holds only `code` ([chapter 11](../../spec/11-the-trace-and-conformance.md#core-output)). Making a case explain the mismatch would add a key carrying `explain`'s report, as ADR 0172 did for `run`.
  - **Parity:** the Host error's detail stays outside parity, as every Host error's does.
- **A Script's `send`, with or without `and wait`,** would raise at the `send`, before anything is sent, as `mailbox full` and `bad message name` do (chapter 5, Sending).
  - **Its fields:** `wrong kind` (or `not encodable`) with chapter 6's fields, plus `argument` and the message's `name`, as a Capability argument's error adds `capability` and `operation`.
  - **Why not a Trace entry only:** that would give no new guarantee. The receiver's Trace already explains a mismatch (ADR 0172). The point of the check is that the sender's code learns.
  - **What stays unchecked:** a Remote Send is a call to `peer`'s `post` or `call` (ADR 0153). It never reaches the local table, and the receiving Group's table checks it there.
- **The Fallback Handler never sees a refused message,** since it never enters a mailbox. A forwarding Fallback, `send (n) with ...a to logger` (chapter 5), is itself a sender and is checked.

### Charging

- **A Host Delivery is uncharged by necessity.** No Run exists yet, and admission work isn't Fuel, as the depth check isn't.
- **A Script's `send` should be uncharged too,** as the Capability boundary is.
  - Every existing Trace case keeps its Fuel.
  - No Cost Model row changes.
  - The check is bounded by the size of arguments the sender has already paid to build. *Inferred:* the deep scan for Function Values under `any` is the worst case, and the boundary already accepts that work uncharged.
- **Charging the sender was considered.** It would put a cost row on `send` that depends on a Host-declared table, so the same Script would cost different Fuel in different Hosts. Today only an Operation's own declared cost does that. ADR 0172 rejected charging for the same kind of reason: it would change the Fuel of existing cases.

### Script-to-Script sends and Clause Shapes

Admission should use only the declared table, never the receiving Script's Clause Shapes:

- A Clause Shape is a Guard (ADR 0171). Its mismatch means "not this clause". Dispatch then tries the next clause and the Fallback Handler, and the message climbs to a parent that may accept it. A message no clause of the first receiver takes is still a valid message.
- The receiver isn't fixed at the `send` for an object-addressed message (chapter 5, Message Path), so its clauses can't be consulted at the call.
- Taking the union of a Script's Clause Shapes as its interface would turn ADR 0171's Guards into contracts after the fact. Every Script with a catch-all clause or a Fallback would accept everything anyway.

So the receiver's Clause Shapes stay a Guard. A sender learns of a mismatch through `send failed` (with `and wait`), and a reader through the Trace's `mismatches`. Only a Host-declared table refuses at the `send`.

### Saves, Restore and Reload

- **Admitted messages stay admitted.** A message in a mailbox passed its check when it was admitted, and admission is never repeated (chapter 9, Deliveries). Rewinds and moves are not new admissions (chapter 5).
- **The table belongs with the Grants.** A save must restore with the same table, or save then restore would be observable ([chapter 10, The rule](../../spec/10-save-and-restore.md#the-rule)). The Host would hand it back to `Restore`, as it re-binds Grants. The Core folds it into the Group Fingerprint and compares it with the saved one ([chapter 10, Restoring](../../spec/10-save-and-restore.md#restoring), step 4).
- **A different table is a mismatch.** The Host's `Mismatch` policy decides:
  - `RejectMismatch` fails.
  - `VariablesOnly` drops every mailbox and Run.
  - `ReloadChanged` also falls back to variables-only, because only a code-identity mismatch gives a Partial Restore ([chapter 10, Partial Restore](../../spec/10-save-and-restore.md#partial-restore)).

  So the question "what happens to mailbox messages when the Shapes change" has no new answer. They are dropped through the existing mismatch path, or kept by refusing the restore. Dropping a whole Group's Runs for a Shape edit is heavy. A finer rule, re-checking each kept message against the new table, would break "a Delivery the Host was told is accepted is never lost".
- **The save format wouldn't change,** if the table is Host-supplied like Grants. The saved Group Fingerprint already captures it. *Inferred:* a Partial Restore would need the table in its list of non-code mismatches, which needs no format change either.
- **Reload, Extend and Library replacement don't touch the table,** because it belongs to the Group, not to a Script. A Group-wide table fixed at `newGroup` has no live-change question. A Host that wants a new table restores into a new Group.

### Carrying the Shapes into the Core

*Inferred from the interfaces, not prototyped:* every embedding surface already carries Shapes for Operation Declarations, so a table of `{name, args}` would be one new field on each:

- TS `GroupOptions` ([`talk.ts:658`](../../spec/embedding/talk.ts)), and `RestoreOptions`.
- The Zig C API's group creation and restore in [`talk.h`](../../impl/zig/include/talk.h).
- The Message Layer's group creation, in the Host Manifest's data model as Shapes already are there ([chapter 9, The message layer](../../spec/09-embedding.md#the-message-layer)).
- `@northtalk/ts/wasm` ([ADR 0097](../adr/0097-browser-hosts-may-run-the-zig-reactor-through-the-ts-embedding-api.md)).
- The Go embedding over the embedded Zig Core ([ADR 0117](../adr/0117-go-hosts-run-the-zig-core-and-the-go-core-is-retired.md)).
- The Elixir Host, after a new `reactor-v*` pin.

The Host Manifest would stay tooling-only. A Host would build both from the same `MessageDecl`s, as it builds Grants and the Manifest's `grants` from the same Capability today. The corpus's `case.toml` would gain the table as setup, as it carries Operation Declarations ([chapter 11, case.toml](../../spec/11-the-trace-and-conformance.md#casetoml)).

### Cost on each Core

**What was measured.** No prototype exists, so these are proxies:

1. **The Capability-boundary check alone.** This is the function an admission check would call, on a pre-decoded Shape and a pre-built value: TS `mismatch` and Zig `checkValue`. It is the closest proxy, since an admission check would decode the table once, at `newGroup`.
2. **The same check in place, at a Capability call (TS only).** It compares an immediate Operation whose argument Shape is `value` with the same Operation declaring the message Shape. The native Zig benchmark Host installs no Capability bindings ([`benchmarks.json`](../../bench/scripts/benchmarks.json), the `skip.zig` reasons).
3. **A Clause Shape on a `send … and wait` to `me`, on both Cores.** It compares `on handle m` with `on handle m is a Pointer` (or `is an Invoice`). This is what a Script pays today to guard itself, and it bounds a check done the Script-side way from above.

The baseline is one Delivery and one Pump of an empty Handler, the Benchmark Suite's `host/pump` Script.

**Shapes:**

- Pointer: `{kind: text, x: number, y: number}`, closed, three scalar fields.
- Invoice: `{type: text, amount: GBP, ref: optional text, lines: list of {sku: text, qty: number}}`, with 2 lines, and with 10 lines for the direct check.
- `any` over the 10-line invoice, the Function Value deep scan.

**Setup:** Apple M5 (arm64), Bun 1.4.4, Zig 0.17.1. The Zig Core was built `ReleaseSafe`, its shipping mode ([`build.zig`](../../impl/zig/build.zig)), and its end-to-end figures came through the Benchmark Suite's native Host ([`bench/zig/host.c`](../../bench/zig/host.c)). The direct checks are the best of 7 × 200,000 checks. The end-to-end figures are medians of 3 rounds of N = 1,500. TS runs varied by up to ±30% between rounds, so read them as orders of magnitude.

| Direct check, pre-decoded Shape | Zig (ReleaseSafe) | TS |
| --- | --- | --- |
| Pointer | 0.13 µs | 0.34 µs |
| Invoice, 2 lines | 0.37 µs | 1.02 µs |
| Invoice, 10 lines | 1.08 µs | 3.29 µs |
| `any`, invoice with 10 lines | 0.17 µs | 0.90 µs |
| *Baseline: one Delivery and Pump, empty Handler* | *0.85 µs* | *1.97 µs* |

| Per message, end to end | Zig | TS | Fuel, both Cores |
| --- | --- | --- | --- |
| `send … and wait` to `me`, no Clause Shape (pointer) | 1.13 µs | ~4 µs | 49 |
| + Clause Shape `is a Pointer` | +1.09 µs | +~3 µs | +38 |
| `send … and wait` to `me`, no Clause Shape (invoice) | 1.13 µs | ~4 µs | 58 |
| + Clause Shape `is an Invoice` | +2.41 µs | +~6 µs | +64 |
| Capability call, `value` argument → pointer Shape (TS only) | – | +0.5 µs | +0 |
| Capability call, `value` argument → invoice Shape (TS only) | – | +1.5–2.6 µs | +0 |

Fuel per message is the Run's total Fuel over N, rounded: 73,530 → 130,530 for the pointer, and 87,053 → 183,053 for the invoice, identical on both Cores. The Capability variants used identical Fuel (40,530 and 40,553), which confirms the boundary check is uncharged.

**Reading:**

- **Against a whole Delivery:** a pre-decoded admission check would add about 15% (pointer) to 45% (2-line invoice) to the cheapest possible Delivery and Pump on Zig, and about 17% to 50% on TS. Against any Handler that does real work, the share is far smaller. Nothing would change in Fuel.
- **Against the Script-side way:** the check would cost about a tenth of what a Clause Shape costs today. That is because the Script side decodes and validates the Shape data on every test (the [surprise](#surprises-and-notes) below).
- **TS's `mismatch` is ~2.5–3× slower than Zig's `checkValue` on map Shapes, and ~5× on the `any` scan.** It copies the path array at each step and builds a `Set` of keys for every map ([`capabilities.ts:156-262`](../../impl/ts/src/capabilities.ts)). That affects the Capability boundary today as well.

Cost is therefore not the obstacle. The size of the change is.

## Recommendation: close as not worth it now

**Close #2057**, and record on #2054 that contract semantics for messages are declined. The reasons:

1. **The guarantee is ergonomic, not a boundary.** The Capability boundary keeps the Host safe whatever a message holds. A bad message can hurt only its own Run, in its own Script, within its own limits.
2. **The diagnostics have shipped.** Clause Shapes, the Trace's `mismatches` (ADR 0172) and `send-fits-no-clause` (#2147) already show an author why a message wasn't handled, at run time and in the editor. The only thing left is an error at a plain `send`.
3. **The Hosts build their own messages.** For a Host Delivery, a Core check of Host-declared Shapes checks the Host's own output. The one untrusted path, the Remote Send, ends at an Exposed Script that opted in, and at a receiving Host that can refuse a frame in its own transport code.
4. **The change is wide.** It needs:
   - a new Group input on five embedding surfaces (TS, the Zig C API, the Message Layer, wasm, and Go over Zig), and an Elixir re-pin;
   - a Group Fingerprint key, and `Restore` re-supply rules;
   - a Host error, or a widened `invalid value`, and a new Script error at `send`;
   - a `refused` record key, and `case.toml` setup;
   - edits to chapters 5, 6, 9, 10 and 11 and the glossary (Group Fingerprint, Host Manifest's "The Core never does").

   The table would also fight the Message Path unless it is Group-wide, which makes it a Group protocol, a concept no Host has asked for.
5. **It can be added later without breaking anything.** It is opt-in, uncharged, and absent from the Fingerprint when empty, so nothing about existing Groups, saves or cases blocks a later ADR.

### If it is reopened: the ADR's decision

Should a Host need it, for example a multi-tenant server whose Exposed Scripts are written by end users, the decision these answers lead to is:

- **The table:** a Host may give `newGroup` (and `Restore`) a **message table**. It is a list of `{name, args}`, the Host Manifest's `messages` without their documentation or receiving kinds. A Selector appears in it at most once, and a Selector not in it is unchecked.
- **The Fingerprint:** the table is part of the Group Fingerprint, written only when it isn't empty, in the Host Manifest's data model and canonical order.
- **Host admission:** a Host Delivery, Request, Decision or Broadcast whose arguments break their Shapes is refused at the call, with no delivery id. The Host error is `invalid value`, or a new code if the Remote Send case needs one. The Trace writes the input, then `refused` with a key holding `explain`'s report.
- **Script admission:** a Script's `send` of a declared Selector checks its arguments at the `send`, before the mailbox depth check, and raises `wrong kind` or `not encodable` with `argument` and `name`, uncharged. This applies whether or not the `send` waits. A Command Call sent up the Message Path is a `send` here. A Remote Send isn't, since the receiving Group checks it.
- **Clause Shapes are unchanged:** they stay Guards (ADR 0171), and the table never reads them.
- **Admission is once:** climbs, moves and Rewinds aren't checked again. A restore with a different table is a Group Fingerprint mismatch, handled by the Host's existing policy.

### Follow-ups worth filing on their own

- **A Host-side Shape check.** The embedding interface could offer `conforms(value, shape)` and `explain(value, shape)`: pure, needing no Group, and with the same acceptance. A Host could then check what it delivers or relays in its own code, or in its own tests. That gives a Host most of the issue's guarantee with no Core state, no Fingerprint change and no Trace change. *Inferred:* it is a small addition to `talk.ts`, `talk.go` and `talk.h`, reusing `mismatch`, `shapeDiagnostics` and `checkValue`.
- **Cache decoded Clause Shapes.** A Clause Shape's data is a Constant, fixed at load, yet every test decodes and validates it again. A Core could cache the decoded Shape per Constant and still charge the Cost Model's `4 + scanned` exactly, as Fuel is a model, not a measurement ([ADR 0054](../adr/0054-benchmarks-live-outside-the-cores-and-only-advise-the-cost-model.md)). On Zig this would remove most of the 1.1–2.4 µs per message measured above. Whether the Fuel rate itself should drop is a Cost Model question.
- **TS `mismatch` allocations.** The path copies and per-map key `Set`s also slow the Capability boundary today.

## Surprises and notes

- **Clause Shapes are expensive.** One Clause Shape roughly doubles the Zig per-message cost of a minimal `send … and wait`, and triples it for the 2-line invoice: +1.09 and +2.41 µs on a 1.13 µs round trip. It costs 38–64 Fuel, against a 49–58 Fuel baseline.
  - **Why:** the Shape data is decoded and validated on every test, and `scanned` charges that validation each time ([`costs.toml`](../../spec/data/costs.toml), `builtin.conforms`).
  - **What the Spec says:** ADR 0171 says a Clause Shape "charges the same Fuel" as the Guard. That is accurate, but the ADR doesn't note that this Guard re-validates a constant Shape on every message.
- **"Delivery" is Host-only.** The glossary defines a Delivery as "one message the Host hands to a Script Group from outside", and the issue title speaks of Deliveries. Its Script-to-Script question is about `send`, which the glossary doesn't call a Delivery. The Cores do use the word internally for sends (Zig `newDelivery`, [`machine.zig:5573`](../../impl/zig/src/machine/machine.zig)). Any ADR should say "message" or "a Delivery or `send`".
- **The Core has no "kind of Script".** The issue's "per Script kind" has no Core counterpart. It exists only as the Host Manifest's `kind` field and file name.
- **The Host Manifest's argument Shapes are plural in chapter 9 and singular in ADR 0028.** Chapter 9 says "argument Shapes". ADR 0028 says "with its argument Shape". Chapter 9 is the current contract, so this is harmless.
- **ADR 0080 is stale.** It still says "This records an agreed design, not implemented support", but the Shape Built-ins shipped in #852 (see [script-shapes-and-mappings.md](script-shapes-and-mappings.md)).
- **No spec contradiction bears on the recommendation.** Chapters 5, 9, 10 and 11 agree on admission at the call, one-time admission, and refusal records.

## Reproducing the measurements

The throwaway files lived in the session scratchpad and are not in the tree.

**Scripts.** Each is a `.talk` file, run as `run n` with N = 1,500 and expected result 1,500. The invoice variant:

```talk
shape Line is {sku: text, qty: number}
shape Invoice is {type: text, amount: GBP, ref: optional text, lines: list of Line}

on run n
  put {type: "invoice", amount: 12 GBP, ref: "A-1", lines: [{sku: "a", qty: 1}, {sku: "b", qty: 2}]} into msg
  put 0 into total
  repeat for each i in 1..n
    send handle with msg to me and wait
    add it to total
  end repeat
  return total
end run

on handle m is an Invoice
  return 1
end handle
```

The other variants change this one:

- **No Clause Shape:** the Handler head is `on handle m`.
- **Pointer:** `shape Pointer is {kind: text, x: number, y: number}`, with `put {kind: "down", x: 120, y: 48} into msg`.
- **Capability call (TS):** the loop body is `ask host to take msg`, against an immediate Operation `take` whose `args` is `[shape.value]` or the message Shape, and which returns 1.

**Zig end to end:**

1. Build the Benchmark Suite's native Host: `bun bench/ts/src/measure-zig.ts <no-match> smoke` builds `.cache/bench-zig/host`.
2. Run `.cache/bench-zig/host <script> 1500 1500 0 10 0`.

**Zig direct check:** a `main` that builds the Shapes with `capabilities.Shape.map`, `listOf` and `quantityOf`, and the values with `value.map`, `list`, `text` and `quantity`, then times `capabilities.checkValue` in a loop. Build it from `impl/zig` with:

```sh
zig build-exe -OReleaseSafe -lc --dep talk -Mroot=bench.zig \
  --dep talk.h --dep inspect-reader -Mtalk=src/root.zig \
  -Mtalk.h=include/talk.h -Minspect-reader=../../spec/session/inspect-reader.talk
```

**TS:** a Bun script that imports `impl/ts/src/index.ts` and `mismatch` from `impl/ts/src/capabilities.ts`. It loads each Script into a fresh `newGroup`, then times `deliver` plus `pump` until the Run ends, and times `mismatch` directly in a loop.
