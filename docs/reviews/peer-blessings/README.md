# peer expectation review

Evidence for #1971 on 2026-11-02. The normative rules are chapter 5's [Remote Sends](../../../spec/05-handlers-messages-and-scheduling.md#remote-sends), chapter 7's [`peer`](../../../spec/07-libraries-and-the-standard-library.md#peer), chapter 9's [factory](../../../spec/09-embedding.md#the-peer-factory) and chapter 11's [`peer` Stubs](../../../spec/11-the-trace-and-conformance.md#stubs).

## First expectations

**Approved.** The maintainer approved all six first blessings on 2026-11-02, and each header records it. The TS runner wrote them with its own `--bless` (PR #1979), since only the TS Core offers `peer` yet; the Zig Core and Go API must replay them unchanged for #1973. Approval is separate from that agreement ([checking](../../../corpus/README.md#checking)).

| Case | Pins |
| --- | --- |
| [`sender`](../../../corpus/peer/sender/) | `reach`, a plain `send` as `post`, `send … and wait` as `call`, and a Peer handed back in a reply |
| [`send-checks`](../../../corpus/peer/send-checks/) | `bad message name`, `object gone`, `not encodable` for a Host Object and a Function Value (paths from the Operation's arguments), `wrong kind`, `out of domain` for `wait for … from` and for a Script with no `peer` Grant, and a nested Peer that crosses |
| [`send-failed`](../../../corpus/peer/send-failed/) | `send failed` reasons `unreachable`, `mailbox full`, `not exposed` and `errored` with `error`, each carrying `capability` and `operation`; a late cost; Remote Sends as Join Members |
| [`waiting`](../../../corpus/peer/waiting/) | MaxWait, a Timeout Block, a late answer, `cancel-run` and Stop abandoning a pending `call` |
| [`save-restore`](../../../corpus/peer/save-restore/) | a pending `call` settled as Fail `unreachable`, and `caller` across a restore |
| [`exposed`](../../../corpus/peer/exposed/) | named and unnamed `expose`, its and `reach`'s failures, empty names, `caller` vouched, absent and in-Group, a Peer argument sent to through the Script's own Grant, and `unexpose` by name and by Peer |
