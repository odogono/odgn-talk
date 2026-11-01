---
status: accepted
---

# A `send` to a Peer is a Remote Send, answered like an Operation

Scripts are actors ([ADR 0004](0004-scripts-are-actors.md)), but a `send` reaches only `me`, another Script of the Group or a Host Object, and for anything across Groups chapter 5 says only that "the Host routes". We want Scripts in other Groups, on this Host or another machine, to message each other the way Erlang processes message processes on remote nodes, without giving up the sandbox or the Group's determinism. So a `send` keeps its syntax and meaning, and its receiver may be a **Peer**: a Host Object that stands for an **Exposed Script** elsewhere and can be had only through a Grant of the new optional Standard Capability `peer`.

```talk
on start
  ask peer to reach "billing" into billing and wait
  send charge with order to billing into receipt and wait
end start
```

```talk
on start
  ask peer to expose "billing" and wait
end start

on charge order
  return {receipt: the id of order}
end charge
```

- **Operations:** `expose name` makes the calling Script an Exposed Script under a logical name, `unexpose name` withdraws it, and `reach address` gives a Peer. `reach` is suspending, so a Host may resolve, discover or handshake inside it, and the Peer it gives has been checked: it fails with `not exposed` when no Script is exposed under the name. `post` and `call` are what a Remote Send is, since an Operation has one mode and `send` has two.
- **One `peer` Grant per Script:** every Remote Send goes through the sending Script's Grant, and the Host checks the Peer's destination against its binding (superseded by [ADR 0155](0155-a-peer-may-travel-inside-a-remote-send-and-holding-it-is-authority.md): the binding gates only `reach` and `expose`). A Peer may pass between Scripts of a Group like any Host Object.
- **Addresses are logical.** A Script names `"billing"` or `"billing@ledger"`. The Grant binding resolves the name to a real destination and refuses one it doesn't allow with `bad address`, as `http.fetch` origins and Store names are bound ([ADR 0151](0151-http-fetch-makes-one-buffered-request-to-an-origin-the-grant-allows.md)). A Script never sees a host, port or node id.
- **A Remote Send is an Operation underneath.** A plain `send` to a Peer is defined as a call to the Grant's fire-and-forget `post`, and `send … and wait` as its suspending `call`: charged at its declared cost, Traced as a `call` record, and answered as a Host Input. Joins, Timeout Blocks, cancellation and Fuel need no new rules. Every Group stays deterministic, because the other side's reply is just an answer.
- **At most once.** A Remote Send is never retried. A plain `send` is fire-and-forget and raises no remote failure, not even a full remote mailbox. A `send … and wait` that gets no reply raises `send failed`, with the receiver's outcome as reason, or `mailbox full`, or the new reason `unreachable`. It waits as long as an enclosing Timeout Block, or the Host's longest wait, allows. Links and monitors are not in v1.
- **Only data crosses.** Arguments and replies are data values in the Value Encoding. A Function Value or a Host Object, a Peer included, is refused at the `send` with `not encodable` (amended by [ADR 0155](0155-a-peer-may-travel-inside-a-remote-send-and-holding-it-is-authority.md): a Peer may cross).
- **The receiver sees an ordinary Delivery.** The receiving Host gives a `post` with `Script.Deliver` and a `call` with `Script.Request`, and a rejected `Request`'s `reason` and `error` pass to the caller unchanged. It is dispatched by the Selector it was sent with, through Handler Clauses and the Fallback Handler, and the Run's return value is the reply. The receiver learns nothing about the sender: a caller that must identify itself says so in the arguments, and the receiving Host's binding decides whom it admits (amended by [ADR 0154](0154-a-remote-sends-caller-identity-is-vouched-for-by-the-receiving-host.md): the receiving Host vouches for a Caller Identity).
- **Only an explicit `send` is remote.** A Command Call up the Message Path, a Function Value call, a Broadcast and a Decision never cross to a Peer, so every remote effect is visible in the source. `wait for … from` a Peer raises `out of domain`, since no sender identity ever arrives to match it.
- **Save and restore:** a Group may be saved while a Remote Send waits. After a restore the Host settles that wait with Fail, `send failed`, reason `unreachable`, never Reissue or Adopt, since at-most-once forbids sending again. A receiving Run that owes a remote reply is saved like a `Request`, and after a restore its reply is dropped. The Host re-makes exposures as it re-routes Subscriptions ([ADR 0061](0061-host-notifications-share-routing-and-are-scoped-by-grant-bindings.md)).
- **Transport is the Host's.** The spec fixes the Operation Declarations, the semantics and the reasons, not how bytes move, as for `http`. A reference transport for the Script Runner is separate work.

## Considered Options

- **An explicit Operation for each call** (`ask peer to call "billing", "charge", order and wait`): every remote effect would read as an `ask`, as ADR 0012 asks of Capabilities. But the receiver would answer a Host-shaped request, not a message dispatched by Handler Clauses, and Joins and Timeout Blocks over sends would need a second spelling. Keeping `send` and gating the address keeps the Capability rule where it matters, at `reach` and `expose`.
- **Location transparency, Erlang-style:** any Script reachable by name, with no opt-in. A sandbox for untrusted Scripts can't let a remote party message a Script that never asked to be reached, so receiving needs `expose`.
- **Sender identity (`the sender`) and replies to it:** this is what makes Erlang conversations two-way, but it means defining remote identity and passing Peers, which waits for a version that lets Peers cross. Later settled by [ADR 0154](0154-a-remote-sends-caller-identity-is-vouched-for-by-the-receiving-host.md) for identity and [ADR 0155](0155-a-peer-may-travel-inside-a-remote-send-and-holding-it-is-authority.md) for passing Peers.
- **At-least-once with retries:** safer for delivery, but a retried `charge` charges twice. Scripts that need it can retry under their own keys.
- **The Peer remembering the Grant that reached it:** this would allow several `peer` Grants with different bindings in one Script, but the Core would have to keep a Grant name on every Peer and save it, and a Peer passed to another Script would need that Script to hold a Grant of the same name. One binding can allow many names, so one Grant per Script is enough.
- **Re-issuing a pending Remote Send after a restore**, as a restored Operation may be reissued: this would break at-most-once, since the first copy may have arrived.
- **The names:** `export` reads as a Library Import, `publish` is what the glossary avoids for a Broadcast, `serve` belongs to HTTP Serve Registrations, and `node` suggests a whole VM where our unit is one Script. "Exposure" is already a Value Exposure, so the receiving side is named by the Script.
