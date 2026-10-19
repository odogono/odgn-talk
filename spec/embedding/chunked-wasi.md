# Chunked WASI transfers

The optional `chunked-wasi-v1` Message Layer feature carries large logical
messages through bounded WASI transfers ([#1286](https://github.com/odogono/odgn-talk/issues/1286)).
It changes byte transport only: JSON, Value Encoding, binary Request/Pump
messages, refs, Trace records and admission ordering retain their meanings.
The sidecar does not advertise this feature.

## Negotiation and bounds

A WASI reactor advertises `chunked-wasi-v1` in `hello.features`. A Host requests
it and checks the successful reply before using the chunk exports or continuation
headers. A failed negotiation leaves the previous transport mode intact.
Legacy `talk_buffer`/`talk_send` callers keep their existing framing.

Each chunk contains 1 through 67,108,864 bytes (64 MiB). A logical message
contains at most 2,147,483,647 bytes (2 GiB minus one). The high bit of a
32-bit chunk length, `0x80000000`, means another chunk follows; the remaining
31 bits give this chunk's byte length. The final chunk has no continuation bit.
Chunks may split JSON tokens, UTF-8 scalars, binary items or Save bytes anywhere.
They must be contiguous and ordered; messages cannot interleave.

These are transport bounds, independent of Script resource limits. Chunking
does not bound total memory to 64 MiB: both endpoints currently assemble whole
logical messages before decoding, in addition to retained Script state, Trace
text and Save data. Memory exhaustion, an invalid chunk length, an incomplete
transfer or a failed chunk operation fails the transport; the Host must discard
that instance. It must not publish partial Trace records, acknowledge partial
admissions, or retry the remainder as a new message. A complete malformed logical
message receives the ordinary protocol error and leaves the Session usable.

## Export transfers

`talk_buffer(n)` still reserves at most 64 MiB of input space. After writing a
chunk there, call `talk_send_chunk(n | continuation) -> u64`. A nonfinal input
chunk returns zero and does not parse, dispatch, execute, admit inputs or emit
Trace. The final input chunk dispatches exactly one assembled message. A single
chunk uses its original input buffer without an assembly copy.

The final call returns the first reply chunk as `pointer << 32 | taggedLength`.
Copy it before calling another export. While its continuation bit is set, call
`talk_reply_next() -> u64` to retrieve the following chunk. These calls only read
the completed reply: they do not advance the Core or emit observations. The
Host must drain the entire reply before starting another message. Zero is an
invalid reply chunk; it is an acknowledgement only for nonfinal input chunks.
The reactor keeps its completed reply until the following request, as before.

## Inline transfers

With `inline-inputs-v1`, stdin/stdout retain four-byte big-endian length
headers, now with the same continuation bit and chunk bounds in both directions.
The Host assembles every event before invoking its sink or processing an
admission reply. It sends no response until the final event chunk. The guest
then assembles the Host's response before processing it. There is exactly one
acknowledgement or admission response per logical event, including a large
`vars` Trace record. Nested input admission still occurs on the producing
worker's original stack.

## Acceptance

The Go adapter negotiates this feature for shared and restored guests. Its
focused transport tests cover input messages above 64 MiB, arbitrary byte
boundaries, complete-message protocol errors and reuse, inline observation only
after the final chunk, response chunk headers and refusal without negotiation.
The unchanged `limits/persistent-state-minimum` Corpus case exercises a valid
64 MiB retained state through complete inspection Trace records, inspection
replies and hidden Save/Restore replay. The selected adapter gate includes it;
full Corpus acceptance remains a separate requirement of #1055.
