---
type: feat
scope: tools
---
Run the differential fuzzer on both Cores. The Go fuzz worker (`impl/go/cmd/fuzzworker`) replays each case on the Go Core, and `--go-runner <path>` compares its complete Trace with the TS Core's. PR smoke fuzzing and the nightly campaign now run in this mode (#363).
