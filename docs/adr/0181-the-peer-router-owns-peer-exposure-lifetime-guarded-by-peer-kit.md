---
status: accepted
---

# The Peer Router owns Peer Exposure Lifetime, guarded by peer-kit

Chapter 7 says when a Peer Exposure ends: when it is withdrawn, its Script is stopped, its owner is disposed, or the Grant that made it is revoked or disabled. A successful Reload keeps it. Each Host's Peer Router carries this rule, and the copies drifted. The TS router withdraws on every release reason except `reload`. The Go example router withdraws on `stop` only, and the Go and Zig Runners never withdraw ([#2268](https://github.com/odogono/odgn-talk/issues/2268)). We keep Lifetime in the Peer Router and catch drift with a language-neutral `corpus/peer-kit`, which every Host that offers `peer` runs in CI. This is how `corpus/notify-kit` guards watches.

- **The Core stays out:** `expose` remains a Capability Operation the Host answers. The Core keeps no record of Peer Exposures, and it sends no "withdraw" call. The Peer Router hears releases through the existing Grant release hook (chapter 9). The C ABI's `talk_peer_impl` gains the `release` member that `talk_store_impl` already has.
- **Revoke and disable withdraw:** chapter 7 holds the rule. It refines [ADR 0155](0155-a-peer-may-travel-inside-a-remote-send-and-holding-it-is-authority.md)'s Lifetime, which named only withdrawal, stop and owner disposal.
- **One router per language:** Go gets a public Peer Router, which the Go Runner uses, and `internal/examples/peers` goes. Each language then has one router for peer-kit to run against.
- **Transport is unchanged:** peer-kit drives the Peer Router in process with stand-in Groups, and no link takes part. [ADR 0153](0153-a-send-to-a-peer-is-a-remote-send-answered-like-an-operation.md)'s "Transport is the Host's" holds.

## Considered Options

- **The Core decides Lifetime and tells the router "Peer Exposure X withdrawn":** the Core already sees every release, so the rule would live beside it. But each language has its own Core, so the four router copies would become three Core copies. Every Core would also need a record of Peer Exposures that it learns from Host answers, plus a new Core↔Host call and a C ABI member. And the rule differs per Capability: Reload removes watches but keeps Peer Exposures. So a shared Core mechanism would still carry one rule per Capability. A kit catches the drift for less.

## Consequences

- A Lifetime fix still lands once per language, and peer-kit makes a missed one fail in CI.
- This ADR doesn't cover Restore. Chapter 7's Saving rule, under which the Host makes Peer Exposures again with the same identity, stays normative. No Peer Router meets it yet, and no Host that offers `peer` saves Groups. A Host that offers both `watch` and `peer` can't restore through two routers that each call `Core.Restore`, so how routers share a checkpoint is decided separately.
- Zig gains a peer-kit runner and its first kit step in CI.
