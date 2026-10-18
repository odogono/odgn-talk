# Binary Request and Pump exchanges

**Status: accepted, with the fields envelope selected. The Zig Session and the
experimental Go adapter implement both candidates behind negotiation. Go and C
publish the combined Host APIs; TS publishes them on both Cores with a
transferable browser codec. Elixir follows separately.** This is
[#1245](https://github.com/odogono/odgn-talk/issues/1245)'s contract, under
[ADR 0110](../../docs/adr/0110-request-and-pump-have-an-optional-binary-exchange.md).
It does not change the accepted [binary-frames-v1](binary-frames.md) contract.

## Negotiation and framing

The experiment has two mutually exclusive feature names:
`request-pump-map-v1` and `request-pump-fields-v1`. Initial `hello` and its reply
are JSON. A Host must see its requested feature in the reply before sending
binary frames. Neither feature implies `binary-frames-v1`; requesting both
candidate features, or either alongside `binary-frames-v1`, is a protocol error.
A later hello cannot change the selected candidate during the Session.

Binary frames begin with the bytes `4e 54 42 01` (ASCII `NTB`, version 1), then
a layout byte (`00` for map, `01` for fields), then exactly one payload.
JSON frames retain their ordinary JSON syntax. The binary prefix is not valid
JSON; dispatch must identify it before UTF-8 or JSON validation. Existing
transport lengths and the frame-size limit remain unchanged. Browser transports
may send a dedicated ArrayBuffer using transfer ownership; the codec does not
import WASM or browser transport code.

Only `request`, `call`, `pump`, `request-pump` and `call-pump`, their ordinary
admission replies, and final Pump replies use binary frames. Every interim need,
its result answer, inline observation/admission and acknowledgement stays JSON.
A final Pump reply after a JSON continuation still uses the layout selected for
its original exchange. Store this choice per Group exchange, not globally per
last frame. Other messages retain JSON, including `cancel-correlated` below.

A malformed binary frame produces a JSON protocol error and changes no
admission, correlation or exchange state. Validate the entire frame before
executing it. Do not retry an admitted operation automatically after a transport
failure. Unknown tags, versions, layouts, extra bytes and unsupported messages
are refused. Existing open exchanges remain available for corrected frames.

## Candidate payloads

Both candidates use the [binary Value items](binary-frames.md#items), including
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

The map candidate is a map item with the existing field names and types. It
adds the combined operations and correlation fields described below. Envelope
field order is not semantic; Value Map order is semantic. Benchmark encoders
use a fixed order so field-order variation cannot decide the comparison.

The fields candidate is a message tag followed by a list item. Its elements
are positional; absence is Nothing, and list length must match exactly:

| Tag | Message | Fields in order |
| --- | --- | --- |
| `01` | request | ref, group, to, message |
| `02` | call | ref, group, fn, args, limits |
| `03` | pump | ref, group, now, fuelSlice, fuelCap |
| `04` | request-pump | ref, group, token, to, message, now, fuelSlice, fuelCap |
| `05` | call-pump | ref, group, token, fn, args, limits, now, fuelSlice, fuelCap |
| `81` | admission | ref, delivery, err, abandoned, settled, trace |
| `82` | Pump completion | ref, delivery, token, state, nextDeadline, fuelUsed, reports, gone, err, abandoned, settled, trace |

`delivery` and `token` in Pump completion are Nothing for ordinary Pump.
Admission and Pump errors retain their ordinary error objects. `reports` is an
ordered list; a report's existing data model remains authoritative. Each specialized Report is a report tag followed by a list of these fields,
using Nothing for absent fields and retaining ordinary nested record shapes:

| Tag | Report | Fields in order |
| --- | --- | --- |
| `01` | run end | script, run, delivery, broadcast, handler, fallback, climbed, outcome, result, error, limit, effect, cleanupFailed, at, fuel, alloc |
| `02` | run started | script, run, args, rootDelivery, parentRun, parentCall, delivery, selector, fn |
| `03` | run discarded | script, run, reason, rootDelivery, parentRun, parentCall |
| `04` | run accounting | script, run, fuel, state, rootDelivery, parentRun, parentCall |
| `05` | causal work | rootDelivery, liveRuns, queuedMessages, discardedMessages |
| `06` | stop | script, reason, discardedRuns, droppedMessages, pendingCalls |
| `07` | unhandled | delivery, message, target |
| `08` | call failed | script, call, operation, detail |
| `09` | effect failure | script, run, grant, segment, phase, status, scope |
| `0a` | decided | delivery, broadcast, verdict, vetoes, undecided |
| `0b` | host error | code, detail |
| `0c` | charge result | request, call, fuel, status |

A common-case-only prototype is not an acceptance result.

### Envelope fields

Both candidates give envelope fields these items. A field the table marks
optional is omitted from a map and Nothing in a list.

| Field | Item |
| --- | --- |
| `m` (map inputs only), `group`, `delivery`, Script names, `kind`, `state`, codes | protocol text |
| `ref` | integer or negative integer |
| `token` | positive integer |
| `to` | map: `script` as protocol text, or `object` as an object item |
| `message` | map: `name` as protocol text, `args` as a list of Values, optional `limits` |
| `fn`, `args`, Report Values | Value items; a Report Value the Core can't encode is Nothing |
| `limits` | map of integer items by override name; any other item is the sentinel for an override the Host can't represent, refused with the ordinary record |
| `now`, `nextDeadline` | instant item |
| `fuelSlice`, `fuelCap` | optional integers; absent is zero |
| `err` | map: `kind`, and a host error's `code` and `detail`, as protocol text |
| `abandoned`, `settled`, `trace`, `gone`, Stop's id lists | lists of protocol text |

The map candidate's replies keep the JSON reply shapes: an admission is
`{ref, ok: {delivery, trace?}}` or `{ref, err, trace?}`, and a completion is
`{ref, delivery?, token?, ok: {state, nextDeadline?, fuelUsed, reports, gone?, trace?}, abandoned, settled?}`
or `{ref, delivery?, token?, err, trace?}`. A combined input's admission
refusal is an admission reply, so a reply with `delivery` is a Pump outcome.
In the fields candidate's completion, each `reports` element is a Report tag
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
the request. Preserve existing per-Host targets and options, including Elixir's
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
10–19% slower than fields, so fields is selected. The gate first asked for at
most 3× native. That limit measures the Zig guest rather than the transport, and
is now a separate goal ([ADR 0110](../../docs/adr/0110-request-and-pump-have-an-optional-binary-exchange.md)).
Go, C and TS implementations publish the combined APIs; Elixir follows.

Verify codec canonicality, deep Values, every Report, malformed recovery, mixed
continuations, cancellation races, stale tokens, worker exclusion, partial
success, Function lifecycle and unsupported negotiation. Browser interoperability
uses transferred buffers and the same codec vectors. Folio transport migration
and its structured-clone comparison remain separate work.
