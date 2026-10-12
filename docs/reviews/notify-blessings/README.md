# Router kit expectation review

Evidence for [#619](https://github.com/odogono/odgn-talk/issues/619). The rules were staged at the delivery of #619. Their final homes are [Store registrations, routing, lifetime and limits](../../../spec/07-libraries-and-the-standard-library.md#store-watch-operations), [checkpoints](../../../spec/10-save-and-restore.md#store-notification-checkpoints) and [the router](../../../spec/09-embedding.md#the-notification-router).

## Proposed first expectations

**Approval is pending.** The [router kit](../../../corpus/notify-kit/) is new data. Its expectations were derived by hand from the proposal, not recorded from a router. Both routers then passed it. That agreement verifies execution; it doesn't replace the [required human first-blessing review](../../../corpus/README.md#checking).

| File | Pins |
| --- | --- |
| [`routing.toml`](../../../corpus/notify-kit/routing.toml) | net changes by Value Encoding (same value, delete of a missing key, Nothing as missing, set-then-restore, no-op increment, equal maps), sorted unique keys, prefix matching by NFC code points, one Notification per watch, other Stores untouched, own writes, the order of watches, and the registration boundary |
| [`registrations.toml`](../../../corpus/notify-kit/registrations.toml) | same-parameter `watch` keeping pending work, replacement discarding it, over-limit replacement leaving the old watch, `unwatch`, Grant aliases, and each limit and its `limit` word, in table order |
| [`pending.toml`](../../../corpus/notify-kit/pending.toml) | held Notifications and in-order retry, stopping at a watch's first refusal, overload by `pending` and `pendingSize`, resyncing and the marker's return, fair rotation, and removal on a refusal other than `MailboxFull` |
| [`lifetime.toml`](../../../corpus/notify-kit/lifetime.toml) | each release reason, release by named Grant, idempotent release, freed limits, and detach |
| [`checkpoints.toml`](../../../corpus/notify-kit/checkpoints.toml) | unchanged-source restore with pending work and retry position, no marker for a commit with no changes, markers for changed and offline-changed Stores, a resyncing watch restored, dropped Grants, variables-only, damaged checkpoints, `effects pending`, and limits unchecked on restore |

## What a reviewer checks

The derivations a reviewer should confirm, beyond the payloads themselves:

- **Sizes.** `pendingSize` and `watchSize` limits use chapter 8 logical sizes. A map counts its keys as text, so a marker for Grant `store`, watch `w` and prefix `""` is 240, and each key adds 24 plus its UTF-8 bytes. The file headers show the arithmetic.
- **A Group's place.** The proposal orders Groups "in the order the router first registered a watch from that Group". The kit reads that as: a Group that comes to hold no watches loses its place. That is what makes "unwatch and re-watch moves it" observable, since within one Group the order is set by Script, Grant and name alone. A restored Group is a new Group, so it takes its place after the Groups already watching.
- **Replacement and the limits.** A replacement counts in place of the watch it replaces, including that watch's pending work, which the replacement discards.
- **Retry rotation.** A round starts at the first watch with pending work after the previous round's first watch, wrapping. A Pump with no pending work starts no round and leaves the position.
- **Revoked and disabled Grants on restore.** A Grant the restore doesn't re-bind is restored revoked (chapter 10), which the kit shows as unbound. A Grant revoked or disabled before the checkpoint was released at that point, so the checkpoint holds no watch of it. The kit shows that no watch is restored and none is listed as dropped, where the proposal's table says such watches are "dropped and listed".
- **Invalid replacements.** An invalid `watch` is refused by the Core before the Host runs ([Validation](../../../spec/07-libraries-and-the-standard-library.md#store-watch-validation)), so the kit can't give one to a router. Trace Cases in #620 cover it.

## Running

`bun test impl/ts/tests/notify-kit.test.ts` and `go -C impl/go test ./notify` run the whole kit. The TS kit also runs under Node and Deno (`impl/ts/tests/notify-runtimes.test.ts`).
