---
status: accepted
---

# A Remote Send's Caller Identity is vouched for by the receiving Host

[ADR 0153](0153-a-send-to-a-peer-is-a-remote-send-answered-like-an-operation.md) left the receiver knowing nothing about who sent a Remote Send. A caller could name itself in the arguments, but a server can't trust that: a browser Script can claim to be anyone. The party that does know is the receiving Host, which authenticated the connection the Remote Send came over. So `peer` gains an immediate Operation, `caller`, that gives the **Caller Identity**: the data the receiving Host vouches for about who made the Remote Send that started the calling Run.

```talk
on myOrders
  ask peer to caller
  if it is nothing then throw {code: "forbidden"}
  return ordersFor(the principal of it)
end myOrders
```

- **No Core change:** every Host function's `Call` already names the delivery id of the Host Delivery that started the calling Run, and Snapshots already save it ([ADR 0125](0125-a-host-functions-call-names-the-delivery-that-started-its-run.md)). The receiving Host records the identity against that delivery id when it gives the Remote Send to the Exposed Script, and `caller` looks it up. The Trace records the answer, so a replay needs no transport.
- **Only the Run the Remote Send started** has a Caller Identity, whether it came by `post` or by `call`. A Run started by a Script's `send`, a Function Value call or a Join, or by any other Host Delivery, gets Nothing, even in the same root. A Script that hands the work on passes the identity along as data. This is the rule `http`'s `respond` already follows ([ADR 0124](0124-http-is-an-optional-standard-capability-answered-by-the-receiving-run.md)).
- **Opaque, Host-defined data:** the value is whatever data the receiving Host's binding vouches for, such as `{principal: "alice", via: "ws"}`, or Nothing when the transport authenticated nobody. The spec fixes no keys, since authentication is the Host's, as transports are. An answer that isn't data ends the call as `host error`.
- **Per hop:** the receiving Host vouches only for the Host or connection it authenticated. When a Peer was handed over ([ADR 0155](0155-a-peer-may-travel-inside-a-remote-send-and-holding-it-is-authority.md)), the Caller Identity is the holder that sent, never the Script that introduced it. A receiver that must know the introducer is told so in the arguments.
- **Always together:** a Grant of `peer` that includes `expose` includes `caller`, since an Exposed Script is what receives Remote Sends.

## Considered Options

- **A language form, `the sender`:** it reads well, but it needs grammar, state on every Run, a save-format change and work in every Core, for a value only the Host can supply.
- **An extra argument on the Delivery**, as an HTTP Exchange's map: this changes the Handler's arity, so a remote message would no longer look like a local one.
- **Identity in the arguments only,** as ADR 0153 had it: fine between Groups that trust each other, but spoofable by any untrusted caller, which is the browser-to-server case.
- **Tracking introductions,** as OCapN's signed handoffs do: Carol could learn that Alice introduced Bob. Holding a Peer is already authority, so this adds certificates to every handoff for a property few Scripts need.

## Consequences

- `PeerImpl` gains `caller`. A Host that authenticates connections with mutual TLS, a pinned key or a session token derives the identity from that. Scripts never see keys, certificates or tokens.
