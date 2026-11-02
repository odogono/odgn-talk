# Peer router Example Host

An in-process peer router for the optional [`peer`](../../../../spec/07-libraries-and-the-standard-library.md#peer) Standard Capability: the Host component that [chapter 9](../../../../spec/09-embedding.md#the-peer-router) makes holding exposures and carrying Remote Sends between Groups. It is an embedding example, not a product, and it has a [Go twin](../../../go/internal/examples/peers/router.go).

[`router.ts`](router.ts) keeps every exposure under a secret of 128 random bits, gives each Group one Peer per exposure, turns a `post` into a `Deliver` and a `call` into a `Request` on the Exposed Script, and answers the `call` with the Run's result. Peers in arguments and replies cross as the receiving Group's Peers for the same exposures. `caller` gives the identity the router vouched for when it delivered the Remote Send: the sending Group's, given to `attach`, never a claim in the arguments. A Grant's binding, `{expose, reach}`, lists the names it may use.

```sh
bun test impl/ts/examples/peers
go -C impl/go test ./internal/examples/peers
```

The tests run two Groups, `shop` and `billing`, through the router end to end: a `call` and its reply, a Script error coming back as `send failed` `errored`, a `post` and its vouched-for sender, an unnamed exposure handed over as a push channel, a refused name, and sends after `unexpose`. This is where the round trip is tested; the [Conformance Corpus](../../../../corpus/peer/) pins one side of a Remote Send per case.

Left out, as an example may: exposures don't end when their Script stops, Caller Identities aren't dropped when their Runs end, and nothing crosses between Hosts, so there is no transport, no Host key and no save of the router's own state.
