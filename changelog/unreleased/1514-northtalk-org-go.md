---
type: feat
scope: repo
breaking: true
---
The Go embedding's module path is now `northtalk.org/go`, and its SQLite Capability's is `northtalk.org/go/sqlite` (ADR 0148). Every Go module requires Go 1.26. The CLI, the Store kit and report tools, the HTTP Host and the multi-tenant Example Host moved under `internal/`, so the supported packages are the root, `driver`, `session`, `store` and `notify` (#1514).
