# Exchanges per Group and dropping a Group

The optional `group-exchanges-v1` Message Layer feature lets one Session host
many Groups without one Group's Host callback holding up the others, and lets
the Host free a Group it no longer needs
([#1103](https://github.com/odogono/odgn-talk/issues/1103)). It doesn't change
protocol version 1, the Trace catalogue, Fuel, Clock readings, or how needs and
results are exchanged within one Group. A Host requests it in `hello.features`
and checks the reply before using it.

## Exchanges

Without the feature, a Session has one exchange. While a `pump`, `reload` or
`replace-library` waits for a `…-result`, or a held reply waits for its
`release-result`, the Session accepts only that result and the
[paused inputs](paused-crossing-inputs.md) addressed to the worker's Group.

With the feature, each Group has its own exchange:

- An open need, or a held reply waiting for `release-result`, belongs to its
  Group's exchange. That Group accepts only its result under the worker's
  `ref`, and paused inputs under other refs, exactly as without the feature.
  A worker message for that Group is refused with `reentrant call` and its
  refusal record.
- A frame addressed to another Group is handled as if no need were open. That
  Group's own `pump`, `reload` or `replace-library` may pause in turn, so
  several Groups may have needs open at once. Each result goes to the exchange
  its `group` and `ref` name.
- A frame naming no Group (`define-capability`, `standard-capability`,
  `define-object-kind`, `grant`, `compile-library`, `add` and the
  [language analysis](../09-embedding.md#language-analysis) messages) is
  handled whatever exchanges are open.
- `restore` is refused while any Group's exchange is open. While a restore
  waits for its `resolve-result`, every other frame is refused as without the
  feature, apart from the registrations `restore-bindings-v1` allows.

A result names its Group, as every Group message does. Inline frames from the
[inline transport](inline-inputs.md) still belong to the exporting Group.
Interim needs, Trace records and `abandoned` notices go to the exchange of the
Group that made them.

## Dropping a Group

`drop-group` is a Group message with no other fields, and no reply fields. It
frees the Group: its Scripts, mailboxes, Runs, Host Objects, pending Calls and
Trace not yet carried by a reply. It runs no Handler, `finally` block, Grant
release hook or Segment lifecycle hook, and records no Trace, as when an
in-process Host lets go of its last reference to a Group. Afterwards a message
naming the Group is refused as one naming an unknown Group, including a late
`answer` or `fail` for one of its Calls. `new-group` may reuse its handle, but
the dropped Group's Function Value tokens would then name the new Group, so a
Host reusing a handle must not send them.

`drop-group` is refused with a protocol error while the Group's exchange is
open. Grants, Capability declarations, Object Kinds and Libraries belong to the
Session and stay. Without the feature, `drop-group` is a protocol error.
