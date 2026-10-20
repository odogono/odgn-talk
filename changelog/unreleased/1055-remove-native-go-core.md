---
type: feat
scope: repo
breaking: true
---
Remove the native Go Core: its parser, checker, lowering, interpreter and save format, the `talk_native_go` build tag, and the `cmd/corpus` and `cmd/fuzzworker` commands. The Go API always runs the embedded Zig Core. Run Go Corpus cases with `NORTHTALK_CORPUS=<case> go -C impl/go test ./internal/corpus -run TestSelectedCases`. The differential fuzzer drops `--go-runner`. Native Go saves don't restore (#1055).
