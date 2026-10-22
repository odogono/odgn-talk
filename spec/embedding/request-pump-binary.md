# Binary Request and Pump exchanges

**Status: accepted, with the fields envelope selected. The Zig Session and the
experimental Go adapter implement it behind negotiation. Go and C
publish the combined Host APIs; TS publishes them on both Cores with a
transferable browser codec; Elixir publishes them over its WASI reactor.** This is
[#1245](https://github.com/odogono/odgn-talk/issues/1245)'s contract, under
[ADR 0110](../../docs/adr/0110-request-and-pump-have-an-optional-binary-exchange.md).
It does not change the accepted [binary-frames-v1](binary-frames.md) contract.

The fields tables are generated from [`envelope.toml`](../data/envelope.toml).
Regenerate them and the four language catalogues with `bun run envelope:generate`.
Codecs retain their hand-written validation and reshaping; the catalogue changes
no wire bytes or negotiated versions.

## Negotiation and framing

<!-- generated: envelope.features -->

| Negotiated feature |
| --- |
| `request-pump-fields-v1` |
| `callbacks-fields-v1` |
| `settlements-fields-v1` |
| `load-fields-v1` |
| `queue-fields-v1` |

<!-- end -->

The exchange is negotiated as `request-pump-fields-v1`. Initial `hello` and its
reply are JSON. A Host must see its requested feature in the reply before
sending binary frames. The feature does not imply `binary-frames-v1`;
requesting it alongside `binary-frames-v1` is a protocol error. A later hello
cannot change the negotiated layout during the Session. The map layout,
`request-pump-map-v1`, was measured and retired
([#1334](https://github.com/odogono/odgn-talk/issues/1334)); a `hello` naming
it is refused like any unknown feature.

Binary frames begin with the bytes `4e 54 42 01` (ASCII `NTB`, version 1), then
the layout byte `01` (fields), then exactly one payload. Layout `00`, the
retired map layout, is refused like any other unknown layout.
JSON frames retain their ordinary JSON syntax. The binary prefix is not valid
JSON; dispatch must identify it before UTF-8 or JSON validation. Existing
transport lengths and the frame-size limit remain unchanged. Browser transports
may send a dedicated ArrayBuffer using transfer ownership; the codec does not
import WASM or browser transport code.

Only `request`, `call`, `pump`, `request-pump` and `call-pump`, the queued
inputs [`queue-fields-v1`](#queued-deliveries) adds, their ordinary
admission replies, and final Pump replies use binary frames. Every interim need,
its result answer, inline observation/admission and acknowledgement stays JSON,
except the callback needs and results that
[`callbacks-fields-v1`](#callback-needs-and-results) moves to binary.
A final Pump reply after a JSON continuation still uses the layout selected for
its original exchange. Store this choice per Group exchange, not globally per
last frame. Other messages retain JSON, including `cancel-correlated` below.

A malformed binary frame produces a JSON protocol error and changes no
admission, correlation or exchange state. Validate the entire frame before
executing it. Do not retry an admitted operation automatically after a transport
failure. Unknown tags, versions, layouts, extra bytes and unsupported messages
are refused. Existing open exchanges remain available for corrected frames.

## Payloads

Frames use the [binary Value items](binary-frames.md#items), including
shortest LEB128, ordered Maps, canonical numbers and NFC text. This experiment
corrects the older document's "Zero is always an integer item" rule: only zero
with no fractional digits uses the integer tag. `0.0`, `0.00` and `1.00` retain
their canonical decimal text because their scale is observable. Traverse with a
heap work stack rather than a fixed nesting limit. The experiment extends those tags as follows (without altering the accepted
`binary-frames-v1` format): `11` is a Core-error Map, with the same payload as
`07`; `12` is protocol text, UTF-8 without NFC normalization; `13` is a Function
metadata payload, a count followed by six or seven items in the existing JSON
Function payload order. Tags here are hexadecimal. Three-item Functions retain
`0f`. Unit identities in the seventh Function item are 32 raw bytes rather than
Base64 text. Every Map key is a tagged text item; a quantity's Unit is a tagged
text item. Protocol text is allowed only in protocol fields, never in a Value.
Validate Function payload types and negotiated metadata before resolving it.

An envelope is a message tag followed by a list item. Its elements
are positional; absence is Nothing, and list length must match exactly:

<!-- generated: envelope.messages -->

| Tag | Message | Direction | Fields in order |
| --- | --- | --- | --- |
| `01` | request | host-to-guest | ref, group, to, message |
| `02` | call | host-to-guest | ref, group, fn, args, limits |
| `03` | pump | host-to-guest | ref, group, now, fuelSlice, fuelCap |
| `04` | request-pump | host-to-guest | ref, group, token, to, message, now, fuelSlice, fuelCap |
| `05` | call-pump | host-to-guest | ref, group, token, fn, args, limits, now, fuelSlice, fuelCap |
| `0b` | load | host-to-guest | ref, group, name, source, grants, grantsAsUsed, owner, objects, limits, newGroup, refuseWorker |
| `81` | admission | guest-to-host | ref, delivery, err, abandoned, settled, trace |
| `82` | completion | guest-to-host | ref, delivery, token, state, nextDeadline, fuelUsed, reports, gone, err, abandoned, settled, trace |

<!-- end -->

`delivery` and `token` in Pump completion are Nothing for ordinary Pump.
Admission and Pump errors retain their ordinary error objects. `reports` is an
ordered list; a report's existing data model remains authoritative. Each specialized Report is a report tag followed by a list of these fields,
using Nothing for absent fields and retaining ordinary nested record shapes:

<!-- generated: envelope.reports -->

| Tag | Report | Direction | Fields in order |
| --- | --- | --- | --- |
| `01` | run end | guest-to-host | script, run, delivery, broadcast, handler, fallback, climbed, outcome, result, error, limit, effect, cleanupFailed, at, fuel, alloc |
| `02` | run started | guest-to-host | script, run, args, rootDelivery, parentRun, parentCall, delivery, selector, fn |
| `03` | run discarded | guest-to-host | script, run, reason, rootDelivery, parentRun, parentCall |
| `04` | run accounting | guest-to-host | script, run, fuel, state, rootDelivery, parentRun, parentCall |
| `05` | causal work | guest-to-host | rootDelivery, liveRuns, queuedMessages, discardedMessages |
| `06` | stop | guest-to-host | script, reason, discardedRuns, droppedMessages, pendingCalls |
| `07` | unhandled | guest-to-host | delivery, message, target |
| `08` | call failed | guest-to-host | script, call, operation, detail |
| `09` | effect failure | guest-to-host | script, run, grant, segment, phase, status, scope |
| `0a` | decided | guest-to-host | delivery, broadcast, verdict, vetoes, undecided |
| `0b` | host error | guest-to-host | code, detail |
| `0c` | charge result | guest-to-host | request, call, fuel, status |

<!-- end -->

A common-case-only prototype is not an acceptance result.

### Envelope fields

The Data File records each positional field's item kind and structural
`required` flag. A required field must be present; conditional rules (such as a
successful admission's delivery, a completion's state, and a failure's code)
remain in the codec and the ordinary admission checks. Optional fields are
Nothing. A Value position can carry Nothing.

`text` means protocol text (item `12`), `texts` a list of protocol texts,
`int` either integer sign, `uint` a nonnegative integer, `bool` a boolean item,
and `instant` an instant item. `value` and `values` use Value items and lists
of Values. `target`, `message`, `limits` and `err` retain the nested map shapes
described below. `record` is nested protocol data whose keys select Value
positions (for example a veto's `reason`); `reports` is the specialized tagged
Report list, and `settlements` is the positional settlement list. Neither is
an ordinary list of generic items. Token positivity and uniqueness remain
ordinary protocol checks.

A target is a map with `script` as protocol text or `object` as an Object Value.
A message has `name` as protocol text, `args` as a list of Values and optional
`limits`. Limits carry integer overrides by name; any other item is the
sentinel for an override the Host cannot represent, refused with the ordinary
record. Errors retain `kind`, and a Host error's `code` and `detail`, as
protocol text. Fuel options are optional integers; absent means zero.
A Report Value the Core cannot encode is Nothing.

<!-- generated: envelope.fields -->

| Field | Kinds by use |
| --- | --- |
| `abandoned` | `texts` |
| `alloc` | `uint` |
| `args` | `values` |
| `at` | `record` |
| `automatic` | `bool` |
| `broadcast` | `bool` (decide); `text` (run end, decided) |
| `call` | `text` |
| `capability` | `text` |
| `charged` | `uint` |
| `cleanupFailed` | `record` |
| `climbed` | `bool` |
| `code` | `text` |
| `coordinator` | `text` |
| `delivery` | `text` |
| `detail` | `text` |
| `discardedMessages` | `uint` |
| `discardedRuns` | `texts` |
| `droppedMessages` | `texts` |
| `effect` | `record` |
| `err` | `err` |
| `error` | `value` |
| `fallback` | `bool` |
| `fn` | `value` |
| `fuel` | `uint` (run end, run accounting, charge result); `int` (settlement) |
| `fuelCap` | `int` |
| `fuelLeft` | `uint` |
| `fuelSlice` | `int` |
| `fuelUsed` | `uint` |
| `gone` | `texts` |
| `grant` | `text` |
| `grants` | `record` (load); `texts` (effect) |
| `grantsAsUsed` | `bool` |
| `group` | `text` |
| `handler` | `text` |
| `limit` | `text` |
| `limits` | `limits` |
| `liveRuns` | `uint` |
| `message` | `message` (request, request-pump, deliver, broadcast, decide, unhandled); `text` (op-result, prop-result, settlement) |
| `mode` | `text` |
| `name` | `text` |
| `newGroup` | `record` |
| `nextDeadline` | `instant` |
| `now` | `instant` |
| `object` | `texts` |
| `objects` | `record` |
| `op` | `text` |
| `operation` | `text` (op); `record` (call failed) |
| `outcome` | `text` |
| `owner` | `record` |
| `parentCall` | `text` |
| `parentRun` | `text` |
| `pendingCalls` | `texts` |
| `phase` | `text` |
| `prop` | `text` |
| `queuedMessages` | `uint` |
| `reason` | `text` |
| `ref` | `int` |
| `refuseWorker` | `bool` |
| `reports` | `reports` |
| `request` | `text` |
| `result` | `value` |
| `rootDelivery` | `text` |
| `run` | `text` |
| `scope` | `text` |
| `script` | `text` |
| `segment` | `text` |
| `selector` | `value` (prop); `text` (run started) |
| `set` | `bool` |
| `settled` | `texts` |
| `settlements` | `settlements` |
| `source` | `text` |
| `state` | `text` |
| `status` | `text` |
| `target` | `value` |
| `to` | `target` |
| `token` | `uint` |
| `trace` | `texts` |
| `undecided` | `record` |
| `value` | `value` |
| `verdict` | `text` |
| `vetoes` | `record` |

<!-- end -->

A combined input's admission refusal is an admission reply, so a completion
with `delivery` is a Pump outcome. In a completion, each `reports` element is a Report tag
followed by its list. That element is not an item, so a reader uses the Report
table rather than skipping generically.

A structurally invalid envelope is a protocol error: an unknown message, field
or tag, a wrong list length, a zero or already-bound token, or bytes after the
item. So is a binary frame on a Session that has not negotiated its layout. A
well-formed input refused before execution gets its exchange's binary reply.
For example, an unknown Group, Script or Object, or an invalid Value, refuses
an admission. An unusable Clock or Fuel option refuses an ordinary Pump. A
combined input with an unusable Clock or Fuel option is admitted, and its Pump
is refused, as an ordinary Pump with those options would be.

## Callback needs and results

`callbacks-fields-v1` ([#1311](https://github.com/odogono/odgn-talk/issues/1311))
moves the `op`, `prop`, `effect` and `release` needs, and their results, to
the fields envelope. It is negotiated at `hello` independently of
`request-pump-fields-v1`: it doesn't need it, and it may accompany it. The
`trace` and `resolve` needs, `trace-result`, `resolve-result` and inline events
stay JSON. Once negotiated, every one of these four needs is a binary frame,
whatever the exchange's first frame was. The Host may answer in binary or with
the ordinary JSON result, which keeps compatibility checks possible. A binary
need's final reply keeps the layout of its exchange.

Frames use the `NTB` prefix and the fields layout byte `01`, then a message
tag and a positional list, as above:

<!-- generated: envelope.callbacks -->

| Tag | Message | Direction | Fields in order |
| --- | --- | --- | --- |
| `06` | op-result | host-to-guest | ref, group, outcome, value, code, message, charged |
| `07` | prop-result | host-to-guest | ref, group, outcome, value, code, message, charged |
| `08` | effect-result | host-to-guest | ref, group, status |
| `09` | release-result | host-to-guest | ref, group |
| `83` | op | guest-to-host | ref, call, script, run, segment, grant, capability, operation, mode, now, args, scope, automatic, fuelLeft, delivery, abandoned, settled, trace |
| `84` | prop | guest-to-host | ref, object, prop, set, value, op, selector, abandoned, settled, trace |
| `85` | effect | guest-to-host | ref, script, run, segment, grant, grants, coordinator, phase, now, abandoned, settled, trace |
| `86` | release | guest-to-host | ref, script, grant, reason, now, abandoned, settled, trace |

<!-- end -->

The fields keep their JSON meanings and the envelope item types above. Names,
ids, `mode`, `phase`, `reason`, `outcome`, `status` and `code` are protocol text;
`now` is an instant item; `args`, `value` and `selector` are Value items, and a
Value the Core can't encode is Nothing. `automatic` and `set` are booleans.
`object` is a list of the Object's kind and id as protocol text. `grants`,
`abandoned`, `settled` and `trace` are lists of protocol text. A need's three
notices come last and are Nothing when the JSON need would omit them.

Since Nothing is an absent field, two fields carry what presence carries in
JSON. A prop need's `set` is true for a setter, whose `value` may be Nothing.
A result's `outcome` names the JSON result key: `result`, `started`, `done`,
`fail`, `limit` or `hostError` for an op, and `value`, `ok`, `fail` or
`hostError` for a prop. `value` is the result, or a failure's Data; `code` and
the optional `message` are a failure's. The Host's `hostError` detail stays in
the Host. `charged` is an optional integer. An unknown outcome, a result that
doesn't match the open need, or another ref is a protocol error. As in JSON, a
Value that doesn't decode is a host error.

## Settlements carried by a Pump

`settlements-fields-v1` ([#1320](https://github.com/odogono/odgn-talk/issues/1320))
lets a Host queue its `answer` and `fail` inputs and send them inside the Pump
that would drain them, instead of one exchange each. It is negotiated at
`hello` together with `request-pump-fields-v1`; asked for without it, `hello`
is a protocol error. It adds one fields-layout input:

<!-- generated: envelope.settle-pump -->

| Tag | Message | Direction | Fields in order |
| --- | --- | --- | --- |
| `0a` | settle-pump | host-to-guest | ref, group, now, fuelSlice, fuelCap, settlements |

<!-- end -->

<!-- generated: envelope.settlement -->

| Field | Kind | Required |
| --- | --- | --- |
| call | `text` | true |
| outcome | `text` | true |
| value | `value` | false |
| fuel | `int` | false |
| code | `text` | false |
| message | `text` | false |

<!-- end -->

`settlements` is Nothing or a list. Each element is a positional list of
`call`, `outcome`, `value`, `fuel`, `code` and `message`. `outcome` is
`answer` or `fail`, as protocol text. An answer's `value` is its Value
(Nothing answers Nothing) and `fuel` its optional late cost. A failure's
`code` and optional `message` are protocol text and its `value` is its Data;
a failure with no `code` fails the call as broken, as a JSON `fail` without
`error` does.

The guest decodes every settlement and finds every call before applying any.
A structurally invalid settlement is a protocol error. A call the Group never
issued, or a Value that doesn't decode, refuses the whole input with its host
error, in Pump completion's layout, and applies none. Otherwise it applies the
settlements in order, exactly as the separate `answer` and `fail` inputs
would, then Pumps as `pump` does. A settle-pump refused before its Pump runs,
such as for an unusable Clock or while a worker is paused, applies none; the
Host keeps them queued.

Settlements are inputs, so they keep their place among the Host's other inputs.
A Host that sends any other input first sends its queued settlements, as
ordinary `answer` and `fail` inputs or a settle-pump, ahead of it.

## Load and deferred Group creation

`load-fields-v1` (#1329) independently negotiates the fields-layout `load`
input (tag `0b`). Its reply, including diagnostics and Trace, remains the
ordinary JSON Load reply. JSON `load` and `new-group` remain available.

`name` and `source` are protocol text: UTF-8 byte strings with a byte length,
without JSON escaping or normalization. `grants`, `grantsAsUsed`, `owner`,
`objects` and `limits` have their JSON Load meanings. The maps are protocol
maps; Object references keep their `{"$object":[kind,id]}` shape, with
protocol-text strings. Nothing omits an optional field. `refuseWorker` keeps
the inline-input worker refusal semantics.

An optional `newGroup` protocol map contains `name`, `trace` and `seed`, with
the meanings and defaults of `new-group`. Its handle is the outer `group`.
The guest validates the envelope before creating the Group. An existing handle
is refused as `name reused`; it never replaces that Group. Creation precedes
the ordinary Load, and a refused Load leaves the newly created Group available
for a later Load. Restores and open exchanges keep their ordinary exclusion
rules. The Group must already exist when `newGroup` is absent.

A Host may reserve a handle locally and defer guest creation until its first
Group operation. A first Load carries `newGroup`; another first operation can
use the ordinary `new-group` exchange. An unused Group needs no `drop-group`.
Session declarations and Grant creation do not require guest Group state.
No Script compilation, Load validation, worker exclusion or Trace rule changes.

## Queued Deliveries

`queue-fields-v1` ([#1374](https://github.com/odogono/odgn-talk/issues/1374))
moves the ordinary queued `deliver`, `broadcast` and `decide` inputs to the
fields envelope. It is negotiated at `hello` together with
`request-pump-fields-v1`; asked for without it, `hello` is a protocol error.
JSON `deliver`, `broadcast` and `decide` remain available.

<!-- generated: envelope.queue -->

| Tag | Message | Direction | Fields in order |
| --- | --- | --- | --- |
| `0c` | deliver | host-to-guest | ref, group, to, message |
| `0d` | broadcast | host-to-guest | ref, group, message |
| `0e` | decide | host-to-guest | ref, group, to, message, broadcast |

<!-- end -->

Each input has its JSON fields and meanings, positionally. `to` and `message`
have the `request` shapes. A `decide` whose `broadcast` is true is a Broadcast
Decision and has no `to`; otherwise `broadcast` is false or Nothing and `to`
names a Script or Object. A `broadcast` has no `to` field at all.

The reply is the admission reply (`81`). Its `delivery` is the admitted id:
the Delivery's, or the Broadcast's for a `broadcast` or a Broadcast Decision,
where the JSON reply names it `broadcast`. A refused admission carries its
ordinary error, records and Trace; the binary input changes no admission rule,
id, Report or `cancel-delivery` behaviour.

## Combined operations

`request-pump` carries the ordinary Request target and message plus the Pump
Clock and options. `call-pump` carries the ordinary Function and arguments,
optional limits and Pump inputs. Each is a worker operation. Claim the Group
worker guard before admission and hold it through the final reply, including
needs. A competing worker is refused before admitting the combined input.

Validate and admit exactly once, using ordinary admission rules. On refusal,
return no delivery or pending handle and do not Pump. After successful admission,
perform exactly one ordinary Pump. Earlier inputs stay ahead of this input;
the Pump can execute other work and can leave this input pending. A Pump refusal
returns the admitted delivery and pending handle with the error and leaves the
input queued. Do not roll it back or retry it.

The initial combined admission omits OnReady because this worker is about to
Pump. A Pump refusal leaving work queued notifies readiness. Other readiness
notifications keep their existing rules. Trace contains the ordinary Request
(or `call-value`) and Pump records, not a new combined record. All Report,
accounting, `abandoned`, `settled`, `gone`, pause and inline-ordering rules remain.
Stale Functions fail at drain; arity errors belong to execution, not admission.

## Correlation and cancellation

A token is a positive unsigned 64-bit Session-unique counter supplied by the
Host, separate from the worker ref and Core-assigned delivery id. Hosts never
reuse it in the Session and fail locally on exhaustion. The guest binds it to
the admitted delivery before any execution or observable callback. Refusal
creates no binding. Reject duplicate active tokens before admission.

`cancel-correlated` is a JSON queued input carrying its own ref, Group and token
(`{"m":"cancel-correlated","ref":…,"group":…,"token":…}`), available only after
negotiation, with `cancel-delivery`'s reply.
It has exactly the cancellation semantics of `cancel-delivery` for the binding,
including crossing landing and Trace identity. It does not execute a Pump.
An unknown, retired or wrong-Group token is a protocol error with no effect.
Allow it wherever cancellation is admitted during the combined exchange.

The Host registers a provisional pending entry before sending the combined
frame. It processes returned delivery/report associations before publishing
observations. On final receipt, under the same admission serialization used for
cancellation, it installs the delivery-id mapping, switches cancellation to that
id and retires the token. Already queued token cancellations must be ordered
before retirement, or rewritten to delivery-id cancellation before transmission.
The guest retires the binding when it emits the final reply. The Host's
serialized exchange owner must resolve the race: queued token cancellations
not yet transmitted when that reply arrives become ordinary delivery-id
cancellations. A token cancellation already transmitted must be answered before
the owner processes final completion. No retirement acknowledgement or idle
binding retention is needed. A lost final reply is a transport failure, never
permission to replay the combined admission. A cancellation queued for an
admission that was refused has nothing to cancel; the Host sends no token for it.

Inline admission, where a transport serves queued inputs while an export runs,
carries JSON. An ordinary binary input queued behind an export may cross as its
JSON form. A binary worker input waits for the export boundary instead.

## Host APIs and compatibility

Go adds Script/Group `RequestPump` and Group `CallPump`, preserving their ordinary
admission arguments and adding Clock/Pump options; results are delivery id,
Pending, PumpResult and error. TS adds `requestPump`/`callPump` with structured
admission and Pump outcomes. Its `PumpedRequest` is either
`{admitted: false, error}` or `{admitted: true, requested, pump}`, where `pump`
is `{ok: true, result}` or `{ok: false, error}`. Group Request preserves its
Object target; Script Request preserves its Script target. `now` precedes an
options object combining Pump options, `signal` and Call's optional `limits`.
A synchronous TS reactor orders an already-aborted signal's ordinary admission
and cancellation before its one Pump; it still requires combined negotiation.
C uses corresponding functions and existing owned
id/Pending/output conventions. Elixir adds `request_pump`/`call_pump` with an
explicit pending handle and Pump outcome. Do not hide admitted handles inside
an otherwise ordinary thrown Pump error.

Elixir permits both drive modes: the combined call performs one Pump, and auto
drive can subsequently resume. Await is repeatable; completed results remain
until release or Group closure. An await timeout leaves execution running.
Release discards retained state and fails active/later awaiters without cancelling
the request. Elixir has no request cancellation, so it never sends
`cancel-correlated`; it still sends a fresh token with each combined input. Preserve existing per-Host targets and options, including Elixir's
Script-only Request target and existing Function-call options.

Unsupported guests reject combined calls before admission. There is no automatic
two-call fallback. Ordinary Request, Function call and Pump APIs remain available.

## Experiment and acceptance

Implement Go/Zig candidates first. Compare unchanged `BackendRequest` and an
identical native/Zig combined Request benchmark, recording environment, artifact
identity, allocation, latency and repeated samples on all three `go-zig-bench`
platforms. Both Request benchmarks must beat the JSON Message Layer by at least
25% in the same job on every platform, with no native regression. Record combined
Function-call performance without a new limit. Missing measurements are not
passing evidence.

#1254 measured fields at 27–43% faster than JSON on every platform, and map
10–19% slower than fields, so fields is selected and map retired (#1334). The gate first asked for at
most 3× native. That limit measures the Zig guest rather than the transport, and
is now a separate goal ([ADR 0110](../../docs/adr/0110-request-and-pump-have-an-optional-binary-exchange.md)).
Go, C, TS and Elixir implementations publish the combined APIs.

Verify codec canonicality, deep Values, every Report, malformed recovery, mixed
continuations, cancellation races, stale tokens, worker exclusion, partial
success, Function lifecycle and unsupported negotiation. Browser interoperability
uses transferred buffers and the same codec vectors. Folio transport migration
and its structured-clone comparison remain separate work.

## Shared frame vectors

[`envelope-frames.json`](../../impl/testdata/envelope-frames.json) contains the
fields-layout frames for every message and Report tag, including the three
frames formerly kept in Elixir's `request_pump_fields.txt`. Each vector records
a name, numeric tag, direction, hexadecimal bytes, and `tree`: the decoded
Message Layer tree as ordered JSON text. Keeping that text lossless preserves
u64 correlation tokens, decimal scale and ordered Value Maps. The TS codec
produced the bytes once. They require human first review before merge; codec
agreement is execution evidence, not that approval. After review, a disagreeing
codec gets a bug issue rather than an edited vector. The independent binary
Value item vectors remain unchanged.

`bun run envelope:check` validates the Data File and deliberate field-kind
conflicts, checks coverage against the actual frame bytes (Report tags have
their own namespace), and compares both decoded trees and re-encoded bytes
through the TS codec. Zig's envelope tests consume the same checked-in file.
The generator never rewrites vectors.
