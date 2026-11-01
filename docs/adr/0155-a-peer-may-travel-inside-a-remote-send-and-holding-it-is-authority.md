---
status: accepted
---

# A Peer may travel inside a Remote Send, and holding it is authority

Under [ADR 0153](0153-a-send-to-a-peer-is-a-remote-send-answered-like-an-operation.md) a Peer never leaves its Group, so a server can't push to a client, and a client can't hand a server a channel to call back on, without inventing a name that anyone could `reach`. Erlang passes pids and E passes far references, and both get two-way conversations, delegation and callbacks from that one move. So a Peer may now travel inside a Remote Send, and holding one is permission to send to it, as in object-capability systems such as E, OCapN and Cap'n Proto.

```talk
-- a browser Script
on start
  ask peer to reach "chat" into server and wait
  ask peer to expose into inbox and wait
  send join with "#talk", inbox to server and wait
end start

on said channel, nick, text
  say nick & ": " & text
end said
```

- **Where Peers travel:** at any depth in a Remote Send's arguments, and in a `call`'s reply. Anywhere else that needs data, such as `store`, `http` or `json`, a Peer still raises `not encodable`. A Function Value or any other Host Object in a Remote Send still raises `not encodable`.
- **Holding is authority:** a Script uses any Peer it holds through its own `peer` Grant, however the Peer reached it. The binding decides which names a Grant may `reach` and `expose`, and is never checked again at `post` or `call`. That replaces ADR 0153's check of the Peer's destination against the sending Grant's binding, which would break delegation whenever bindings are narrow.
- **Unnamed exposures:** `expose` takes its name as optional, and gives the exposing Script a Peer to itself. Without a name it makes a new **unnamed exposure** that nobody can `reach`, so the Peer is the only way to it, and passing the Peer is the only way to share it. A named `expose` also gives its Peer.
- **Withdrawing:** `unexpose` takes a name or the Peer `expose` gave. After an exposure is withdrawn, a `call` to it fails with `send failed` and the new reason `not exposed`, and a `post` is dropped. `not exposed` says the Script withdrew; `unreachable` still says the transport failed.
- **Lifetime:** an exposure lasts until it is withdrawn, its Script is stopped, or its owner is disposed, as a Subscription does. Nothing counts remote holders, so a Peer handed on never keeps an exposure alive. A Host may cap exposures through its binding.
- **One Peer per exposure per Group:** every Peer in a Group for the same exposure is the same Host Object, whether it came from `reach`, `expose` or a message, so `is` tells whether two Peers reach the same Script.
- **Always remote:** a Peer that arrives naming a Script of the receiving Group is still a Peer, and a `send` to it is still a Remote Send.
- **Saving:** the Host makes unnamed exposures again on Restore with the same identity as named ones, so Peers held in other Groups keep working.
- **Unforgeable on the wire:** the transport is still the Host's, but a Peer that crosses between Hosts must name its exposure with a secret no one can guess, of at least 128 random bits, and identify the target Host's key, as an OCapN sturdy ref does. Otherwise holding would not be authority, since anyone could forge or redirect one.

## Considered Options

- **Checking the receiver's binding on every Peer it is given:** a browser Host whose binding allows only `api` could refuse a Peer the server hands it, but every delegation and reply-to channel would need its destination listed in advance.
- **Fresh names instead of unnamed exposures:** a Script could expose a random name and send the name. That works without passing Peers, but a guessable or leaked name is reachable by anyone the binding allows.
- **Distributed garbage collection,** as Cap'n Proto and CapTP count remote references: it frees exposures when the last holder drops its Peer, but it needs a protocol between Hosts and makes lifetime depend on other machines. Exposures ending with their Script, or at `unexpose`, keep that local.
- **Short-circuiting a Peer to its own Group into a local `send`:** this would change delivery from at-most-once remote rules to mailbox rules depending on where a Peer happens to point.

## Consequences

- The Core's check on a Remote Send's arguments changes from "no Host Object" to "no Host Object but a Peer". The peer router translates Peers in arguments and replies into Peers of the receiving Group.
- `expose` gives a Peer, and `unexpose` accepts one. `send failed` gains the reason `not exposed`.
- A non-normative Host convention recommends mutual TLS between Hosts, with each destination's key pinned in the binding, and a session token for browsers.
