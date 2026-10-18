# PROTOTYPE: Request crossing budget (#1103 spike)

Throwaway; not for `main`. Question: can an optimised Message Layer bring the
public `BackendRequest` on the Zig adapter from about 21.6 µs to the ≤3× limit,
about 11 µs against native's 3.7–4.0 µs?

Apple M5, darwin/arm64, Go 1.27.2, wazero v1.12.0, `CGO_ENABLED=0`, six samples
at `-cpu 3,10`. The guest is built from this branch, which is #1241's source
plus two prototype entry points in `impl/zig/src/message.zig`:
`proto-request-pump` (Request and Pump in one JSON frame) and
`talk_proto_ping` (the same work with no JSON in; mode 1 also writes the JSON
`reports`).

| Layer (GOMAXPROCS=10) | Time |
|---|---|
| Public `BackendRequest`, Zig | 21.46 µs |
| Public `BackendRequest`, native | 3.73 µs |
| Guest and boundary, current two JSON frames, no Go adapter | 11.26 µs |
| Same, one combined JSON frame | 10.29 µs |
| Guest work only, no JSON (`talk_proto_ping`) | 4.19 µs |
| Same, plus writing JSON Reports | 5.17 µs |
| Empty wazero export call | 19.4 ns |
| Go: current Pump-reply decode and settle | 5.89 µs |
| Go: toy binary Pump-reply decode and settle | 0.39 µs |
| Go: building the four Reports and settling, no decode | 0.27 µs |

Reading:

- A crossing costs about 20 ns. Combining Request and Pump saves about 1 µs,
  from the second frame's parse and reply, not from the call.
- The Go adapter is about 10 µs of the 21.5 µs. Decoding the Pump reply is
  5.9 µs of that, and a binary frame makes it 0.4 µs.
- In the guest, JSON and frame handling are about 7 µs of 11.3 µs; the Request
  and Pump themselves are 4.2 µs.
- Projection with binary frames both ways and one crossing: guest about 5 µs,
  Go about 2.5–4.7 µs, total about 7.5–9.7 µs, which is 2.0–2.6× native and
  under the limit. Neither side alone gets there: Go-only about 16 µs, guest-only
  about 15.5 µs.

Not covered: CI runners, deferred calls (the 14 µs answering-goroutine
handoff), general Values and other Report kinds, inline admission polling,
`abandoned`/`settled` lists, Trace, and the request-side Go overhead (about
4.3 µs, assumed unchanged to halved).

Reproduce:

```sh
(cd impl/zig && zig build -Dtarget=wasm32-wasi -p /tmp/odgn-1103-spike)
NORTHTALK_PROTO_GUEST=/tmp/odgn-1103-spike/bin/talk.wasm CGO_ENABLED=0 \
  go -C impl/go test ./internal/zigwasm -run '^$' -bench BenchmarkProtoCrossing -cpu 3,10
CGO_ENABLED=0 go -C impl/go test -tags talk_zig_experimental -run '^$' \
  -bench BenchmarkProtoDecode -benchmem -cpu 3,10 .
```
