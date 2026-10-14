---
type: feat
---
The differential fuzzer takes `--zig-runner`, running each case on the Zig Core's new `talk-fuzzworker` (`zig build fuzzworker`) and reporting its Trace differences as `differential-zig` findings. The nightly campaign fuzzes the Go and Zig Cores, and a finding keeps each Core's Trace as `go.trace` and `zig.trace` instead of `peer.trace` (#636).
