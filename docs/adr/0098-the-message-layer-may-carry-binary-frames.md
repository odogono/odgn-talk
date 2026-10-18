# The Message Layer may carry binary frames

The Go Zig adapter misses most of #1103's per-call limits at about 10–15× native Go, and profiles put most of the Host side of each crossing in JSON: parsing the envelope and decoding Value Encoding text. We add an opt-in `binary-frames-v1` feature: after a JSON `hello`, every frame is one tagged binary item, mapping onto the Value Encoding one for one, with the same field names and the same messages. A Host that doesn't ask for it sees no change. The Message Layer stays one message per call, and stays the language-neutral embedding interface; only its bytes change.

The binary form keeps the Value Encoding's rule that the same value gives the same bytes, and that decoding refuses rather than repairs. It keeps ADR 0088's lack of a fixed nesting-depth limit. Instants, byte strings and large integers lose their text and Base64 forms, which also removes the 33% Base64 cost on saves that [the message-layer research](../research/message-layer.md) noted.

## Considered Options

- **Faster JSON only:** decoding the reply envelope into Host structs and each Value once, with no format change. This is being done first, in the Go adapter, and may be enough for some limits. It still parses text and Base64 on both sides.
- **Direct WASM exports:** one export per message, with arguments in linear memory. It removes the frame altogether, but it ties each Host to the guest's memory layout and export list, doubles the interface the Spec defines, and doesn't serve the sidecar.
- **An existing format such as CBOR or MessagePack:** both would need a canonical profile and extension tags for every Value Encoding kind, and Hosts would still have to check canonical form themselves. A small format written for these kinds is easier to keep byte-identical across three Cores.
- **cgo:** an optional Go backend only, under #1054; it doesn't help Elixir, browser or sidecar Hosts.

## Consequences

- The Zig reactor reads and writes both forms. Go, Elixir and TS Hosts may opt in independently.
- The `GLOSSARY.md` definition of the Message Layer no longer says JSON only.
- Acceptance for the feature is #1103's: the crossing rows pass in `go-zig-bench` with it on. If the faster-JSON work passes them first, this feature isn't implemented, and this ADR is superseded.
- Superseded by [ADR 0110](0110-request-and-pump-have-an-optional-binary-exchange.md): only Request, Function call and Pump frames are binary, under a negotiated envelope; other messages stay JSON.
